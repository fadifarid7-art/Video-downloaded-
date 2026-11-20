/*
 * Video & Image Downloader — bookmarklet payload.
 *
 * Tap the bookmarklet on any page: a panel slides up listing the videos and
 * images found on that page. Every "Download" is a real link, so the browser's
 * own download manager handles it (Aloha / Safari on iPhone show their
 * save-location prompt; desktop browsers save to Downloads).
 *
 * Page adapters:
 *   - File-host folder pages: reads the folder listing, can load every page
 *     of a paginated folder, and offers the folder ZIP download.
 *   - Generic: <video>/<source>, links to media files, large <img>, elements
 *     with data-url/data-src, and media URLs the page has already loaded.
 *
 * Tapping the bookmarklet again closes the panel.
 */
(function () {
  "use strict";
  var HOST_ID = "vdl-downloader-host";
  var existing = document.getElementById(HOST_ID);
  if (existing) { existing.remove(); return; }

  var VIDEO_EXT = ["mp4", "webm", "mov", "m4v", "mkv", "avi", "wmv", "flv"];
  var IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "avif"];
  var STREAM_EXT = ["m3u8", "mpd"];

  // ---------- helpers ----------
  function extOf(str) {
    if (!str) return "";
    var clean = String(str).split(/[?#]/)[0];
    var m = clean.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : "";
  }
  function kindOf(nameOrUrl) {
    var e = extOf(nameOrUrl);
    if (VIDEO_EXT.indexOf(e) >= 0) return "videos";
    if (IMAGE_EXT.indexOf(e) >= 0) return "images";
    if (STREAM_EXT.indexOf(e) >= 0) return "streams";
    return "";
  }
  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return ""; } }
  function nameFromUrl(u) {
    try {
      var p = new URL(u).pathname.split("/").filter(Boolean).pop() || "file";
      return decodeURIComponent(p);
    } catch (e) { return "file"; }
  }
  function fmtSize(b) {
    b = +b;
    if (!b) return "";
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
    return (b / 1073741824).toFixed(2) + " GB";
  }

  // ---------- adapters ----------
  var folderHost = {
    name: "folder",
    match: function () {
      // Recognised by page layout: a folder grid whose items open /d/<id> file pages.
      if (!/^\/f\//.test(location.pathname)) return false;
      var first = document.querySelector("#filesGrid .file-item[onclick]");
      return !!(first && /\/d\//.test(first.getAttribute("onclick") || ""));
    },
    folderId: function () {
      if (typeof window.folderIdentifier === "string" && window.folderIdentifier) return window.folderIdentifier;
      var m = location.pathname.match(/^\/f\/([^/?#]+)/);
      return m ? m[1] : "";
    },
    readItems: function (root) {
      var out = [];
      root.querySelectorAll("#filesGrid .file-item, .file-item[data-name]").forEach(function (el) {
        var oc = el.getAttribute("onclick") || "";
        var m = oc.match(/\/d\/([A-Za-z0-9_-]+)/);
        if (!m) return;
        var name = el.getAttribute("data-name") || "";
        var type = el.getAttribute("data-type") || kindOf(name) || "other";
        var img = el.querySelector("img");
        out.push({
          id: m[1],
          name: name || m[1],
          type: type,
          size: el.getAttribute("data-size") || "",
          url: location.origin + "/d/" + m[1],
          thumb: img ? abs(img.getAttribute("src")) : "",
          via: "token", // download link fetched the same way the file page's own button does it
        });
      });
      return out;
    },
    scan: function () { return Promise.resolve(this.readItems(document)); },
    totalPages: function () {
      var b = document.getElementById("loadAllPagesBtn");
      return b ? parseInt(b.getAttribute("data-total"), 10) || 1 : 1;
    },
    loadAllPages: function (onProgress) {
      var self = this, total = this.totalPages(), base = location.origin + location.pathname;
      var all = [], page = 2;
      function next() {
        if (page > total) return Promise.resolve(all);
        onProgress && onProgress(page, total);
        return fetch(base + "?page=" + page, { credentials: "same-origin" })
          .then(function (r) { return r.text(); })
          .then(function (html) {
            var doc = new DOMParser().parseFromString(html, "text/html");
            all = all.concat(self.readItems(doc));
            page++;
            return new Promise(function (r) { setTimeout(r, 250); }).then(next);
          });
      }
      return next();
    },
    // Same steps as the file page's Download button: ask for a one-time token,
    // then open the file server link marked as a download.
    downloadUrl: function (item) {
      return fetch(location.origin + "/v2/api/public/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ file_slug: item.id }),
      })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (t) {
          if (!t || !t.token || !t.file || !t.server) throw new Error("no download link returned");
          return t.server + "/v2/" + t.file + "?token=" + encodeURIComponent(t.token) +
            "&download=true" + (t.name ? "&n=" + encodeURIComponent(t.name) : "");
        });
    },
    zip: function () {
      var id = this.folderId();
      return fetch("/api/folder/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ identifier: id }),
      })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          var d = res.d || {};
          if (res.ok && d.success && d.data && d.data.download_url) return d.data.download_url;
          throw new Error(d.message || "The site didn't return a ZIP link.");
        });
    },
  };

  // A single file page (/d/<id>) with its own Download button: same token route.
  var filePage = {
    name: "file",
    match: function () {
      return /^\/d\/[A-Za-z0-9_-]+\/?$/.test(location.pathname) && !!document.getElementById("downloadButton");
    },
    scan: function () {
      var id = location.pathname.split("/").filter(Boolean).pop();
      var name = (typeof window.fileName === "string" && window.fileName) || document.title.split("|")[0].trim() || id;
      var mime = typeof window.fileType === "string" ? window.fileType : "";
      var type = /^video\//.test(mime) ? "videos" : /^image\//.test(mime) ? "images" : (kindOf(name) || "other");
      return Promise.resolve([{ id: id, name: name, type: type, size: "", url: location.href, thumb: "", via: "token" }]);
    },
    downloadUrl: function (item) { return folderHost.downloadUrl(item); },
    totalPages: function () { return 1; },
  };

  var generic = {
    name: "generic",
    match: function () { return true; },
    scan: function () {
      var seen = {}, out = [];
      function add(url, opts) {
        url = abs(url);
        if (!url || /^(blob|data|javascript):/i.test(url) || seen[url]) return;
        var type = (opts && opts.type) || kindOf((opts && opts.name) || url);
        if (!type) return;
        seen[url] = 1;
        out.push({
          id: url,
          name: (opts && opts.name) || nameFromUrl(url),
          type: type,
          size: (opts && opts.size) || "",
          url: url,
          thumb: (opts && opts.thumb) || (type === "images" ? url : ""),
          via: "direct",
        });
      }
      // 1. Explicit listings (file hosts / galleries that tag their items)
      document.querySelectorAll("[data-url],[data-src][data-name]").forEach(function (el) {
        var u = el.getAttribute("data-url") || el.getAttribute("data-src");
        var t = el.getAttribute("data-type");
        add(u, {
          name: el.getAttribute("data-name") || "",
          type: t === "videos" || t === "images" ? t : "",
          size: el.getAttribute("data-size") || "",
          thumb: abs(el.getAttribute("data-thumb") || ""),
        });
      });
      // 2. Video elements
      document.querySelectorAll("video").forEach(function (v) {
        var poster = v.getAttribute("poster") ? abs(v.getAttribute("poster")) : "";
        [v.currentSrc, v.getAttribute("src")].forEach(function (u) { if (u) add(u, { type: kindOf(u) === "streams" ? "streams" : "videos", thumb: poster }); });
        v.querySelectorAll("source[src]").forEach(function (s) { add(s.getAttribute("src"), { type: kindOf(s.getAttribute("src")) || "videos", thumb: poster }); });
      });
      // 3. Links straight to media files
      document.querySelectorAll("a[href]").forEach(function (a) { add(a.getAttribute("href")); });
      // 4. Big images
      document.querySelectorAll("img").forEach(function (img) {
        var u = img.currentSrc || img.src;
        if ((img.naturalWidth || 0) >= 400 || (img.naturalHeight || 0) >= 400) add(u, { type: "images" });
      });
      // 5. Media the page already fetched over the network (catches players that hide the URL)
      try {
        performance.getEntriesByType("resource").forEach(function (r) {
          var k = kindOf(r.name);
          if (k === "videos" || k === "streams") add(r.name, { type: k });
        });
      } catch (e) {}
      return Promise.resolve(out);
    },
    zipUrl: function () {
      var el = document.querySelector("[data-zip-url]");
      return el ? abs(el.getAttribute("data-zip-url")) : "";
    },
  };

  var adapter = folderHost.match() ? folderHost : filePage.match() ? filePage : generic;

  // ---------- UI (shadow DOM keeps the site's CSS out) ----------
  var host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;";
  var shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  shadow.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}" +
    ".sheet{--bg:#151b24;--card:#1e2633;--line:#2c3646;--fg:#eef2f7;--muted:#9aa6b8;--accent:#5b8cff;--vid:#b48cff;--img:#4fd1b5;--warn:#fbbf24;--err:#fb923c;--ok:#4ade80;" +
    "background:var(--bg);color:var(--fg);border-radius:16px 16px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.45);max-height:72vh;display:flex;flex-direction:column;font-size:15px;line-height:1.4;" +
    "padding-bottom:env(safe-area-inset-bottom,0px)}" +
    ".head{display:flex;align-items:center;gap:10px;padding:12px 14px 8px}" +
    ".title{font-weight:600;font-size:16px;flex:1;min-width:0}" +
    ".title small{display:block;font-weight:400;font-size:13px;color:var(--muted)}" +
    ".x{background:var(--card);color:var(--fg);border:0;border-radius:50%;width:34px;height:34px;font-size:18px;cursor:pointer}" +
    ".bar{display:flex;gap:6px;flex-wrap:wrap;padding:0 14px 10px}" +
    ".chip{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:14px;cursor:pointer}" +
    ".chip[aria-pressed=true]{background:var(--fg);color:var(--bg);border-color:var(--fg)}" +
    ".act{background:var(--accent);color:#0b1220;border:0;border-radius:10px;padding:10px 14px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}" +
    ".act.ghost{background:var(--card);color:var(--fg);border:1px solid var(--line);font-weight:500}" +
    ".act:disabled{opacity:.5}" +
    ".tools{display:flex;gap:8px;flex-wrap:wrap;padding:0 14px 10px}" +
    ".head,.bar,.tools,.status{flex:none}" +
    ".status{padding:0 14px 8px;font-size:13px;color:var(--muted);min-height:1em}" +
    ".status.warn{color:var(--warn)}.status.err{color:var(--err)}.status.ok{color:var(--ok)}" +
    ".list{overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 14px 14px;display:flex;flex-direction:column;gap:8px}" +
    ".row{display:flex;gap:10px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px}" +
    ".th{width:56px;height:56px;border-radius:6px;background:#0b0f16;flex:none;overflow:hidden;display:grid;place-items:center;color:var(--muted);font-size:11px}" +
    ".th img{width:100%;height:100%;object-fit:cover;display:block}" +
    ".meta{flex:1;min-width:0}" +
    ".nm{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".sub{font-size:12px;color:var(--muted);display:flex;gap:8px;align-items:center}" +
    ".tag{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;padding:1px 5px;border-radius:4px;color:#0b1220;font-weight:600}" +
    ".tag.videos{background:var(--vid)}.tag.images{background:var(--img)}.tag.streams,.tag.other{background:var(--muted)}" +
    ".dl{background:var(--accent);color:#0b1220;text-decoration:none;font-weight:600;font-size:14px;padding:8px 12px;border-radius:8px;flex:none}" +
    ".dl.off{background:var(--line);color:var(--muted)}" +
    ".dl.ready{background:var(--ok)}" +
    ".row.pick{cursor:pointer}.row.sel{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}" +
    ".th{position:relative}.ck{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;border:2px solid #fff;background:rgba(0,0,0,.35);color:#0b1220;font-size:12px;font-weight:700;display:grid;place-items:center}" +
    ".row.sel .ck{background:var(--accent);border-color:var(--accent)}" +
    ".empty{color:var(--muted);padding:6px 2px 10px;font-size:14px}" +
    "</style>" +
    '<div class="sheet" role="dialog" aria-label="Downloader">' +
    '<div class="head"><div class="title" id="t">Downloader<small id="sum">Scanning…</small></div><button class="x" id="x" aria-label="Close">×</button></div>' +
    '<div class="bar" id="chips"></div>' +
    '<div class="tools" id="tools"></div>' +
    '<div class="status" id="st"></div>' +
    '<div class="list" id="list"></div>' +
    "</div>";
  document.documentElement.appendChild(host);

  var $ = function (id) { return shadow.getElementById ? shadow.getElementById(id) : shadow.querySelector("#" + id); };
  $("x").addEventListener("click", function () { host.remove(); });

  var items = [];
  var filter = "all";
  var selected = {};   // id -> true
  var fileCache = {};  // id -> File, loaded and ready to hand over
  var batchBusy = false;
  var queuePos = 0;    // next file for "one by one" downloads

  function status(text, kind) { var s = $("st"); s.textContent = text || ""; s.className = "status" + (kind ? " " + kind : ""); }

  function counts() {
    var c = { all: items.length, videos: 0, images: 0, streams: 0, other: 0 };
    items.forEach(function (i) { c[i.type] = (c[i.type] || 0) + 1; });
    return c;
  }

  function renderChips() {
    var c = counts(), chips = $("chips");
    chips.textContent = "";
    [["all", "All"], ["videos", "Videos"], ["images", "Images"], ["streams", "Streams"], ["other", "Other"]].forEach(function (p) {
      if (p[0] !== "all" && !c[p[0]]) return;
      var b = document.createElement("button");
      b.className = "chip";
      b.setAttribute("aria-pressed", String(filter === p[0]));
      b.textContent = p[1] + " " + (c[p[0]] || 0);
      b.addEventListener("click", function () { filter = p[0]; render(); });
      chips.appendChild(b);
    });
    var parts = [];
    if (c.videos) parts.push(c.videos + " video" + (c.videos > 1 ? "s" : ""));
    if (c.images) parts.push(c.images + " image" + (c.images > 1 ? "s" : ""));
    if (c.streams) parts.push(c.streams + " stream" + (c.streams > 1 ? "s" : ""));
    $("sum").textContent = parts.length ? "Found " + parts.join(", ") : "Nothing found on this page yet";
  }

  function renderList() {
    var list = $("list");
    list.textContent = "";
    var shown = items.filter(function (i) { return filter === "all" || i.type === filter; });
    if (!shown.length) {
      var e = document.createElement("div");
      e.className = "empty";
      e.textContent = items.length ? "Nothing in this filter." : "No videos or images found. If a video hasn't started yet, play it for a second and tap the bookmarklet again.";
      list.appendChild(e);
      return;
    }
    shown.forEach(function (i) {
      var row = document.createElement("div"); row.className = "row";
      var th = document.createElement("div"); th.className = "th";
      if (i.thumb) { var im = document.createElement("img"); im.src = i.thumb; im.alt = ""; im.loading = "lazy"; th.appendChild(im); }
      else th.textContent = i.type === "videos" ? "VIDEO" : i.type === "streams" ? "STREAM" : "FILE";
      var meta = document.createElement("div"); meta.className = "meta";
      var nm = document.createElement("div"); nm.className = "nm"; nm.textContent = i.name;
      var sub = document.createElement("div"); sub.className = "sub";
      var tag = document.createElement("span"); tag.className = "tag " + i.type; tag.textContent = i.type === "videos" ? "video" : i.type === "images" ? "image" : i.type === "streams" ? "stream" : "file";
      sub.appendChild(tag);
      if (i.size) { var sz = document.createElement("span"); sz.textContent = fmtSize(i.size); sub.appendChild(sz); }
      meta.appendChild(nm); meta.appendChild(sub);
      var a = document.createElement("a");
      a.className = "dl";
      if (i.type === "streams") {
        a.className = "dl off"; a.textContent = "Stream"; a.href = i.url; a.target = "_blank"; a.rel = "noopener";
        a.title = "Streaming playlist: needs a converter, not a plain download";
      } else if (i.via === "token") {
        a.textContent = "Download"; a.href = i.url; // file page stays as the long-press fallback
        a.addEventListener("click", function (e) { e.preventDefault(); tokenDownload(i, a); });
      } else {
        a.textContent = "Download"; a.href = i.url; a.setAttribute("download", i.name);
        a.addEventListener("click", function (e) { e.preventDefault(); saveDirect(i, a); });
      }
      if (i.via === "direct" && i.type !== "streams") {
        var ck = document.createElement("span"); ck.className = "ck"; ck.textContent = selected[i.id] ? "✓" : "";
        th.appendChild(ck);
        row.classList.add("pick");
        if (selected[i.id]) row.classList.add("sel");
        var toggle = function () { if (batchBusy) return; if (selected[i.id]) delete selected[i.id]; else selected[i.id] = true; render(); };
        th.addEventListener("click", toggle); meta.addEventListener("click", toggle);
      }
      row.appendChild(th); row.appendChild(meta); row.appendChild(a);
      list.appendChild(row);
    });
  }

  function renderTools() {
    var tools = $("tools");
    tools.textContent = "";
    function btn(label, ghost, fn) {
      var b = document.createElement("button");
      b.className = "act" + (ghost ? " ghost" : "");
      b.textContent = label;
      b.addEventListener("click", function () { fn(b); });
      tools.appendChild(b);
      return b;
    }
    if (adapter === folderHost) {
      btn("Download folder as ZIP", false, function (b) {
        b.disabled = true; status("Getting the ZIP link…");
        adapter.zip().then(function (url) {
          status("ZIP ready. Your browser will ask where to save it.", "ok");
          location.href = url;
        }).catch(function (e) { status("ZIP failed: " + e.message, "err"); }).then(function () { b.disabled = false; });
      });
      var queue = items.filter(function (i) { return i.via === "token" && (filter === "all" || i.type === filter); });
      if (queue.length) {
        if (queuePos >= queue.length) queuePos = 0;
        var qb = btn(queuePos === 0 ? "Download all " + queue.length + ", one by one" : "Next: " + (queuePos + 1) + " of " + queue.length, false, function (b) {
          var item = queue[queuePos];
          tokenDownload(item, b, function () {
            queuePos++;
            if (queuePos >= queue.length) { queuePos = 0; status("Started all " + queue.length + " downloads.", "ok"); }
            renderTools();
          });
        });
        if (queuePos > 0) btn("Restart", true, function () { queuePos = 0; renderTools(); });
      }
      if (adapter.totalPages() > 1 && !adapter._allLoaded) {
        btn("Load all " + adapter.totalPages() + " pages", true, function (b) {
          b.disabled = true;
          adapter.loadAllPages(function (p, t) { status("Loading page " + p + " of " + t + "…"); }).then(function (more) {
            var seen = {}; items.forEach(function (i) { seen[i.id] = 1; });
            more.forEach(function (i) { if (!seen[i.id]) { items.push(i); seen[i.id] = 1; } });
            adapter._allLoaded = true;
            status("Loaded every page: " + items.length + " files.", "ok");
            render();
          }).catch(function () { status("Couldn't load the other pages. Try again.", "err"); b.disabled = false; });
        });
      }
    } else if (generic.zipUrl()) {
      var a = document.createElement("a");
      a.className = "act"; a.textContent = "Download all as ZIP"; a.href = generic.zipUrl(); a.setAttribute("download", "");
      tools.appendChild(a);
    }
    var pickable = items.filter(function (i) { return i.via === "direct" && i.type !== "streams" && (filter === "all" || i.type === filter); });
    if (pickable.length) {
      var sel = selectedItems();
      var ready = sel.length && sel.every(function (i) { return fileCache[i.id]; });
      var label = !sel.length ? "Save selected" : ready ? "Save " + sel.length + " file" + (sel.length > 1 ? "s" : "") + " now" : "Save selected (" + sel.length + ")";
      var sb = btn(label, false, function (b) { saveSelected(b); });
      sb.disabled = !sel.length || batchBusy;
      if (ready) sb.style.background = "var(--ok)";
      var allOn = pickable.every(function (i) { return selected[i.id]; });
      btn(allOn ? "Clear selection" : "Select all " + pickable.length, true, function () {
        if (batchBusy) return;
        pickable.forEach(function (i) { if (allOn) delete selected[i.id]; else selected[i.id] = true; });
        render();
      });
    }
    btn("Copy links", true, function (b) {
      var shown = items.filter(function (i) { return filter === "all" || i.type === filter; }).map(function (i) { return i.url; });
      if (!shown.length) return;
      var text = shown.join("\n");
      var done = function () { b.textContent = "Copied " + shown.length; setTimeout(function () { b.textContent = "Copy links"; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
      else { fallbackCopy(text); done(); }
    });
    btn("Rescan", true, function () { scan(); });
  }

  // Save the actual file: load it in the background, then hand it over marked
  // "save, don't play" so iPhone browsers download it instead of opening a player.
  // If the site blocks background loading, fall back to opening the link normally.
  var MIME = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", avif: "image/avif" };
  function canShareFiles() {
    try {
      return !!(navigator.share && navigator.canShare &&
        navigator.canShare({ files: [new File(["x"], "t.jpg", { type: "image/jpeg" })] }));
    } catch (e) { return false; }
  }
  var USE_SHARE = canShareFiles();

  // iPhone route: load the file, turn the button into "Save", and open the
  // share sheet on that second tap (iOS only opens it straight from a tap).
  // The share sheet offers Save to Files (pick any folder) and Save Video/Image.
  function shareFlow(i, a) {
    if (a._file) {
      var f = a._file;
      navigator.share({ files: [f] }).then(function () {
        status("Saved " + i.name + ".", "ok");
      }).catch(function (e) {
        if (e && e.name === "AbortError") status("Cancelled. Tap Save to try again.");
        else status("The share sheet didn't open (" + (e && e.message || "unknown") + "). Try again.", "err");
      });
      return;
    }
    if (a.getAttribute("aria-busy") === "true") return;
    a.setAttribute("aria-busy", "true");
    a.textContent = "Loading…";
    status("Loading " + i.name + "…");
    fetch(i.url, { credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
      .then(function (b) {
        var type = MIME[extOf(i.name)] || b.type || "application/octet-stream";
        var f = new File([b], i.name, { type: type });
        if (!navigator.canShare({ files: [f] })) throw new Error("not shareable");
        a._file = f; fileCache[i.id] = f;
        a.textContent = "Save";
        a.classList.add("ready");
        status(i.name + " is ready (" + fmtSize(b.size) + "). Tap Save, then choose Save to Files or Save Video.", "ok");
      })
      .catch(function () {
        a.textContent = "Download";
        status("Couldn't load " + i.name + " here. The site may block background loading.", "warn");
      })
      .then(function () { a.removeAttribute("aria-busy"); });
  }

  function tokenDownload(i, a, after) {
    if (a.getAttribute("aria-busy") === "true") return;
    a.setAttribute("aria-busy", "true");
    var label = a.textContent;
    a.textContent = "Getting link…";
    status("Getting the download link for " + i.name + "…");
    adapter.downloadUrl(i).then(function (url) {
      status("Downloading " + i.name + ". Pick where to save it in your browser's menu.", "ok");
      location.href = url;
      after && after();
    }).catch(function (e) {
      if (adapter === filePage) { status("Couldn't get a download link (" + e.message + "). Use the page's own Download button.", "warn"); return; }
      status("Couldn't get a download link for " + i.name + " (" + e.message + "). Opening its file page instead.", "warn");
      location.href = i.url;
    }).then(function () { a.textContent = label; a.removeAttribute("aria-busy"); });
  }

  function selectedItems() { return items.filter(function (i) { return selected[i.id]; }); }

  function loadFile(i) {
    if (fileCache[i.id]) return Promise.resolve(fileCache[i.id]);
    return fetch(i.url, { credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
      .then(function (b) {
        var f = new File([b], i.name, { type: MIME[extOf(i.name)] || b.type || "application/octet-stream" });
        fileCache[i.id] = f;
        return f;
      });
  }

  // Several files, one share sheet: first tap loads them, second tap hands them all over.
  function saveSelected(b) {
    var sel = selectedItems();
    if (!sel.length || batchBusy) return;
    var ready = sel.every(function (i) { return fileCache[i.id]; });
    if (ready && USE_SHARE) {
      var files = sel.map(function (i) { return fileCache[i.id]; });
      if (!navigator.canShare({ files: files })) { status("Your phone won't take these files together. Select fewer and try again.", "err"); return; }
      navigator.share({ files: files }).then(function () {
        status("Saved " + files.length + " file" + (files.length > 1 ? "s" : "") + ".", "ok");
        selected = {}; render();
      }).catch(function (e) {
        if (e && e.name === "AbortError") status("Cancelled. Tap the green button to try again.");
        else status("The share sheet didn't open (" + (e && e.message || "unknown") + "). Select fewer files and try again.", "err");
      });
      return;
    }
    batchBusy = true; render();
    var done = 0, total = sel.length, bytes = 0, failed = [];
    var chain = Promise.resolve();
    sel.forEach(function (i) {
      chain = chain.then(function () {
        status("Loading " + (done + 1) + " of " + total + ": " + i.name + "…");
        return loadFile(i).then(function (f) { bytes += f.size; }, function () { failed.push(i.name); delete selected[i.id]; })
          .then(function () { done++; });
      });
    });
    chain.then(function () {
      batchBusy = false;
      var ok = total - failed.length;
      if (!USE_SHARE) {
        selectedItems().forEach(function (i, n) {
          setTimeout(function () {
            var url = URL.createObjectURL(fileCache[i.id]);
            var link = document.createElement("a"); link.href = url; link.download = i.name;
            document.body.appendChild(link); link.click(); link.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
          }, n * 400);
        });
        status("Sent " + ok + " file" + (ok === 1 ? "" : "s") + " (" + fmtSize(bytes) + ") to your downloads." + (failed.length ? " Couldn't load: " + failed.join(", ") : ""), failed.length ? "warn" : "ok");
        selected = {}; render();
        return;
      }
      render();
      var warn = bytes > 500 * 1048576 ? " That's a lot for a phone; if saving fails, save fewer at a time." : "";
      status((ok ? ok + " file" + (ok === 1 ? "" : "s") + " ready (" + fmtSize(bytes) + "). Tap the green button, then Save to Files." : "Nothing could be loaded.") +
        (failed.length ? " Couldn't load: " + failed.join(", ") + "." : "") + warn, ok ? (failed.length || warn ? "warn" : "ok") : "err");
    });
  }

  function saveDirect(i, a) {
    if (USE_SHARE) return shareFlow(i, a);
    if (a.getAttribute("aria-busy") === "true") return;
    a.setAttribute("aria-busy", "true");
    var label = a.textContent;
    a.textContent = "Loading…";
    status("Loading " + i.name + "…");
    fetch(i.url, { credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
      .then(function (b) {
        var url = URL.createObjectURL(new Blob([b], { type: "application/octet-stream" }));
        var link = document.createElement("a");
        link.href = url; link.download = i.name;
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        status("Sent " + i.name + " (" + fmtSize(b.size) + ") to your browser's downloads.", "ok");
      })
      .catch(function () {
        status("This site blocks background loading, so the file opened directly. If it plays instead of saving, long-press Download and choose the download option.", "warn");
        location.href = i.url;
      })
      .then(function () { a.textContent = label; a.removeAttribute("aria-busy"); });
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    ta.remove();
  }

  function render() { renderChips(); renderTools(); renderList(); }

  function scan() {
    status("");
    adapter.scan().then(function (found) {
      items = found;
      render();
      if (adapter === filePage) status("Tap Download to save this file.");
      else if (adapter === folderHost) status("Tap Download on a file, or Download all to go through them one at a time.");
      else if (items.length) status(USE_SHARE ? "Tap Download, then Save. Choose Save to Files to pick a folder." : "Tap Download. Your browser asks where to save.");
    }).catch(function (e) { status("Scan failed: " + e.message, "err"); });
  }

  scan();
})();
