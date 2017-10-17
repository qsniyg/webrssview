"use strict";

var server = require('http').createServer();
var WebSocketServer = require('ws').Server;
var wss = new WebSocketServer({ server: server });
var express = require('express');
var app = express();
var port = 8765;

var db = require("monk")("localhost/webrssview?auto_reconnect=true");
var db_content = db.get("content");
var db_feeds = db.get("feeds");

var request = require("request");
var FeedParser = require("feedparser");

var uuid = require("node-uuid");

var cheerio = require("cheerio");

var feeds;
var feed_parents = {};
var timers = {};

var reload_feed_running = false;
var reload_feed_list = {};

var reload_running = {};

var updating_feeds = false;


Array.prototype.move = function(from, to) {
    if (from === to) return;
    this.splice(to, 0, this.splice(from, 1)[0]);
};

wss.broadcast = function(data) {
  wss.clients.forEach(function(client) {
    client.send(data);
  });
};


function get_feeds(cb, force) {
    if (feeds && !force || (force && updating_feeds)) {
        cb(feeds);
        return;
    }

    db_feeds.find({}).then((doc) => {
        feeds = doc;

        if (arguments.length > 0)
            cb(feeds);
    });
}

function update_feeds(cb) {
    db_feeds.update(feeds[0]._id, feeds[0]).then(() => {
        if (arguments.length > 0)
            cb(feeds);
    });
}

function update_content(data, cb) {
    db_content.update(data._id, data).then(() => {
        var our_feeds = get_feeds_by_url(data.url);
        our_feeds.forEach((feed) => {
            feed.need_update = true;
        });
        if (arguments.length > 1)
            cb(data);
    });
}

function update_many_content(urls, data, cb) {
    db_content.update({
        url: {
            $in: urls
        }
    }, {
        $set: data
    }, {
        multi: true
    }).then(() => {
        urls.forEach((url) => {
            var our_feeds = get_feeds_by_url(url);
            our_feeds.forEach((feed) => {
                feed.need_update = true;
            });
        });
        if (arguments.length > 1)
            cb(data);
    });
}

function sort_feeds(feed) {
    if (!feed.children) {
        return;
    }

    var sorted = [];
    feed.children.forEach((child) => {
        sort_feeds(child);
        sorted.push(child.name);
    });

    sorted.sort();

    for (var i = 0; i < feed.children.length; i++) {
        feed.children.move(i, sorted.indexOf(feed.children[i].name));
    }
}

function fix_feeds(feed) {
    if (!feed.id) {
        feed.id = uuid.v4();
    }

    if (feed.url) {
        feed.url = feed.url.replace(/^\s+/, '');
    }

    if (!feed.children) {
        return;
    }

    var prev_names = {};

    feed.children.forEach((child) => {
        var oldname = child.name;

        while (child.name in prev_names) {
            prev_names[oldname]++;

            child.name = oldname + " (" + prev_names[oldname] + ")"
        }

        prev_names[child.name] = 0;

        fix_feeds(child);
    });
}

function set_unread_feeds(feed) {
    return new Promise(function(resolve, reject) {
        if (feed.children === undefined) {
            if (feed.need_update) {
                delete feed.need_update;

                db_content.find({url: feed.url, unread: true}, {}).then((items) => {
                    feed.unread = items.length;
                    resolve(items.length);
                });
            } else {
                if (isNaN(feed.unread))
                    feed.unread = 0;

                resolve(feed.unread);
            }

            return;
        }

        var processed = 0;
        var size = 0;

        if (feed.children.length == 0) {
            feed.unread = size;
            resolve(size);
            return;
        }

        feed.children.forEach((child) => {
            set_unread_feeds(child).then((amount) => {
                if (isNaN(amount)) {
                    amount = 0;
                }

                size += amount;
                processed++;

                if (processed >= feed.children.length) {
                    feed.unread = size;
                    resolve(size);
                }
            });
        });
    });
}

function update_parents_child(feed) {
    if (!feed.children || feed.children.length === 0) {
        return;
    }

    feed.children.forEach((child) => {
        feed_parents[child.id] = feed;
        update_parents_child(child);
    });
}

