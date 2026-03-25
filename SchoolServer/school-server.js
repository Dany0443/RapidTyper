/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  RapidTyper — SchoolServer  v2                                      ║
 * ║                                                                     ║
 * ║  Runs on a school laptop that hotspots its own Wi-Fi.               ║
 * ║                                                                     ║
 * ║  • Serves game clients (index.html, spell.html) locally on :8080    ║
 * ║  • Accepts 8 phone cameras via WebRTC signaling on :5889            ║
 * ║  • Accepts raw MediaRecorder binary chunks on :5890                 ║
 * ║  • Records each camera stream to WebM file on disk                  ║
 * ║  • Transcodes to H.265 MP4 via ffmpeg after recording stops        ║
 * ║  • Generates JPEG thumbnails (2fps) and relays to MainServer        ║
 * ║  • Proxies all game WS traffic to MainServer via Tailscale          ║
 * ║  • Routes WebRTC signaling for remote live viewing                  ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * ENV (.env file or environment variables):
 *   MAIN_SERVER_WS   ws://100.x.x.x:5889   Tailscale IP of MainServer
 *   SCHOOL_ID        school-cluj-01
 *   STREAM_KEY       yourSecretKey
 *   ADMIN_KEY        1313
 *   LOCAL_PORT       5889
 *   HTTP_PORT        8080
 *   VIDEO_PORT       5890
 *   MAX_CAMS         8
 *   RECORDINGS_DIR   ./recordings
 *   FFMPEG_PATH      ffmpeg
 */

'use strict';

require('dotenv').config();

const WebSocket = require('ws');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const { spawn } = require('child_process');

// ══════════════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════════════
const CFG = {
    mainServerWs  : process.env.MAIN_SERVER_WS  || 'ws://localhost:5889',
    schoolId      : process.env.SCHOOL_ID       || ('school-' + Math.random().toString(36).substr(2, 6)),
    streamKey     : process.env.STREAM_KEY      || 'stream1234',
    adminKey      : process.env.ADMIN_KEY       || '1313',
    localPort     : parseInt(process.env.LOCAL_PORT)  || 5889,
    httpPort      : parseInt(process.env.HTTP_PORT)   || 8080,
    videoPort     : parseInt(process.env.VIDEO_PORT)  || 5890,
    maxCams       : parseInt(process.env.MAX_CAMS)    || 8,
    recordingsDir : process.env.RECORDINGS_DIR  || path.join(__dirname, 'recordings'),
    staticRoot    : process.env.STATIC_ROOT     || path.join(__dirname, '..', 'ClientWeb'),
    ffmpegPath    : process.env.FFMPEG_PATH     || 'ffmpeg',
    thumbWidth    : 320,
    thumbFps      : 2,
};

if (!fs.existsSync(CFG.recordingsDir)) {
    fs.mkdirSync(CFG.recordingsDir, { recursive: true });
}

// ══════════════════════════════════════════════════════════════════════════
//  LOGGING
// ══════════════════════════════════════════════════════════════════════════
const ts   = ()  => new Date().toISOString().substr(11, 12);
const log  = msg => console.log(`[${ts()}] [INFO]  ${msg}`);
const warn = msg => console.warn(`[${ts()}] [WARN]  ${msg}`);
const err  = msg => console.error(`[${ts()}] [ERROR] ${msg}`);

// ══════════════════════════════════════════════════════════════════════════
//  CAMERA REGISTRY
//  cameras: Map<camId, CameraEntry>
//
//  CameraEntry = {
//    ws            WebSocket|null   game-port WS for signaling
//    videoWs       WebSocket|null   video-port WS for binary chunks
//    authed        boolean
//    streaming     boolean
//    label         string
//    recording     boolean
//    recFile       fs.WriteStream|null
//    recPath       string|null
//    recStartedAt  number|null
//    bytesWritten  number
//    lastChunk     Buffer|null      refreshed on every incoming chunk
//    viewers       Set<string>      viewerIds currently watching
//  }
// ══════════════════════════════════════════════════════════════════════════
const cameras = new Map();

// Local game clients: ws → { role, userId, viewingCam? }
const localClients = new Map();

