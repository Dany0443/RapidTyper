/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  RapidTyper — SchoolServer  v2                                       ║
 * ║                                                                      ║
 * ║  Runs on a school laptop that hotspots its own Wi-Fi.                ║
 * ║                                                                      ║
 * ║  • Serves game clients (index.html, spell.html) locally on :8080     ║
 * ║  • Accepts 8 phone cameras via WebRTC signaling on :5889             ║
 * ║  • Accepts raw MediaRecorder binary chunks on :5890                  ║
 * ║  • Records each camera stream to WebM file on disk                   ║
 * ║  • Transcodes to H.265 MP4 via ffmpeg after recording stops          ║
 * ║  • Generates JPEG thumbnails (2fps) and relays to MainServer         ║
 * ║  • Proxies all game WS traffic to MainServer via Tailscale           ║
 * ║  • Routes WebRTC signaling for remote live viewing                   ║
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

const WebSocket   = require('ws');
const http        = require('http');
const https       = require('https');
const { execSync, spawnSync } = require('child_process');
const fs        = require('fs');
const path      = require('path');
const { spawn } = require('child_process');
const readline  = require('readline');

// Shared static file middleware
let serveStatic;
try {
    ({ serveStatic } = require('../shared-static'));
} catch (_) {
    try { ({ serveStatic } = require('./shared-static')); }
    catch (_) { serveStatic = () => false; }
}

const sharedConfig = require('../shared/config');
const Logger = require('../shared/logger');

// ══════════════════════════════════════════════════════════════════════════
//  LOGGING
// ══════════════════════════════════════════════════════════════════════════
const logger = new Logger(path.join(__dirname, 'logs'));
// ── Compatibility shim — works with both old and new logger ──────────────────
if (!logger.banner) logger.banner = (name, ver) => logger.info(`=== ${name} v${ver} started ===`);
if (!logger.cam)    logger.cam    = m => logger.info(m);
if (!logger.school) logger.school = m => logger.info(m);
if (!logger.net)    logger.net    = m => logger.info(m);
if (!logger.game)   logger.game   = m => logger.info(m);
if (!logger.rec)    logger.rec    = m => logger.info(m);
if (!logger.http)   logger.http   = m => logger.info(m);
if (!logger.ws)     logger.ws     = m => logger.info(m);
if (!logger.sep)    logger.sep    = () => {};
if (!logger.statusBlock) logger.statusBlock = rows => rows.forEach(r => r && r.key ? logger.info(`${String(r.key).padEnd(18)}${r.val}`) : null);
const log  = msg => logger.info(msg);
const warn = msg => logger.warn(msg);
const err  = msg => logger.error(msg);

// ══════════════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════════════
const CFG = {
    mainServerWs  : sharedConfig.MAIN_SERVER_WS,
    schoolId      : sharedConfig.SCHOOL_ID,
    streamKey     : sharedConfig.STREAM_KEY,
    adminKey      : sharedConfig.ADMIN_KEY,
    localPort     : sharedConfig.LOCAL_PORT,
    httpPort      : sharedConfig.HTTP_PORT,
    videoPort     : sharedConfig.VIDEO_PORT,
    maxCams       : sharedConfig.MAX_CAMS,
    recordingsDir : sharedConfig.RECORDINGS_DIR,
    staticRoot    : sharedConfig.STATIC_ROOT,
    ffmpegPath    : sharedConfig.FFMPEG_PATH,
    thumbWidth    : 320,
    thumbFps      : 2,
    httpsPort     : sharedConfig.HTTPS_PORT,
    certDir       : sharedConfig.CERT_DIR,
};

if (!fs.existsSync(CFG.recordingsDir)) {
    fs.mkdirSync(CFG.recordingsDir, { recursive: true });
}
// ══════════════════════════════════════════════════════════════════════════
//  TLS CERTIFICATE  (auto-generated self-signed, one-time)
//  Phones must open the stream page over HTTPS because browsers block
//  getUserMedia on plain HTTP.  We generate a cert once on first run and
//  reuse it every time after.  Phones see a "Not private" warning on the
//  very first visit — they tap  Advanced → Proceed  and the camera works.
// ══════════════════════════════════════════════════════════════════════════
if (!fs.existsSync(CFG.certDir)) fs.mkdirSync(CFG.certDir, { recursive: true });