function update_parents(feed) {
    feed_parents = {};
    feed_parents[feed] = null;
    update_parents_child(feed);
}


function updated_feeds(do_timers) {
    updating_feeds = true;
    sort_feeds(feeds[0]);
    fix_feeds(feeds[0]);
    update_parents(feeds[0]);

    if (do_timers !== false)
        set_timers(feeds[0]);

    set_unread_feeds(feeds[0]).then(() => {
        update_feeds();
        updating_feeds = false;
        wss.broadcast(JSON.stringify({
            name: "feeds",
            data: feeds
        }));
    });
}

function get_feeds_by_url(url, our_feeds) {
    var ret = [];

    if (!our_feeds) {
        our_feeds = feeds[0];
    }

    our_feeds.children.forEach((child) => {
        if (child.children) {
            ret.push.apply(ret, get_feeds_by_url(url, child));
        } else if (child.url === url) {
            ret.push(child);
        }
    });

    return ret;
}

function set_feeds(our_feeds, options) {
    var changed = false;

    our_feeds.forEach((feed) => {
        for (var option in options) {
            if (!(option in feed) || feed[option] !== options[option]) {
                feed[option] = options[option];
                changed = true;
            }

            if (option === "title" && !feed.name && options.title) {
                feed.name = options.title;
                changed = true;
            }
        }
    });

    return changed;
}


function splice_content(content, token) {
    var splice_i = -1;
    var id = null;
    for (var i = 0; i < content.length; i++) {
        if (content[i].updated_at !== token.updated_at) {
            break;
        } else if (content[i]._id.toString() === token.id.toString()) {
            id  = content[i]._id.toString();
            splice_i = i;
            break;
        }
    }

    if (splice_i >= 0) {
        content.splice(0, splice_i + 1);
    }

    return id;
}


function send_feed_contents(feed, ws, limit, token) {
    var urls = [];
    var regex = null;

    var basequery = {};

    if (feed.feed) {
        if (feed.feed instanceof Array) {
            feed.feed.forEach((this_feed) => {
                urls.push.apply(urls, get_urls(this_feed));
            });
        } else {
            urls = get_urls(feed.feed);
        }

        basequery.url = {
            $in: urls
        };
    }

    if (feed.regex) {
        regex = feed.regex;
        basequery.content = {
            $regex: regex,
            $options: "i"
        };
    }

    var query = JSON.parse(JSON.stringify(basequery));
    query.unread = true;

    var oldtoken = token || null;

    if (token) {
        query.unread = token.unread;

        query.updated_at = {
            $lte: token.updated_at
        }
    }

    db_content.find(query, {sort: {updated_at: -1}, limit: limit}).then((content) => {
        var old_length = content.length;

        var token_id = null;
        if (token && token.id)
            token_id = splice_content(content, token);

        if (old_length >= limit) {
            send_contents(content, oldtoken, {
                unread: query.unread
            }, ws);
            return;
        }

        if (query.unread) {
            query = JSON.parse(JSON.stringify(basequery));

            query.unread = false;

            db_content.find(query,
                            {
                                sort: {updated_at: -1},
                                limit: limit - old_length
                            }).then((new_content) => {
                content.push.apply(content, new_content);

                if (content.length <= 0 || content.length < limit) {
                    send_contents(content, oldtoken, null, ws);
                } else {
                    send_contents(content, oldtoken, {
                        unread: false
                    }, ws);
                }
            });
        } else {
            send_contents(content, oldtoken, null, ws);
        }
    });
}

function send_contents(content, oldtoken, token, ws) {
    if (token && content.length > 0) {
        token.updated_at = content[content.length - 1].updated_at;
        token.id = content[content.length - 1]._id;
    }

    var data = JSON.stringify({
        name: "content",
        data: {
            content: content,
            token: token,
            oldtoken: oldtoken
        }
    });

    if (ws) {
        ws.send(data);
    } else {
        wss.broadcast(data);
    }
}