// ══════════════════════════════════════════════════════════════════════════
//  MAINSERVER CONNECTION
// ══════════════════════════════════════════════════════════════════════════
let mainWs                = null;
let mainConnected         = false;
let mainReconnectAttempts = 0;
let mainReconnectTimer    = null;

function connectToMain() {
    if (mainReconnectTimer) { clearTimeout(mainReconnectTimer); mainReconnectTimer = null; }
    log(`🔗 Connecting to MainServer: ${CFG.mainServerWs}`);
    try { mainWs = new WebSocket(CFG.mainServerWs); }
    catch (e) { scheduleMainReconnect(); return; }

    mainWs.on('open', () => {
        mainConnected         = true;
        mainReconnectAttempts = 0;
        log('✅ Connected to MainServer');
        safeSendMain({
            type     : 'SCHOOL_REGISTER',
            schoolId : CFG.schoolId,
            httpPort : CFG.httpPort,
            localPort: CFG.localPort,
            videoPort: CFG.videoPort,
            maxCams  : CFG.maxCams,
        });
        notifyMainCameraState();
    });

    mainWs.on('message', raw => {
        if (raw instanceof Buffer && raw[0] !== 0x7b) return;
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        handleMainMessage(msg);
    });

    mainWs.on('close', () => {
        mainConnected = false;
        warn('MainServer disconnected');
        scheduleMainReconnect();
    });

    mainWs.on('error', e => {
        warn(`MainServer error: ${e.message}`);
        mainConnected = false;
    });
}

function scheduleMainReconnect() {
    if (mainReconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(1.8, mainReconnectAttempts), 30000);
    mainReconnectAttempts++;
    mainReconnectTimer = setTimeout(connectToMain, delay);
}

function handleMainMessage(msg) {
    switch (msg.type) {

        case 'SCHOOL_REGISTER_OK':
            log(`✅ Registered with MainServer as "${CFG.schoolId}"`);
            break;

        // Host wants to view a camera live (WebRTC)
        case 'VIEW_CAM_REQUEST':
            if (msg.schoolId !== CFG.schoolId) return;
            handleViewCamRequest(msg.camId, msg.viewerId);
            break;

        // WebRTC answer from a remote viewer
        case 'SCHOOL_STREAM_ANSWER':
            if (msg.schoolId !== CFG.schoolId) return;
            sendToCam(msg.camId, { type: 'STREAM_ANSWER', sdp: msg.sdp, viewerId: msg.viewerId });
            break;

        // ICE candidate from a remote viewer
        case 'SCHOOL_STREAM_ICE':
            if (msg.schoolId !== CFG.schoolId) return;
            sendToCam(msg.camId, { type: 'STREAM_ICE', candidate: msg.candidate, viewerId: msg.viewerId });
            break;

        // Recording control from host
        case 'RECORDING_START':
            if (msg.schoolId !== CFG.schoolId) return;
            startRecording(msg.camId);
            break;

        case 'RECORDING_STOP':
            if (msg.schoolId !== CFG.schoolId) return;
            stopRecording(msg.camId);
            break;

        // All other messages → broadcast to local game clients
        default:
            broadcastToLocalClients(JSON.stringify(msg));
            break;
    }
}

function handleViewCamRequest(camId, viewerId) {
    const cam = cameras.get(camId);
    if (!cam) {
        safeSendMain({ type: 'CAM_NOT_FOUND', camId, schoolId: CFG.schoolId });
        return;
    }
    cam.viewers.add(viewerId);
    sendToCam(camId, { type: 'VIEWER_JOINED', viewerId });
    log(`👁️  Viewer ${viewerId} → cam ${camId}`);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function safeSendMain(obj) {
    if (mainWs && mainConnected && mainWs.readyState === WebSocket.OPEN) {
        try { mainWs.send(JSON.stringify(obj)); } catch (e) {}
    }
}

function safeSendMainBinary(buf) {
    if (mainWs && mainConnected && mainWs.readyState === WebSocket.OPEN) {
        try { mainWs.send(buf); } catch (e) {}
    }
}

function sendToCam(camId, obj) {
    const cam = cameras.get(camId);
    if (!cam) return;
    const target = cam.ws?.readyState === WebSocket.OPEN ? cam.ws :
                   cam.videoWs?.readyState === WebSocket.OPEN ? cam.videoWs : null;
    if (target) { try { target.send(JSON.stringify(obj)); } catch (e) {} }
}

function broadcastToLocalClients(data) {
    gameWss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && !client._isCamera) {
            try { client.send(data); } catch (e) {}
        }
    });
}

