"use strict";

module.exports = {};

const uuid = require("node-uuid");

const db = require("./db");
const server = require("./server");
const schedule = require("./schedule");

var feeds_root = null;
var feed_parents = {};
var feed_urls = {};
var feed_ids = {};
var updating_feeds = false;


function sort_feeds(feed) {
  if (!feed.children) {
    return false;
  }

  var modified = false;

  feed.children.forEach((child) => {
    modified = sort_feeds(child) || modified;
  });

  var old_array = [];
  if (!modified) {
    feed.children.forEach(child => {
      old_array.push(child);
    });
  }

  feed.children.sort((a, b) => {
    return a.name < b.name ? -1 : a.name > b.name;
  });

  if (!modified) {
    for (var i = 0; i < feed.children.length; i++) {
      if (feed.children[i] !== old_array[i]) {
        modified = true;
        break;
      }
    }
  }

  return modified;
}


function fix_feeds(feed) {
  var modified = false;

  if (!feed.id) {
    feed.id = uuid.v4();
    modified = true;
  }

  if (feed.url) {
    feed.url = feed.url.replace(/^\s+/, '');
    modified = true;
  }

  if (!feed.children) {
    return modified;
  }

  var prev_names = {};

  feed.children.forEach((child) => {
    var oldname = child.name;

    while (child.name in prev_names) {
      prev_names[oldname]++;

      child.name = oldname + " (" + prev_names[oldname] + ")";
      modified = true;
    }

    prev_names[child.name] = 0;

    modified = fix_feeds(child) || modified;
  });

  return modified;
}


function update_unread(feed) {
  return new Promise((resolve, reject) => {
    db.count_content({url: feed.url, unread: true}).then(
      (count) => {
        if (isNaN(count)) {
          count = 0;
        }

        var modified = false;
        if (feed.unread !== count) {
          feed.unread = count;
          modified = true;
        }

        resolve({
          count: count,
          modified: modified
        });
      },
      (err) => {
        console.error("update_unread", err);
        reject(err);
      }
    );
  });
}
module.exports.update_unread = update_unread;


