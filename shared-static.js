/**
 * shared-static.js
 * ─────────────────────────────────────────────────────────────────────────
 * Static file middleware shared by server.js (dev mode) and school-server.js.
 *
 * Solves two problems:
 *
 * 1. PATH RESOLUTION
 *    HTML files use "../css/foo.css" and "../js/foo.js".
 *    The browser resolves these correctly relative to the page URL, so the
 *    server always receives GET /css/foo.css and GET /js/foo.js — no matter
 *    where the HTML files physically live (root or pages/ subfolder).
 *
 * 2. WS URL AUTO-PATCH
 *    A small <script> is injected into every HTML response that computes
 *    the correct WebSocket URL at runtime:
 *
 *      - Opened on :5890 or :8080 (dev/school HTTP)  → ws://HOST:5889
 *      - Opened on :80 / :443 (production nginx)      → ws(s)://HOST
 *      - Any other port                               → ws://HOST:PORT
 *
 *    stream.js hard-codes "wss://typer.webjuniors.org/ws" for non-localhost.
 *    The injection runs BEFORE the JS files load, so `window.__WS_URL__` is
 *    already set when stream.js (or index.js etc.) reads it.
 *    stream.js's WS_URL line is also rewritten in-flight to use __WS_URL__.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── MIME types ─────────────────────────────────────────────────────────────
const MIME = {
    '.html' : 'text/html; charset=utf-8',
    '.js'   : 'application/javascript; charset=utf-8',
    '.css'  : 'text/css; charset=utf-8',
    '.png'  : 'image/png',
    '.jpg'  : 'image/jpeg',
    '.jpeg' : 'image/jpeg',
    '.ico'  : 'image/x-icon',
    '.json' : 'application/json',
    '.woff2': 'font/woff2',
    '.woff' : 'font/woff',
    '.ttf'  : 'font/ttf',
    '.svg'  : 'image/svg+xml',
    '.webm' : 'video/webm',
    '.mp4'  : 'video/mp4',
    '.txt'  : 'text/plain',
};

const HTML_PAGES = ['index', 'stream', 'spell', 'host', 'presentation'];

// ── WS auto-patch snippet (injected before </head> in every HTML) ──────────
// Uses a self-invoking function to avoid polluting global scope.
// Sets window.__WS_URL__ before any of the page's own JS runs.
const WS_INJECT_MARKER = '/*__ws_patched__*/';
const WS_INJECT_SCRIPT = `
<script>
/* RapidTyper WS URL auto-detection */
(function(){
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  var host  = location.hostname || 'localhost';
  var port  = location.port;
  // Dev/school HTTP servers run on 5890 or 8080;
  // in both cases the WS server is always on 5889.
  // 8443 = school HTTPS  → wss on same port (upgrade handler attached there)
  // 8080 = school HTTP   → game WS on 5889
  // 5890 = dev HTTP      → game WS on 5889
  var wsPort;
  if (port === '8443') {
      wsPort = '8443';                    // wss://host:8443  (same server)
  } else if (port === '5890' || port === '8080') {
      wsPort = '5889';                    // ws://host:5889
  } else {
      wsPort = port;
  }
  window.__WS_URL__ = proto + '://' + host + (wsPort ? ':' + wsPort : '');
})();
</script>`;