function notifyMainCameraState() {
    const list = [];
    for (const [camId, cam] of cameras.entries()) {
        list.push({
            camId,
            label       : cam.label,
            streaming   : cam.streaming,
            recording   : cam.recording,
            recFilename : cam.recPath ? path.basename(cam.recPath) : null,
            bytesWritten: cam.bytesWritten,
        });
    }
    safeSendMain({ type: 'SCHOOL_CAMERAS_UPDATE', schoolId: CFG.schoolId, cameras: list });
}

function makeCamEntry(camId, gameWsArg, videoWsArg, label) {
    return {
        ws          : gameWsArg,
        videoWs     : videoWsArg,
        authed      : true,
        streaming   : false,
        label       : label || camId,
        recording   : false,
        recFile     : null,
        recPath     : null,
        recStartedAt: null,
        bytesWritten: 0,
        lastChunk   : null,
        viewers     : new Set(),
    };
}

// ══════════════════════════════════════════════════════════════════════════
//  RECORDING
// ══════════════════════════════════════════════════════════════════════════

function startRecording(camId) {
    const cam = cameras.get(camId);
    if (!cam)          { warn(`startRecording: cam ${camId} not found`);       return; }
    if (cam.recording) { warn(`startRecording: cam ${camId} already recording`); return; }

    const dateStr  = new Date().toISOString().replace(/[:.]/g, '-').substr(0, 19);
    const filename = `${CFG.schoolId}_${camId}_${dateStr}.webm`;
    const filepath = path.join(CFG.recordingsDir, filename);

    cam.recPath      = filepath;
    cam.recFile      = fs.createWriteStream(filepath, { flags: 'w' });
    cam.recording    = true;
    cam.recStartedAt = Date.now();
    cam.bytesWritten = 0;

    cam.recFile.on('error', e => {
        err(`Recording write error (${camId}): ${e.message}`);
        cam.recording = false;
        cam.recFile   = null;
    });

    log(`🔴 Recording started: ${filename}`);
    notifyMainCameraState();
    sendToCam(camId, { type: 'RECORDING_STARTED', filename });
    return filename;
}

function stopRecording(camId) {
    const cam = cameras.get(camId);
    if (!cam || !cam.recording) return;

    cam.recording = false;

    if (cam.recFile) {
        cam.recFile.end(() => {
            const duration = ((Date.now() - cam.recStartedAt) / 1000).toFixed(1);
            const sizeMB   = (cam.bytesWritten / 1024 / 1024).toFixed(2);
            log(`⏹  Recording done: ${path.basename(cam.recPath)} — ${duration}s, ${sizeMB}MB`);
            notifyMainCameraState();
            // Non-blocking H.265 transcode
            transcodeToH265(cam.recPath);
        });
        cam.recFile = null;
    }

    sendToCam(camId, { type: 'RECORDING_STOPPED' });
}