function fuzzy_compare(contents1, contents2) {
    try {
        var c1 = cheerio.load(contents1).text();
    } catch (e) {
        c1 = contents1;
    }

    try {
        var c2 = cheerio.load(contents2).text();
    } catch (e) {
        c2 = contents2;
    }

    return c1 === c2;
}

function reload_feed_promise(url, ws, resolve, reject) {
    console.log("Reloading " + url);

    reload_running[url] = true;

    wss.broadcast(JSON.stringify({
        name: "reload",
        data: {
            url: url,
            value: true
        }
    }));

    var url_feeds = get_feeds_by_url(url);

    var req = request({
        uri: url,
        timeout: 500 * 1000
    });
    var feedparser = new FeedParser({
        feedurl: url
    });

    var items = [];
    var meta;

    var changed = false;
    var error = false;

    var update_timers = function() {
        var now = Date.now();
        url_feeds.forEach((feed) => {
            feed.last_updated = now;
            schedule_timer(feed);
        });

        changed = true;
    };

    var do_error = function() {
        delete reload_running[url];

        error = true;
        update_timers();

        wss.broadcast(JSON.stringify({
            name: "reload",
            data: {
                url: url,
                value: false
            }
        }));

        updated_feeds(false);

        reject();
    };

    changed = set_feeds(url_feeds, {"error": null}) || changed;

    req.on('error', function(err) {
        if (error) {
            return;
        }

        console.log("[request] " + err.message);
        changed = set_feeds(url_feeds, {"error": "[request] " + err.message}) || changed;

        do_error();
    });

    req.on('response', function(res) {
        if (error) {
            return;
        }

        var stream = this;

        if (res.statusCode !== 200) {
            return this.emit("error", new Error("Bad status code: " + res.statusCode));
        }

        stream.pipe(feedparser);
    });

    feedparser.on('error', function(err) {
        if (error) {
            return;
        }

        console.log("[feedparser] " + err.message);
        changed = set_feeds(url_feeds, {"error": "[feedparser] " + err.message}) || changed;

        do_error();
    });

    feedparser.on('readable', function() {
        if (error) {
            return;
        }

        var item;

        meta = this.meta;
        while (item = this.read()) {
            items.push(item);
        }
    });

    feedparser.on('end', function() {
        if (error) {
            return;
        }

        if (!meta) {
            do_error();
            return;
        }

        var item;
        var processed = 0;
        var unreads = 0;
        var need_update = true;

        changed = set_feeds(url_feeds, {
            "title": meta.title,
            "description": meta.description,
            "link": meta.link
        }) || changed;

        var needs_processed = items.length;

        var inserts = [];

        var endthis2 = function() {
            delete reload_running[url];

            update_timers();

            wss.broadcast(JSON.stringify({
                name: "reload",
                data: {
                    url: url,
                    value: false
                }
            }));

            url_feeds.forEach((feed) => {
                if (feed.unread !== unreads) {
                    feed.need_update = true;
                    need_update = false;
                }
            });

            if (!need_update || changed) {
                updated_feeds(false);
            } else if (ws)
            {
                ws.send(JSON.stringify({
                    name: "feeds",
                    data: feeds
                }));
            }

            update_timers();

            resolve();
        };

        var endthis = function() {
            processed++;

            if (processed >= needs_processed) {
                if (inserts.length > 0)
                    db_content.insert(inserts).then(endthis2);
                else
                    endthis2();
            };
        };

        var orquery = [];
        items.forEach((item) => {
            orquery.push({
                "url": url,
                "guid": item.guid
            });
        });

        db_content.find({
            "$or": orquery
        }).then((db_items) => {
            items.forEach((item) => {
                var content = {
                    "url": url,
                    "guid": item.guid,
                    "title": item.title,
                    "content": item.description,
                    "link": item.link,
                    "created_at": item.pubDate.getTime(),
                    "updated_at": item.date.getTime(),
                    "unread": true
                };

                var db_item = null;
                for (var i = 0; i < db_items.length; i++) {
                    if (db_items[i].guid === item.guid)
                        db_item = db_items[i];
                }

                if (db_item) {
                    if (content.title === db_item.title &&
                        content.content === db_item.content)
                    {
                        if (db_item.unread)
                            unreads++;

                        endthis();
                        return;
                    }

                    if (content.title === db_item.title &&
                        fuzzy_compare(content.content, db_item.content)) {
                        if (!db_item.unread)
                            content.unread = false;
                    } else {
                        db_item.unread = true;
                        unreads++;

                        if (content.updated_at <= db_item.updated_at) {
                            content.updated_at = Date.now();
                        }
                    }

                    if (true) {
                        console.log("Old content: " + db_item.content);
                        console.log("New content: " + content.content);
                    }

                    if (need_update) {
                        need_update = false;
                        url_feeds.forEach((feed) => {
                            feed.need_update = true;
                        });
                    }

                    db_content.update(db_item._id, content).then(() => {
                        endthis();
                    });
                } else {
                    unreads++;

                    if (need_update) {
                        need_update = false;
                        url_feeds.forEach((feed) => {
                            feed.need_update = true;
                        });
                    }

                    inserts.push(content);

                    endthis();
                    /*db_content.insert(content).then(() => {
                        endthis();
                    });*/
                }
            });
        });
    });
}