const CERT_KEY = path.join(CFG.certDir, 'server.key');
const CERT_CRT = path.join(CFG.certDir, 'server.crt');

function getLocalIp() {
    try {
        const nets = require('os').networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const iface of nets[name]) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
    } catch (_) {}
    return '0.0.0.0';
}

function ensureCert() {
    if (fs.existsSync(CERT_KEY) && fs.existsSync(CERT_CRT)) {
        const keyStat = fs.statSync(CERT_KEY);
        const crtStat = fs.statSync(CERT_CRT);
        if (keyStat.size > 0 && crtStat.size > 0) {
            log('🔐 TLS cert found — HTTPS will be available');
            return true;
        }
        warn('🔐 TLS cert files are empty — regenerating...');
    }
    
    log('🔐 Generating self-signed TLS certificate (runs once)...');
    const ip  = getLocalIp();
    const ext = path.join(CFG.certDir, 'v3.ext');
    
    try {
        fs.writeFileSync(ext, [
            '[req]\nreq_extensions=v3_req\ndistinguished_name=dn\nprompt=no',
            '[dn]\nCN=rapidtyper.local',
            '[v3_req]\nsubjectAltName=@alt',
            '[alt]',
            `IP.1=${ip}`,
            'IP.2=127.0.0.1',
            'DNS.1=localhost',
        ].join('\n'));
        
        const openssl_paths = [
            'openssl',
            'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
            'C:\\Program Files (x86)\\OpenSSL-Win32\\bin\\openssl.exe',
            '/usr/bin/openssl',
            '/usr/local/bin/openssl'
        ];
        
        let r = { status: -1 };
        for (const p of openssl_paths) {
            r = spawnSync(p, [
                'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                '-keyout', CERT_KEY, '-out', CERT_CRT,
                '-days', '3650', '-subj', '/CN=rapidtyper.local/O=RapidTyper',
                '-extensions', 'v3_req', '-config', ext,
            ], { stdio: 'pipe' });
            if (r.status === 0) break;
        }
        
        if (r.status !== 0) {
            warn('❌ openssl failed — no HTTPS. Is openssl installed?');
            warn('   Ensure openssl is in your PATH or installed at C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe');
            return false;
        }
        
        log(`✅ Certificate written to ${CFG.certDir}`);
        return true;
    } catch (e) {
        err(`❌ Failed to generate certificate: ${e.message}`);
        return false;
    }
}

const TLS_OK = ensureCert();

function checkFfmpeg() {
    try {
        spawnSync(CFG.ffmpegPath, ['-version'], { stdio: 'ignore' });
        return true;
    } catch (_) {
        warn(`FFMPEG NOT FOUND at "${CFG.ffmpegPath}"`);
        warn('Recording and transcoding will fail. Please install ffmpeg.');
        warn('  Windows: choco install ffmpeg');
        warn('  Linux:   sudo apt install ffmpeg');
        return false;
    }
}
const FFMPEG_OK = checkFfmpeg();

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
let _lastMainMsg          = 0;     // epoch ms of last received message
let _heartbeatTimer       = null;
let _regConfirmTimer      = null;  // fires if SCHOOL_REGISTER_OK not received in time

// Queue: VIEW_CAM_REQUEST that arrived before the camera's videoWs was ready
// Map<camId, Array<{ viewerId, queuedAt }>>
const pendingViewerQueue = new Map();

