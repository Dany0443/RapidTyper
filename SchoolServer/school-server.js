/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  RapidTyper — SchoolServer                                          ║
 * ║  Runs on a laptop/mini-PC that hotspots its own Wi-Fi.             ║
 * ║  • Serves game clients (index.html, spell.html) locally            ║
 * ║  • Accepts up to 8 phone camera streams via WebRTC + WS            ║
 * ║  • Relays video as H.265/HEVC JPEG-thumbnails over Tailscale WS    ║
 * ║    to the MainServer                                                ║
 * ║  • Proxies game WS messages to/from MainServer                     ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * ENV variables (create a .env or set via systemd):
 *   MAIN_SERVER_WS   = ws://100.x.x.x:5889   ← Tailscale IP of MainServer
 *   SCHOOL_ID        = school-cluj-01         ← unique ID for this school node
 *   STREAM_KEY       = yourSecretKey          ← shared with stream.html phones
 *   ADMIN_KEY        = 1313                   ← for local host.html
 *   LOCAL_PORT       = 5889                   ← WS port for local clients
 *   HTTP_PORT        = 8080                   ← HTTP for static files
 *   VIDEO_PORT       = 5890                   ← dedicated video relay WS port
 */

'use strict';

require('dotenv').config();
const WebSocket  = require('ws');
const http       = require('http');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const { execFile, spawn } = require('child_process');

// ══════════════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════════════
const CFG = {
    mainServerWs  : process.env.MAIN_SERVER_WS  || 'ws://localhost:5889',
    schoolId      : process.env.SCHOOL_ID        || 'school-' + Math.random().toString(36).substr(2,6),
    streamKey     : process.env.STREAM_KEY       || 'stream1234',
    adminKey      : process.env.ADMIN_KEY        || '1313',
    localPort     : parseInt(process.env.LOCAL_PORT)  || 5889,
    httpPort      : parseInt(process.env.HTTP_PORT)   || 8080,
    videoPort     : parseInt(process.env.VIDEO_PORT)  || 5890,
    maxCams       : parseInt(process.env.MAX_CAMS)    || 8,
    // Video relay settings
    thumbnailWidth : 320,   // px for preview thumbnails sent to MainServer
    thumbnailFps   : 2,     // frames/sec for thumbnails (very low = tiny bandwidth)
    ffmpegPath    : process.env.FFMPEG_PATH || 'ffmpeg',
};

// ══════════════════════════════════════════════════════════════════════════
//  LOGGING
// ══════════════════════════════════════════════════════════════════════════
const log  = (msg) => console.log(`[${ts()}] [INFO]  ${msg}`);
const warn = (msg) => console.warn(`[${ts()}] [WARN]  ${msg}`);
const err  = (msg) => console.error(`[${ts()}] [ERROR] ${msg}`);
function ts() { return new Date().toISOString().substr(11,12); }

// ══════════════════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════════════════

// Connected cameras: camId → { ws, authed, streaming, label, thumbnailBuf }
const cameras = new Map();

// WebRTC viewers on the local network waiting for a specific cam
// viewerId → { ws, camId }
const viewers = new Map();

// Local game clients (players, spellers, host, presentation screens)
// Just forwarded to/from MainServer
const localClients = new Map(); // ws → { role, userId }

// Connection to MainServer
let mainWs     = null;
let mainConnected = false;
let mainReconnectTimer = null;
let mainReconnectAttempts = 0;

// ══════════════════════════════════════════════════════════════════════════
//  STATIC FILE SERVER  (serves ClientWeb from ../ClientWeb or ./public)
// ══════════════════════════════════════════════════════════════════════════
const STATIC_ROOT = process.env.STATIC_ROOT || path.join(__dirname, '..', 'ClientWeb');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js'  : 'application/javascript',
    '.css' : 'text/css',
    '.png' : 'image/png',
    '.jpg' : 'image/jpeg',
    '.ico' : 'image/x-icon',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
};

