"use strict";

module.exports = {};

const cheerio = require("cheerio");
const request = require("request");
const FeedParser = require("feedparser");
const async = require("async");

const db = require("./db");
const feed_utils = require("./feeds");
const options = require("./options");
const schedule = require("./schedule");
const server = require("./server");

var reload_running = {};
var reload_feed_list = {};

// from: https://stackoverflow.com/a/11598864/999400
// removes emoji
const non_printable_re = /[\0-\x1F\x7F-\x9F\xAD\u0378\u0379\u037F-\u0383\u038B\u038D\u03A2\u0528-\u0530\u0557\u0558\u0560\u0588\u058B-\u058E\u0590\u05C8-\u05CF\u05EB-\u05EF\u05F5-\u0605\u061C\u061D\u06DD\u070E\u070F\u074B\u074C\u07B2-\u07BF\u07FB-\u07FF\u082E\u082F\u083F\u085C\u085D\u085F-\u089F\u08A1\u08AD-\u08E3\u08FF\u0978\u0980\u0984\u098D\u098E\u0991\u0992\u09A9\u09B1\u09B3-\u09B5\u09BA\u09BB\u09C5\u09C6\u09C9\u09CA\u09CF-\u09D6\u09D8-\u09DB\u09DE\u09E4\u09E5\u09FC-\u0A00\u0A04\u0A0B-\u0A0E\u0A11\u0A12\u0A29\u0A31\u0A34\u0A37\u0A3A\u0A3B\u0A3D\u0A43-\u0A46\u0A49\u0A4A\u0A4E-\u0A50\u0A52-\u0A58\u0A5D\u0A5F-\u0A65\u0A76-\u0A80\u0A84\u0A8E\u0A92\u0AA9\u0AB1\u0AB4\u0ABA\u0ABB\u0AC6\u0ACA\u0ACE\u0ACF\u0AD1-\u0ADF\u0AE4\u0AE5\u0AF2-\u0B00\u0B04\u0B0D\u0B0E\u0B11\u0B12\u0B29\u0B31\u0B34\u0B3A\u0B3B\u0B45\u0B46\u0B49\u0B4A\u0B4E-\u0B55\u0B58-\u0B5B\u0B5E\u0B64\u0B65\u0B78-\u0B81\u0B84\u0B8B-\u0B8D\u0B91\u0B96-\u0B98\u0B9B\u0B9D\u0BA0-\u0BA2\u0BA5-\u0BA7\u0BAB-\u0BAD\u0BBA-\u0BBD\u0BC3-\u0BC5\u0BC9\u0BCE\u0BCF\u0BD1-\u0BD6\u0BD8-\u0BE5\u0BFB-\u0C00\u0C04\u0C0D\u0C11\u0C29\u0C34\u0C3A-\u0C3C\u0C45\u0C49\u0C4E-\u0C54\u0C57\u0C5A-\u0C5F\u0C64\u0C65\u0C70-\u0C77\u0C80\u0C81\u0C84\u0C8D\u0C91\u0CA9\u0CB4\u0CBA\u0CBB\u0CC5\u0CC9\u0CCE-\u0CD4\u0CD7-\u0CDD\u0CDF\u0CE4\u0CE5\u0CF0\u0CF3-\u0D01\u0D04\u0D0D\u0D11\u0D3B\u0D3C\u0D45\u0D49\u0D4F-\u0D56\u0D58-\u0D5F\u0D64\u0D65\u0D76-\u0D78\u0D80\u0D81\u0D84\u0D97-\u0D99\u0DB2\u0DBC\u0DBE\u0DBF\u0DC7-\u0DC9\u0DCB-\u0DCE\u0DD5\u0DD7\u0DE0-\u0DF1\u0DF5-\u0E00\u0E3B-\u0E3E\u0E5C-\u0E80\u0E83\u0E85\u0E86\u0E89\u0E8B\u0E8C\u0E8E-\u0E93\u0E98\u0EA0\u0EA4\u0EA6\u0EA8\u0EA9\u0EAC\u0EBA\u0EBE\u0EBF\u0EC5\u0EC7\u0ECE\u0ECF\u0EDA\u0EDB\u0EE0-\u0EFF\u0F48\u0F6D-\u0F70\u0F98\u0FBD\u0FCD\u0FDB-\u0FFF\u10C6\u10C8-\u10CC\u10CE\u10CF\u1249\u124E\u124F\u1257\u1259\u125E\u125F\u1289\u128E\u128F\u12B1\u12B6\u12B7\u12BF\u12C1\u12C6\u12C7\u12D7\u1311\u1316\u1317\u135B\u135C\u137D-\u137F\u139A-\u139F\u13F5-\u13FF\u169D-\u169F\u16F1-\u16FF\u170D\u1715-\u171F\u1737-\u173F\u1754-\u175F\u176D\u1771\u1774-\u177F\u17DE\u17DF\u17EA-\u17EF\u17FA-\u17FF\u180F\u181A-\u181F\u1878-\u187F\u18AB-\u18AF\u18F6-\u18FF\u191D-\u191F\u192C-\u192F\u193C-\u193F\u1941-\u1943\u196E\u196F\u1975-\u197F\u19AC-\u19AF\u19CA-\u19CF\u19DB-\u19DD\u1A1C\u1A1D\u1A5F\u1A7D\u1A7E\u1A8A-\u1A8F\u1A9A-\u1A9F\u1AAE-\u1AFF\u1B4C-\u1B4F\u1B7D-\u1B7F\u1BF4-\u1BFB\u1C38-\u1C3A\u1C4A-\u1C4C\u1C80-\u1CBF\u1CC8-\u1CCF\u1CF7-\u1CFF\u1DE7-\u1DFB\u1F16\u1F17\u1F1E\u1F1F\u1F46\u1F47\u1F4E\u1F4F\u1F58\u1F5A\u1F5C\u1F5E\u1F7E\u1F7F\u1FB5\u1FC5\u1FD4\u1FD5\u1FDC\u1FF0\u1FF1\u1FF5\u1FFF\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2072\u2073\u208F\u209D-\u209F\u20BB-\u20CF\u20F1-\u20FF\u218A-\u218F\u23F4-\u23FF\u2427-\u243F\u244B-\u245F\u2700\u2B4D-\u2B4F\u2B5A-\u2BFF\u2C2F\u2C5F\u2CF4-\u2CF8\u2D26\u2D28-\u2D2C\u2D2E\u2D2F\u2D68-\u2D6E\u2D71-\u2D7E\u2D97-\u2D9F\u2DA7\u2DAF\u2DB7\u2DBF\u2DC7\u2DCF\u2DD7\u2DDF\u2E3C-\u2E7F\u2E9A\u2EF4-\u2EFF\u2FD6-\u2FEF\u2FFC-\u2FFF\u3040\u3097\u3098\u3100-\u3104\u312E-\u3130\u318F\u31BB-\u31BF\u31E4-\u31EF\u321F\u32FF\u4DB6-\u4DBF\u9FCD-\u9FFF\uA48D-\uA48F\uA4C7-\uA4CF\uA62C-\uA63F\uA698-\uA69E\uA6F8-\uA6FF\uA78F\uA794-\uA79F\uA7AB-\uA7F7\uA82C-\uA82F\uA83A-\uA83F\uA878-\uA87F\uA8C5-\uA8CD\uA8DA-\uA8DF\uA8FC-\uA8FF\uA954-\uA95E\uA97D-\uA97F\uA9CE\uA9DA-\uA9DD\uA9E0-\uA9FF\uAA37-\uAA3F\uAA4E\uAA4F\uAA5A\uAA5B\uAA7C-\uAA7F\uAAC3-\uAADA\uAAF7-\uAB00\uAB07\uAB08\uAB0F\uAB10\uAB17-\uAB1F\uAB27\uAB2F-\uABBF\uABEE\uABEF\uABFA-\uABFF\uD7A4-\uD7AF\uD7C7-\uD7CA\uD7FC-\uF8FF\uFA6E\uFA6F\uFADA-\uFAFF\uFB07-\uFB12\uFB18-\uFB1C\uFB37\uFB3D\uFB3F\uFB42\uFB45\uFBC2-\uFBD2\uFD40-\uFD4F\uFD90\uFD91\uFDC8-\uFDEF\uFDFE\uFDFF\uFE1A-\uFE1F\uFE27-\uFE2F\uFE53\uFE67\uFE6C-\uFE6F\uFE75\uFEFD-\uFF00\uFFBF-\uFFC1\uFFC8\uFFC9\uFFD0\uFFD1\uFFD8\uFFD9\uFFDD-\uFFDF\uFFE7\uFFEF-\uFFFB\uFFFE\uFFFF]/g;