function connectToMain() {
    if (mainReconnectTimer) { clearTimeout(mainReconnectTimer); mainReconnectTimer = null; }

    const attempt = mainReconnectAttempts;
    if (attempt > 0) {
        logger.net(`🔁 Reconnect attempt #${attempt} → ${CFG.mainServerWs}`);
    } else {
        logger.net(`🔗 Connecting to MainServer: ${CFG.mainServerWs}`);
    }

    try { mainWs = new WebSocket(CFG.mainServerWs); }
    catch (e) { warn(`MainServer WS create error: ${e.message}`); scheduleMainReconnect(); return; }

    mainWs.on('open', () => {
        mainConnected         = true;
        mainReconnectAttempts = 0;
        _lastMainMsg          = Date.now();
        log(`✅ Connected to MainServer`);

        _startHeartbeat();

        // Send registration
        safeSendMain({
            type     : 'SCHOOL_REGISTER',
            schoolId : CFG.schoolId,
            httpPort : CFG.httpPort,
            localPort: CFG.localPort,
            videoPort: CFG.videoPort,
            maxCams  : CFG.maxCams,
        });

        // If SCHOOL_REGISTER_OK not received in 5s, log a warning
        if (_regConfirmTimer) clearTimeout(_regConfirmTimer);
        _regConfirmTimer = setTimeout(() => {
            if (mainConnected) {
                warn(`⚠️  No SCHOOL_REGISTER_OK after 5s — MainServer may not have accepted registration`);
                // Retry registration once
                safeSendMain({
                    type: 'SCHOOL_REGISTER', schoolId: CFG.schoolId,
                    httpPort: CFG.httpPort, localPort: CFG.localPort,
                    videoPort: CFG.videoPort, maxCams: CFG.maxCams,
                });
            }
        }, 5000);

        // Delay camera-state broadcast by 300ms to give MainServer time to process SCHOOL_REGISTER
        setTimeout(notifyMainCameraState, 300);
    });

    mainWs.on('message', raw => {
        _lastMainMsg = Date.now();
        _missedPings = 0;   // any message from main proves connection is alive
        if (raw instanceof Buffer && raw[0] !== 0x7b) return;
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        handleMainMessage(msg);
    });

    mainWs.on('close', (code, reason) => {
        mainConnected = false;
        _stopHeartbeat();
        const why = reason?.toString() || 'no reason';
        warn(`📶 MainServer disconnected (code ${code}: ${why})`);
        scheduleMainReconnect();
    });

    mainWs.on('error', e => {
        warn(`📶 MainServer error: ${e.message}`);
        mainConnected = false;
        // 'close' fires after 'error' — reconnect is handled there
    });
}

function scheduleMainReconnect() {
    if (mainReconnectTimer) return;
    // Exponential backoff: 1s, 1.8s, 3.2s … capped at 30s
    const delay = Math.min(1000 * Math.pow(1.8, mainReconnectAttempts), 30000);
    mainReconnectAttempts++;
    logger.net(`🔁 Will retry in ${(delay / 1000).toFixed(1)}s  (attempt #${mainReconnectAttempts})`);
    mainReconnectTimer = setTimeout(connectToMain, delay);
}

// ── Heartbeat: ping main server every 30s, detect true silence after 5 min ───
// The main server only sends messages when there is game activity. During idle
// periods it sends nothing to school nodes — that is normal, not a dead connection.
// We send our own PING and update _lastMainMsg on any response (including PONG).
// Only declare the connection dead if we haven't heard ANYTHING for 5 minutes
// AND our last ping went unanswered for 2 intervals (60s).
let _lastPingSent = 0;
let _missedPings  = 0;

function _startHeartbeat() {
    _stopHeartbeat();
    _missedPings  = 0;
    _lastPingSent = 0;
    _heartbeatTimer = setInterval(() => {
        if (!mainConnected || !mainWs || mainWs.readyState !== 1) return;

        const now    = Date.now();
        const silent = now - _lastMainMsg;

        // Send a ping every 30s regardless
        try { mainWs.send(JSON.stringify({ type: 'PING', from: 'school', schoolId: CFG.schoolId })); }
        catch (_) {}

        // If we sent a ping last interval and got no reply at all, count it
        if (_lastPingSent > 0 && silent > (_lastPingSent - _lastMainMsg + 5000)) {
            _missedPings++;
        } else {
            _missedPings = 0;
        }
        _lastPingSent = now;

        // Only force-reconnect if silent for 5 min AND 2+ consecutive pings unanswered
        if (silent > 300_000 && _missedPings >= 2) {
            warn(`💔 MainServer truly silent for ${Math.round(silent / 1000)}s (${_missedPings} pings unanswered) — forcing reconnect`);
            try { mainWs.terminate(); } catch (_) {}
            mainConnected = false;
            _stopHeartbeat();
            scheduleMainReconnect();
        }
    }, 30_000);
}