const httpServer = http.createServer((req, res) => {
    // Health endpoint
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'ok',
            schoolId: CFG.schoolId,
            mainConnected,
            cameras: cameras.size,
            localClients: localClients.size,
            uptime: process.uptime()
        }));
    }

    // Static files
    let filePath = path.join(STATIC_ROOT, req.url === '/' ? '/index.html' : req.url);
    filePath = filePath.split('?')[0]; // strip query string

    fs.readFile(filePath, (e, data) => {
        if (e) {
            res.writeHead(404); res.end('Not found'); return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

httpServer.listen(CFG.httpPort, '0.0.0.0', () => {
    log(`🌐 HTTP static server on :${CFG.httpPort}`);
});

// ══════════════════════════════════════════════════════════════════════════
//  LOCAL GAME WEBSOCKET SERVER  (port 5889)
//  All messages except stream-related ones are forwarded to MainServer
// ══════════════════════════════════════════════════════════════════════════
const gameWss = new WebSocket.Server({ port: CFG.localPort });

gameWss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Send initial connecting state; will be filled once MainServer responds
    ws.send(JSON.stringify({ type: 'SYNC_STATE', phase: 'LOBBY', mode: 'race' }));

    ws.on('message', (raw) => {
        if (raw.length > 64 * 1024) return; // drop oversized
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        // ── Stream auth is handled locally ───────────────────────────
        if (msg.type === 'STREAM_AUTH') {
            handleStreamAuth(ws, msg); return;
        }

        // ── Stream signaling handled locally ─────────────────────────
        if (['STREAM_START','STREAM_STOP','STREAM_OFFER','STREAM_ICE',
             'VIEWER_JOIN','VIEWER_LEAVE','PING'].includes(msg.type)) {
            handleStreamMessage(ws, msg); return;
        }

        // ── Everything else → forward to MainServer ──────────────────
        // Tag the message with schoolId so MainServer knows which school
        if (!localClients.has(ws)) {
            localClients.set(ws, { role: 'unknown', userId: null });
        }
        forwardToMain(raw, ws);
    });

    ws.on('close', () => {
        const client = localClients.get(ws);
        localClients.delete(ws);
        // Notify MainServer of disconnect
        if (mainWs && mainConnected && client?.userId) {
            mainWs.send(JSON.stringify({
                type: 'SCHOOL_CLIENT_DISCONNECT',
                schoolId: CFG.schoolId,
                userId: client.userId
            }));
        }
        // Clean up if this was a camera client
        for (let [camId, cam] of cameras.entries()) {
            if (cam.ws === ws) {
                log(`📷 Camera ${camId} disconnected`);
                cameras.delete(camId);
                notifyMainCameraState();
                break;
            }
        }
    });

    ws.on('error', () => {});
});

// Heartbeat for local clients
setInterval(() => {
    gameWss.clients.forEach(ws => {
        if (!ws.isAlive) { ws.terminate(); return; }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

log(`🎮 Game WS server on :${CFG.localPort}`);

// ══════════════════════════════════════════════════════════════════════════
//  VIDEO WEBSOCKET SERVER  (port 5890)
//  Phones connect here after auth to send raw MediaRecorder chunks.
//  The SchoolServer receives them and relays thumbnails to MainServer
//  while also forwarding the raw stream chunks for local WebRTC viewers.
// ══════════════════════════════════════════════════════════════════════════
const videoWss = new WebSocket.Server({ port: CFG.videoPort });

videoWss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.authed = false;
    ws.camId  = null;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        // Auth message is always text JSON
        if (typeof data === 'string' || data instanceof Buffer && data[0] === 0x7b) {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch { return; }

            if (msg.type === 'STREAM_AUTH') {
                if (msg.key !== CFG.streamKey) {
                    ws.send(JSON.stringify({ type: 'STREAM_AUTH_FAIL' }));
                    ws.close(); return;
                }
                if (cameras.size >= CFG.maxCams) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Max cameras reached' }));
                    ws.close(); return;
                }
                ws.authed = true;
                ws.camId  = msg.camId || ('cam-' + Date.now());
                cameras.set(ws.camId, {
                    ws,
                    authed: true,
                    streaming: false,
                    label: msg.label || ws.camId,
                    lastThumb: null,
                });
                ws.send(JSON.stringify({
                    type: 'STREAM_AUTH_OK',
                    camId: ws.camId,
                    schoolId: CFG.schoolId
                }));
                log(`📷 Camera ${ws.camId} authed`);
                notifyMainCameraState();
                return;
            }

            if (!ws.authed) { ws.close(); return; }

            if (msg.type === 'STREAM_START') {
                const cam = cameras.get(ws.camId);
                if (cam) { cam.streaming = true; cam.label = msg.label || ws.camId; }
                notifyMainCameraState();
                log(`▶️  Camera ${ws.camId} started streaming`);
                // Tell any waiting viewers
                broadcastToViewers(ws.camId, JSON.stringify({
                    type: 'CAM_LIVE', camId: ws.camId, schoolId: CFG.schoolId
                }));
                return;
            }

            if (msg.type === 'STREAM_STOP') {
                const cam = cameras.get(ws.camId);
                if (cam) cam.streaming = false;
                notifyMainCameraState();
                broadcastToViewers(ws.camId, JSON.stringify({
                    type: 'CAM_OFFLINE', camId: ws.camId
                }));
                return;
            }

            // WebRTC signaling for local WebRTC path (phones → host preview)
            if (msg.type === 'STREAM_OFFER') {
                // Relay to any viewer waiting for this cam
                for (let [vid, viewer] of viewers.entries()) {
                    if (viewer.camId === ws.camId && viewer.ws.readyState === WebSocket.OPEN) {
                        viewer.ws.send(JSON.stringify({
                            type: 'STREAM_OFFER',
                            camId: ws.camId,
                            sdp: msg.sdp,
                            schoolId: CFG.schoolId
                        }));
                    }
                }
                return;
            }

            if (msg.type === 'STREAM_ICE') {
                for (let [vid, viewer] of viewers.entries()) {
                    if (viewer.camId === ws.camId && viewer.ws.readyState === WebSocket.OPEN) {
                        viewer.ws.send(JSON.stringify({
                            type: 'STREAM_ICE_FROM_CAM',
                            camId: ws.camId,
                            candidate: msg.candidate,
                            schoolId: CFG.schoolId
                        }));
                    }
                }
                return;
            }

            // Viewer joining to watch a specific cam
            if (msg.type === 'VIEWER_JOIN') {
                viewers.set(ws.camId + '_' + Date.now(), { ws, camId: msg.camId });
                // Tell the camera a viewer joined
                const cam = cameras.get(msg.camId);
                if (cam && cam.ws.readyState === WebSocket.OPEN) {
                    cam.ws.send(JSON.stringify({
                        type: 'VIEWER_JOINED',
                        viewerId: 'local-' + Date.now()
                    }));
                }
                return;
            }
            return;
        }

        // ── Binary data = video frame chunk ──────────────────────────
        if (!ws.authed || !ws.camId) return;
        const cam = cameras.get(ws.camId);
        if (!cam || !cam.streaming) return;

        // Store last chunk for thumbnail generation
        cam.lastRawChunk = data;

        // Relay raw chunk to MainServer for HLS/relay
        relayVideoChunkToMain(ws.camId, data);
    });

    ws.on('close', () => {
        if (ws.camId) {
            cameras.delete(ws.camId);
            notifyMainCameraState();
            broadcastToViewers(ws.camId, JSON.stringify({
                type: 'CAM_OFFLINE', camId: ws.camId
            }));
            log(`📷 Camera ${ws.camId} closed`);
        }
    });
    ws.on('error', () => {});
});