function trim_text(text) {
  if (!text)
    return text;

  return text.replace(non_printable_re, "").replace(/^\s+|\s+$/g, '');
}

function trim_compare(text1, text2) {
  return trim_text(text1) === trim_text(text2);
}

function fuzzify_text(text) {
  var newtext;

  try {
    newtext = cheerio.load(text).text();
  } catch (e) {
    newtext = text;
  }

  newtext = trim_text(newtext);

  return newtext;
}

function fuzzy_compare(contents1, contents2) {
  return fuzzify_text(contents1) === fuzzify_text(contents2);
}

function read_feed(url) {
  return new Promise((resolve, reject) => {
    var req = request({
      uri: url,
      timeout: options.http_timeout
    });

    var feedparser = new FeedParser({
      feedurl: url
    });

    var items = [];
    var meta;

    var error = false;

    req.on('error', function(err) {
      if (error) {
        return;
      }

      error = true;
      reject("[request] " + err.message + " (" + url + ")");
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

      error = true;
      reject("[feedparser] " + err.message + " (" + url + ")");
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
        error = true;
        reject("[feedparser] no meta" + " (" + url + ")");
        return;
      }

      resolve({
        meta,
        items
      });
    });
  });
}

function check_updated_item(db_item, new_item) {
  if (!db_item || !new_item) {
    console.log("Error: one of db_item and new_item is null");
  }

  if (new_item.title === db_item.title &&
      new_item.content === db_item.content)
    return false;

  if (trim_compare(new_item.title, db_item.title) &&
      fuzzy_compare(new_item.content, db_item.content)) {
    if (!db_item.unread)
      new_item.unread = false;
  } else {
    // unnecessary
    //new_item.unread = true;

    if (new_item.updated_at <= db_item.updated_at) {
      new_item.updated_at = Date.now();
    }
  }

  if (true) {
    if (!trim_compare(new_item.title, db_item.title)) {
      console.log("Old title: " + trim_text(db_item.title));
      console.log("New title: " + trim_text(new_item.title));
    }

    if (!fuzzy_compare(new_item.content, db_item.content)) {
      console.log("Old content: " + fuzzify_text(db_item.content));
      console.log("New content: " + fuzzify_text(new_item.content));
    }
  }

  return true;
}