function transcodeToH265(inputPath) {
    // Output file sits next to the .webm
    const outputPath = inputPath.replace(/\.webm$/, '_h265.mp4');

    const args = [
        '-i', inputPath,
        '-c:v', 'libx265',
        '-crf', '28',        // 0=lossless, 28=good balance, 51=worst
        '-preset', 'fast',   // fast tradeoff: not ultra-slow but still small files
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-y',
        outputPath,
    ];

    log(`🔄 Transcoding → H.265: ${path.basename(outputPath)}`);

    const ff = spawn(CFG.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    ff.stderr.on('data', () => {}); // suppress output

    ff.on('close', code => {
        if (code === 0) {
            const stat = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;
            const sizeMB = stat ? (stat.size / 1024 / 1024).toFixed(1) + 'MB' : '?';
            log(`✅ H.265 transcode done: ${path.basename(outputPath)} (${sizeMB})`);
            // Notify MainServer so host.html recordings list updates
            notifyMainCameraState();
        } else {
            warn(`H.265 transcode failed (exit ${code}) — .webm kept`);
        }
    });

    ff.on('error', e => {
        warn(`ffmpeg error: ${e.message} — skipping transcode, .webm kept`);
    });

    // Safety kill after 10 minutes
    setTimeout(() => { try { ff.kill(); } catch (_) {} }, 600_000);
}

// ══════════════════════════════════════════════════════════════════════════
//  THUMBNAIL GENERATION
//  Every 500ms: snapshot one JPEG frame from the latest chunk of each
//  streaming camera and push it to MainServer as a binary frame.
// ══════════════════════════════════════════════════════════════════════════
const thumbLastSent = new Map();

setInterval(() => {
    for (const [camId, cam] of cameras.entries()) {
        if (!cam.streaming || !cam.lastChunk) continue;
        const now  = Date.now();
        const last = thumbLastSent.get(camId) || 0;
        if (now - last < 1000 / CFG.thumbFps) continue;
        thumbLastSent.set(camId, now);
        generateThumbnail(camId, cam.lastChunk);
    }
}, 500);

function generateThumbnail(camId, chunk) {
    if (!mainConnected) return;

    const ff = spawn(CFG.ffmpegPath, [
        '-loglevel', 'quiet',
        '-i',        'pipe:0',
        '-vframes',  '1',
        '-vf',       `scale=${CFG.thumbWidth}:-1`,
        '-f',        'image2',
        '-vcodec',   'mjpeg',
        'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });

    const parts = [];
    ff.stdout.on('data', d => parts.push(d));
    ff.stdout.on('end', () => {
        if (!parts.length || !mainConnected) return;
        const jpeg      = Buffer.concat(parts);
        const header    = JSON.stringify({
            type    : 'CAM_THUMBNAIL',
            schoolId: CFG.schoolId,
            camId,
            camKey  : `${CFG.schoolId}::${camId}`,
            ts      : Date.now(),
            w       : CFG.thumbWidth,
        });
        const headerBuf = Buffer.alloc(256, 0);
        headerBuf.write(header.substring(0, 255));
        safeSendMainBinary(Buffer.concat([headerBuf, jpeg]));
    });

    try { ff.stdin.write(chunk); ff.stdin.end(); }
    catch (e) { try { ff.kill(); } catch (_) {} }

    setTimeout(() => { try { ff.kill(); } catch (_) {} }, 4000);
}

// ══════════════════════════════════════════════════════════════════════════
//  VIDEO PORT WS SERVER  :5890
//  Phones can connect here to send raw MediaRecorder binary chunks.
// ══════════════════════════════════════════════════════════════════════════
const videoWss = new WebSocket.Server({ port: CFG.videoPort });

videoWss.on('connection', ws => {
    ws.isAlive = true;
    ws.camId   = null;
    ws.authed  = false;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', raw => {
        // Text / JSON control message
        if (typeof raw === 'string' || (raw instanceof Buffer && raw[0] === 0x7b)) {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }

            if (msg.type === 'STREAM_AUTH') {
                if (msg.key !== CFG.streamKey) {
                    ws.send(JSON.stringify({ type: 'STREAM_AUTH_FAIL' }));
                    ws.terminate(); return;
                }
                if (cameras.size >= CFG.maxCams && !cameras.has(msg.camId)) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Camera slots full' }));
                    ws.terminate(); return;
                }
                ws.authed = true;
                ws.camId  = msg.camId || ('vcam-' + Date.now());

                const existing = cameras.get(ws.camId);
                if (existing) { existing.videoWs = ws; }
                else          { cameras.set(ws.camId, makeCamEntry(ws.camId, null, ws, msg.label)); }

                ws.send(JSON.stringify({ type: 'STREAM_AUTH_OK', camId: ws.camId }));
                log(`📷 Video-port cam authed: ${ws.camId}`);
                notifyMainCameraState();
                return;
            }

            if (!ws.authed) { ws.terminate(); return; }
            handleCamControlMsg(ws.camId, msg);
            return;
        }

        // Binary = raw MediaRecorder chunk
        if (!ws.authed || !ws.camId) return;
        const cam = cameras.get(ws.camId);
        if (!cam || !cam.streaming) return;
        handleVideoChunk(ws.camId, cam, raw);
    });

    ws.on('close', () => {
        if (!ws.camId) return;
        const cam = cameras.get(ws.camId);
        if (!cam) return;
        cam.videoWs = null;
        if (cam.recording) stopRecording(ws.camId);
        if (!cam.ws || cam.ws.readyState !== WebSocket.OPEN) {
            cameras.delete(ws.camId);
            notifyMainCameraState();
        }
    });

    ws.on('error', () => {});
});