function reload_feed_real(url, ws) {
    return new Promise(function(resolve, reject) {
        reload_feed_promise(url, ws, resolve, reject);
    });
}

function reload_feed_schedule(override) {
    /*if (reload_feed_running && !override) {
        return;
    }*/

    for (var thread in reload_feed_list) {
        if (reload_feed_list[thread].running && override !== true && override !== thread) {
            continue;
        }

        reload_feed_list[thread].running = true;

        if (reload_feed_list[thread].data.length <= 0) {
            reload_feed_list[thread].running = false;
            continue;
        }

        var our_item = reload_feed_list[thread].data[0];

        var common;
        (function() {
            var thread_copy = thread;
            var data = reload_feed_list[thread_copy].data;
            var our_item_copy = our_item;

            common = function() {
                data.splice(data.indexOf(our_item_copy), 1);
                reload_feed_schedule(thread_copy);
            }
        })();

        delete reload_feed_list[thread].urls[our_item.url];

        if (our_item === undefined) {
            console.log(reload_feed_list[thread]);
        }

        reload_feed_real(our_item.url, our_item.ws).then(
            () => {
                common();

                our_item.resolve.forEach((resolve) => {
                    resolve();
                });
            },
            () => {
                common();

                our_item.reject.forEach((reject) => {
                    reject();
                });
            }
        );
    }
}

function reload_feed(url, ws, options) {
    if (!options) {
        options = {};
    }

    if (options.priority === undefined) {
        options.priority = false;
    }

    if (!options.thread) {
        options.thread = "default";
    }

    return new Promise((resolve, reject) => {
        var obj = {
            url: url,
            ws: ws,
            resolve: [resolve],
            reject: [reject]
        };

        if (!(options.thread in reload_feed_list)) {
            reload_feed_list[options.thread] = {
                running: false,
                data: [],
                urls: {}
            };
        }

        if (reload_feed_list[options.thread].urls[url]) {
            reload_feed_list[options.thread].urls[url].resolve.push(resolve);
            reload_feed_list[options.thread].urls[url].reject.push(reject);
        } else {
            reload_feed_list[options.thread].urls[url] = obj;

            if (options.priority) {
                reload_feed_list[options.thread].data.unshift(obj);
            } else {
                reload_feed_list[options.thread].data.push(obj);
            }
        }

        reload_feed_schedule();
    });
}

function reload_feeds(urls, ws, i, options) {
    if (!options) {
        options = {};
    }

    if (!i) {
        i = 0;
    }

    if (i >= urls.length)
        return;

    var f = function() {
        reload_feeds(urls, ws, i + 1, options);
    };

    reload_feed(urls[i], ws, options).then(f, f);
}

