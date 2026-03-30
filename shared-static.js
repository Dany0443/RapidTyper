/**
 * shared-static.js
 * ─────────────────────────────────────────────────────────────────────────
 * Static file middleware shared by server.js (dev mode) and school-server.js.
 * 
 * Simplified Version:
 * - NO LONGER does inline patching of JS and HTML files.
 * - This logic is now handled by the /config.js endpoint.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { handleConfigRequest } = require('./shared/config-endpoint');

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

// ── File resolver ──────────────────────────────────────────────────────────
function tryFile(p) {
    try {
        const s = fs.statSync(p);
        return s.isFile() ? p : null;
    } catch (_) { return null; }
}

function resolve(root, rawUrl) {
    const urlPath = decodeURIComponent(rawUrl.split('?')[0]);

    // HTML files may live at root, html/, or pages/
    const htmlDir  = path.join(root, 'html');
    const pagesDir = path.join(root, 'pages');
    
    // Check for the HTML directory first, as that's where they are in this project
    const htmlBase = fs.existsSync(htmlDir) ? htmlDir : (fs.existsSync(pagesDir) ? pagesDir : root);

    // Root → index.html
    if (urlPath === '/' || urlPath === '') {
        return tryFile(path.join(htmlBase, 'index.html'));
    }

    // Named pages (e.g., /stream or /stream.html)
    for (const page of HTML_PAGES) {
        if (urlPath === `/${page}` || urlPath === `/${page}.html`) {
            return tryFile(path.join(htmlBase, `${page}.html`));
        }
    }

    // Strip leading slash
    const rel = urlPath.replace(/^\//, '');

    // Direct hit
    const direct = tryFile(path.join(root, rel));
    if (direct) return direct;

    // Bare filename without subdirectory
    const ext = path.extname(rel).toLowerCase();
    if (ext === '.css')  return tryFile(path.join(root, 'css', rel));
    if (ext === '.js')   return tryFile(path.join(root, 'js',  rel));
    if (ext === '.html') return tryFile(path.join(htmlBase, rel));

    const normalised = path.normalize(path.join('/', rel)).replace(/^\//, '');
    return tryFile(path.join(root, normalised));
}

// ── Main middleware ────────────────────────────────────────────────────────
function serveStatic(root, req, res, opts = {}) {
    if (handleConfigRequest(req, res)) {
        return true;
    }
    
    const filePath = resolve(root, req.url);
    if (!filePath) return false;

    const ext = path.extname(filePath).toLowerCase();
    const ct  = MIME[ext] || 'application/octet-stream';

    // Binary files
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

    // Text files
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch(_) { res.writeHead(500); res.end('Read error'); return true; }

    res.writeHead(200, {
        'Content-Type' : ct,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    res.end(content, 'utf8');
    return true;
}

module.exports = { serveStatic, resolve, MIME };