setInterval(() => {
    videoWss.clients.forEach(ws => {
        if (!ws.isAlive) { ws.terminate(); return; }
        ws.isAlive = false; ws.ping();
    });
}, 25000);

log(`📽️  Video WS server on :${CFG.videoPort}`);

// ══════════════════════════════════════════════════════════════════════════
//  GAME PORT WS SERVER  :5889
//  All players, spellers, host, and presentation screens connect here.
//  Camera phones also connect here for WebRTC signaling (stream.js).
// ══════════════════════════════════════════════════════════════════════════
const gameWss = new WebSocket.Server({ port: CFG.localPort });

gameWss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.send(JSON.stringify({ type: 'SYNC_STATE', phase: 'LOBBY', mode: 'race' }));

    ws.on('message', raw => {
        if (raw.length > 128 * 1024) return;
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // Camera auth comes first
        if (msg.type === 'STREAM_AUTH') { handleGamePortAuth(ws, msg); return; }

        // If this is an authenticated camera, handle its messages here
        if (ws._isCamera) { handleCamControlMsg(ws.camId, msg); return; }

        // Regular game client → track role, forward to MainServer
        trackClientRole(ws, msg);
        proxyToMain(msg);
    });

    ws.on('close', () => {
        if (ws._isCamera && ws.camId) {
            const cam = cameras.get(ws.camId);
            if (cam) {
                cam.ws = null;
                if (cam.recording) stopRecording(ws.camId);
                if (!cam.videoWs || cam.videoWs.readyState !== WebSocket.OPEN) {
                    cameras.delete(ws.camId);
                    broadcastToLocalClients(JSON.stringify({
                        type: 'CAM_OFFLINE', camId: ws.camId, schoolId: CFG.schoolId,
                    }));
                    notifyMainCameraState();
                    log(`📷 Camera ${ws.camId} disconnected`);
                }
            }
        }

        const client = localClients.get(ws);
        localClients.delete(ws);
        if (client?.userId && mainConnected) {
            safeSendMain({
                type    : 'SCHOOL_CLIENT_DISCONNECT',
                schoolId: CFG.schoolId,
                userId  : client.userId,
            });
        }
    });

    ws.on('error', () => {});
});

setInterval(() => {
    gameWss.clients.forEach(ws => {
        if (!ws.isAlive) { ws.terminate(); return; }
        ws.isAlive = false; ws.ping();
    });
}, 30000);

log(`🎮 Game WS server on :${CFG.localPort}`);

function handleGamePortAuth(ws, msg) {
    if (msg.key !== CFG.streamKey) {
        ws.send(JSON.stringify({ type: 'STREAM_AUTH_FAIL' })); return;
    }
    if (cameras.size >= CFG.maxCams && !cameras.has(msg.camId)) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Camera slots full' })); return;
    }
    const camId      = msg.camId || ('cam-' + Date.now());
    ws._isCamera     = true;
    ws.camId         = camId;

    const existing = cameras.get(camId);
    if (existing) { existing.ws = ws; }
    else          { cameras.set(camId, makeCamEntry(camId, ws, null, msg.label || camId)); }

    ws.send(JSON.stringify({ type: 'STREAM_AUTH_OK', camId }));
    log(`📷 Game-port cam authed: ${camId}`);
    notifyMainCameraState();
}

// ── Camera control messages (used by both ports) ──────────────────────────