setInterval(() => {
    videoWss.clients.forEach(ws => {
        if (!ws.isAlive) { ws.terminate(); return; }
        ws.isAlive = false; ws.ping();
    });
}, 20000);

log(`📷 Video WS server on :${CFG.videoPort}`);

// ══════════════════════════════════════════════════════════════════════════
//  STREAM AUTH (for game WS — when phones use stream.html on port 5889)
// ══════════════════════════════════════════════════════════════════════════
function handleStreamAuth(ws, msg) {
    if (msg.key !== CFG.streamKey) {
        ws.send(JSON.stringify({ type: 'STREAM_AUTH_FAIL' })); return;
    }
    if (cameras.size >= CFG.maxCams) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Max cameras reached' })); return;
    }
    ws.authed = true;
    ws.camId  = msg.camId || ('cam-' + Date.now());
    ws.isCamera = true;
    cameras.set(ws.camId, {
        ws,
        authed: true,
        streaming: false,
        label: msg.label || ws.camId,
        lastThumb: null,
    });
    ws.send(JSON.stringify({ type: 'STREAM_AUTH_OK', camId: ws.camId }));
    log(`📷 Camera ${ws.camId} authed (game port)`);
    notifyMainCameraState();
}

function handleStreamMessage(ws, msg) {
    if (!ws.authed || !ws.camId) return;
    const cam = cameras.get(ws.camId);

    if (msg.type === 'STREAM_START') {
        if (cam) { cam.streaming = true; cam.label = msg.label || ws.camId; }
        notifyMainCameraState();
        log(`▶️  Camera ${ws.camId} live`);
        // Signal to viewers
        broadcastToViewersOnGamePort(ws.camId, { type: 'CAM_LIVE', camId: ws.camId, schoolId: CFG.schoolId });
        return;
    }

    if (msg.type === 'STREAM_STOP') {
        if (cam) cam.streaming = false;
        notifyMainCameraState();
        broadcastToViewersOnGamePort(ws.camId, { type: 'CAM_OFFLINE', camId: ws.camId });
        return;
    }

    // WebRTC offer from streamer: relay to any local viewer watching this cam
    if (msg.type === 'STREAM_OFFER') {
        gameWss.clients.forEach(client => {
            const c = localClients.get(client);
            if (c?.viewingCam === ws.camId && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'STREAM_OFFER',
                    camId: ws.camId,
                    sdp: msg.sdp,
                    viewerId: msg.viewerId,
                    schoolId: CFG.schoolId
                }));
            }
        });
        // Also relay to MainServer for remote viewing
        if (mainWs && mainConnected) {
            mainWs.send(JSON.stringify({
                type: 'SCHOOL_STREAM_OFFER',
                schoolId: CFG.schoolId,
                camId: ws.camId,
                sdp: msg.sdp,
                viewerId: msg.viewerId
            }));
        }
        return;
    }

    if (msg.type === 'STREAM_ICE') {
        // Relay ICE to any local viewer
        gameWss.clients.forEach(client => {
            const c = localClients.get(client);
            if (c?.viewingCam === ws.camId && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'STREAM_ICE_FROM_CAM',
                    camId: ws.camId,
                    candidate: msg.candidate
                }));
            }
        });
        if (mainWs && mainConnected) {
            mainWs.send(JSON.stringify({
                type: 'SCHOOL_STREAM_ICE_FROM_CAM',
                schoolId: CFG.schoolId,
                camId: ws.camId,
                candidate: msg.candidate,
                viewerId: msg.viewerId
            }));
        }
    }
}

