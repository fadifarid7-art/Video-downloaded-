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
        const result = await scan(url.searchParams.get("url"), url.searchParams.get("all") === "1");
        await signItems(result.items, env);
        return json(result);
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: e && e.message ? e.message : String(e) }, (e && e.status) || 502);
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

async function scan(raw, all) {
  const target = requireHttpUrl(raw);
  const page = await fetchPage(target);
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
  await fillSizes(result.items, 40);
  return result;
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