function process_items(url, db_items, items) {
  var promises = [];
  var inserts = [];

  var processed_guids = {};

  var unreads = 0;
  for (var item of items) {
    var content = {
      "url": url,
      "guid": item.guid,
      "title": item.title,
      "content": item.description,
      "link": item.link,
      "created_at": item.pubDate.getTime(),
      "updated_at": item.date.getTime(),
      "added_at": Date.now(),
      "unread": true
    };

    if (content.guid in processed_guids) {
      //console.log("Warning: Duplicate GUID: " + content.guid);
      continue;
    }

    processed_guids[content.guid] = content;

    var db_item = null;
    for (var i = 0; i < db_items.length; i++) {
      if (db_items[i].guid === content.guid)
        db_item = db_items[i];
    }

    if (db_item) {
      if (db_item.added_at)
        content.added_at = db_item.added_at;
      else
        delete content.added_at;

      if (check_updated_item(db_item, content)) {
        if (item.unread) {
          unreads++;
        }

        promises.push(db.update_content(db_item._id, content));
      }
    } else {
      unreads++;
      inserts.push(content);
    }
  }

  return new Promise((resolve, reject) => {
    Promise.all(promises).then(
      () => {
        resolve({
          inserts,
          unreads
        });
      },
      () => {
        reject();
      });
  });
}

function reload_inner(url) {
  return new Promise((resolve, reject) => {
    var url_feeds = feed_utils.get_feeds_by_url(url);

    var changed = false;

    changed = feed_utils.set_feeds(url_feeds, {"error": null}) || changed;

    read_feed(url).then(
      (data) => {
        changed = feed_utils.set_feeds(url_feeds, {
          "title": data.meta.title,
          "description": data.meta.description,
          "link": data.meta.link
        }) || changed;

        var orquery = [];
        data.items.forEach((item) => {
          orquery.push({
            "url": url,
            "guid": item.guid
          });
        });

        if (data.items.length === 0) {
          console.log("No items");
          resolve(changed);
          return;
        }

        db.find_content({
          "$or": orquery
        }).then((db_items) => {
          process_items(url, db_items, data.items).then(
            (retval) => {
              if (retval.inserts.length > 0) {
                server.broadcast(JSON.stringify({
                  name: "newcontent",
                  data: {
                    url: url,
                    content: retval.inserts
                  }
                }));

                db.insert_content(retval.inserts).then(
                  () => {
                    if (retval.unreads > 0) {
                      url_feeds.forEach((feed) => {
                        feed_utils.update_unread(feed);
                        changed = true;
                      });
                    }

                    resolve(changed);
                  },
                  () => {
                    console.log("Error adding new content to mongo");
                    changed = feed_utils.set_feeds(url_feeds, {"error": "Error adding new content to mongo"}) || changed;
                    reject(changed);
                  });
              } else {
                resolve(changed);
              }
            },
            () => {
              console.log("Error processing items");
              changed = feed_utils.set_feeds(url_feeds, {"error": "Error processing items"}) || changed;
              reject(changed);
            }
          );
        });
      },
      (message) => {
        console.log(message);
        changed = feed_utils.set_feeds(url_feeds, {"error": message}) || changed;
        reject(changed);
      }
    );
  });
}