function broadcastToViewers(camId, data) {
    for (let [id, viewer] of viewers.entries()) {
        if (viewer.camId === camId && viewer.ws.readyState === WebSocket.OPEN) {
            viewer.ws.send(data);
        }
    }
}

function broadcastToViewersOnGamePort(camId, msgObj) {
    const data = JSON.stringify(msgObj);
    gameWss.clients.forEach(client => {
        const c = localClients.get(client);
        if (c?.viewingCam === camId && client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════
//  RELAY VIDEO CHUNKS TO MAINSERVER
//  We relay raw MediaRecorder webm chunks + generate low-res JPEG thumbnails
//  via ffmpeg for the host preview grid.
// ══════════════════════════════════════════════════════════════════════════
const thumbProcesses = new Map(); // camId → ffmpeg proc

function relayVideoChunkToMain(camId, chunk) {
    if (!mainWs || !mainConnected) return;

    // Send the binary chunk with a small text header
    // Format: JSON header (fixed 256 bytes, zero-padded) + binary data
    const header = JSON.stringify({
        type: 'VIDEO_CHUNK',
        schoolId: CFG.schoolId,
        camId,
        ts: Date.now()
    });
    const headerBuf = Buffer.alloc(256, 0);
    headerBuf.write(header.substring(0, 255));
    const combined = Buffer.concat([headerBuf, Buffer.from(chunk)]);

    try {
        mainWs.send(combined);
    } catch(e) {
        // Non-fatal — just skip this chunk
    }
}

// Thumbnail generator: every 2s, snapshot a JPEG from a cam's raw chunk
// Uses ffmpeg to decode a webm frame → JPEG in memory
const thumbInterval = setInterval(() => {
    for (let [camId, cam] of cameras.entries()) {
        if (!cam.streaming || !cam.lastRawChunk) continue;
        generateThumbnail(camId, cam.lastRawChunk);
    }
}, 500); // check every 500ms, throttle per cam inside

const thumbLastSent = new Map();

function generateThumbnail(camId, chunk) {
    const now = Date.now();
    const last = thumbLastSent.get(camId) || 0;
    if (now - last < (1000 / CFG.thumbnailFps)) return;
    thumbLastSent.set(camId, now);

    if (!mainWs || !mainConnected) return;

    // Pipe chunk through ffmpeg: webm → single JPEG frame
    const ff = spawn(CFG.ffmpegPath, [
        '-loglevel', 'quiet',
        '-i', 'pipe:0',
        '-vframes', '1',
        '-vf', `scale=${CFG.thumbnailWidth}:-1`,
        '-f', 'image2',
        '-vcodec', 'mjpeg',
        'pipe:1'
    ], { stdio: ['pipe','pipe','ignore'] });

    const chunks = [];
    ff.stdout.on('data', d => chunks.push(d));
    ff.stdout.on('end', () => {
        if (!chunks.length) return;
        const jpeg = Buffer.concat(chunks);
        if (!mainWs || !mainConnected) return;

        const header = JSON.stringify({
            type: 'CAM_THUMBNAIL',
            schoolId: CFG.schoolId,
            camId,
            ts: Date.now(),
            w: CFG.thumbnailWidth
        });
        const headerBuf = Buffer.alloc(256, 0);
        headerBuf.write(header.substring(0, 255));
        try {
            mainWs.send(Buffer.concat([headerBuf, jpeg]));
        } catch(e) {}
    });

    try {
        ff.stdin.write(chunk);
        ff.stdin.end();
    } catch(e) { ff.kill(); }

    setTimeout(() => { try { ff.kill(); } catch(e) {} }, 3000);
}

// ══════════════════════════════════════════════════════════════════════════
//  MAINSERVER CONNECTION  (Tailscale WS)
// ══════════════════════════════════════════════════════════════════════════
function connectToMain() {
    if (mainReconnectTimer) { clearTimeout(mainReconnectTimer); mainReconnectTimer = null; }

    log(`🔗 Connecting to MainServer: ${CFG.mainServerWs}`);

    try {
        mainWs = new WebSocket(CFG.mainServerWs);
    } catch(e) {
        scheduleMainReconnect(); return;
    }

    mainWs.on('open', () => {
        mainConnected = true;
        mainReconnectAttempts = 0;
        log(`✅ Connected to MainServer`);

        // Register this school node
        mainWs.send(JSON.stringify({
            type: 'SCHOOL_REGISTER',
            schoolId: CFG.schoolId,
            httpPort: CFG.httpPort,
            localPort: CFG.localPort,
            videoPort: CFG.videoPort,
            maxCams: CFG.maxCams,
            serverTime: Date.now()
        }));

        // Re-announce any active cameras
        notifyMainCameraState();

        // Replay pending local clients state
        broadcastToLocalFromMain({ type: 'SYNC_STATE', phase: 'LOBBY', mode: 'race' });
    });

    mainWs.on('message', (data) => {
        // Binary data = video relay response (rare) or thumbnails ACK
        if (data instanceof Buffer && data[0] !== 0x7b) return;

        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        handleMainMessage(msg);
    });

    mainWs.on('close', () => {
        mainConnected = false;
        log(`⚠️  MainServer disconnected`);
        scheduleMainReconnect();
    });

    mainWs.on('error', (e) => {
        warn(`MainServer WS error: ${e.message}`);
        mainConnected = false;
        scheduleMainReconnect();
    });
}

function scheduleMainReconnect() {
    if (mainReconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(1.8, mainReconnectAttempts), 30000);
    mainReconnectAttempts++;
    log(`⏳ Reconnecting to MainServer in ${Math.round(delay/1000)}s`);
    mainReconnectTimer = setTimeout(connectToMain, delay);
}

// Messages FROM MainServer → distribute to local clients
function handleMainMessage(msg) {
    switch (msg.type) {

        case 'SCHOOL_REGISTER_OK':
            log(`✅ Registered with MainServer as ${CFG.schoolId}`);
            break;

        // Host on MainServer selected a camera from this school
        case 'VIEW_CAM_REQUEST': {
            if (msg.schoolId !== CFG.schoolId) return;
            const cam = cameras.get(msg.camId);
            if (!cam) {
                mainWs.send(JSON.stringify({ type: 'CAM_NOT_FOUND', camId: msg.camId, schoolId: CFG.schoolId }));
                return;
            }
            // Tell the camera to start WebRTC offer to a specific viewerId
            cam.ws.send(JSON.stringify({
                type: 'VIEWER_JOINED',
                viewerId: msg.viewerId
            }));
            break;
        }

        // WebRTC answer from a MainServer viewer → relay to camera
        case 'SCHOOL_STREAM_ANSWER': {
            if (msg.schoolId !== CFG.schoolId) return;
            const cam = cameras.get(msg.camId);
            if (cam && cam.ws.readyState === WebSocket.OPEN) {
                cam.ws.send(JSON.stringify({
                    type: 'STREAM_ANSWER',
                    sdp: msg.sdp,
                    viewerId: msg.viewerId
                }));
            }
            break;
        }

        case 'SCHOOL_STREAM_ICE': {
            if (msg.schoolId !== CFG.schoolId) return;
            const cam = cameras.get(msg.camId);
            if (cam && cam.ws.readyState === WebSocket.OPEN) {
                cam.ws.send(JSON.stringify({
                    type: 'STREAM_ICE',
                    candidate: msg.candidate,
                    viewerId: msg.viewerId
                }));
            }
            break;
        }

        // School-specific admin commands
        case 'SCHOOL_ADMIN_CMD': {
            if (msg.schoolId !== CFG.schoolId) return;
            // Forward to local admin if connected
            gameWss.clients.forEach(client => {
                const c = localClients.get(client);
                if (c?.role === 'admin' && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(msg.payload));
                }
            });
            break;
        }

        // All game messages from MainServer → broadcast to ALL local clients
        default:
            broadcastToLocalFromMain(msg);
            break;
    }
}

// Broadcast a message from MainServer to all local game clients
function broadcastToLocalFromMain(msg) {
    const data = JSON.stringify(msg);
    gameWss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && !client.isCamera) {
            try { client.send(data); } catch(e) {}
        }
    });
}

