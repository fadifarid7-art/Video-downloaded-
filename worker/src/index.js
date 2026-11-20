/*
 * Video Downloader helper (Cloudflare Worker).
 *
 *   GET /                  the page (public/index.html, built into the Worker)
 *   GET /api/scan?url=…    read a page and list the videos and images on it
 *       &all=1             on folder pages, also read every further page
 *   GET /api/file?…        stream one file back marked as a download
 *       url=…&name=…&ref=… a direct file link
 *       page=…&slug=…      a file page with a token download button
 *
 *   GET /dl/<signed>/<name> download one file found by a scan. These links are
 *                          signed with SIGNING_KEY and expire, so they work in
 *                          a browser's download manager (which has no login
 *                          cookie) without opening the helper to anyone else.
 *
 * The API only answers requests that carry a valid Cloudflare Access login
 * (set ACCESS_TEAM and ACCESS_AUD). Without them it refuses to work, so the
 * helper can never be used by strangers as an open downloader.
 */

import PAGE from "../public/index.html";

const VIDEO_EXT = ["mp4", "webm", "mov", "m4v", "mkv", "avi", "wmv", "flv"];
const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "avif"];
const STREAM_EXT = ["m3u8", "mpd"];
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAX_ITEMS = 500;
const MAX_PAGES = 50;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/dl/")) {
      try {
        const params = await verifyLink(url.pathname, env);
        if (!params) return new Response("This download link is invalid or has expired. Search again for a fresh one.", { status: 403 });
        return await file(params, request, url.searchParams.get("view") === "1");
      } catch (e) {
        return new Response("Download failed: " + (e && e.message ? e.message : String(e)), { status: (e && e.status) || 502 });
      }
    }
    if (!url.pathname.startsWith("/api/")) {
      if (url.pathname !== "/" && url.pathname !== "/index.html") return new Response("Not found", { status: 404 });
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }

    const who = await checkAccess(request, env);
    if (!who.ok) return json({ error: who.message, code: "locked" }, 401);

    try {
      if (url.pathname === "/api/whoami") return json({ email: who.email || null });
      if (url.pathname === "/api/scan") {
        const result = await scan(url.searchParams.get("url"), url.searchParams.get("all") === "1", url.searchParams.get("password"));
        await signItems(result.items, env);
        result.items.forEach((i) => { delete i.blocked; });
        return json(result);
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: e && e.message ? e.message : String(e), code: (e && e.code) || undefined, open: (e && e.open) || undefined, site: (e && e.site) || undefined }, (e && e.status) || 502);
    }
  },
};

// ---------------------------------------------------------------- helpers

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function extOf(s) {
  const clean = String(s || "").split(/[?#]/)[0];
  const m = clean.match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : "";
}

function kindOf(s) {
  const e = extOf(s);
  if (VIDEO_EXT.includes(e)) return "videos";
  if (IMAGE_EXT.includes(e)) return "images";
  if (STREAM_EXT.includes(e)) return "streams";
  return "";
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\\//g, "/");
}

function absUrl(u, base) {
  try {
    const r = new URL(decodeEntities(u), base);
    return /^https?:$/.test(r.protocol) ? r.href : "";
  } catch {
    return "";
  }
}

function nameFromUrl(u) {
  try {
    const last = new URL(u).pathname.split("/").filter(Boolean).pop() || "file";
    return decodeURIComponent(last);
  } catch {
    return "file";
  }
}

function attr(tag, name) {
  const m = tag.match(new RegExp("\\s" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", "i"));
  return m ? decodeEntities(m[2] !== undefined ? m[2] : m[3]) : "";
}

function inputError(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function requireHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    throw inputError("That doesn't look like a web link. Paste the full address, starting with https://");
  }
  if (!/^https?:$/.test(u.protocol)) throw inputError("Only http and https links work.");
  return u;
}

// fetch() that explains network failures in plain words
async function get(url, init, what) {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new Error("Couldn't reach " + what + " (" + new URL(url).hostname + ").");
  }
}

async function fetchPage(u) {
  const r = await get(u.href, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" },
    redirect: "follow",
  }, "that page");
  if (!r.ok) throw new Error("The page answered with HTTP " + r.status + ".");
  const type = r.headers.get("content-type") || "";
  if (!/html|xml|text\/plain/i.test(type)) {
    // The link is itself a file
    return { html: "", finalUrl: new URL(r.url || u.href), directType: type, size: r.headers.get("content-length") || "" };
  }
  return { html: await r.text(), finalUrl: new URL(r.url || u.href) };
}

// Scan results carry the download parameters; signItems turns them into
// signed, expiring /dl/ links before they leave the helper.
function fileLink(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) if (v) out[k] = v;
  return out;
}

