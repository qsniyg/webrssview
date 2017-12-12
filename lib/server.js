"use strict";

module.exports = {};

Array.prototype.move = function(from, to) {
    if (from === to) return;
    this.splice(to, 0, this.splice(from, 1)[0]);
};

const server = require('http').createServer();
const WebSocketServer = require('ws').Server;
const wss = new WebSocketServer({ server: server });
const express = require('express');
const app = express();
const path = require('path');

const db = require('./db');
const feed_utils = require('./feeds');
const reload = require('./reload');
const options = require('./options');
const schedule = require('./schedule');
const contents = require('./contents');

db.init();
feed_utils.init();
schedule.init();

function broadcast(data) {
  wss.clients.forEach(function(client) {
    client.send(data);
  });
}
module.exports.broadcast = broadcast;


app.use('/content', express.static(path.normalize(__dirname + "/../content")));
app.get('/', function(req, res) {
  res.sendFile(path.normalize(__dirname + "/../content/index.html"));
});

wss.on('connection', function (ws) {
  ws.on('message', function (message) {
    var parsed = JSON.parse(message);

    if (parsed.name === "feeds") {
      db.get_feeds().then((feeds) => {
        ws.send(JSON.stringify({
          name: "feeds",
          data: feeds
        }));
      });
    } else if (parsed.name === "content") {
      db.get_feeds().then((feeds) => {
        //var feed = get_feed_by_hierarchy(parsed.data.feed);

        var feed = {};

        if (parsed.data.feed) {
          feed.feed = feed_utils.get_feed_by_id(parsed.data.feed);

          if (!feed.feed) {
            console.log("can't find feed: " + parsed.data.feed.toString());
            return;
          }
        }

        if (parsed.data.regex) {
          feed.regex = parsed.data.regex;
        }

        if (parsed.data.search) {
          feed.search = parsed.data.search;
        }

        var token = parsed.data.token || null;
        var limit = parsed.data.limit || 0;

        contents.send_feed_contents(feed, ws, limit, token);
      });
    } else if (parsed.name === "move") {
      db.get_feeds().then((feeds) => {
        var from = feed_utils.get_feed_by_hierarchy(feeds, parsed.data.from);
        var from_parent = feed_utils.get_feed_by_hierarchy(feeds, parsed.data.from.slice(0, -1));
        var to = feed_utils.get_feed_by_hierarchy(feeds, parsed.data.to);
        var key = parsed.data.from[parsed.data.from.length - 1];

        to.children.push(from);
        from_parent.children.splice(from_parent.children.indexOf(from), 1);

        feed_utils.updated_feeds(feeds);
      });
    } else if (parsed.name === "set_feeds") {
      feed_utils.updated_feeds(parsed.data);
    } else if (parsed.name === "reload") {
      db.get_feeds().then((feeds) => {
        var urls = [];
        var feed;

        if (parsed.data.id) {
          feed = feed_utils.get_feed_by_id(parsed.data.id);

          if (!feed) {
            console.log("can't find feed: " + JSON.stringify(parsed.data));
            return;
          }

          urls = feed_utils.get_feed_urls(feed);
        } else if (parsed.data.hierarchy) {
          feed = feed_utils.get_feed_by_hierarchy(feeds, parsed.data.hierarchy);

          if (!feed) {
            console.log("can't find feed: " + JSON.stringify(parsed.data));
            return;
          }

          urls = feed_utils.get_feed_urls(feed);
        } else if (parsed.data.url) {
          urls = [parsed.data.url];
        }

        reload.reload_feeds(urls, 0, {
          priority: true,
          thread: "reload"
        });
      });
    } else if (parsed.name === "set_content") {
      db.get_feeds().then((feeds) => {
        feed_utils.update_content(parsed.data).then(() => {
          feed_utils.updated_feeds(feeds);
        });
      });
    } else if (parsed.name === "update_many_content") {
      db.get_feeds().then((feeds) => {
        var feed = feed_utils.get_feed_by_hierarchy(feeds, parsed.data.hierarchy);

        if (!feed) {
          console.log("can't find feed: " + parsed.data.toString());
          return;
        }

        var urls = feed_utils.get_feed_urls(feed);
        feed_utils.update_many_content(urls, parsed.data.data).then(() => {
          feed_utils.updated_feeds(feeds);
        });
      });
    } else {
      console.dir(parsed);
    }
  });
});

server.on('request', app);
server.listen(options.port, function () {
  console.log('Listening on ' + server.address().port);
});