function _stopHeartbeat() {
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

function handleMainMessage(msg) {
    switch (msg.type) {

        case 'SCHOOL_REGISTER_OK':
            if (_regConfirmTimer) { clearTimeout(_regConfirmTimer); _regConfirmTimer = null; }
            logger.school(`✅ Registered with MainServer as "${CFG.schoolId}"`);
            break;

        case 'PONG':
            // Heartbeat reply — _lastMainMsg and _missedPings already updated in message handler
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

        // All other messages from MainServer → route to the right local client(s)
        default: {
            // If the message carries a _lcid, it's a targeted reply to one specific client
            // (e.g. JOIN_SUCCESS, GAME_IN_PROGRESS, AUTH_SUCCESS, USERNAME_CHANGED)
            if (msg._lcid) {
                const targetWs = lcidToWs.get(msg._lcid);
                // Strip routing metadata before forwarding
                const { _lcid, _schoolId, _schoolProxy, ...clean } = msg;
                const data = JSON.stringify(clean);
                if (targetWs?.readyState === WebSocket.OPEN) {
                    try { targetWs.send(data); } catch (_) {}
                }
                // Some targeted replies are also useful to broadcast (e.g. USERNAME_CHANGED
                // must reach the client, but UPDATE_LOBBY should reach everyone)
                const alsobroadcast = new Set([
                    'UPDATE_LOBBY', 'START_GAME', 'GAME_OVER', 'COUNTDOWN',
                    'FORCE_RESET', 'SERIES_COMPLETE', 'SERIES_OVER', 'SERVER_SHUTDOWN',
                    'UPDATE_SPELLERS', 'SPELL_START', 'SPELL_END', 'MODE_CHANGED',
                    'SYNC_STATE', 'TIME_SYNC', 'FULL_STATE_SYNC',
                ]);
                if (alsobroadcast.has(clean.type)) {
                    broadcastToLocalClients(data);
                }
            } else {
                // No _lcid → broadcast to all local clients
                const { _schoolId, _schoolProxy, ...clean } = msg;
                broadcastToLocalClients(JSON.stringify(clean));
            }
            break;
        }
    }
}

function handleViewCamRequest(camId, viewerId) {
    const cam = cameras.get(camId);
    if (!cam) {
        safeSendMain({ type: 'CAM_NOT_FOUND', camId, schoolId: CFG.schoolId });
        logger.cam(`⚠️  VIEW requested for unknown cam ${camId} (viewer ${viewerId})`);
        return;
    }

    // If camera exists but videoWs not ready yet, queue the request for up to 6s
    const videoReady = cam.videoWs?.readyState === WebSocket.OPEN;
    const gameReady  = cam.ws?.readyState === WebSocket.OPEN;
    if (!videoReady && !gameReady) {
        if (!pendingViewerQueue.has(camId)) pendingViewerQueue.set(camId, []);
        pendingViewerQueue.get(camId).push({ viewerId, queuedAt: Date.now() });
        logger.cam(`⏳ VIEW queued for ${camId} (not yet ready) — viewer ${viewerId}`);
        // Self-expiring: processed in flushPendingViewers on STREAM_START
        return;
    }

    cam.viewers.add(viewerId);
    sendToCam(camId, { type: 'VIEWER_JOINED', viewerId });
    logger.cam(`👁️  Viewer ${viewerId} → cam ${camId}`);
}

// Called after a camera's WebRTC link becomes ready (STREAM_START)
function flushPendingViewers(camId) {
    const queue = pendingViewerQueue.get(camId);
    if (!queue || !queue.length) return;
    const now    = Date.now();
    const valid  = queue.filter(q => now - q.queuedAt < 6000);
    const expired = queue.length - valid.length;
    pendingViewerQueue.delete(camId);
    if (expired > 0) logger.cam(`⚠️  ${expired} queued viewer(s) for ${camId} expired before flush`);
    valid.forEach(({ viewerId }) => {
        const cam = cameras.get(camId);
        if (!cam) return;
        cam.viewers.add(viewerId);
        sendToCam(camId, { type: 'VIEWER_JOINED', viewerId });
        logger.cam(`👁️  Flushed queued viewer ${viewerId} → cam ${camId}`);
    });
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

// Ring-buffer: keep the last ~10s of chunks per camera so that when recording
// starts we can write the init segment + recent data instead of starting mid-stream
// (a webm without its init cluster is unreadable by anything).
// Map<camId, Buffer[]>   — cleared when recording stops
const chunkBuffers = new Map();
const CHUNK_BUF_MAX = 20;   // ~10s at 1s timeslice

function bufferChunk(camId, chunk) {
    if (!chunkBuffers.has(camId)) chunkBuffers.set(camId, []);
    const buf = chunkBuffers.get(camId);
    buf.push(chunk);
    if (buf.length > CHUNK_BUF_MAX) buf.shift();
}

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

    // ── Flush buffered chunks so the file starts with the init segment ──
    const buffered = chunkBuffers.get(camId) || [];
    if (buffered.length > 0) {
        log(`🔴 Writing ${buffered.length} buffered chunk(s) → ${filename}`);
        for (const chunk of buffered) {
            try {
                cam.recFile.write(chunk);
                cam.bytesWritten += chunk.length;
            } catch (e) { err(`Buffer flush error (${camId}): ${e.message}`); break; }
        }
    } else {
        log(`🔴 Recording started (no buffer yet): ${filename}`);
    }
    // Clear buffer — from here chunks write directly
    chunkBuffers.set(camId, []);

    notifyMainCameraState();
    sendToCam(camId, { type: 'RECORDING_STARTED', filename });
    return filename;
}

function stopRecording(camId) {
    const cam = cameras.get(camId);
    if (!cam || !cam.recording) return;

    cam.recording = false;
    chunkBuffers.delete(camId);

    if (cam.recFile) {
        cam.recFile.end(() => {
            const duration = ((Date.now() - cam.recStartedAt) / 1000).toFixed(1);
            const sizeMB   = (cam.bytesWritten / 1024 / 1024).toFixed(2);
            log(`⏹  Recording saved: ${path.basename(cam.recPath)} — ${duration}s, ${sizeMB} MB`);
            notifyMainCameraState();
            if (cam.bytesWritten > 50_000) {
                transcodeToMp4(cam.recPath);
            } else {
                warn(`⚠️  Recording too small (${sizeMB} MB) — skipping transcode`);
            }
        });
        cam.recFile = null;
    }

    sendToCam(camId, { type: 'RECORDING_STOPPED' });
}

function transcodeToMp4(inputPath) {
    if (!FFMPEG_OK) {
        warn(`⚠️  ffmpeg not available — keeping .webm: ${path.basename(inputPath)}`);
        return;
    }

    const outputPath = inputPath.replace(/\.webm$/, '.mp4');
    log(`🔄 Transcoding → MP4: ${path.basename(inputPath)}`);

    // Strategy:
    //   1. Try re-encoding video with libx264 + aac (most compatible)
    //   2. If that fails, try stream-copy (fastest, works when codec is already h264)
    //   3. If both fail, keep the .webm as-is and log clearly

    function attemptTranscode(args, label, onFail) {
        const ff = spawn(CFG.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let ffErr = '';
        ff.stderr.on('data', d => { ffErr += d.toString().slice(-500); });  // keep last 500 chars

        ff.on('close', code => {
            if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
                const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
                log(`✅ Transcode done [${label}]: ${path.basename(outputPath)} (${sizeMB} MB)`);
                notifyMainCameraState();
            } else {
                warn(`⚠️  Transcode failed [${label}] (exit ${code}): ${ffErr.trim().split('\n').pop()}`);
                try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
                if (onFail) onFail();
            }
        });

        ff.on('error', e => {
            warn(`⚠️  ffmpeg spawn error [${label}]: ${e.message}`);
            if (onFail) onFail();
        });

        setTimeout(() => { try { ff.kill(); } catch (_) {} }, 600_000);
        return ff;
    }

    // Pass 1: re-encode (vp8/vp9 webm → h264 mp4)
    const encodeArgs = [
        '-y', '-i', inputPath,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-max_muxing_queue_size', '1024',
        outputPath,
    ];

    attemptTranscode(encodeArgs, 'libx264', () => {
        // Pass 2: stream copy (if camera already sent h264 — rare on WebRTC but possible)
        const copyArgs = [
            '-y', '-i', inputPath,
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            outputPath,
        ];
        attemptTranscode(copyArgs, 'copy', () => {
            warn(`⚠️  All transcode attempts failed — .webm is kept: ${path.basename(inputPath)}`);
        });
    });
}

// ══════════════════════════════════════════════════════════════════════════
//  THUMBNAIL GENERATION
//  Primary path: camera phone sends CAM_THUMB (canvas JPEG) every 2s.
//  Fallback path: if no phone-side thumb in 60s, try ffmpeg on lastChunk.
//  The phone canvas path is faster, always on, and needs no ffmpeg.
// ══════════════════════════════════════════════════════════════════════════
const thumbLastSent     = new Map();   // camId → last sent timestamp (any source)
const thumbFfmpegActive = new Map();   // camId → bool (prevent parallel ffmpeg)

// Phone-side canvas thumbnail received — relay immediately to MainServer
function relayPhoneThumbnail(camId, jpegB64, w) {
    if (!mainConnected) return;
    thumbLastSent.set(camId, Date.now());
    try {
        const jpeg      = Buffer.from(jpegB64, 'base64');
        const header    = JSON.stringify({
            type    : 'CAM_THUMBNAIL', schoolId: CFG.schoolId,
            camId, camKey: `${CFG.schoolId}::${camId}`, ts: Date.now(), w: w || 320,
        });
        const headerBuf = Buffer.alloc(256, 0);
        headerBuf.write(header.substring(0, 255));
        safeSendMainBinary(Buffer.concat([headerBuf, jpeg]));
    } catch (_) {}
}

// Fallback: every 15s check if any streaming camera hasn't sent a thumb for 60s
// and try ffmpeg on its lastChunk (requires recording to have produced a valid webm chunk)
setInterval(() => {
    if (!FFMPEG_OK) return;
    const now = Date.now();
    for (const [camId, cam] of cameras.entries()) {
        if (!cam.streaming || !cam.lastChunk) continue;
        const last = thumbLastSent.get(camId) || 0;
        if (now - last < 60_000) continue;          // phone thumb is recent enough
        if (thumbFfmpegActive.get(camId)) continue; // already running
        thumbFfmpegActive.set(camId, true);
        generateThumbnailFfmpeg(camId, cam.lastChunk);
    }
}, 15_000);

function generateThumbnailFfmpeg(camId, chunk) {
    if (!mainConnected) { thumbFfmpegActive.set(camId, false); return; }

    const ff = spawn(CFG.ffmpegPath, [
        '-loglevel', 'quiet',
        '-i', 'pipe:0',
        '-vframes', '1',
        '-vf', `scale=${CFG.thumbWidth}:-1`,
        '-f', 'image2', '-vcodec', 'mjpeg',
        'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });

    const parts = [];
    ff.stdout.on('data', d => parts.push(d));
    ff.stdout.on('end', () => {
        thumbFfmpegActive.set(camId, false);
        if (!parts.length || !mainConnected) return;
        const jpeg      = Buffer.concat(parts);
        const header    = JSON.stringify({
            type: 'CAM_THUMBNAIL', schoolId: CFG.schoolId,
            camId, camKey: `${CFG.schoolId}::${camId}`, ts: Date.now(), w: CFG.thumbWidth,
        });
        const headerBuf = Buffer.alloc(256, 0);
        headerBuf.write(header.substring(0, 255));
        safeSendMainBinary(Buffer.concat([headerBuf, jpeg]));
        thumbLastSent.set(camId, Date.now());
    });

    ff.on('error', () => { thumbFfmpegActive.set(camId, false); });
    try { ff.stdin.write(chunk); ff.stdin.end(); } catch (_) { thumbFfmpegActive.set(camId, false); try { ff.kill(); } catch (_) {} }
    setTimeout(() => { thumbFfmpegActive.set(camId, false); try { ff.kill(); } catch (_) {} }, 5000);
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
//  GAME PORT WS SERVER
//  All players, spellers, host, and presentation screens connect here.
//  Camera phones also connect here for WebRTC signaling (stream.js).
// ══════════════════════════════════════════════════════════════════════════
// Game WS runs via the 'upgrade' event on both HTTP and HTTPS servers.
const gameWss = new WebSocket.Server({ noServer: true });

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
        proxyToMain(ws, msg);
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
        if (ws._lcid) lcidToWs.delete(ws._lcid);
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

log(`🎮 Game WS  :${CFG.localPort}  (plain) + attached to HTTPS :${CFG.httpsPort || 8443} (secure)`);

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
    log(`📷 Camera phone connected & authed: ${camId}`);
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
            logger.cam(`▶️  Camera ${camId} streaming`);
            notifyMainCameraState();
            broadcastToLocalClients(JSON.stringify({
                type: 'CAM_LIVE', camId, schoolId: CFG.schoolId, label: cam.label,
            }));
            // Flush any VIEW_CAM_REQUEST that arrived before the cam was ready
            flushPendingViewers(camId);
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

        // Camera phone sends its own JPEG thumbnail (from canvas) every ~2s
        // while streaming. We relay it to MainServer as a binary frame so
        // the admin host grid can show it without needing ffmpeg or recording.
        case 'CAM_THUMB': {
            if (!msg.jpeg || !mainConnected) break;
            relayPhoneThumbnail(camId, msg.jpeg, msg.w || 320);
            break;
        }
    }   // end switch
}       // end handleCamControlMsg

// ── Video chunk handler ────────────────────────────────────────────────────

function handleVideoChunk(camId, cam, chunk) {
    const buf = Buffer.from(chunk);
    cam.lastChunk = buf;

    // Always buffer recent chunks so recording starts with the init segment
    if (!cam.recording) {
        bufferChunk(camId, buf);
    }

    // Write to disk if recording
    if (cam.recording && cam.recFile) {
        try {
            cam.recFile.write(buf);
            cam.bytesWritten += buf.length;
            if (cam.bytesWritten % (10 * 1024 * 1024) < buf.length) {
                log(`💾 ${camId}: ${(cam.bytesWritten / 1024 / 1024).toFixed(1)} MB recorded`);
            }
        } catch (e) {
            err(`Write error (${camId}): ${e.message}`);
            cam.recording = false;
            cam.recFile   = null;
        }
    }

    // Relay raw chunk to MainServer for viewers
    const header    = JSON.stringify({ type: 'VIDEO_CHUNK', schoolId: CFG.schoolId, camId, camKey: `${CFG.schoolId}::${camId}`, ts: Date.now() });
    const headerBuf = Buffer.alloc(256, 0);
    headerBuf.write(header.substring(0, 255));
    safeSendMainBinary(Buffer.concat([headerBuf, buf]));
}

// ── Client role tracking ───────────────────────────────────────────────────

// Assign a stable local-client ID to every game-port WS on first use.
// This ID travels with every proxied message so server.js can maintain
// per-player virtual state even though all school clients share one upstream WS.
let _lcidCounter = 0;
function getLcid(ws) {
    if (!ws._lcid) ws._lcid = CFG.schoolId + '::lc' + (++_lcidCounter);
    return ws._lcid;
}

// lcid → local ws (for routing targeted replies from server.js back to the right client)
const lcidToWs = new Map();

function trackClientRole(ws, msg) {
    if (!localClients.has(ws)) localClients.set(ws, {});
    const client = localClients.get(ws);
    if      (msg.type === 'JOIN' || msg.type === 'RECONNECT') { client.role = 'player';  client.userId = msg.userId; }
    else if (msg.type === 'JOIN_SPELL')                       { client.role = 'speller'; client.userId = msg.userId; }
    else if (msg.type === 'ADMIN_LOGIN')                      { client.role = 'admin';   }
    else if (msg.type === 'PRESENTATION_JOIN')                { client.role = 'viewer';  }
    // Always register lcid → ws so targeted replies can reach this client
    lcidToWs.set(getLcid(ws), ws);
}

function proxyToMain(ws, msg) {
    // Tag every proxied message with school ID + per-client ID.
    // server.js uses _lcid to demux replies back to the right local WS.
    msg._schoolId    = CFG.schoolId;
    msg._schoolProxy = true;
    msg._lcid        = getLcid(ws);
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

// ── Shared request handler (used by both HTTP and HTTPS servers) ────────────
function handleRequest(req, res) {
    const setCors = () => res.setHeader('Access-Control-Allow-Origin', '*');
    const isHttps = !!req.socket.encrypted;

    // /stream on plain HTTP → redirect to HTTPS so camera works on phones
    if (TLS_OK && !isHttps && (req.url === '/stream' || req.url.startsWith('/stream?'))) {
        const ip   = (req.headers.host || '').split(':')[0] || getLocalIp();
        res.writeHead(302, { Location: `https://${ip}:${CFG.httpsPort}${req.url}` });
        return res.end();
    }

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

    // Static files — shared-static handles path resolution + WS URL patching
    const handled = serveStatic(CFG.staticRoot, req, res);
    if (!handled) { res.writeHead(404); res.end('Not found'); }
}

// ── HTTP server :8080 ─────────────────────────────────────────────────────────
const httpServer = http.createServer(handleRequest);

// Attach the game WS server to this HTTP server
httpServer.on('upgrade', (req, socket, head) => {
    // Only handle upgrades if it's not the video port (if they were the same)
    gameWss.handleUpgrade(req, socket, head, ws => gameWss.emit('connection', ws, req));
});

httpServer.listen(CFG.httpPort, '0.0.0.0', () => {
    log(`🌐 HTTP  :${CFG.httpPort}  (static files + recordings)`);
    if (TLS_OK) log(`   /stream auto-redirects → https://<ip>:${CFG.httpsPort}/stream`);
});

// ── HTTPS server :8443 ───────────────────────────────────────────────────────
// Camera phones MUST use this — getUserMedia is blocked on plain HTTP.
// WSS (secure WebSocket) is handled here too via the 'upgrade' event,
// so wss://<ip>:8443 works without an extra port.
if (TLS_OK) {
    try {
        const tlsOpts = { key: fs.readFileSync(CERT_KEY), cert: fs.readFileSync(CERT_CRT) };
        const httpsServer = https.createServer(tlsOpts, handleRequest);

        // Attach the game WS server to this HTTPS server so wss:// works on port 8443
        httpsServer.on('upgrade', (req, socket, head) => {
            gameWss.handleUpgrade(req, socket, head, ws => gameWss.emit('connection', ws, req));
        });

        httpsServer.listen(CFG.httpsPort, '0.0.0.0', () => {
            const ip = getLocalIp();
            log(`🔒 HTTPS :${CFG.httpsPort}  (cameras — getUserMedia requires this)`);
            log(`   📱 Phone URL: https://${ip}:${CFG.httpsPort}/stream`);
            log(`   ⚠  First visit: tap  Advanced → Proceed  in Chrome (once per phone)`);
        });
    } catch (e) {
        warn(`HTTPS server failed to start: ${e.message}`);
    }
}

// ══════════════════════════════════════════════════════════════════════════
//  CONSOLE COMMANDS
// ══════════════════════════════════════════════════════════════════════════
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', async line => {
    const cmd = line.trim().toLowerCase();
    if (cmd === 'stop') await shutdown('CONSOLE');
    if (cmd === 'status') {
        const camRows = [...cameras.entries()].map(([id, c]) =>
            `${id}: ${c.streaming ? '🟢 live' : '⚫ idle'}${c.recording ? ' 🔴 rec' : ''}`
        );
        logger.statusBlock([
            { key: 'School ID',      val: CFG.schoolId },
            { key: 'Main server',    val: mainConnected ? '🟢 connected' : '🔴 disconnected', sub: CFG.mainServerWs },
            { key: 'Reconnect #',    val: mainReconnectAttempts },
            { key: 'Local clients',  val: localClients.size },
            { key: 'Cameras',        val: cameras.size + (cameras.size ? '  — ' + camRows.join('  ') : '') },
            { key: 'Uptime',         val: Math.floor(process.uptime() / 60) + ' min' },
            { key: 'Pending viewers',val: [...pendingViewerQueue.values()].reduce((s, q) => s + q.length, 0) },
        ]);
    }
});

// ══════════════════════════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ══════════════════════════════════════════════════════════════════════════
async function shutdown(signal) {
    log(`🛑 ${signal} — shutting down`);
    for (const [camId] of cameras.entries()) {
        stopRecording(camId);
    }
    
    // Close servers
    if (httpServer)  httpServer.close();
    if (gameWss)     gameWss.close();
    if (videoWss)    videoWss.close();
    if (mainWs)      mainWs.close();

    await new Promise(r => setTimeout(r, 1000)); // let streams flush
    log('👋 Stopped');
    process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  e => err(`Uncaught: ${e.message}\n${e.stack}`));
process.on('unhandledRejection', r => err(`Unhandled: ${r}`));

// ══════════════════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════════════════
logger.banner('SchoolServer', '2.0', [
    { key: 'school id',   val: CFG.schoolId },
    { key: 'main ws',     val: CFG.mainServerWs },
    '---',
    { key: 'game port',   val: `:${CFG.localPort}` },
    { key: 'http port',   val: `:${CFG.httpPort}` },
    { key: 'video port',  val: `:${CFG.videoPort}` },
    { key: 'https port',  val: TLS_OK ? `:${CFG.httpsPort}  ✓ TLS ready` : `:${CFG.httpsPort}  ✗ no cert` },
    '---',
    { key: 'max cameras', val: CFG.maxCams },
    { key: 'recordings',  val: CFG.recordingsDir },
    { key: 'ffmpeg',      val: FFMPEG_OK ? CFG.ffmpegPath + '  ✓' : 'NOT FOUND  ✗' },
    { key: 'static root', val: CFG.staticRoot },
]);

connectToMain();