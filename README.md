# Video Downloader

A bookmarklet that finds the videos and images on the page you're viewing and lets you save them
with your browser's own download manager. It works in Aloha, Safari and Chrome on iPhone, and in desktop browsers.

- `downloader.js`: the panel the bookmarklet loads. Site adapters:
  - **filester.me folders** (`/f/<id>`): lists every file (and can load every page of a long folder),
    opens each file's page, and fetches the folder ZIP through the site's own download API.
  - **Any other page**: `<video>`/`<source>`, links to media files, large images, tagged gallery items,
    and media URLs the page has already loaded. HLS/DASH streams are listed but not downloaded yet.
- `test-folder/`: generated test media (test patterns, colour bars, fractals) with real download links and a ZIP.
- `install/`: bookmarklet install steps for iPhone and desktop.

## Hosting (GitHub Pages)

Repo **Settings → Pages → Build and deployment**: Source *Deploy from a branch*, pick this branch and `/ (root)`.
The site then lives at `https://<user>.github.io/Video-downloaded-/`.
