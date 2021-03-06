"use strict";

module.exports = {};

const db = require("./db");
const feed_utils = require("./feeds");
const reload = require("./reload");

var timers = {};

function nullfunc() {}

function get_timer_time(feed, last_updated) {
  var now = Date.now();

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

    if (last_updated >= now)
      last_updated = now;
  }

  var result = last_updated + millis;

  // why result < now = now?
  if (isNaN(result)/* || result < now*/)
    result = now;

  return result;
}

function clear_timer(feed) {
  if (timers[feed.url].timer !== undefined) {
    clearTimeout(timers[feed.url].timer);
    timers[feed.url].timer = undefined;
    return true;
  }

  return false;
}

function add_timer(feed) {
  if (false) {
    if (timers[feed.url].timer !== undefined) {
      return true;

      clearTimeout(timers[feed.url].timer);
      timers[feed.url].timer = undefined;
    }
  } else {
    clear_timer(feed);
  }

  var now = Date.now();

  var millis = timers[feed.url].scheduled - now;
  if (isNaN(timers[feed.url].scheduled) ||
      isNaN(millis)                     ||
      timers[feed.url].scheduled <= now ||
      millis < 0)
    millis = 0;

  var func = function() {
    timers[feed.url].timer = undefined;

    setTimeout(function() {
      reload.reload_feed_nopromise(feed.url, {
        thread: feed_utils.get_setting(feed, "thread", "default")
      });
    }, 0);
  };

  if (millis <= 1) {
    timers[feed.url].timer = setTimeout(func, 0);
    return true;
  } else {
    timers[feed.url].timer = setTimeout(func, millis);
    return false;
  }
}
module.exports.add_timer = add_timer;

function schedule_timer(feed) {
  if (reload.is_reload_running(feed)) {
    console.log("Already running on " + feed.url + " (you shouldn't see this)");
    return;
  }

  //clear_timer(feed);
  timers[feed.url].scheduled = get_timer_time(feed);

  return add_timer(feed);
}
module.exports.schedule_timer = schedule_timer;

function set_timers(feed, print) {
  var total_timers = 0;
  var overdue_timers = 0;

  if (feed.children) {
    feed.children.forEach((child) => {
      var res = set_timers(child, print);
      total_timers += res[0];
      overdue_timers += res[1];
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
      var overdue = schedule_timer(feed);
      total_timers++;
      if (overdue)
        overdue_timers++;
    }
  }

  return [total_timers, overdue_timers];
}
module.exports.set_timers = set_timers;


var last_added_time = Date.now();
module.exports.init = function() {
  db.get_feeds().then((feeds) => {
    var timers = set_timers(feeds[0]);
    setInterval(() => {
      db.get_feeds().then((feeds) => {
        var new_added_time = Date.now();
        var diff = ((new_added_time - last_added_time) - 60*1000) / 1000.0;
        last_added_time = new_added_time;

        var timers = set_timers(feeds[0], false);
        if (timers[0] > 0) {
          console.log("--- Added " + timers[0] + " timer(s) (" + timers[1] + " overdue, " + diff + "s off)");
        }
      }, true);
    }, 60*1000);
    console.log("Done initialization (" + timers + " timers)");
  });
};
