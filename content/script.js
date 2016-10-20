"use strict";

var page_title = "webrssview";

var $tree;
var $content;
var $overlay;
var $contextmenu;
var ws;
var edit_modal_info;
var folder_modal_info;
var delete_modal_info;
var search_modal_info;
var feeds;
var feed_freeze = false;
var retree_freeze = false;
var currentnode;

var urls = {};
var ids = {};
var reloading = {};

var unreads = [];
var unread_count = {};

var currenttoken = null;
var lasttokenrequest = null;
var lastquery = null;

function node_is_folder(node) {
    return ("_data" in node) && node._data.is_folder;
}

function node_is_root(node, strict) {
    if (strict)
        return node.parent && !node.parent.parent;
    else
        return !node.parent || !node.parent.parent;
}

function get_node_hierarchy(node) {
    var ret = [node._data.name];

    var parent = node.parent;
    while (parent && parent.name.length > 0) {
        ret.push(parent.name);
        parent = parent.parent;
    }

    ret.reverse();
    return ret;
}

function get_feed_by_hierarchy(hierarchy) {
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

function get_feed_from_node(node) {
    return get_feed_by_hierarchy(get_node_hierarchy(node));
}


// http://stackoverflow.com/a/12484507
function feed_url_exists(url) {
    url = (url + "").toLowerCase();

    for (var p in urls) {
        if (urls.hasOwnProperty(p) && url == (p + "").toLowerCase()){
            return true;
        }
    }
    return false;
}


function open_contextmenu(x, y, items) {
    $contextmenu.html("");

    if (items) {
        items.forEach(function(item) {
            var liel = document.createElement("li");

            if (item.separator) {
                liel.setAttribute("role", "separator");
                liel.classList.add("divider");
            } else {
                var ael = document.createElement("a");

                ael.innerHTML = item.name;

                if (item.href) {
                    ael.href = item.href;
                } else {
                    ael.href = "javascript:void(0);";
                }

                if (item.onclick) {
                    ael.onclick = item.onclick;
                }

                liel.appendChild(ael);
            }

            $contextmenu[0].appendChild(liel);
        });
    }

    $overlay.removeClass("hidden");

    var height = $contextmenu.height();

    if (y + height > $(window).height()) {
        $contextmenu.css({
            left: x,
            top: y - height
        });
    } else {
        $contextmenu.css({
            left: x,
            top: y
        });
    }
}

function reset_modal(modal) {
    modal.find("[data-required=true]").each(function(i, item) {
        var $item = $(item);
        $item.parent().removeClass("has-error");
    });
}

function focus_modal(modal) {
    modal.find("[autofocus]").focus();
}

function validate_modal(modal) {
    var ok = true;

    modal.find("[data-required=true]").each(function(i, item) {
        var $item = $(item);
        if ($item.val().length <= 0) {
            ok = false;
            $item.parent().addClass("has-error");
        }
    });

    return ok;
}

function show_edit_modal(node) {
    var $edit_modal = $("#edit_modal");
    var $edit_modal_name = $("#edit_modal_name");
    var $edit_modal_url = $("#edit_modal_url");
    var $edit_modal_reload = $("#edit_modal_reload");

    reset_modal($edit_modal);

    edit_modal_info = node;


    if (node_is_folder(node)) {
        $edit_modal_name.val("");
        $edit_modal_url.val("");
        $edit_modal_reload.val("");
    } else {
        $edit_modal_name.val(node.name);
        $edit_modal_url.val(node._data.url);
        $edit_modal_reload.val(edit_modal_info.reload_mins);
    }

    $edit_modal.modal("show");
    focus_modal($edit_modal);
}

function save_edit_modal() {
    var $edit_modal = $("#edit_modal");
    var $edit_modal_name = $("#edit_modal_name");
    var $edit_modal_url = $("#edit_modal_url");
    var $edit_modal_reload = $("#edit_modal_reload");

    if (!validate_modal($edit_modal)) {
        return;
    }

    feed_freeze = true;
    var our_node = get_feed_from_node(edit_modal_info);
    if (!our_node) {
        console.log("can't find info for node");
        console.log(node);
        feed_freeze = false;
        return;
    }

    var reload_val;

    if ($edit_modal_reload.val() === "") {
        reload_val = null;
    } else {
        reload_val = parseFloat($edit_modal_reload.val());
    }

    if (our_node.children) {
        if (feed_url_exists($edit_modal_url.val())) {
            $edit_modal_url.parent().addClass("has-error");
            feed_freeze = false;
            return;
        }

        our_node.children.push({
            name: $edit_modal_name.val(),
            url: $edit_modal_url.val(),
            reload_mins: reload_val
        });
        our_node = our_node.children[our_node.children.length - 1];
    } else {
        our_node.name = $edit_modal_name.val();
        our_node.url = $edit_modal_url.val();
        our_node.reload_mins = reload_val;
    }

    var senddata = JSON.stringify({
        name: "set_feeds",
        data: feeds
    });

    feed_freeze = false;

    ws.send(senddata);

    /*our_node._data = {};
    our_node._data.url = our_node.url;
    reload_feed(our_node);*/

    $edit_modal.modal("hide");
}


function show_folder_modal(node, add) {
    var $folder_modal = $("#folder_modal");
    var $folder_modal_name = $("#folder_modal_name");
    var $folder_modal_title = $("#folder_modal .modal-title");
    var $folder_modal_reload = $("#folder_modal_reload");

    reset_modal($folder_modal);

    if (!node_is_folder(node)) {
        // not a folder
        return;
    }

    folder_modal_info = {
        node: node,
        add: add
    };

    $folder_modal_name.parent().show();
    $folder_modal_reload.parent().hide();

    if (add) {
        $folder_modal_title.html("Add Folder");
    } else {
        if (node_is_root(node)) {
            $folder_modal_title.html("Settings");
            $folder_modal_name.parent().hide();
            $folder_modal_reload.parent().show();
            $folder_modal_reload.val(folder_modal_info.node.reload_mins);
        } else {
            $folder_modal_title.html("Edit Folder");
            $folder_modal_name.parent().show();
            $folder_modal_reload.parent().hide();
            $folder_modal_reload.val("");
        }
    }

    if (add) {
        $folder_modal_name.val("");
    } else {
        $folder_modal_name.val(node.name);
    }

    $folder_modal.modal("show");
    focus_modal($folder_modal);
}

function save_folder_modal() {
    var $folder_modal = $("#folder_modal");
    var $folder_modal_name = $("#folder_modal_name");
    var $folder_modal_reload = $("#folder_modal_reload");

    if (!validate_modal($folder_modal)) {
        return;
    }

    feed_freeze = true;
    var our_node = get_feed_from_node(folder_modal_info.node);
    if (!our_node) {
        console.log("can't find info for node");
        console.log(node);
        feed_freeze = false;
        return;
    }

    var reload_val;

    if ($folder_modal_reload.val() === "") {
        reload_val = null;
    } else {
        reload_val = parseFloat($folder_modal_reload.val());
    }

    if (folder_modal_info.add) {
        our_node.children.push({
            name: $folder_modal_name.val(),
            children: []
        });
    } else {
        our_node.name = $folder_modal_name.val();
        our_node.reload_mins = reload_val;
    }

    var senddata = JSON.stringify({
        name: "set_feeds",
        data: feeds
    });

    feed_freeze = false;

    ws.send(senddata);

    $folder_modal.modal("hide");
}


function show_delete_modal(node) {
    var $delete_modal = $("#delete_modal");
    var $delete_modal_name = $("#delete_modal_name");
    var $folder_text = $delete_modal.find(".folder_text");

    if (!node.parent || !node.parent.parent) {
        return; // root element
    }

    delete_modal_info = {
        node: get_feed_from_node(node),
        parent: get_feed_from_node(node.parent)
    }

    if (!delete_modal_info.node || !delete_modal_info.parent) {
        console.log("can't find info for node");
        console.log(node);
        return;
    }

    $delete_modal_name.html(node.name);

    if (node_is_folder(node)) {
        $folder_text.show();
    } else {
        $folder_text.hide();
    }

    $delete_modal.modal("show");
}

function save_delete_modal() {
    var $delete_modal = $("#delete_modal");

    var index = delete_modal_info.parent.children.indexOf(delete_modal_info.node);
    delete_modal_info.parent.children.splice(index, 1);

    ws.send(JSON.stringify({
        name: "set_feeds",
        data: feeds
    }));

    $delete_modal.modal("hide");
}


function show_info_modal(node) {
    var $info_modal = $("#info_modal");

    $("#info_modal_title").html(node._data.title);

    if (node._data.description) {
        $("#info_modal_desc").parent().show();
        $("#info_modal_desc").html(node._data.description);
    } else {
        $("#info_modal_desc").parent().hide();
    }

    $("#info_modal_link").html(node._data.link);
    $("#info_modal_link").attr("href", node._data.link);

    $("#info_modal").modal("show");
}


function show_search_modal(node) {
    var $search_modal = $("#search_modal");
    var $search_modal_query = $("#search_modal_query");

    reset_modal($search_modal);

    search_modal_info = node;

    $search_modal_query.val("");

    $search_modal.modal("show");
    focus_modal($search_modal);
}

function save_search_modal() {
    var $search_modal = $("#search_modal");
    var $search_modal_query = $("#search_modal_query");

    if (!validate_modal($search_modal))
        return;

    get_content(search_modal_info, $search_modal_query.val())

    $search_modal.modal("hide");
}


function set_reloading(node) {
    if (node_is_folder(node)) {
        node.children.forEach(function(child) {
            set_reloading(child);
        });
    } else {
        reloading[node._data.url] = true;
    }
}


function reload_feed(node) {
    /*set_reloading(node);
    retree();*/

    if (node_is_folder(node)) {
        ws.send(JSON.stringify({
            name: "reload",
            data: {
                //hierarchy: get_node_hierarchy(node)
                id: node.id
            }
        }));
    } else if (node._data.url) {
        ws.send(JSON.stringify({
            name: "reload",
            data: {
                url: node._data.url
            }
        }));
    }
}


function get_content(node, search) {
    var query = {};
    var token = null;

    if (search) {
        query.regex = search;
    }

    if (node) {
        query.feed = node.id;
    } else {
        //query.feed = currentnode.id;
        query = lastquery;
        if (currenttoken)
            token = currenttoken;
    }

    if (lasttokenrequest && token && lasttokenrequest.id === token.id)
        return;

    query.token = token;
    query.limit = 20;

    ws.send(JSON.stringify({
        "name": "content",
        "data": query
    }));

    lasttokenrequest = token;
    lastquery = query;
}


function read_item(item) {
    if (!item.our_content.unread) {
        return;
    }

    item.our_content.unread = false;
    ws.send(JSON.stringify({
        name: "set_content",
        data: item.our_content
    }));

    item.classList.remove("unread");
    item.onclick = null;

    unreads.splice(unreads.indexOf(item), 1);
}


function unread_item(item) {
    if (item.our_content.unread) {
        return;
    }

    item.our_content.unread = true;
    ws.send(JSON.stringify({
        name: "set_content",
        data: item.our_content
    }));

    item.classList.add("unread");
    item.onclick = function() {
        read_item(item);
    };

    item.was_seen = true;

    unreads.push(item);
}


function check_scroll(all) {
    var our_unreads = unreads.slice();

    for (var i = 0; i < our_unreads.length; i++) {
        var scroll_status = isScrolledIntoView(our_unreads[i]);

        if (our_unreads[i].last_status !== undefined) {
            if (scroll_status === 2 && our_unreads[i].last_status < 1) {
                read_item(our_unreads[i]);
            }

            /*if (scroll_status === -2 && our_unreads[i].last_status > -1) {
              read_item(our_unreads[i]);
              }*/
        }

        if (scroll_status !== 1)
            our_unreads[i].last_status = scroll_status;

        if (scroll_status <= -1 && !all) {
            // no point in going further
            break;
        }
    }

    if (currenttoken && (($content[0].scrollHeight - $content.height()) - $content.scrollTop()) <= 2000) {
        get_content();
    }
}


function set_state() {
    feeds[0].state = $tree.tree("getState");
    ws.send(JSON.stringify({
        name: "set_feeds",
        data: feeds
    }));
}


function mark_as_read(node, read) {
    var unread;

    if (read) {
        unread = true;
    } else {
        unread = false;
    }

    var hierarchy = get_node_hierarchy(node);
    ws.send(JSON.stringify({
        name: "update_many_content",
        data: {
            hierarchy: hierarchy,
            data: {
                unread: unread
            }
        }
    }));
}


function bind_evts() {
    $content.scroll(function(e) {
        check_scroll();
    });

    $overlay.click(function(e) {
        $overlay.addClass("hidden");
    });

    $("input[type=text]").keydown(function(e) {
        if (e.keyCode == 13) {
            $(this).closest(".modal-content").find(".modal-footer .btn-primary").click();
        }
    });

    $tree.bind("mousedown", function(e) {
        retree_freeze = true;
    });

    $tree.bind("mouseup", function(e) {
        retree_freeze = false;
    });

    $tree.bind("tree.close", set_state);
    $tree.bind("tree.open", set_state);

    $tree.bind("tree.click", function(e) {
        $tree.tree("selectNode", null);
        $tree.tree("selectNode", e.node);
        e.preventDefault();
    });

    $tree.bind("tree.dblclick", function(e) {
        if (node_is_folder(e.node)) {
            $tree.tree("toggle", e.node);
            e.preventDefault();
        } else {
            $tree.tree("selectNode", e.node);
            e.preventDefault();
        }
    });

    $tree.bind("tree.select", function(e) {
        currentnode = e.node;
        get_content(e.node);
        /*ws.send(JSON.stringify({
            "name": "content",
            "data": {
                feed: get_node_hierarchy(e.node),
                token: null,
                limit: 20
            }
        }));*/
    });

    $tree.bind("tree.contextmenu", function(e) {
        var items = []
        if (node_is_folder(e.node)) {
            items = [
                {
                    name: "Reload",
                    onclick: function() {
                        reload_feed(e.node);
                    }
                },
                {
                    separator: true
                },
                {
                    name: "Search",
                    onclick: function() {
                        show_search_modal(e.node);
                    }
                },
                {
                    separator: true
                },
                {
                    name: "Add Feed",
                    onclick: function() {
                        show_edit_modal(e.node);
                    }
                },
                {
                    name: "Add Folder",
                    onclick: function() {
                        show_folder_modal(e.node, true);
                    }
                },
                {
                    separator: true
                },
                {
                    name: "Mark all as read",
                    onclick: function() {
                        mark_as_read(e.node);
                    }
                },
                {
                    name: "Mark all as unread",
                    onclick: function() {
                        mark_as_read(e.node, true);
                    }
                },
                {
                    separator: true
                },
                {
                    name: "Edit Folder",
                    onclick: function() {
                        show_folder_modal(e.node);
                    }
                },
                {
                    separator: true
                },
                {
                    name: "Delete",
                    onclick: function() {
                        show_delete_modal(e.node);
                    }
                }
            ];

            if (node_is_root(e.node)) {
                items.pop();
                items.pop();
                items[items.length - 1].name = "Settings";
            }
        } else {
            items = [
                {
                    name: "Reload",
                    onclick: function() {
                        reload_feed(e.node);
                    }
                },
                {
                    separator: true
                },
                {
                    name: "Search",
                    onclick: function() {
                        show_search_modal(e.node);
                    }
                },
                {
                    separator: true
                },
                {
                    name: "Mark all as read",
                    onclick: function() {
                        mark_as_read(e.node);
                    }
                },
                {
                    name: "Mark all as unread",
                    onclick: function() {
                        mark_as_read(e.node, true);
                    }
                },
                {
                    separator: true
                },
                {
                    name: "Info",
                    onclick: function() {
                        show_info_modal(e.node);
                    }
                },
                {
                    name: "Edit",
                    onclick: function() {
                        show_edit_modal(e.node);
                    }
                },
                {
                    separator: true
                },
                {
                    name: "Delete",
                    onclick: function() {
                        show_delete_modal(e.node);
                    }
                }
            ];
        }

        open_contextmenu(e.click_event.pageX, e.click_event.pageY, items);
    });

    $tree.bind("tree.move", function(e) {
        ws.send(JSON.stringify({
            name: "move",
            data: {
                from: get_node_hierarchy(e.move_info.moved_node),
                to: get_node_hierarchy(e.move_info.target_node)
            }
        }));
        e.preventDefault();
    });
}

function treeme_update_unread(node) {
    if (node_is_root(node, true)) {
        if (node._data.unread) {
            document.title = "(" + node._data.unread + ") " + page_title;
        } else {
            document.title = page_title;
        }
    }

    if (node.element) {
        for (var i = 0; i < node.element.children.length; i++) {
            var child = node.element.children[i];

            if (!child.classList.contains("jqtree-element"))
                continue;

            if (node._data.unread) {
                var unreadel = document.createElement("span");
                unreadel.classList.add("label");
                unreadel.classList.add("label-default");
                unreadel.classList.add("unread-label");

                unreadel.innerHTML = node._data.unread;

                child.appendChild(unreadel);
            } else if (node._data.error) {
                child.classList.add("error");
            }
        }
    }

    node.children.forEach(function(child) {
        treeme_update_unread(child);
    });
}

function treeme(data) {
    if (retree_freeze)
        return true;

    if ($tree.html().length > 0) {
        var oldstate = $tree.tree("getState");
        $tree.tree("loadData", data);
        $tree.tree("setState", oldstate);
    } else {
        $tree.tree({
            data: data,

            closedIcon: '＋',
            openedIcon: '－',

            dragAndDrop: true,
            onCanMoveTo: function(moved_node, target_node, position) {
                if (position === "inside")
                    return node_is_folder(target_node) && target_node != moved_node.parent;
                else
                    return false;
            }
        });

        if (feeds[0].state) {
            $tree.tree("setState", feeds[0].state);
        }
    }

    var treedata = $tree.tree("getTree");
    treeme_update_unread(treedata);
}

// http://stackoverflow.com/a/488073
function isScrolledIntoView(elem)
{
    var docViewTop = $(window).scrollTop();
    var docViewBottom = docViewTop + $(window).height();

    var elemTop = $(elem).position().top;
    var elemBottom = elemTop + $(elem).height();

    if (((elemBottom <= docViewBottom) && (elemTop >= docViewTop)) ||
        ((elemBottom >= docViewBottom) && (elemTop <= docViewTop)))
        return 0;

    if (elemTop >= docViewBottom)
        return -2;

    if (elemBottom <= docViewTop)
        return 2;

    if (elemBottom >= docViewBottom)
        return -1;

    if (elemTop <= docViewTop) {
        return 1;
    }

    return null;
}


function format_timestamp(timestamp) {
    var date = new Date(timestamp);
    var iso = date.toISOString();
    var day = iso.slice(0, 10) + " "
    var time = iso.slice(11, 16);

    var day_millis = 86400000;

    if (Math.floor(Date.now() / day_millis) - Math.floor(timestamp / day_millis) > 0)
        return day + time;
    else
        return time;
}

function rendercontent(content, append) {
    if (!append)
        $content.html("");

    if (currentnode._data.error) {
        var errorel = document.getElementById("content-error");

        if (!errorel) {
            errorel = document.createElement("div");
            errorel.classList.add("error");
            errorel.setAttribute("id", "content-error");
            $content[0].appendChild(errorel);
        }

        errorel.innerHTML = currentnode._data.error;
    }

    if (!append)
        unreads = [];

    for (var i = 0; i < content.length; i++) {
        var itemel = document.createElement("div");
        itemel.classList.add("item");

        itemel.our_content = content[i];

        if (content[i].unread) {
            itemel.classList.add("unread");
            unreads.push(itemel);
        }

        var itemheadingel = document.createElement("div");
        itemheadingel.classList.add("item-heading");

        var itemtitleel = document.createElement("div");
        itemtitleel.classList.add("item-title");

        var itemtitleael = document.createElement("a");
        itemtitleael.href = content[i].link;
        itemtitleael.innerHTML = content[i].title;

        itemtitleel.appendChild(itemtitleael);

        var itemdateel = document.createElement("span");
        itemdateel.classList.add("item-date");
        itemdateel.innerHTML = format_timestamp(content[i].updated_at);

        var itemfeedel = document.createElement("div");
        itemfeedel.classList.add("item-feedname");
        itemfeedel.classList.add("label");
        itemfeedel.classList.add("label-default");
        itemfeedel.innerHTML = urls[content[i].url].name;

        itemheadingel.appendChild(itemtitleel);
        itemheadingel.appendChild(itemdateel);
        itemheadingel.appendChild(itemfeedel);

        var itembodyel = document.createElement("div");
        itembodyel.classList.add("item-body");
        itembodyel.innerHTML = content[i].content

        itemel.appendChild(itemheadingel);
        itemel.appendChild(itembodyel);

        (function() {
            var our_itemel = itemel;

            if (itemel.our_content.unread) {
                itemel.onclick = function() {
                    read_item(our_itemel);
                };
            }

            itemfeedel.onclick = function(e) {
                retree_freeze = true;

                var node = $tree.tree('getNodeById', urls[our_itemel.our_content.url].id);
                $tree.tree('selectNode', node);

                retree_freeze = false;
            };

            itemheadingel.oncontextmenu = function(e) {
                e.preventDefault();

                var items = [{
                    name: "URL",
                    href: our_itemel.our_content.link
                }];

                if (our_itemel.our_content.unread) {
                    items.push({
                        name: "Mark as read",
                        onclick: function() {
                            read_item(our_itemel);
                        }
                    });
                } else {
                    items.push({
                        name: "Mark as unread",
                        onclick: function() {
                            unread_item(our_itemel);
                        }
                    });
                }

                open_contextmenu(e.pageX, e.pageY, items);
            }
        })();

        $content[0].appendChild(itemel);
    }

    if (!append)
        $content.scrollTop(0);

    check_scroll(true);
}

function parse_feeds(feeds, hierarchy) {
    if (!hierarchy) {
        hierarchy = [];
    }

    var ret = [];

    var changed = false;

    for (var i = 0; i < feeds.length; i++) {
        var thisfeed = {};

        thisfeed._data = {};

        for (var x in feeds[i]) {
            if (x === "children") {
                thisfeed._data.is_folder = true;
                thisfeed.children = parse_feeds(feeds[i].children, Array.prototype.concat(hierarchy, feeds[i].name));
            }

            if (x === "name") {
                thisfeed.name = feeds[i].name;
            } else if (x === "id") {
                thisfeed.id = feeds[i].id;
            }

            thisfeed._data[x] = feeds[i][x];
        }

        if (thisfeed.name === "") {
            thisfeed.name = thisfeed._data.url;
        }

        if (!node_is_folder(thisfeed)) {
            thisfeed._data.is_feed = true;
        }

        if (thisfeed._data.url) {
            urls[thisfeed._data.url] = thisfeed;

            if (!node_is_folder(thisfeed)) {
                if (reloading[thisfeed._data.url]) {
                    thisfeed.name = "[R] " + thisfeed.name;
                }
            }
        }

        if (thisfeed.id) {
            ids[thisfeed.id] = thisfeed;
        }

        ret.push(thisfeed);
    }

    return ret;
}

function retree() {
    treeme(parse_feeds(feeds, []));
}

$(function() {
    Split(["#tree-container", "#content-container"], {
        sizes: [25, 75]
    });


    $content = $("#content");
    $tree = $("#tree");
    $overlay = $("#overlay");
    $contextmenu = $("#contextmenu .dropdown-menu");
    bind_evts();

    ws = new WebSocket("ws://" + window.location.host);
    ws.onopen = function(e) {
        ws.send(JSON.stringify({name: "feeds"}));
    };

    ws.onmessage = function(e) {
        var parsed = JSON.parse(e.data);

        if (parsed.name === "feeds") {
            if (feed_freeze)
                return;

            urls = {};
            feeds = parsed.data;
            retree();
        } else if (parsed.name === "content") {
            if (parsed.data.oldtoken) {
                rendercontent(parsed.data.content, true);
            } else {
                rendercontent(parsed.data.content, false);
            }
            currenttoken = parsed.data.token;
            lasttokenrequest = null;
        } else if (parsed.name === "reload") {
            reloading[parsed.data.url] = parsed.data.value;
            retree();
        }
    };
});
