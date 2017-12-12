"use strict";

module.exports = {};

const db = require("./db");
const feed_utils = require("./feeds");
const reload = require("./reload");

var timers = {};

function nullfunc() {}

function get_timer_time(feed, last_updated) {
  var reload_mins = feed_utils.get_setting(feed, "reload_mins", 30);
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

  var func = function() {
    timers[feed.url].timer = undefined;

    reload.reload_feed(feed.url, {
      thread: feed_utils.get_setting(feed, "thread", "default")
    }).then(nullfunc, nullfunc);
  };

  if (millis <= 1) {
    timers[feed.url].timer = setTimeout(func, 1);
  } else {
    timers[feed.url].timer = setTimeout(func, millis);
  }
}
module.exports.add_timer = add_timer;

function schedule_timer(feed) {
  if (reload.is_reload_running(feed)) {
    console.log("Already running on " + feed.url + " (you shouldn't see this)");
    return;
  }

  timers[feed.url].scheduled = get_timer_time(feed);

  add_timer(feed);
}
module.exports.schedule_timer = schedule_timer;

function set_timers(feed, print) {
  var total_timers = 0;

  if (feed.children) {
    feed.children.forEach((child) => {
      total_timers += set_timers(child, print);
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

    if (timers[feed.url].timer === undefined && !reload.is_reload_running(feed)) {
      if (print) {
        console.log(feed.url);
      }
      schedule_timer(feed);
      total_timers++;
    }
  }

  return total_timers;
}
module.exports.set_timers = set_timers;


module.exports.init = function() {
  db.get_feeds().then((feeds) => {
    var timers = set_timers(feeds[0]);
    setInterval(() => {
      db.get_feeds((feeds) => {
        var timers = set_timers(feeds[0], false);
        if (timers > 0)
          console.log("Added " + timers + " timer(s)");
      }, true);
    }, 60*1000);
    console.log("Done initialization (" + timers + " timers)");
  });
};