// ── Rewrite the WS_URL declaration inside .js files ────────────────────────
// Handles:
//   const WS_URL = `ws://${location.hostname || 'localhost'}:5889`;     ← index.js etc.
//   const WS_URL = location.hostname === 'localhost' ? `ws://...`       ← stream.js
//       : `wss://typer.webjuniors.org/ws`;
const WS_LINE_RE = [
    // stream.js multiline conditional form
    /const WS_URL\s*=\s*location\.hostname[^;]+?`wss?:\/\/[^`]+`\s*;/gs,
    // simple template literal form used by all other JS files
    /const WS_URL\s*=\s*`ws[s]?:\/\/\$\{[^`]+\}`\s*;/g,
];
const WS_REPLACEMENT = "const WS_URL = window.__WS_URL__ || `ws://${location.hostname || 'localhost'}:5889`;";

function patchJsWsUrl(content) {
    if (content.includes(WS_INJECT_MARKER)) return content;
    let out = content;
    for (const re of WS_LINE_RE) out = out.replace(re, WS_REPLACEMENT);
    return WS_INJECT_MARKER + '\n' + out;
}

// ── File resolver ──────────────────────────────────────────────────────────
function tryFile(p) {
    try {
        const s = fs.statSync(p);
        return s.isFile() ? p : null;
    } catch (_) { return null; }
}

/**
 * Resolve a URL path to an absolute file path inside `root`.
 * Returns null if not found.
 */
function resolve(root, rawUrl) {
    const urlPath = decodeURIComponent(rawUrl.split('?')[0]);

    // HTML files may live at root, html/, or pages/
    const htmlDir  = path.join(root, 'html');
    const pagesDir = path.join(root, 'pages');
    const htmlBase = fs.existsSync(htmlDir)
        ? htmlDir
        : fs.existsSync(pagesDir) ? pagesDir : root;

    // Root → index
    if (urlPath === '/' || urlPath === '') {
        return tryFile(path.join(htmlBase, 'index.html'));
    }

    // Named pages (/stream, /stream.html, /host, /host.html …)
    for (const page of HTML_PAGES) {
        if (urlPath === `/${page}` || urlPath === `/${page}.html`) {
            return tryFile(path.join(htmlBase, `${page}.html`));
        }
    }

    // Strip leading slash
    const rel = urlPath.replace(/^\//, '');

    // Direct hit (covers /css/foo.css, /js/bar.js, /foo.png …)
    const direct = tryFile(path.join(root, rel));
    if (direct) return direct;

    // Bare filename without subdirectory — search known asset dirs
    const ext = path.extname(rel).toLowerCase();
    if (ext === '.css')  return tryFile(path.join(root, 'css', rel));
    if (ext === '.js')   return tryFile(path.join(root, 'js',  rel));
    if (ext === '.html') return tryFile(path.join(htmlBase, rel));

    // Normalise path traversal (browser already does this but be safe)
    const normalised = path.normalize(path.join('/', rel)).replace(/^\//, '');
    return tryFile(path.join(root, normalised));
}

// ── Main middleware ────────────────────────────────────────────────────────
/**
 * serveStatic(root, req, res, opts)
 *
 * @param {string}  root      – absolute path to ClientWeb folder
 * @param {object}  req       – http.IncomingMessage
 * @param {object}  res       – http.ServerResponse
 * @param {object}  opts
 * @param {boolean} opts.patchJs – if true, rewrite WS URLs in JS and inject
 *                                 the WS URL detection snippet into HTML
 * @returns {boolean} true if handled, false if caller should 404
 */
function serveStatic(root, req, res, opts = {}) {
    
    const filePath = resolve(root, req.url);
    if (!filePath) return false;

    const ext = path.extname(filePath).toLowerCase();
    const ct  = MIME[ext] || 'application/octet-stream';

    // Binary files — stream, no patching
    const binaryExts = new Set(['.png','.jpg','.jpeg','.ico','.woff2','.woff','.ttf','.webm','.mp4','.svg']);
    if (binaryExts.has(ext)) {
        let stat;
        try { stat = fs.statSync(filePath); } catch(_) { res.writeHead(404); res.end('Not found'); return true; }
        res.writeHead(200, {
            'Content-Type'  : ct,
            'Content-Length': stat.size,
            'Cache-Control' : 'public, max-age=3600',
        });
        fs.createReadStream(filePath).pipe(res);
        return true;
    }

    // Text files — read, optionally patch, send
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch(_) { res.writeHead(500); res.end('Read error'); return true; }

    if (opts.patchJs) {
        if (ext === '.html') {
            // Inject WS snippet right before </head>
            if (content.includes('</head>')) {
                content = content.replace('</head>', WS_INJECT_SCRIPT + '\n</head>');
            } else {
                content = WS_INJECT_SCRIPT + '\n' + content;
            }
        } else if (ext === '.js') {
            content = patchJsWsUrl(content);
        }
    }

    res.writeHead(200, {
        'Content-Type' : ct,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    res.end(content, 'utf8');
    return true;
}

module.exports = { serveStatic, resolve, MIME };