function set_unread_feeds(feed) {
  return new Promise(function(resolve, reject) {
    if (feed.children === undefined) {
      if (feed.need_update) {
        delete feed.need_update;

        /*db.count_content({url: feed.url, unread: true}).then((count) => {
          feed.unread = count;
          resolve(count);
          });*/
        update_unread(feed).then(data => {
          let modified_feeds = {};

          if (data.modified) {
            modified_feeds[feed.id] = data.count;
          }

          resolve({
            count: data.count,
            modified: modified_feeds
          });
          //resolve(data.count);
        });
      } else {
        let modified_feeds = {};

        if (isNaN(feed.unread)) {
          feed.unread = 0;
          modified_feeds[feed.id] = feed.unread;
        }

        resolve({
          count: feed.unread,
          modified: modified_feeds
        });
        //resolve(feed.unread);
      }

      return;
    }

    var processed = 0;
    var size = 0;

    if (feed.children.length === 0) {
      let modified_feeds = {};

      if (size !== feed.unread) {
        feed.unread = size;
        modified_feeds[feed.id] = feed.unread;
      }

      resolve({
        count: size,
        modified: modified_feeds
      });
      //resolve(size);
      return;
    }

    let modified_feeds = {};
    feed.children.forEach((child) => {
      set_unread_feeds(child).then(data => {
        var amount = data.count;

        if (data.modified) {
          for (var modified_id in data.modified) {
            modified_feeds[modified_id] = data.modified[modified_id];
          }
        }

        if (isNaN(amount)) {
          amount = 0;
        }

        size += amount;
        processed++;

        if (processed >= feed.children.length) {
          if (size !== feed.unread) {
            feed.unread = size;
            modified_feeds[feed.id] = feed.unread;
          }

          resolve({
            count: feed.unread,
            modified: modified_feeds
          });
          //resolve(size);
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


function update_indices(feed) {
  if (feed.children) {
    feed.children.forEach((child) => {
      update_indices(child);
    });
  } else {
    if (feed_urls[feed.url]) {
      feed_urls[feed.url].push(feed);
    } else {
      feed_urls[feed.url] = [feed];
    }
  }

  feed_ids[feed.id] = feed;
}


function reset_indices(feeds) {
  feed_urls = {};
  feed_ids = {};

  update_indices(feeds);
}


function easy_feed_fix(feeds) {
  var modified = false;
  feeds_root = feeds;

  modified = sort_feeds(feeds[0]) || modified;
  modified = fix_feeds(feeds[0]) || modified;
  update_parents(feeds[0]);

  reset_indices(feeds[0]);

  return modified;
}
module.exports.easy_feed_fix = easy_feed_fix;


function updated_feeds(feeds, do_timers) {
  if (!feeds) {
    db.get_feeds().then(
      (feeds) => {
        updated_feeds(feeds);
      },
      (err) => {
        console.error("updated_feeds (get_feeds)", err);
      }
    );
    return;
  }

  db.set_feed_freeze(true);

  var modified = easy_feed_fix(feeds) || true;

  if (do_timers !== false) {
    schedule.set_timers(feeds[0]);
  }

  set_unread_feeds(feeds[0]).then(data => {
    if (!modified) {
      if (data.modified && Object.keys(data.modified).length > 0) {
        modified = true;
      }
    }

    if (modified) {
      db.update_feeds(feeds, true).then(
        () => {},
        (err, newfeeds) => {
          console.error("updated_feeds (set_unread_feeds->modified)", err);
        }
      );
    }

    db.set_feed_freeze(false);

    if (modified) {
      server.broadcast({
        name: "feeds",
        data: feeds
      });
    }
  });
}
module.exports.updated_feeds = updated_feeds;


module.exports.init = function() {
  db.events.on("feeds", (feeds) => {
    updated_feeds(feeds, false);
  });
};


function get_feeds_by_url(url) {
  return feed_urls[url];
}
module.exports.get_feeds_by_url = get_feeds_by_url;


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

  return null;
}
module.exports.get_feed_by_hierarchy = get_feed_by_hierarchy;


function get_feed_by_id(id) {
  return feed_ids[id];
}
module.exports.get_feed_by_id = get_feed_by_id;


function get_feed_urls(feed) {
  if (!feed) {
    console.log("can't find feed");
    return;
  }

  if (!feed.children) {
    return [feed.url];
  } else {
    var ret = [];

    feed.children.forEach((child) => {
      ret.push.apply(ret, get_feed_urls(child));
    });

    return ret;
  }
}
module.exports.get_feed_urls = get_feed_urls;


function setting_defined(setting) {
  return setting !== undefined && setting !== null && setting !== "";
}
module.exports.setting_defined = setting_defined;


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

  if (setting_defined(feeds_root[0][setting]))
    return feeds_root[0][setting];

  return _default;
}
module.exports.get_setting = get_setting;


function set_feeds(our_feeds, options) {
  var changed = false;

  if (!our_feeds)
    return false;

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
module.exports.set_feeds = set_feeds;


function update_content(data) {
  return new Promise((resolve, reject) => {
    db.update_content(data._id, { "$set": { "unread": data.unread } }).then(
      () => {
        var our_feeds = get_feeds_by_url(data.url);
        our_feeds.forEach((feed) => {
          feed.need_update = true;
        });

        resolve(data);
      },
      (err) => {
        reject(err);
      });
  });
}
module.exports.update_content = update_content;

function update_many_content(urls, data) {
  return new Promise((resolve, reject) => {
    db.update_content({
      url: {
        $in: urls
      }
    }, {
      $set: data
    }, {
      multi: true
    }).then(
      () => {
        urls.forEach((url) => {
          var our_feeds = get_feeds_by_url(url);
          our_feeds.forEach((feed) => {
            feed.need_update = true;
          });
        });
        resolve(data);
      },
      (err) => {
        reject(err);
      }
    );
  });
}
module.exports.update_many_content = update_many_content;