const LINK_TTL_SECONDS = 6 * 3600;

function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacKey(env) {
  if (!env.SIGNING_KEY || env.SIGNING_KEY.length < 32) throw new Error("The download signing key isn't set up.");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(env.SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function safeFileName(name) {
  return String(name || "file").replace(/[\/\\?#%\r\n"]/g, "_").slice(0, 150) || "file";
}

async function signItems(items, env) {
  const key = await hmacKey(env);
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  for (const it of items) {
    if (!it.dl || typeof it.dl !== "object") continue;
    const payload = bytesToB64url(new TextEncoder().encode(JSON.stringify({ ...it.dl, exp })));
    const sig = bytesToB64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
    it.dl = "/dl/" + payload + "." + sig + "/" + encodeURIComponent(safeFileName(it.name));
  }
}

async function verifyLink(pathname, env) {
  const m = pathname.match(/^\/dl\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)(?:\/|$)/);
  if (!m) return null;
  const key = await hmacKey(env);
  const ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(m[2]), new TextEncoder().encode(m[1]));
  if (!ok) return null;
  const data = JSON.parse(new TextDecoder().decode(b64urlToBytes(m[1])));
  if (!data.exp || data.exp < Date.now() / 1000) return null;
  delete data.exp;
  return new URLSearchParams(data);
}

// ---------------------------------------------------------------- scanning

async function scan(raw, all, password) {
  const result = await scanInner(requireHttpUrl(raw), all, password);
  return result;
}

// Ordinary forwarding: HTTP redirects (followed by fetch) and pages that forward
// with a <meta http-equiv="refresh"> tag. Ad gates and "unlock" pages are not
// worked around; they are just read like any other page.
function metaRefresh(html, base) {
  if (!html || html.length > 200000) return null;
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/http-equiv\s*=\s*["']?refresh/i.test(m[0])) continue;
    const c = attr(m[0], "content");
    const mm = c.match(/^\s*(\d+(?:\.\d+)?)\s*[;,]\s*url\s*=\s*['"]?([^'"]+)/i);
    if (mm && +mm[1] <= 10) { const u = absUrl(mm[2].trim(), base); if (u) return new URL(u); }
  }
  return null;
}

async function scanInner(start, all, password) {
  let target = start, page, hops = 0;
  for (;;) {
    const ext = externalOnly(target);
    if (ext) { const e = new Error(ext.message); e.status = 422; e.code = "external"; e.open = target.href; e.site = ext.site; throw e; }
    const koofr = await koofrLink(target);
    if (koofr) return withVia(await scanKoofr(koofr, password || ""), start, target);
    const pd = pixeldrainLink(target);
    if (pd) return withVia(await scanPixeldrain(pd), start, target);
    page = await fetchPage(target);
    if (page.finalUrl.href !== target.href) {
      const k2 = await koofrLink(page.finalUrl);
      if (k2) return withVia(await scanKoofr(k2, password || ""), start, page.finalUrl);
    }
    const next = hops < 3 && metaRefresh(page.html, page.finalUrl);
    if (!next || next.href === page.finalUrl.href) break;
    target = next; hops++;
  }
  return withVia(await scanPage(page, all), start, page.finalUrl);
}

function withVia(result, start, end) {
  if (end && end.host !== start.host) result.via = end.href;
  return result;
}

async function scanPage(page, all) {
  const base = page.finalUrl;

  if (!page.html) {
    const name = nameFromUrl(base.href);
    const type = kindOf(name) || (/^video\//.test(page.directType) ? "videos" : /^image\//.test(page.directType) ? "images" : "other");
    return {
      kind: "file",
      title: name,
      items: [{ name, type, size: page.size, thumb: type === "images" ? base.href : "", dl: fileLink({ url: base.href, name }), source: base.href }],
    };
  }

  const title = decodeEntities((page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim();

  if (isFolderPage(page.html, base)) return await scanFolder(page.html, base, all, title);
  if (isTokenFilePage(page.html, base)) return scanTokenFile(page.html, base, title);
  const result = scanGeneric(page.html, base, title);
  const followed = await followFilePageLinks(page.html, base, result.items);
  await fillSizes(result.items, Math.max(0, 40 - followed));
  return result;
}

// A page that lists links to single file pages (/d/<id>), like a post with
// several file links: open each one and add its file. Capped so a search stays
// within the free plan's limit of 50 outside requests.
const MAX_FOLLOW = 30;
async function followFilePageLinks(html, base, items) {
  const seen = new Set(items.map((i) => i.source));
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const u = absUrl(attr(m[0], "href"), base);
    if (!u) continue;
    const path = new URL(u).pathname;
    if (/^\/d\/[A-Za-z0-9_-]{4,64}\/?$/.test(path) && !seen.has(u) && !links.includes(u)) links.push(u);
    if (links.length >= MAX_FOLLOW) break;
  }
  await Promise.all(links.map(async (u) => {
    try {
      const pg = await fetchPage(new URL(u));
      if (pg.html && isTokenFilePage(pg.html, pg.finalUrl)) {
        const t = decodeEntities((pg.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim();
        for (const it of scanTokenFile(pg.html, pg.finalUrl, t).items) {
          if (!seen.has(it.source)) { seen.add(it.source); it._at = links.indexOf(u); items.push(it); }
        }
      }
    } catch {}
  }));
  // keep the order the links appear in on the page
  const tail = items.filter((i) => i._at !== undefined).sort((a, b) => a._at - b._at);
  const head = items.filter((i) => i._at === undefined);
  items.length = 0;
  for (const i of head.concat(tail)) { delete i._at; items.push(i); }
  return links.length;
}

// ---------------------------------------------------------------- Sites used on their own page
// Hosts that lock their file list against outside tools. The downloader doesn't
// work around that; it points the person to the site's own page instead.
function externalOnly(u) {
  if (/(^|\.)gofile\.io$/.test(u.hostname)) {
    return { site: "gofile", message: "gofile only allows downloads from its own page. Open it on gofile, play a video, then use Aloha's own download button (gofile's download button saves a web page in Aloha)." };
  }
  return null;
}

// ---------------------------------------------------------------- Pixeldrain
// Public read API: /api/file/<id>/info and /api/list/<id> list files; downloads
// use /api/file/<id>?download. Heavily-downloaded files get a rate-limit captcha,
// which is surfaced to the user (pixeldrain's own page), never worked around.

const PD = "https://pixeldrain.com";

function pixeldrainLink(u) {
  if (!/(^|\.)pixeldrain\.com$/.test(u.hostname) && !/(^|\.)pd\.cybar\.xyz$/.test(u.hostname)) return null;
  var m = u.pathname.match(/^\/(u|l|api\/file|api\/list)\/([A-Za-z0-9_-]{4,40})/);
  if (!m) return null;
  var kind = m[1] === "l" || m[1] === "api/list" ? "list" : "file";
  return { kind: kind, id: m[2] };
}

async function pdJson(path) {
  const r = await get(PD + path, { headers: { "user-agent": UA, accept: "application/json" } }, "Pixeldrain");
  if (r.status === 404) { const e = new Error("Pixeldrain says this link doesn't exist or has been removed."); e.status = 404; throw e; }
  if (!r.ok) throw new Error("Pixeldrain answered with HTTP " + r.status + ".");
  return r.json();
}

function pdItem(f) {
  const name = f.name || f.id;
  const type = kindOf(name) || (/^video\//.test(f.mime_type || "") ? "videos" : /^image\//.test(f.mime_type || "") ? "images" : "other");
  return {
    name, type,
    size: f.size ? String(f.size) : "",
    thumb: type === "images" ? PD + "/api/file/" + f.id + "/thumbnail" : "",
    dl: fileLink({ url: PD + "/api/file/" + f.id + "?download", name, ref: PD + "/u/" + f.id }),
    source: PD + "/u/" + f.id,
    blocked: f.can_download === false,
  };
}

async function scanPixeldrain(link) {
  if (link.kind === "list") {
    const j = await pdJson("/api/list/" + link.id);
    const files = (j.files || []).filter((f) => f && f.id);
    const items = files.map(pdItem);
    const blocked = items.filter((i) => i.blocked).length;
    const out = { kind: "folder", title: j.title || "Pixeldrain album", items };
    if (blocked) out.notice = blocked + " of these files can't be downloaded without a captcha; open them on pixeldrain.com.";
    return out;
  }
  const f = await pdJson("/api/file/" + link.id + "/info");
  const it = pdItem(f);
  const out = { kind: "file", title: f.name || "Pixeldrain file", items: [it] };
  if (it.blocked) out.notice = "This file needs a captcha to download; open it on pixeldrain.com and download there.";
  return out;
}

// ---------------------------------------------------------------- Koofr shared links
// Public links (app.koofr.net/links/<id>, short k00.fr/<code>) are meant for anyone
// to download. The app reads the link and its file list from /api/v2/public/links
// and downloads from /content/links/<id>/files/get, adding &password= when the owner
// set one and &force to download rather than preview.

const KOOFR = "https://app.koofr.net";

async function koofrLink(u) {
  let url = u;
  if (/(^|\.)k00\.fr$/.test(url.hostname)) {
    const r = await get(url.href, { redirect: "manual", headers: { "user-agent": UA } }, "the short link");
    const loc = r.headers.get("location");
    if (!loc) return null;
    url = new URL(loc, url);
  }
  if (!/(^|\.)koofr\.net$/.test(url.hostname)) return null;
  const m = url.pathname.match(/\/links\/([A-Za-z0-9-]{6,64})/);
  if (!m) return null;
  return { id: m[1], path: url.searchParams.get("path") || "/" };
}

function joinPath(dir, name) { return (dir.endsWith("/") ? dir : dir + "/") + name; }

async function koofrJson(path, password, what) {
  const q = password ? (path.includes("?") ? "&" : "?") + "password=" + encodeURIComponent(password) : "";
  const r = await get(KOOFR + path + q, { headers: { "user-agent": UA, accept: "application/json" } }, "Koofr");
  if (r.status === 401 || r.status === 403) {
    const e = new Error(password ? "That password isn't right." : "This Koofr link has a password. Enter it and search again.");
    e.status = 401; e.code = "password"; throw e;
  }
  if (r.status === 404) { const e = new Error("Koofr says this link doesn't exist or has expired."); e.status = 404; throw e; }
  if (!r.ok) throw new Error("Koofr answered with HTTP " + r.status + " for " + what + ".");
  return r.json();
}

// The file list can come as {files:[…]}, {file:{children:[…]}} or a bare array.
function koofrEntries(j) {
  const list = Array.isArray(j) ? j : j.files || (j.file && (j.file.children || j.file.files)) || j.children || j.items || [];
  return list.map((f) => ({
    name: f.name || "",
    dir: f.type === "dir" || f.type === "folder" || f.isDir === true || f.dir === true,
    size: f.size || f.contentLength || "",
    mime: f.contentType || f.mimeType || "",
  })).filter((f) => f.name);
}

async function scanKoofr(link, password) {
  let title = "Koofr shared link";
  try {
    const info = await koofrJson("/api/v2/public/links/" + link.id, password, "the link");
    title = info.name || (info.link && info.link.name) || (info.file && info.file.name) || title;
  } catch (e) { if (e.code === "password" || e.status === 404) throw e; }
  const items = [];
  const pw = password ? "&password=" + encodeURIComponent(password) : "";
  let requests = 1;
  const walk = async (path, depth) => {
    if (items.length >= MAX_ITEMS || requests >= 40) return;
    requests++;
    const j = await koofrJson("/api/v2/public/links/" + link.id + "/bundle?path=" + encodeURIComponent(path), password, "the file list");
    const entries = koofrEntries(j);
    if (!entries.length && depth === 0 && !(Array.isArray(j) || j.files || j.file)) {
      throw new Error("Koofr's file list came back in an unexpected layout (keys: " + Object.keys(j).slice(0, 8).join(", ") + "). Send this message to Claude.");
    }
    for (const f of entries) {
      const p = joinPath(path, f.name);
      if (f.dir) { if (depth < 3) await walk(p, depth + 1); continue; }
      const type = kindOf(f.name) || (/^video\//.test(f.mime) ? "videos" : /^image\//.test(f.mime) ? "images" : "other");
      const fileUrl = KOOFR + "/content/links/" + link.id + "/files/get/" + encodeURIComponent(f.name) + "?path=" + encodeURIComponent(p) + "&force" + pw;
      items.push({
        name: f.name, type, size: f.size ? String(f.size) : "", thumb: "",
        dl: fileLink({ url: fileUrl, name: f.name, ref: KOOFR + "/links/" + link.id }),
        source: KOOFR + "/links/" + link.id + "?path=" + encodeURIComponent(p),
        folder: path === "/" ? "" : path,
      });
      if (items.length >= MAX_ITEMS) return;
    }
  };
  await walk(link.path, 0);
  return { kind: "folder", title, items };
}

// Folder listing whose items open /d/<id> file pages.
function isFolderPage(html, base) {
  return /^\/f\//.test(base.pathname) && /class="file-item[^"]*"[\s\S]{0,600}?\/d\/[A-Za-z0-9_-]+/.test(html);
}

function readFolderItems(html, base) {
  const out = [];
  const re = /<div\b[^>]*class="file-item[^"]*"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const slug = (attr(tag, "onclick").match(/\/d\/([A-Za-z0-9_-]+)/) || [])[1];
    if (!slug) continue;
    const name = attr(tag, "data-name") || slug;
    const after = html.slice(re.lastIndex, re.lastIndex + 1500);
    const img = after.match(/<img\b[^>]*>/i);
    const fileUrl = base.origin + "/d/" + slug;
    out.push({
      name,
      type: attr(tag, "data-type") || kindOf(name) || "other",
      size: attr(tag, "data-size"),
      thumb: img ? absUrl(attr(img[0], "src"), base) : "",
      dl: fileLink({ page: fileUrl, slug }),
      source: fileUrl,
    });
  }
  return out;
}

async function scanFolder(html, base, all, title) {
  let items = readFolderItems(html, base);
  const total = parseInt((html.match(/id="loadAllPagesBtn"[^>]*data-total="(\d+)"/) || html.match(/data-total="(\d+)"[^>]*id="loadAllPagesBtn"/) || [])[1] || "1", 10);
  if (all && total > 1) {
    const seen = new Set(items.map((i) => i.source));
    for (let p = 2; p <= Math.min(total, MAX_PAGES) && items.length < MAX_ITEMS; p++) {
      const u = new URL(base.origin + base.pathname);
      u.searchParams.set("page", String(p));
      const next = await fetchPage(u);
      for (const it of readFolderItems(next.html, base)) {
        if (!seen.has(it.source)) { seen.add(it.source); items.push(it); }
      }
    }
  }
  return { kind: "folder", title, pages: total, allPages: all || total <= 1, items: items.slice(0, MAX_ITEMS) };
}

// Single file page whose Download button asks the site for a one-time token.
function isTokenFilePage(html, base) {
  return /^\/d\/[A-Za-z0-9_-]+\/?$/.test(base.pathname) && /id="downloadButton"/.test(html);
}

function scanTokenFile(html, base, title) {
  const slug = base.pathname.split("/").filter(Boolean).pop();
  const js = (k) => decodeEntities((html.match(new RegExp("window\\." + k + "\\s*=\\s*\"([^\"]*)\"")) || [])[1] || "");
  const name = js("fileName") || title.split("|")[0].trim() || slug;
  const mime = js("fileType");
  const type = /^video\//.test(mime) ? "videos" : /^image\//.test(mime) ? "images" : kindOf(name) || "other";
  return {
    kind: "file",
    title,
    items: [{ name, type, size: "", thumb: "", dl: fileLink({ page: base.href, slug }), source: base.href }],
  };
}

// Any other page: video tags, media links, og: tags, images, media URLs inside scripts.
function scanGeneric(html, base, title) {
  const seen = new Set();
  const items = [];
  const add = (raw, opts = {}) => {
    const u = absUrl(raw, base);
    if (!u || seen.has(u) || items.length >= MAX_ITEMS) return;
    const type = opts.type || kindOf(u);
    if (!type) return;
    if (type === "images" && /(^|[\/_.-])(logo|icon|sprite|favicon|avatar|emoji|badge|pixel|spacer|thumbs?|thumbnails?)([\/_.-]|$)/i.test(u)) return;
    seen.add(u);
    const name = opts.name || nameFromUrl(u);
    items.push({
      name,
      type,
      size: "",
      thumb: opts.thumb || (type === "images" ? u : ""),
      dl: type === "streams" ? "" : fileLink({ url: u, name, ref: base.href }),
      source: u,
    });
  };

  for (const m of html.matchAll(/<video\b[^>]*>[\s\S]*?<\/video>|<video\b[^>]*\/?>/gi)) {
    const block = m[0];
    const open = block.match(/<video\b[^>]*>/i)[0];
    const poster = absUrl(attr(open, "poster"), base);
    const src = attr(open, "src");
    if (src) add(src, { type: kindOf(src) === "streams" ? "streams" : "videos", thumb: poster });
    for (const s of block.matchAll(/<source\b[^>]*>/gi)) {
      const ssrc = attr(s[0], "src");
      if (ssrc) add(ssrc, { type: kindOf(ssrc) === "streams" ? "streams" : "videos", thumb: poster });
    }
  }
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const prop = (attr(m[0], "property") || attr(m[0], "name")).toLowerCase();
    const content = attr(m[0], "content");
    if (!content) continue;
    if (/^(og:video(:url|:secure_url)?|twitter:player:stream)$/.test(prop)) add(content, { type: kindOf(content) === "streams" ? "streams" : "videos" });
    else if (/^(og:image(:url|:secure_url)?|twitter:image)$/.test(prop)) add(content, { type: "images" });
  }
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0], "href");
    if (href && kindOf(href)) add(href);
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = attr(m[0], "src") || attr(m[0], "data-src");
    if (src && kindOf(src) === "images") add(src, { type: "images" });
  }
  for (const m of html.matchAll(/https?:(?:\\?\/){2}[^"'\s<>()]+?\.(?:mp4|webm|mov|m4v|m3u8|mpd)(?:\?[^"'\s<>()]*)?/gi)) {
    add(m[0]);
  }
  return { kind: "page", title, items };
}

// Look up file sizes the page didn't list, so results can be sorted by size.
async function fillSizes(items, budget) {
  const todo = items.filter((i) => !i.size && i.dl && i.dl.url).slice(0, budget);
  await Promise.all(todo.map(async (i) => {
    try {
      const r = await fetch(i.dl.url, { method: "HEAD", headers: { "user-agent": UA, referer: i.dl.ref || "" }, redirect: "follow" });
      const len = r.ok && r.headers.get("content-length");
      if (len && +len > 0) i.size = len;
    } catch {}
  }));
}

// ---------------------------------------------------------------- files

function contentDisposition(name, inline) {
  const safe = String(name || "file").replace(/[\r\n"]/g, "").slice(0, 200) || "file";
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  return (inline ? "inline" : "attachment") + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(safe);
}

// Players ask for a video in many small pieces; reuse one site token per file
// for a while instead of asking the site again for every piece.
const tokenCache = new Map();

async function tokenDownloadUrl(pageUrl, slug) {
  const key = pageUrl.origin + "|" + slug;
  const hit = tokenCache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const r = await get(pageUrl.origin + "/v2/api/public/download", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA, origin: pageUrl.origin, referer: pageUrl.href },
    body: JSON.stringify({ file_slug: slug }),
  }, "the site");
  if (!r.ok) throw new Error("The site refused the download (HTTP " + r.status + ").");
  const t = await r.json();
  if (!t || !t.token || !t.file || !t.server) throw new Error("The site didn't return a download link.");
  const u = t.server + "/v2/" + t.file + "?token=" + encodeURIComponent(t.token) + "&download=true" + (t.name ? "&n=" + encodeURIComponent(t.name) : "");
  const value = { url: u, name: t.name || "" };
  const ttl = Math.min(20 * 60, Math.max(60, (t.expires_in || 600) - 120)) * 1000;
  tokenCache.set(key, { value, until: Date.now() + ttl });
  if (tokenCache.size > 500) tokenCache.delete(tokenCache.keys().next().value);
  return value;
}

async function file(params, request, inline) {
  let upstreamUrl, name, referer;
  if (params.get("slug") && params.get("page")) {
    const pageUrl = requireHttpUrl(params.get("page"));
    const slug = params.get("slug");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug)) throw inputError("Bad file id.");
    const t = await tokenDownloadUrl(pageUrl, slug);
    upstreamUrl = t.url;
    name = t.name || params.get("name") || slug;
    referer = pageUrl.href;
  } else {
    const u = requireHttpUrl(params.get("url"));
    upstreamUrl = u.href;
    name = params.get("name") || nameFromUrl(u.href);
    referer = params.get("ref") || u.origin + "/";
  }

  // Pass the player's byte-range request through so videos can play and seek.
  const upHeaders = { "user-agent": UA, referer };
  const range = request && request.headers.get("range");
  if (range && /^bytes=\d*-\d*$/.test(range)) upHeaders.range = range;
  const method = request && request.method === "HEAD" ? "HEAD" : "GET";
  const up = await get(upstreamUrl, { method, headers: upHeaders, redirect: "follow" }, "the file server");
  if (up.status === 403) {
    return new Response("The file host is asking for a captcha or blocking this download (403). Open the file on the host's own page and download it there.", { status: 403 });
  }
  if (!(up.ok || up.status === 206) || (method === "GET" && !up.body)) {
    return new Response("The file server answered with HTTP " + up.status + ".", { status: 502 });
  }
  const headers = new Headers({
    "content-type": up.headers.get("content-type") || "application/octet-stream",
    "content-disposition": contentDisposition(name, inline),
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
  });
  for (const h of ["content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
    const v = up.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
  return new Response(method === "HEAD" ? null : up.body, { status: up.status === 206 ? 206 : 200, headers });
}

// ---------------------------------------------------------------- login lock

let certCache = { team: "", at: 0, keys: [] };

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function accessKeys(team) {
  if (certCache.team === team && Date.now() - certCache.at < 3600_000 && certCache.keys.length) return certCache.keys;
  const r = await fetch("https://" + team + "/cdn-cgi/access/certs");
  if (!r.ok) throw new Error("Couldn't load the login lock's keys (HTTP " + r.status + ").");
  const data = await r.json();
  certCache = { team, at: Date.now(), keys: data.keys || [] };
  return certCache.keys;
}

function readToken(request) {
  const h = request.headers.get("cf-access-jwt-assertion");
  if (h) return h;
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : "";
}

async function checkAccess(request, env) {
  if (env.ALLOW_OPEN === "1") return { ok: true, email: "local-test" };
  const team = (env.ACCESS_TEAM || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const aud = env.ACCESS_AUD || "";
  if (!team || !aud) {
    return { ok: false, message: "The login lock isn't set up yet, so the helper is switched off. Finish the Cloudflare Access step in the setup guide." };
  }
  const token = readToken(request);
  if (!token) return { ok: false, message: "You're not signed in. Reload the page to sign in." };
  try {
    const [h, p, s] = token.split(".");
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    const jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
    if (!jwk) throw new Error("unknown key");
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(s), new TextEncoder().encode(h + "." + p));
    if (!valid) throw new Error("bad signature");
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) throw new Error("wrong application");
    if (payload.iss !== "https://" + team) throw new Error("wrong team");
    if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error("expired");
    return { ok: true, email: payload.email || "" };
  } catch (e) {
    return { ok: false, message: "Your sign-in couldn't be checked (" + e.message + "). Reload the page to sign in again." };
  }
}