// Forward a local client message to MainServer, tagging it with schoolId
function forwardToMain(raw, fromWs) {
    if (!mainWs || !mainConnected) {
        // Queue? For now just drop non-critical; JOIN will retry on reconnect
        return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Tag with school info
    msg._schoolId = CFG.schoolId;
    msg._schoolProxy = true;

    // Track role for this connection
    if (msg.type === 'JOIN' || msg.type === 'RECONNECT') {
        const client = localClients.get(fromWs) || {};
        client.role = 'player';
        client.userId = msg.userId;
        localClients.set(fromWs, client);
    } else if (msg.type === 'JOIN_SPELL') {
        const client = localClients.get(fromWs) || {};
        client.role = 'speller';
        client.userId = msg.userId;
        localClients.set(fromWs, client);
    } else if (msg.type === 'ADMIN_LOGIN') {
        if (msg.key === CFG.adminKey) {
            // Authenticate locally AND forward to MainServer
            const client = localClients.get(fromWs) || {};
            client.role = 'admin';
            localClients.set(fromWs, client);
        }
    } else if (msg.type === 'PRESENTATION_JOIN') {
        const client = localClients.get(fromWs) || {};
        client.role = 'viewer';
        localClients.set(fromWs, client);
    }

    try {
        mainWs.send(JSON.stringify(msg));
    } catch(e) {
        warn(`Failed to forward to MainServer: ${e.message}`);
    }
}

// Notify MainServer about current camera list
function notifyMainCameraState() {
    if (!mainWs || !mainConnected) return;
    const list = [];
    for (let [camId, cam] of cameras.entries()) {
        list.push({
            camId,
            label: cam.label,
            streaming: cam.streaming,
            schoolId: CFG.schoolId
        });
    }
    mainWs.send(JSON.stringify({
        type: 'SCHOOL_CAMERAS_UPDATE',
        schoolId: CFG.schoolId,
        cameras: list,
        serverTime: Date.now()
    }));
}

// ══════════════════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════════════════
(async () => {
    log(`🏫 SchoolServer starting — ID: ${CFG.schoolId}`);
    log(`   Main: ${CFG.mainServerWs}`);
    log(`   Game WS  :${CFG.localPort}  HTTP :${CFG.httpPort}  Video :${CFG.videoPort}`);
    log(`   Max cams: ${CFG.maxCams}`);
    connectToMain();
})();

process.on('SIGINT',  () => { log('Shutting down'); process.exit(0); });
process.on('SIGTERM', () => { log('Shutting down'); process.exit(0); });
process.on('uncaughtException', e => err(`Uncaught: ${e.message}\n${e.stack}`));
process.on('unhandledRejection', (r) => err(`Unhandled rejection: ${r}`));