db_feeds.count({}).then((count) => {
    if (count == 0) {
        db_feeds.insert({
            name: "root",
            children: [
            ],
            reload_mins: 30
        });
    }
});


db_content.ensureIndex({"guid": 1, "url": 1, "updated_at": 1, "unread": 1});


function setting_defined(setting) {
    return setting !== undefined && setting !== null && setting !== "";
}

function get_setting(feed, setting, _default) {
    if (setting_defined(feed[setting]))
        return feed[setting];

    var curr = feed;
    var parent = null;
    for (var i = 0; i < 1000 && curr.id in feed_parents; i++) {
        parent = feed_parents[curr.id];
        if (!parent)
            break;

        if (setting_defined(parent[setting]))
            return parent[setting];

        curr = parent;
    }

    if (setting_defined(feeds[0][setting]))
        return feeds[0][setting];

    return _default;
}


function get_timer_time(feed, last_updated) {
    var reload_mins = get_setting(feed, "reload_mins", 30);
    if (isNaN(reload_mins)) {
        console.log("[ERROR] NaN reload_mins for " + feed.url + " (" + reload_mins + ")");
        reload_mins = 30;
    }

    var millis = Math.floor(reload_mins * 60 * 1000);

    if (!last_updated) {
        last_updated = feed.last_updated;

        if (isNaN(last_updated))
            last_updated = 0;

        if (last_updated >= Date.now())
            last_updated = Date.now();
    }

    var result = last_updated + millis;

    if (isNaN(result) || result < Date.now())
        result = Date.now();

    return result;
}


function add_timer(feed) {
    if (timers[feed.url].timer !== undefined) {
        clearTimeout(timers[feed.url].timer);
        timers[feed.url].timer = undefined;
    }

    var millis = timers[feed.url].scheduled - Date.now();

    if (millis <= 1) {
        //millis = get_timer_time(feed, Date.now()) - Date.now();
        timers[feed.url].timer = setTimeout(function() {
            timers[feed.url].timer = undefined;
            reload_feed(feed.url, undefined, {
                thread: get_setting(feed, "thread", "default")
            });
        }, 1);

        /*setTimeout(function() {
            reload_feed(feed.url);
        }, 1);*/
    } else {
        timers[feed.url].timer = setTimeout(function() {
            timers[feed.url].timer = undefined;
            reload_feed(feed.url, undefined, {
                thread: get_setting(feed, "thread", "default")
            });
        }, millis);
    }
}

function schedule_timer(feed) {
    if (reload_running[feed.url]) {
        console.log("Already running on " + feed.url + " (you shouldn't see this!)");
        return;
    }

    timers[feed.url].scheduled = get_timer_time(feed);

    add_timer(feed);
}

function set_timers(feed) {
    var total_timers = 0;

    if (feed.children) {
        feed.children.forEach((child) => {
            total_timers += set_timers(child);
        });
    } else {
        var now = Date.now();

        if (!feed.last_updated || isNaN(feed.last_updated)) {
            feed.last_updated = 0;
        }

        if (feed.last_updated >= Date.now()) {
            feed.last_updated = Date.now();
        }

        if (!timers[feed.url]) {
            timers[feed.url] = {};
        }

        if (timers[feed.url].timer === undefined && !reload_running[feed.url]) {
            schedule_timer(feed);
            total_timers++;
        }
    }

    return total_timers;
}

get_feeds((feeds) => {
    update_parents(feeds[0]);
    var timers = set_timers(feeds[0]);
    setInterval(() => {
        get_feeds((feeds) => {
            var timers = set_timers(feeds[0]);
            /*if (timers > 0)
                console.log("Added " + timers + " timer(s)");*/
        }, true);
    }, 60*1000);
    console.log("Done initialization (" + timers + " timers)");
});

function get_feed_by_hierarchy(feeds, hierarchy) {
    var level = 0;
    var feed_ptr = feeds;

    while (true) {
        var found = false;

        for (var i = 0; i < feed_ptr.length; i++) {
            if (feed_ptr[i].name === hierarchy[level]) {
                var new_feed_ptr = feed_ptr[i].children;
                level++;

                if (!new_feed_ptr || level >= hierarchy.length) {
                    return feed_ptr[i];
                }

                feed_ptr = new_feed_ptr;
                found = true;
                break;
            }
        }

        if (!found)
            break;
    }
}