function handleCamControlMsg(camId, msg) {
    const cam = cameras.get(camId);
    if (!cam) return;

    switch (msg.type) {

        case 'STREAM_START':
            cam.streaming = true;
            cam.label     = msg.label || camId;
            log(`▶️  Camera ${camId} streaming`);
            notifyMainCameraState();
            broadcastToLocalClients(JSON.stringify({
                type: 'CAM_LIVE', camId, schoolId: CFG.schoolId, label: cam.label,
            }));
            break;

        case 'STREAM_STOP':
            cam.streaming = false;
            if (cam.recording) stopRecording(camId);
            log(`⏹  Camera ${camId} stopped`);
            notifyMainCameraState();
            broadcastToLocalClients(JSON.stringify({
                type: 'CAM_OFFLINE', camId, schoolId: CFG.schoolId,
            }));
            break;

        // WebRTC offer from camera → relay to all waiting viewers
        case 'STREAM_OFFER':
            // Local viewers on the same network
            gameWss.clients.forEach(client => {
                const c = localClients.get(client);
                if (c?.viewingCam === camId && client.readyState === WebSocket.OPEN) {
                    try { client.send(JSON.stringify({
                        type    : 'STREAM_OFFER',
                        camId,
                        camKey  : `${CFG.schoolId}::${camId}`,
                        sdp     : msg.sdp,
                        viewerId: msg.viewerId,
                        schoolId: CFG.schoolId,
                    })); } catch (_) {}
                }
            });
            // Remote viewers via MainServer
            safeSendMain({
                type    : 'SCHOOL_STREAM_OFFER',
                schoolId: CFG.schoolId,
                camId,
                camKey  : `${CFG.schoolId}::${camId}`,
                sdp     : msg.sdp,
                viewerId: msg.viewerId,
            });
            break;

        // ICE candidate from camera → relay to viewers
        case 'STREAM_ICE':
            gameWss.clients.forEach(client => {
                const c = localClients.get(client);
                if (c?.viewingCam === camId && client.readyState === WebSocket.OPEN) {
                    try { client.send(JSON.stringify({
                        type     : 'STREAM_ICE_FROM_CAM',
                        camId,
                        camKey   : `${CFG.schoolId}::${camId}`,
                        candidate: msg.candidate,
                    })); } catch (_) {}
                }
            });
            safeSendMain({
                type     : 'SCHOOL_STREAM_ICE_FROM_CAM',
                schoolId : CFG.schoolId,
                camId,
                camKey   : `${CFG.schoolId}::${camId}`,
                candidate: msg.candidate,
                viewerId : msg.viewerId,
            });
            break;

        case 'PING':
            sendToCam(camId, { type: 'PONG' });
            break;
    }
}

// ── Video chunk handler ────────────────────────────────────────────────────

function handleVideoChunk(camId, cam, chunk) {
    cam.lastChunk = Buffer.from(chunk);

    // 1. Write to disk if recording
    if (cam.recording && cam.recFile) {
        try {
            cam.recFile.write(cam.lastChunk);
            cam.bytesWritten += cam.lastChunk.length;
            if (cam.bytesWritten % (10 * 1024 * 1024) < cam.lastChunk.length) {
                log(`💾 ${camId}: ${(cam.bytesWritten / 1024 / 1024).toFixed(1)}MB recorded`);
            }
        } catch (e) {
            err(`Write error (${camId}): ${e.message}`);
            cam.recording = false;
            cam.recFile   = null;
        }
    }

    // 2. Relay raw chunk to MainServer for presentation MSE playback
    const header    = JSON.stringify({
        type    : 'VIDEO_CHUNK',
        schoolId: CFG.schoolId,
        camId,
        camKey  : `${CFG.schoolId}::${camId}`,
        ts      : Date.now(),
    });
    const headerBuf = Buffer.alloc(256, 0);
    headerBuf.write(header.substring(0, 255));
    safeSendMainBinary(Buffer.concat([headerBuf, cam.lastChunk]));
}

// ── Client role tracking ───────────────────────────────────────────────────

function trackClientRole(ws, msg) {
    if (!localClients.has(ws)) localClients.set(ws, {});
    const client = localClients.get(ws);
    if      (msg.type === 'JOIN' || msg.type === 'RECONNECT') { client.role = 'player';  client.userId = msg.userId; }
    else if (msg.type === 'JOIN_SPELL')                       { client.role = 'speller'; client.userId = msg.userId; }
    else if (msg.type === 'ADMIN_LOGIN')                      { client.role = 'admin';   }
    else if (msg.type === 'PRESENTATION_JOIN')                { client.role = 'viewer';  }
}

