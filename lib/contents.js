"use strict";

module.exports = {};

const sanitizeHtml = require("sanitize-html");

const feed_utils = require("./feeds");
const db = require("./db");
const server = require("./server");


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

const allowedtags = [ 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'a', 'ul', 'ol',
                      'nl', 'li', 'b', 'i', 'strong', 'em', 'strike', 'code', 'hr', 'br', 'div',
                      'table', 'thead', 'caption', 'tbody', 'tr', 'th', 'td', 'pre',
                      'img', 'iframe' ];
const allowedattributes = {
  a: [ 'href', 'target' ],
  img: [ 'src', 'alt' ],
  iframe: [ 'src' ],
  '*': [ 'style', 'title', 'height', 'width', 'border' ]
};
const transformtags = {
  'a': (tagName, attribs) => {
    attribs.target = "_blank";
    return {
      tagName: tagName,
      attribs: attribs
    };
  },
  'iframe': (tagName, attribs) => {
    return {
      tagName: "a",
      attribs: {
        'href': attribs.src
      },
      text: "(iframe to " + attribs.src + ")"
    };
  }
};

function send_contents(content, oldtoken, token, ws) {
  if (token && content.length > 0 && !token.skip) {
    token.updated_at = content[content.length - 1].updated_at;
    token.id = content[content.length - 1]._id;
    token.unread = content[content.length - 1].unread;
  }

  for (var i = 0; i < content.length; i++) {
    content[i].content = sanitizeHtml(content[i].content, {
      allowedTags: allowedtags,
      allowedAttributes: allowedattributes,
      transformTags: transformtags
    });
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
    server.broadcast(data);
  }
}


function send_feed_contents(feed, ws, limit, token) {
  var urls = [];
  var regex = null;

  var basequery = {};

  if (feed.feed) {
    if (feed.feed instanceof Array) {
      feed.feed.forEach((this_feed) => {
        urls.push.apply(urls, feed_utils.get_feed_urls(this_feed));
      });
    } else {
      urls = feed_utils.get_feed_urls(feed.feed);
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
  } else if (feed.search) {
    basequery.$text = {
      $search: feed.search
    };
  }

  var query = JSON.parse(JSON.stringify(basequery));
  if (feed.sort !== "relevance") {
    query.unread = true;
  }

  var oldtoken = token || null;
  var is_relevance = feed.sort === "relevance";

  if (token && !is_relevance) {
    query.unread = token.unread;

    query.updated_at = {
      $lte: token.updated_at
    };
  }

  var sortfield = {
    sort: {updated_at: -1},
    limit: limit
  };

  var skip = 0;

  if (is_relevance) {
    sortfield.sort = {
      score: { "$meta": "textScore" }
    };

    sortfield.fields = {
      _id: 1,
      content: 1,
      created_at: 1,
      guid: 1,
      link: 1,
      title: 1,
      unread: 1,
      updated_at: 1,
      url: 1,

      score: {
        $meta: "textScore"
      }
    };

    if (token) {
      skip = token.skip;
      sortfield.skip = token.skip;
    }
  }

  db.find_content(query, sortfield).then((content) => {
    var old_length = content.length;

    var token_id = null;
    if (token && token.id)
      token_id = splice_content(content, token);

    if (old_length >= limit) {
      if (!is_relevance) {
        send_contents(content, oldtoken, {
          unread: query.unread
        }, ws);
      } else {
        send_contents(content, oldtoken, {
          skip: skip + limit
        }, ws);
      }
      return;
    }

    if (query.unread && !is_relevance) {
      query = JSON.parse(JSON.stringify(basequery));

      query.unread = false;

      db.find_content(query, {
        sort: {updated_at: -1},
        limit: limit - old_length
      }).then(
        (new_content) => {
          content.push.apply(content, new_content);

          if (content.length <= 0) {
            send_contents(content, oldtoken, null, ws);
          } else {
            send_contents(content, oldtoken, {
              unread: false
            }, ws);
          }
        }
      );
    } else {
      if (!is_relevance) {
        send_contents(content, oldtoken, {
          unread: false
        }, ws);
      } else {
        send_contents(content, oldtoken, {
          skip: skip + limit
        }, ws);
      }
    }
  });
}
module.exports.send_feed_contents = send_feed_contents;
