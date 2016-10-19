"use strict";

var $tree;
var $content;
var $overlay;
var $contextmenu;
var ws;
var edit_modal_info;
var folder_modal_info;
var delete_modal_info;
var feeds;

var urls = {};
var reloading = {};

var unreads = [];
var unread_count = {};

function node_is_folder(node) {
    return ("_data" in node) && node._data.is_folder;
}

function node_is_root(node) {
    return !node.parent || !node.parent.parent;
}

function get_node_hierarchy(node) {
    var ret = [node.name];

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

function open_contextmenu(x, y, items) {
    $contextmenu.css({
        left: x,
        top: y
    });

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
}

function reset_modal(modal) {
    modal.find("[data-required=true]").each(function(i, item) {
        var $item = $(item);
        $item.parent().removeClass("has-error");
    });
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

    edit_modal_info = get_feed_from_node(node);
    if (!edit_modal_info) {
        console.log("can't find info for node");
        console.log(node);
        return;
    }

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
}

function save_edit_modal() {
    var $edit_modal = $("#edit_modal");
    var $edit_modal_name = $("#edit_modal_name");
    var $edit_modal_url = $("#edit_modal_url");
    var $edit_modal_reload = $("#edit_modal_reload");

    if (!validate_modal($edit_modal)) {
        return;
    }

    var our_node = edit_modal_info;

    var reload_val;

    if ($edit_modal_reload.val() === "") {
        reload_val = null;
    } else {
        reload_val = parseFloat($edit_modal_reload.val());
    }

    if (edit_modal_info.children) {
        edit_modal_info.children.push({
            name: $edit_modal_name.val(),
            url: $edit_modal_url.val(),
            reload_mins: reload_val
        });
        our_node = edit_modal_info.children[edit_modal_info.children.length - 1];
    } else {
        edit_modal_info.name = $edit_modal_name.val();
        edit_modal_info.url = $edit_modal_url.val();
        edit_modal_info.reload_mins = reload_val;
    }

    ws.send(JSON.stringify({
        name: "set_feeds",
        data: feeds
    }));

    our_node._data = {};
    our_node._data.url = our_node.url;
    reload_feed(our_node);

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
        node: get_feed_from_node(node),
        add: add
    };

    if (!folder_modal_info.node) {
        console.log("can't find info for folder node");
        console.log(node);
        return;
    }

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
}

function save_folder_modal() {
    var $folder_modal = $("#folder_modal");
    var $folder_modal_name = $("#folder_modal_name");
    var $folder_modal_reload = $("#folder_modal_reload");

    if (!validate_modal($folder_modal)) {
        return;
    }

    var reload_val;

    if ($folder_modal_reload.val() === "") {
        reload_val = null;
    } else {
        reload_val = parseFloat($folder_modal_reload.val());
    }

    if (folder_modal_info.add) {
        folder_modal_info.node.children.push({
            name: $folder_modal_name.val(),
            children: []
        });
    } else {
        folder_modal_info.node.name = $folder_modal_name.val();
        folder_modal_info.node.reload_mins = reload_val;
    }

    ws.send(JSON.stringify({
        name: "set_feeds",
        data: feeds
    }));

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
                hierarchy: get_node_hierarchy(node)
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


function check_scroll() {
    for (var i = 0; i < unreads.length; i++) {
        var scroll_status = isScrolledIntoView(unreads[i]);

        if (scroll_status === 0) {
            unreads[i].was_seen = true;
            continue;
        }

        if (scroll_status != null && unreads[i].was_seen) {
            read_item(unreads[i]);
        }

        if (scroll_status === -1) {
            // no point in going further
            break;
        }
    };
}


function set_state() {
    feeds[0].state = $tree.tree("getState");
    ws.send(JSON.stringify({
        name: "set_feeds",
        data: feeds
    }));
}


function bind_evts() {
    $content.scroll(function(e) {
        check_scroll();
    });

    $overlay.click(function(e) {
        $overlay.addClass("hidden");
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
        ws.send(JSON.stringify({
            "name": "content",
            "data": get_node_hierarchy(e.node)
        }));
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
    if (node.element && node._data.unread) {
        for (var i = 0; i < node.element.children.length; i++) {
            var child = node.element.children[i];

            if (!child.classList.contains("jqtree-element"))
                continue;

            var unreadel = document.createElement("span");
            unreadel.classList.add("label");
            unreadel.classList.add("label-default");
            unreadel.classList.add("unread-label");

            unreadel.innerHTML = node._data.unread;

            child.appendChild(unreadel);
        }
    }

    node.children.forEach(function(child) {
        treeme_update_unread(child);
    });
}

function treeme(data) {
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

    if (elemTop >= docViewBottom)
        return -1;

    if (((elemBottom <= docViewBottom) && (elemTop >= docViewTop)) ||
        ((elemBottom >= docViewBottom) && (elemTop <= docViewTop)))
        return 0;

    if (elemBottom <= docViewTop) {
        return 1;
    }

    return null;
}


function format_timestamp(timestamp) {
    var date = new Date(timestamp);
    var iso = date.toISOString();
    var day = iso.slice(0, 10) + " "
    var time = iso.slice(11, 16);

    if ((Date.now() - timestamp) > 86400000)
        return day + time;
    else
        return time;
}

function rendercontent(content, from, to) {
    if (arguments.length < 3) {
        to = content.length;

        if (arguments.length < 2) {
            from = 0;
        }
    }

    $content.html("");

    unreads = [];

    for (var i = from; i < to; i++) {
        var itemel = document.createElement("div");
        itemel.classList.add("item");

        itemel.our_content = content[i];

        (function() {
            var our_itemel = itemel;

            if (itemel.our_content.unread) {
                itemel.onclick = function() {
                    read_item(our_itemel);
                };
            }

            itemel.oncontextmenu = function(e) {
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

        $content[0].appendChild(itemel);
    }

    $content.scrollTop(0);

    check_scroll();
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
            } else {
                thisfeed._data[x] = feeds[i][x];
            }
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
            urls = {};
            feeds = parsed.data;
            retree();
        } else if (parsed.name === "content") {
            rendercontent(parsed.data);
        } else if (parsed.name === "reload") {
            reloading[parsed.data.url] = parsed.data.value;
            retree();
        }
    };
});