function proxyToMain(msg) {
    msg._schoolId    = CFG.schoolId;
    msg._schoolProxy = true;
    safeSendMain(msg);
}

// ══════════════════════════════════════════════════════════════════════════
//  STATIC HTTP + RECORDINGS SERVER  :8080
// ══════════════════════════════════════════════════════════════════════════
const MIME = {
    '.html' : 'text/html; charset=utf-8',
    '.js'   : 'application/javascript',
    '.css'  : 'text/css',
    '.png'  : 'image/png',
    '.jpg'  : 'image/jpeg',
    '.ico'  : 'image/x-icon',
    '.json' : 'application/json',
    '.woff2': 'font/woff2',
    '.webm' : 'video/webm',
    '.mp4'  : 'video/mp4',
};

const httpServer = http.createServer((req, res) => {
    const setCors = () => res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/health') {
        setCors();
        const camList = [];
        for (const [id, cam] of cameras.entries()) {
            camList.push({ camId: id, streaming: cam.streaming, recording: cam.recording, bytesWritten: cam.bytesWritten });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', schoolId: CFG.schoolId, mainConnected, cameras: camList, uptime: process.uptime() }, null, 2));
    }

    // List all recordings as JSON
    if (req.url === '/recordings') {
        setCors();
        fs.readdir(CFG.recordingsDir, (e, files) => {
            if (e) { res.writeHead(500); res.end('Error'); return; }
            const items = files
                .filter(f => /\.(webm|mp4)$/.test(f))
                .map(f => {
                    const fp   = path.join(CFG.recordingsDir, f);
                    const stat = fs.statSync(fp);
                    return { name: f, sizeMB: parseFloat((stat.size / 1024 / 1024).toFixed(2)), mtime: stat.mtime };
                })
                .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(items));
        });
        return;
    }

    // Download a specific recording
    if (req.url.startsWith('/recordings/')) {
        const filename = path.basename(decodeURIComponent(req.url.replace('/recordings/', '')));
        const filepath = path.join(CFG.recordingsDir, filename);
        if (!fs.existsSync(filepath)) { res.writeHead(404); res.end('Not found'); return; }
        const stat = fs.statSync(filepath);
        const ext  = path.extname(filename).toLowerCase();
        res.writeHead(200, {
            'Content-Type'       : MIME[ext] || 'application/octet-stream',
            'Content-Length'     : stat.size,
            'Content-Disposition': `attachment; filename="${filename}"`,
        });
        fs.createReadStream(filepath).pipe(res);
        return;
    }

    // Static files
    const urlPath  = req.url.split('?')[0];
    const filePath = path.join(CFG.staticRoot, urlPath === '/' ? 'index.html' : urlPath);
    fs.readFile(filePath, (e, data) => {
        if (e) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

httpServer.listen(CFG.httpPort, '0.0.0.0', () => {
    log(`🌐 HTTP on :${CFG.httpPort}  (static files + recordings)`);
    log(`   GET /health           → server status`);
    log(`   GET /recordings       → list recordings (JSON)`);
    log(`   GET /recordings/:file → download recording`);
});

// ══════════════════════════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ══════════════════════════════════════════════════════════════════════════
async function shutdown(signal) {
    log(`${signal} — shutting down`);
    for (const [camId] of cameras.entries()) {
        stopRecording(camId);
    }
    await new Promise(r => setTimeout(r, 2000)); // let streams flush
    process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  e => err(`Uncaught: ${e.message}\n${e.stack}`));
process.on('unhandledRejection', r => err(`Unhandled: ${r}`));

// ══════════════════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════════════════
log(`🏫 SchoolServer — ID: ${CFG.schoolId}`);
log(`   MainServer : ${CFG.mainServerWs}`);
log(`   Ports: game=${CFG.localPort}  http=${CFG.httpPort}  video=${CFG.videoPort}`);
log(`   Max cameras : ${CFG.maxCams}`);
log(`   Recordings  : ${CFG.recordingsDir}`);

connectToMain();