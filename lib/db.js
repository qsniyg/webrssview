"use strict";

module.exports = {};

const monk = require("monk");
var db = monk("localhost/webrssview?auto_reconnect=true");
//var db = monk("localhost/testrss?auto_reconnect=true");
var db_content = db.get("content");
var db_feeds = db.get("feeds");
const EventEmitter = require("events");

var feeds;
var feed_freeze = false;
var inited = false;

var nullfunc = function() {};
var errfunc = function(e) {console.error(e);};

module.exports.init = function() {
  db_content.createIndex({
    "updated_at": 1,
    "unread": 1
  }).then(nullfunc, errfunc);
  db_content.createIndex({ url: 1 }).then(nullfunc, errfunc);
  db_content.createIndex({ guid: 1 }).then(nullfunc, errfunc);
  db_content.createIndex({ title: "text", content: "text" }).then(nullfunc, errfunc);
};


function init_feeds() {
  return db_feeds.insert({
    name: "root",
    children: [
    ],
    reload_mins: 30
  });
}

module.exports.set_feed_freeze = function(freeze) {
  feed_freeze = freeze;
};

var events = new EventEmitter();
module.exports.events = events;

function get_feeds(force) {
  return new Promise((resolve, reject) => {
    if (!inited) {
      inited = true;

      db_feeds.count({}).then((count) => {
        if (count === 0) {
          init_feeds().then(
            () => {
              get_feeds(true).then(
                (data) => {
                  resolve(data);
                },
                (err) => {
                  reject(err);
                }
              );
            }
            // TODO: handle rejection
          );
        } else {
          get_feeds(true).then(
            (data) => {
              resolve(data);
            },
            (err) => {
              reject(err);
            }
          );
        }
      });

      return;
    }

    if (feeds && (feed_freeze || !force)) {
      resolve(feeds);
      return;
    }

    db_feeds.find({}).then(
      (doc) => {
        feeds = doc;
        events.emit("feeds", feeds);

        resolve(feeds);
      },
      () => {
        // FIXME?
        console.log("[db] Feeds rejected");
        reject();
      });
  });
}
module.exports.get_feeds = get_feeds;

function update_feeds(newfeeds, silent) {
  feeds = newfeeds;

  return new Promise((resolve, reject) => {
    db_feeds.update(newfeeds[0]._id, {
      "$set": newfeeds[0]
    }).then(
      () => {
        if (!silent)
          events.emit("feeds", newfeeds);

        resolve(newfeeds);
      },
      (err) => {
        reject(err);
      });
  });
}
module.exports.update_feeds = update_feeds;

function find_content(query, options) {
  if (!options) {
    options = {};
  }

  return db_content.find(query, options);
}
module.exports.find_content = find_content;

function update_content(query, content, options) {
  return db_content.update(query, content, options);
}
module.exports.update_content = update_content;

function insert_content(query, content) {
  return db_content.insert(query, content);
}
module.exports.insert_content = insert_content;

function count_content(query, content) {
  return db_content.count(query);
}
module.exports.count_content = count_content;