function reload_outer(url) {
  console.log("Reloading " + url);

  reload_running[url] = Date.now();

  var url_feeds = feed_utils.get_feeds_by_url(url);

  server.broadcast(JSON.stringify({
    name: "reload",
    data: {
      url: url,
      value: true
    }
  }));

  var finish = function(nochange) {
    return new Promise((resolve, reject) => {
      delete reload_running[url];

      var now = Date.now();
      url_feeds.forEach((feed) => {
        feed.last_updated = now;
        feed.need_update = true;
        schedule.schedule_timer(feed);
      });

      server.broadcast(JSON.stringify({
        name: "reload",
        data: {
          url: url,
          value: false
        }
      }));

      db.get_feeds().then(
        (feeds) => {
          if (!nochange) {
            feed_utils.updated_feeds(feeds, false);
          }

          resolve();
        },
        () => {
          reject();
        }
      );
    });
  };

  return new Promise((resolve, reject) => {
    reload_inner(url).then(
      (changed) => {
        var nochange = false;
        if (changed === false)
          nochange = true;

        finish(nochange).then(
          () => {
            resolve();
          },
          () => {
            reject();
          });
      },
      (err) => {
        finish().then(
          () => {
            reject();
          },
          () => {
            reject();
          });
      });
  });
}

function process_queue(item, cb) {
  if (item === undefined || !item) {
    console.log("Empty item to process?");
    cb();
    return;
  }

  var did_timeout = false;

  var timeout_f = setTimeout(function() {
    if (did_timeout)
      return;

    did_timeout = true;
    console.log("Feed timeout! (" + item.url + ", " + item.thread + ")");

    item.reject.forEach((reject) => {
      reject();
    });

    cb();
  }, options.feed_timeout);

  delete reload_feed_list[item.thread].urls[item.url];

  //console.dir(item);
  reload_outer(item.url).then(
    () => {
      if (did_timeout)
        return;

      did_timeout = true;
      clearTimeout(timeout_f);

      item.resolve.forEach((resolve) => {
        resolve();
      });

      cb();
    },
    () => {
      if (did_timeout)
        return;

      did_timeout = true;
      clearTimeout(timeout_f);

      item.reject.forEach((reject) => {
        reject();
      });

      cb();
    }
  );
}

function reload_feed(url, options) {
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
    if (!(options.thread in reload_feed_list)) {
      reload_feed_list[options.thread] = {
        queue: async.queue(process_queue, 1),
        urls: {}
      };
    }

    var obj = {
      url: url,
      resolve: [resolve],
      reject: [reject],
      thread: options.thread
    };

    if (url in reload_feed_list[options.thread].urls) {
      reload_feed_list[options.thread].urls[url].resolve.push(resolve);
      reload_feed_list[options.thread].urls[url].reject.push(reject);
    } else {
      reload_feed_list[options.thread].urls[url] = obj;

      if (options.priority) {
        reload_feed_list[options.thread].queue.unshift(obj);
      } else {
        reload_feed_list[options.thread].queue.push(obj);
      }
    }
  });
}
module.exports.reload_feed = reload_feed;

function reload_feeds(urls, i, options) {
  if (!options) {
    options = {};
  }

  if (!i) {
    i = 0;
  }

  if (i >= urls.length)
    return;

  var f = function() {
    reload_feeds(urls, i + 1, options);
  };

  reload_feed(urls[i], options).then(f, f);
}
module.exports.reload_feeds = reload_feeds;

function is_reload_running(feed) {
  if (!reload_running[feed.url]) {
    return false;
  }

  if ((Date.now() - reload_running[feed.url]) > options.feed_timeout) {
    return false;
  }

  return true;
}
module.exports.is_reload_running = is_reload_running;