function get_feed_by_id(feed, id) {
    if (feed.id === id) {
        return feed;
    }

    if (feed.children) {
        for (var i = 0; i < feed.children.length; i++) {
            var newid = get_feed_by_id(feed.children[i], id);
            if (newid)
                return newid;
        }
    }
}

function get_urls(feed) {
    if (!feed) {
        console.log("can't find feed");
        return;
    }

    if (!feed.children) {
        return [feed.url];
    } else {
        var ret = [];

        feed.children.forEach((child) => {
            ret.push.apply(ret, get_urls(child));
        });

        return ret;
    }
}


app.use('/content', express.static(__dirname + "/content"));
app.get('/', function(req, res) {
    res.sendFile(__dirname + "/content/index.html");
});

wss.on('connection', function (ws) {
    ws.on('message', function (message) {
        var parsed = JSON.parse(message);

        if (parsed.name === "feeds") {
            get_feeds((doc) => {
                ws.send(JSON.stringify({
                    name: "feeds",
                    data: doc
                }));
            });
        } else if (parsed.name === "content") {
            get_feeds((feeds) => {
                //var feed = get_feed_by_hierarchy(feeds, parsed.data.feed);

                var feed = {};

                if (parsed.data.feed) {
                    feed.feed = get_feed_by_id(feeds[0], parsed.data.feed);

                    if (!feed.feed) {
                        console.log("can't find feed: " + parsed.data.feed.toString());
                        return;
                    }
                }

                if (parsed.data.regex) {
                    feed.regex = parsed.data.regex;
                }

                var token = parsed.data.token || null;
                var limit = parsed.data.limit || 0;

                send_feed_contents(feed, ws, limit, token);
            });
        } else if (parsed.name === "move") {
            get_feeds((feeds_f) => {
                var from = get_feed_by_hierarchy(feeds, parsed.data.from);
                var from_parent = get_feed_by_hierarchy(feeds, parsed.data.from.slice(0, -1));
                var to = get_feed_by_hierarchy(feeds, parsed.data.to);
                var key = parsed.data.from[parsed.data.from.length - 1];

                to.children.push(from);
                from_parent.children.splice(from_parent.children.indexOf(from), 1);

                updated_feeds();
            });
        } else if (parsed.name === "set_feeds") {
            feeds = parsed.data;
            updated_feeds();
        } else if (parsed.name === "reload") {
            get_feeds((feeds) => {
                var urls = [];

                if (parsed.data.id) {
                    var feed = get_feed_by_id(feeds, parsed.data.id);

                    if (!feed) {
                        console.log("can't find feed: " + JSON.stringify(parsed.data));
                        return;
                    }

                    urls = get_urls(feed);
                } else if (parsed.data.hierarchy) {
                    var feed = get_feed_by_hierarchy(feeds, parsed.data.hierarchy);

                    if (!feed) {
                        console.log("can't find feed: " + JSON.stringify(parsed.data));
                        return;
                    }

                    urls = get_urls(feed);
                } else if (parsed.data.url) {
                    urls = [parsed.data.url];
                }

                reload_feeds(urls, ws, 0, {
                    priority: true,
                    thread: "reload"
                });
            });
        } else if (parsed.name === "set_content") {
            update_content(parsed.data, function() {
                updated_feeds();
            });
        } else if (parsed.name === "update_many_content") {
            var feed = get_feed_by_hierarchy(feeds, parsed.data.hierarchy);

            if (!feed) {
                console.log("can't find feed: " + parsed.data.toString());
                return;
            }

            var urls = get_urls(feed);
            update_many_content(urls, parsed.data.data, function() {
                updated_feeds();
            });
        } else {
            console.dir(parsed);
        }
    });
});

server.on('request', app);
server.listen(port, function () { console.log('Listening on ' + server.address().port) });
