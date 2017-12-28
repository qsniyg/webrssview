# WebRSSview

Web-based RSS/Atom feed viewer.

## Requirements

WebRSSview requires node.js + mongo, and various packages outlined in package.json.
You can install them automatically via:

`npm install`

## Usage

`$ node webrssview.js`

It will serve at `http://localhost:8765`.

Right click any feed or folder (such as `root`) to access the context menu.
Any settings set to folders will cascade down to the feeds they hold (unless modified by a child feed/folder).

Search uses [mongo's text search](https://docs.mongodb.com/manual/text-search/) syntax, which is similar to google's.

## Options

Here is a general description of the options provided:

 * Name - Name of the feed/folder
 * URL (feed only) - URL of the feed
 * Update interval - Period of time between feed updates (in minutes)
 * Thread - Thread name for updating. Each thread can only update one feed at a time, so it's recommended
     to batch together feeds that are on the same website
 * Special indicator - Indicator in the title for when the feed has unread items.
     This will also turn the unread counter red, and provide notifications for new items (if enabled)
