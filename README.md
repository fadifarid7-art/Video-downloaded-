# Video Downloader

A bookmarklet that finds the videos and images on the page you're viewing and lets you save them
with your browser's own download manager. It works in Aloha, Safari and Chrome on iPhone, and in desktop browsers.

## How to use

1. Open `install/` and copy the bookmarklet code.
2. Add any bookmark, edit it, rename it **Downloader**, and paste the code in place of its address.
3. On a page with videos or images, open your bookmarks and tap **Downloader**.
4. In the panel, filter by Videos or Images and tap **Download**. Your browser asks where to save.
   On folder pages, use **Load all pages** first, or **Download folder as ZIP** to get everything at once.
5. Tap the bookmark again to close the panel.

Try it first on `test-folder/`, which holds generated test media.

## Files

- `downloader.js`: the panel the bookmarklet loads.
- `test-folder/`: test media with real download links and a ZIP.
- `install/`: install steps for iPhone and desktop.

## Hosting (GitHub Pages)

Repo **Settings → Pages → Build and deployment**: Source *Deploy from a branch*, pick this branch and `/ (root)`.
