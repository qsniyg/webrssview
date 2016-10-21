"use strict";

var server = require('http').createServer();
var WebSocketServer = require('ws').Server;
var wss = new WebSocketServer({ server: server });
var express = require('express');
var app = express();
var port = 8765;

var db = require("monk")("localhost/webrssview");
var db_content = db.get("content");
var db_feeds = db.get("feeds");

var request = require("request");
var FeedParser = require("feedparser");

var uuid = require("node-uuid");

var cheerio = require("cheerio");

var feeds;
var timers = {};

var reload_feed_running = false;
var reload_feed_list = [];


Array.prototype.move = function(from, to) {
    if (from === to) return;
    this.splice(to, 0, this.splice(from, 1)[0]);
};

wss.broadcast = function(data) {
  wss.clients.forEach(function(client) {
    client.send(data);
  });
};


function get_feeds(cb) {
    if (feeds) {
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


function updated_feeds(do_timers) {
    sort_feeds(feeds[0]);
    fix_feeds(feeds[0]);

    if (do_timers !== false)
        set_timers(feeds[0]);

    set_unread_feeds(feeds[0]).then(() => {
        update_feeds();
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
                unread: true
            }, ws);
            return;
        }

        if (!token || token.unread) {
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
    return cheerio.load(contents1).text() === cheerio.load(contents2).text();
}

function reload_feed_promise(url, ws, resolve, reject) {
    console.log("Reloading " + url);

    wss.broadcast(JSON.stringify({
        name: "reload",
        data: {
            url: url,
            value: true
        }
    }));

    var url_feeds = get_feeds_by_url(url);

    var req = request(url);
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

        var endthis = function() {
            processed++;

            if (processed >= needs_processed) {
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
            }
        };

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

            db_content.find({
                "url": content.url,
                "guid": content.guid
            }).then((db_items) => {
                if (db_items.length > 0) {
                    if (content.title === db_items[0].title &&
                        content.content === db_items[0].content)
                    {
                        if (db_items[0].unread)
                            unreads++;

                        endthis();
                        return;
                    }

                    if (content.title === db_items[0].title &&
                        fuzzy_compare(content.content, db_items[0].content)) {
                        content.unread = false;
                    } else {
                        db_items[0].unread = true;
                        unreads++;

                        if (content.updated_at <= db_items[0].updated_at) {
                            content.updated_at = Date.now();
                        }
                    }

                    if (true) {
                        console.log("Old content: " + db_items[0].content);
                        console.log("New content: " + content.content);
                    }

                    if (need_update) {
                        need_update = false;
                        url_feeds.forEach((feed) => {
                            feed.need_update = true;
                        });
                    }

                    db_content.update(db_items[0]._id, content).then(() => {
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

                    db_content.insert(content).then(() => {
                        endthis();
                    });
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
    if (reload_feed_running && !override) {
        return;
    }

    reload_feed_running = true;

    if (reload_feed_list.length <= 0) {
        reload_feed_running = false;
        return;
    }

    var our_item = reload_feed_list[0];

    var common = function() {
        reload_feed_list.splice(0, 1);
        reload_feed_schedule(true);
    }

    reload_feed_real(our_item.url, our_item.ws).then(
        () => {
            common();
            our_item.resolve();
        },
        () => {
            common();
            our_item.reject();
        }
    )
}

function reload_feed(url, ws) {
    return new Promise((resolve, reject) => {
        reload_feed_list.push({
            url: url,
            ws: ws,
            resolve: resolve,
            reject: reject
        });
        reload_feed_schedule();
    });
}

function reload_feeds(urls, ws, i) {
    if (!i) {
        i = 0;
    }

    if (i >= urls.length)
        return;

    var f = function() {
        reload_feeds(urls, ws, i + 1);
    };

    reload_feed(urls[i], ws).then(f, f);
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


function setting_defined(setting) {
    return setting !== undefined && setting !== null && setting !== "";
}

function get_setting(feed, setting, _default) {
    if (setting_defined(feed[setting]))
        return feed[setting];

    // TODO: implement hierarchy settings
    if (setting_defined(feeds[0][setting]))
        return feeds[0][setting];

    return _default;
}


function add_timer(feed) {
    if (timers[feed.url].timer !== undefined) {
        clearTimeout(timers[feed.url].timer);
        timers[feed.url].timer = undefined;
    }

    var millis = timers[feed.url].scheduled - Date.now();

    if (millis <= 1) {
        reload_feed(feed.url);
    } else {
        timers[feed.url].timer = setTimeout(function() {
            reload_feed(feed.url);
        }, millis);
    }
}

function schedule_timer(feed) {
    var millis = Math.floor(get_setting(feed, "reload_mins", 30) * 60 * 1000);
    timers[feed.url].scheduled = feed.last_updated + millis;

    add_timer(feed);
}

function set_timers(feed) {
    if (feed.children) {
        feed.children.forEach((child) => {
            set_timers(child);
        });
    } else {
        var now = Date.now();

        if (!feed.last_updated) {
            feed.last_updated = 0;
        }

        if (!timers[feed.url]) {
            timers[feed.url] = {};
        }

        if (timers[feed.url].timer === undefined) {
            schedule_timer(feed);
        }
    }
}

get_feeds((feeds) => {
    set_timers(feeds[0]);
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

                reload_feeds(urls, ws);
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
