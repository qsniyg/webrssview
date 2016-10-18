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

var feeds;
var timers = {};


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

    if (!feed.children) {
        return;
    }

    var prev_names = {};

    feed.children.forEach((child) => {
        var oldname = child.name;

        while (child.name in prev_names) {
            prev_names[oldname]++;

            child.name = oldname + " (" + prev_names[name] + ")"
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

function updated_feeds() {
    sort_feeds(feeds[0]);
    fix_feeds(feeds[0]);
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

function send_feed_contents(feed, ws) {
    var urls = [];

    if (feed instanceof Array) {
        feed.forEach((this_feed) => {
            urls.push.apply(urls, get_urls(this_feed));
        });
    } else {
        urls = get_urls(feed);
    }

    db_content.find({
        url: {
            $in: urls
        }
    }, {"sort": {"unread": -1, "updated_at": -1}}).then((content) => {
        send_contents(content, ws);
    });
}

function send_contents(contents, ws) {
    var data = JSON.stringify({
        name: "content",
        data: contents
    });

    if (ws) {
        ws.send(data);
    } else {
        wss.broadcast(data);
    }
}

function reload_feed_promise(url, ws, resolve, reject) {
    console.log("Reloading " + url);
    var url_feeds = get_feeds_by_url(url);

    var req = request(url);
    var feedparser = new FeedParser({
        feedurl: url
    });

    var items = [];
    var meta;

    var changed = false;

    req.on('error', function(error) {
        console.log("[request] " + error.message);
        changed = set_feeds(url_feeds, {"error": "[request] " + error.message});
    });

    req.on('response', function(res) {
        var stream = this;

        if (res.statusCode !== 200) {
            return this.emit("error", new Error("Bad status code: " + res.statusCode));
        }

        stream.pipe(feedparser);
    });

    feedparser.on('error', function(error) {
        console.log("[feedparser] " + error.message);
        changed = set_feeds(url_feeds, {"error": "[feedparser] " + error.message}) || changed;
    });

    feedparser.on('readable', function() {
        var item;

        meta = this.meta;
        while (item = this.read()) {
            items.push(item);
        }
    });

    feedparser.on('end', function() {
        var item;
        var processed = 0;
        var need_update = true;

        var wsdata = JSON.stringify({
            name: "reload",
            data: url
        });

        changed = set_feeds(url_feeds, {
            "title": meta.title,
            "description": meta.description,
            "link": meta.link,
            "last_updated": Date.now()
        }) || changed;

        var needs_processed = items.length;

        var endthis = function() {
            processed++;

            if (processed >= needs_processed) {
                if (ws)
                    ws.send(wsdata);

                if (!need_update || changed)
                    updated_feeds();
                else if (ws)
                {
                    ws.send(JSON.stringify({
                        name: "feeds",
                        data: feeds
                    }));
                }

                schedule_timer(url_feeds[0]);
                set_timers(url_feeds[0]);

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
                    db_items[0].unread = true;

                    if (content.title === db_items[0].title &&
                        content.content === db_items[0].content)
                    {
                        endthis();
                        return;
                    }

                    if (need_update) {
                        need_update = false;
                        url_feeds.forEach((feed) => {
                            feed.need_update = true;
                        });
                    }

                    if (content.updated_at <= db_items[0].updated_at) {
                        content.updated_at = Date.now();
                    }

                    db_content.update(db_items[0]._id, content).then(() => {
                        endthis();
                    });
                } else {
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

function reload_feed(url, ws) {
    return new Promise(function(resolve, reject) {
        reload_feed_promise(url, ws, resolve, reject);
    });
}

function reload_feeds(urls, ws, i) {
    if (!i) {
        i = 0;
    }

    if (i >= urls.length)
        return;

    reload_feed(urls[i], ws).then(function() {
        reload_feeds(urls, ws, i + 1);
    });
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


function schedule_timer(feed) {
    var millis = Math.floor(get_setting(feed, "reload_mins", 30) * 60 * 1000);
    timers[feed.url].scheduled = feed.last_updated + millis;
}


function set_timers(feed) {
    if (feed.children) {
        feed.children.forEach((child) => {
            set_timers(child);
        });
    } else {
        if (!feed.last_updated) {
            reload_feed(feed.url);
            return;
        }

        var millis = Math.floor(get_setting(feed, "reload_mins", 30) * 60 * 1000);
        var now = Date.now();

        if (timers[feed.url] !== undefined) {
            if (timers[feed.url].scheduled - feed.last_updated != millis) {
                clearTimeout(timers[feed.url].timer);
                schedule_timer(feed);
            }
        } else {
            timers[feed.url] = {};
            timers[feed.url].scheduled = feed.last_updated + millis;
        }

        if (timers[feed.url].scheduled <= now) {
            reload_feed(feed.url);
        } else {
            timers[feed.url].timer = setTimeout(function() {
                reload_feed(feed.url);
            }, millis);
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
                var feed = get_feed_by_hierarchy(feeds, parsed.data);

                if (!feed) {
                    console.log("can't find feed: " + parsed.data.toString());
                    return;
                }

                send_feed_contents(feed, ws);
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

                if (parsed.data.hierarchy) {
                    var feed = get_feed_by_hierarchy(feeds, parsed.data.hierarchy);

                    if (!feed) {
                        console.log("can't find feed: " + parsed.data.toString());
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
        } else {
            console.dir(parsed);
        }
    });
});

server.on('request', app);
server.listen(port, function () { console.log('Listening on ' + server.address().port) });
