'use strict';

// ════════════════════════════════════════════════════════════
//  CONFIG — WS URL auto-detection
// ════════════════════════════════════════════════════════════
const WS_URL = window.__WS_URL__ || (() => {
    const proto  = location.protocol === 'https:' ? 'wss' : 'ws';
    const host   = location.hostname || 'localhost';
    const wsPort = (location.port === '5890' || location.port === '8080') ? ':5889'
                 : location.port ? ':' + location.port : '';
    return `${proto}://${host}${wsPort}`;
})();

// Video port for binary MediaRecorder chunks (school server only)
const VIDEO_WS_URL = (() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.hostname || 'localhost'}:5890`;
})();

// ════════════════════════════════════════════════════════════
//  SESSION PERSISTENCE
//  Saves stream key + stable camId so the phone skips re-auth
//  after a page reload or brief disconnect.
// ════════════════════════════════════════════════════════════
const LS_KEY = 'rt_stream_session';

function loadSession() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
}
function saveSession(key, id) {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ key, camId: id })); } catch {}
}
function clearSession() {
    try { localStorage.removeItem(LS_KEY); } catch {}
}

// ════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════
const _session   = loadSession();

let ws               = null;
let authed           = false;
let localStream      = null;
let peerConns        = {};
let streaming        = false;
let facingMode       = 'environment';
let camId            = _session?.camId || ('cam-' + Math.random().toString(36).substr(2, 5).toUpperCase());
let savedKey         = _session?.key   || '';
let quality          = null;   // set by autodetectQuality() on first camera init
let qualityKey       = 'hd';   // tracks which button is active
let reconnectAttempts = 0;
let pingInterval     = null;

// Recording
let videoWs      = null;
let mediaRec     = null;
let recording    = false;

const qualityMap = {
    hd:  { width: 1280, height: 720  },
    fhd: { width: 1920, height: 1080 },
    '4k':{ width: 3840, height: 2160 },
};

// ════════════════════════════════════════════════════════════
//  DOM HELPERS — all getElementById calls go through these
//  so a missing element never throws
// ════════════════════════════════════════════════════════════
const el = id => document.getElementById(id);

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const t = el(id);
    if (t) t.classList.add('active');
}

let _toastTimer = null;
function showToast(msg) {
    const t = el('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function setStatus(state, text) {
    const dot = el('status-dot');
    if (dot) dot.className = 'status-indicator status-' + state;
    const txt = el('status-text');
    if (txt) txt.textContent = text;
}

function log(msg) {
    const e = el('status-log');
    if (e) e.textContent = msg;
    const dot = el('log-dot');
    if (dot) dot.classList.toggle('live', streaming);
}

function updateQualityBadge() {
    const labels = { hd: '720p', fhd: '1080p', '4k': '4K' };
    const badge = el('quality-badge');
    if (badge) badge.textContent = labels[qualityKey] || quality ? `${quality?.width || ''}p` : '—';
}

// ════════════════════════════════════════════════════════════
//  WEBSOCKET
// ════════════════════════════════════════════════════════════
function connectWS() {
    setStatus('yellow', 'connecting...');
    try { ws = new WebSocket(WS_URL); }
    catch (e) {
        setStatus('red', 'connection failed');
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        reconnectAttempts = 0;
        startPing();
        if (savedKey) {
            // Silent re-auth with saved session
            setStatus('yellow', 'reconnecting...');
            ws.send(JSON.stringify({ type: 'STREAM_AUTH', key: savedKey, camId, role: 'streamer' }));
        } else {
            setStatus('yellow', 'connected · needs auth');
            showScreen('auth-screen');
        }
    };

    ws.onmessage = e => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        handleMsg(msg);
    };

    ws.onclose = () => {
        setStatus('red', 'disconnected');
        authed = false;
        stopPing();
        if (streaming) forceStopStream();
        showScreen('connecting-screen');
        scheduleReconnect();
    };

    ws.onerror = () => setStatus('red', 'error');
}

function scheduleReconnect() {
    const delay = Math.min(1500 * Math.pow(1.5, reconnectAttempts), 20000);
    reconnectAttempts++;
    setTimeout(connectWS, delay);
}

// ════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ════════════════════════════════════════════════════════════
async function handleMsg(msg) {
    switch (msg.type) {

        case 'STREAM_AUTH_OK':
            authed = true;
            saveSession(savedKey, camId);
            setStatus('green', 'autentificat');
            hideAuthWaiting();
            await autodetectQuality();
            await initCamera();
            showScreen('stream-screen');
            if (el('cam-id-display')) el('cam-id-display').textContent = 'cam ' + camId;
            await acquireWakeLock();
            log('cameră pornită · pregătit de stream');
            break;

        case 'STREAM_AUTH_FAIL':
            authed = false;
            clearSession();
            savedKey = '';
            hideAuthWaiting();
            setStatus('yellow', 'connected · needs auth');
            showAuthError('Cheie incorectă. Încearcă din nou.');
            re_enableAuthBtn();
            showScreen('auth-screen');
            break;

        case 'VIEWER_JOINED':
            if (!authed || !msg.viewerId) return;
            log('viewer · ' + String(msg.viewerId).substr(0, 8));
            await createOffer(msg.viewerId);
            break;

        case 'STREAM_ANSWER':
            if (!authed || !msg.viewerId || !peerConns[msg.viewerId]) return;
            await peerConns[msg.viewerId]
                  .setRemoteDescription({ type: 'answer', sdp: msg.sdp })
                  .catch(() => {});
            break;

        case 'STREAM_ICE':
            if (!authed || !msg.viewerId || !msg.candidate || !peerConns[msg.viewerId]) return;
            peerConns[msg.viewerId].addIceCandidate(msg.candidate).catch(() => {});
            break;

        case 'VIEWER_LEFT':
            if (msg.viewerId) closePeer(msg.viewerId);
            break;

        case 'RECORDING_STARTED':
            if (authed) { startMediaRecorder(); log('🔴 recording'); }
            break;

        case 'RECORDING_STOPPED':
            if (authed) { stopMediaRecorder(); log('⏹ stopped'); }
            break;

        // Intentionally ignored on this page
        case 'PONG':
        case 'SYNC_STATE':
        case 'TIME_SYNC':
        case 'MODE_CHANGED':
        case 'UPDATE_LOBBY':
            break;
    }
}

// ════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════
function submitAuth() {
    const keyInput = el('stream-key');
    const key = keyInput ? keyInput.value.trim() : '';
    if (!key) { shakeInput(); return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('Nu ești conectat la server'); return; }

    savedKey = key;
    if (el('auth-btn'))     el('auth-btn').disabled   = true;
    if (el('auth-waiting')) el('auth-waiting').style.display = 'block';
    if (el('auth-error'))   el('auth-error').style.display   = 'none';

    ws.send(JSON.stringify({ type: 'STREAM_AUTH', key, camId, role: 'streamer' }));
}

function hideAuthWaiting() {
    if (el('auth-waiting')) el('auth-waiting').style.display = 'none';
}

function showAuthError(msg) {
    const e = el('auth-error');
    if (e) { e.textContent = msg; e.style.display = 'block'; }
    shakeInput();
}

function re_enableAuthBtn() {
    if (el('auth-btn')) el('auth-btn').disabled = false;
}

function shakeInput() {
    const e = el('stream-key');
    if (!e) return;
    e.classList.add('error');
    e.value = '';
    setTimeout(() => e.classList.remove('error'), 500);
}

// Logout / change cam — clears session and returns to auth screen
function logoutStream() {
    clearSession();
    savedKey = '';
    authed   = false;
    if (streaming) stopStream();
    if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'STREAM_STOP', camId }));
    camId = 'cam-' + Math.random().toString(36).substr(2, 5).toUpperCase();
    showScreen('auth-screen');
    setStatus('yellow', 'connected · needs auth');
}

// ════════════════════════════════════════════════════════════
//  CAMERA
// ════════════════════════════════════════════════════════════

function initVideoSocket() {
    videoWs = new WebSocket(VIDEO_WS_URL);
    videoWs.binaryType = 'arraybuffer'; // Crucial for binary chunks

    videoWs.onopen = () => {
        log('📹 Video socket open, authenticating...');
        // MANDATORY: The server won't record without this!
        videoWs.send(JSON.stringify({
            type: 'STREAM_AUTH',
            camId: myCamId, // Ensure this is the same ID used in the game socket
            key: STREAM_KEY
        }));
    };

    videoWs.onclose = () => {
        log('📹 Video socket closed, retrying...');
        setTimeout(initVideoSocket, 2000);
    };

    videoWs.onerror = (e) => err('📹 Video socket error', e);
}


/**
 * Returns navigator.mediaDevices or null.
 * On plain HTTP (non-localhost) the API is blocked by browsers — show a clear
 * error and attempt an HTTPS redirect so the user isn't left confused.
 */
function getMediaDevices() {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        return navigator.mediaDevices;
    }
    // Should not normally reach here — school-server.js auto-redirects
    // /stream on HTTP → https://<ip>:8443/stream before this JS even loads.
    // Belt-and-suspenders: redirect manually if we somehow ended up on HTTP.
    const httpsUrl = 'https://' + location.hostname + ':8443' + location.pathname + location.search;
    log('⚠ Redirecționare HTTPS...');
    setTimeout(() => { location.href = httpsUrl; }, 800);
    return null;
}

/** Update the single active quality pill — clears all first, then sets one. */
function setActivePill(key) {
    document.querySelectorAll('.q-btn, .q-pill').forEach(b => b.classList.remove('active'));
    const btn = el('q-' + key);
    if (btn) btn.classList.add('active');
}

/**
 * Auto-detect the highest resolution the rear camera supports.
 * Uses getCapabilities() when available (Android Chrome), otherwise probes
 * with exact constraints one at a time (fallback for older browsers).
 */
async function autodetectQuality() {
    if (quality) return;
    const md = getMediaDevices();
    if (!md) {
        quality = { width: 1280, height: 720 }; qualityKey = 'hd';
        setActivePill(qualityKey); updateQualityBadge(); return;
    }

    // Attempt 1: open a temporary stream and read getCapabilities()
    try {
        const tmp = await md.getUserMedia({ video: { facingMode: { ideal: facingMode } }, audio: false });
        const track = tmp.getVideoTracks()[0];
        if (track && typeof track.getCapabilities === 'function') {
            const caps = track.getCapabilities();
            const maxW = caps.width?.max || 0;
            track.stop(); tmp.getTracks().forEach(t => t.stop());
            if      (maxW >= 3840) { quality = { width: 3840, height: 2160 }; qualityKey = '4k';  }
            else if (maxW >= 1920) { quality = { width: 1920, height: 1080 }; qualityKey = 'fhd'; }
            else                   { quality = { width: 1280, height: 720  }; qualityKey = 'hd';  }
            setActivePill(qualityKey); updateQualityBadge(); return;
        }
        tmp.getTracks().forEach(t => t.stop());
    } catch (_) {}

    // Attempt 2: probe with exact constraints
    const probes = [
        { key: '4k',  w: 3840, h: 2160 },
        { key: 'fhd', w: 1920, h: 1080 },
        { key: 'hd',  w: 1280, h: 720  },
    ];
    for (const p of probes) {
        try {
            const t = await md.getUserMedia({
                video: { facingMode: { ideal: facingMode }, width: { exact: p.w }, height: { exact: p.h } },
                audio: false,
            });
            t.getTracks().forEach(t => t.stop());
            quality = { width: p.w, height: p.h }; qualityKey = p.key;
            setActivePill(qualityKey); updateQualityBadge(); return;
        } catch (_) {}
    }

    // Safe fallback
    quality = { width: 1280, height: 720 }; qualityKey = 'hd';
    setActivePill(qualityKey); updateQualityBadge();
}

async function initCamera() {
    const md = getMediaDevices();
    if (!md) return;
    try {
        if (localStream) localStream.getTracks().forEach(t => t.stop());

        const constraints = {
            video: {
                facingMode: { ideal: facingMode },
                frameRate:  { ideal: 30, max: 60 },
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                channelCount: 1,
            },
        };
        if (quality) {
            constraints.video.width  = { ideal: quality.width  };
            constraints.video.height = { ideal: quality.height };
        }

        localStream = await md.getUserMedia(constraints);
        const vid = el('preview-video');
        if (vid) { vid.srcObject = localStream; try { await vid.play(); } catch (_) {} }

    } catch (err) {
        if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
            log('⚠ Permisiune cameră refuzată');
            showToast('Permite accesul la cameră în setările browserului');
        } else {
            log('⚠ eroare cameră: ' + (err?.message || String(err)));
            showToast('Eroare cameră: ' + (err?.message || String(err)));
        }
    }
}

function setQuality(key, _btn) {
    if (streaming) { showToast('Oprește stream-ul mai întâi'); return; }
    qualityKey = key;
    if (qualityMap[key]) quality = qualityMap[key];
    setActivePill(key);
    updateQualityBadge();
    if (authed && localStream) initCamera();
}

function flipCamera() {
    if (streaming) { showToast('Oprește stream-ul pentru a schimba camera'); return; }
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    if (authed) initCamera();
}

// ════════════════════════════════════════════════════════════
//  STREAM START / STOP
// ════════════════════════════════════════════════════════════
function safeSend(payload) {
    if (!authed || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
}

async function startStream() {
    if (!authed)      { showToast('Autentifică-te mai întâi'); return; }
    if (!localStream) { showToast('Nicio cameră disponibilă'); return; }
    if (streaming)    return;

    streaming = true;
    if (el('start-btn')) el('start-btn').style.display = 'none';
    if (el('stop-btn'))  el('stop-btn').style.display  = 'flex';
    if (el('live-badge')) el('live-badge').classList.add('active');
    if (el('flip-btn'))  el('flip-btn').disabled = true;

    safeSend({ type: 'STREAM_START', camId, label: camId });
    startThumbCapture();
    await acquireWakeLock();
    log('live · stream activ');
}

// ── Canvas thumbnail capture ──────────────────────────────────────────────────
// Every 2s while streaming, grab a 320×180 frame from the preview <video> and
// send it as a JPEG to the school server so the host's camera grid shows a live
// thumbnail — without needing recording or ffmpeg.
let _thumbTimer  = null;
const _thumbCanvas = document.createElement('canvas');
_thumbCanvas.width  = 320;
_thumbCanvas.height = 180;
const _thumbCtx = _thumbCanvas.getContext('2d');

function startThumbCapture() {
    stopThumbCapture();
    _thumbTimer = setInterval(() => {
        if (!streaming || !localStream || !authed) return;
        const vid = el('preview-video');
        if (!vid || vid.readyState < 2 || vid.videoWidth === 0) return;
        try {
            _thumbCtx.drawImage(vid, 0, 0, 320, 180);
            _thumbCanvas.toBlob(blob => {
                if (!blob || !authed || !ws || ws.readyState !== WebSocket.OPEN) return;
                const reader = new FileReader();
                reader.onloadend = () => {
                    const b64 = reader.result?.split(',')[1];
                    if (b64) ws.send(JSON.stringify({ type: 'CAM_THUMB', jpeg: b64, w: 320, camId }));
                };
                reader.readAsDataURL(blob);
            }, 'image/jpeg', 0.5);
        } catch (_) {}
    }, 2000);
}

function stopThumbCapture() {
    if (_thumbTimer) { clearInterval(_thumbTimer); _thumbTimer = null; }
}

function stopStream() {
    if (!streaming) return;
    streaming = false;
    stopThumbCapture();

    if (el('start-btn')) el('start-btn').style.display = 'flex';
    if (el('stop-btn'))  el('stop-btn').style.display  = 'none';
    if (el('live-badge')) el('live-badge').classList.remove('active');
    if (el('flip-btn'))  el('flip-btn').disabled = false;

    Object.keys(peerConns).forEach(id => closePeer(id));
    if (recording) stopMediaRecorder();
    safeSend({ type: 'STREAM_STOP', camId });
    log('stream oprit');
}

function forceStopStream() {
    streaming = false;
    stopThumbCapture();
    Object.keys(peerConns).forEach(id => closePeer(id));
    if (recording) stopMediaRecorder();
    if (el('start-btn')) el('start-btn').style.display = 'flex';
    if (el('stop-btn'))  el('stop-btn').style.display  = 'none';
    if (el('live-badge')) el('live-badge').classList.remove('active');
    if (el('flip-btn'))  el('flip-btn').disabled = false;
}

// ════════════════════════════════════════════════════════════
//  WebRTC
// ════════════════════════════════════════════════════════════
async function createOffer(viewerId) {
    if (!streaming || !localStream || !authed) return;

    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302'  },
            { urls: 'stun:stun1.l.google.com:19302' },
        ],
    });
    peerConns[viewerId] = pc;

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.onicecandidate = e => {
        if (e.candidate) safeSend({ type: 'STREAM_ICE', candidate: e.candidate, viewerId, from: 'streamer', camId });
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') closePeer(viewerId);
    };

    try {
        const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
        await pc.setLocalDescription(offer);
        safeSend({ type: 'STREAM_OFFER', sdp: offer.sdp, viewerId, camId });
    } catch (_) { closePeer(viewerId); }
}

function closePeer(viewerId) {
    if (peerConns[viewerId]) {
        try { peerConns[viewerId].close(); } catch (_) {}
        delete peerConns[viewerId];
    }
}

// ════════════════════════════════════════════════════════════
//  MEDIA RECORDER — binary WebM → school server :5890
// ════════════════════════════════════════════════════════════
function startMediaRecorder() {
    if (recording || !localStream || typeof MediaRecorder === 'undefined') {
        if (typeof MediaRecorder === 'undefined') log('⚠ MediaRecorder not supported');
        return;
    }
    if (videoWs) { try { videoWs.close(); } catch (_) {} videoWs = null; }

    try { videoWs = new WebSocket(VIDEO_WS_URL); }
    catch (e) { log('⚠ videoWs: ' + e.message); return; }

    videoWs.binaryType = 'arraybuffer';

    videoWs.onopen = () => {
        videoWs.send(JSON.stringify({ type: 'STREAM_AUTH', key: savedKey, camId, label: camId }));
    };

    videoWs.onmessage = e => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'STREAM_AUTH_OK')   actuallyStartMediaRecorder();
        if (msg.type === 'STREAM_AUTH_FAIL') { log('⚠ video auth fail'); try { videoWs.close(); } catch(_){} videoWs = null; }
    };

    videoWs.onerror = () => log('⚠ video WS error');
    videoWs.onclose = () => { if (recording) stopMediaRecorder(); };
}

function actuallyStartMediaRecorder() {
    if (!localStream || !videoWs || videoWs.readyState !== WebSocket.OPEN) return;

    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';

    try {
        mediaRec = new MediaRecorder(localStream, { mimeType, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
    } catch (e) { log('⚠ MediaRecorder: ' + e.message); return; }

    mediaRec.ondataavailable = e => {
    if (e.data && e.data.size > 0 && videoWs?.readyState === WebSocket.OPEN) {
        // Sending the blob directly is often more efficient
        videoWs.send(e.data); 
    }
};

    mediaRec.onstop  = () => { recording = false; };
    mediaRec.onerror = e  => { log('⚠ recorder: ' + (e.error?.message || '')); stopMediaRecorder(); };

    recording = true;
    videoWs.send(JSON.stringify({ type: 'STREAM_START', camId, label: camId }));
    mediaRec.start(1000);
    log('🔴 recording · ' + mimeType);
}

function stopMediaRecorder() {
    recording = false;
    if (mediaRec && mediaRec.state !== 'inactive') { try { mediaRec.stop(); } catch (_) {} }
    mediaRec = null;
    if (videoWs) {
        if (videoWs.readyState === WebSocket.OPEN) {
            try { videoWs.send(JSON.stringify({ type: 'STREAM_STOP', camId })); } catch (_) {}
        }
        setTimeout(() => { try { videoWs.close(); } catch (_) {} videoWs = null; }, 400);
    }
}

// ════════════════════════════════════════════════════════════
//  PING / WAKE LOCK
// ════════════════════════════════════════════════════════════
function startPing() {
    stopPing();
    pingInterval = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'PING' }));
    }, 25000);
}

function stopPing() {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
}

let wakeLock = null, wakeLockRetryTimer = null;

async function acquireWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            if (wakeLock && !wakeLock.released) return;
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => {
                if (streaming || authed) scheduleWakeLockRetry();
            });
            return;
        } catch (_) {}
    }
    startNoSleepVideo();
}

function scheduleWakeLockRetry() {
    if (wakeLockRetryTimer) clearTimeout(wakeLockRetryTimer);
    wakeLockRetryTimer = setTimeout(acquireWakeLock, 500);
}

let noSleepVideo = null;
function startNoSleepVideo() {
    if (noSleepVideo) return;
    noSleepVideo = document.createElement('video');
    noSleepVideo.setAttribute('playsinline', '');
    noSleepVideo.setAttribute('webkit-playsinline', '');
    noSleepVideo.muted = true;
    noSleepVideo.loop  = true;
    noSleepVideo.src   = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAA3JtZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE1NSByMjkwMSBhOWY5NmE4IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAxOCAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAFZliIQAV/8EKAAABQAA=';
    noSleepVideo.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0.01;pointer-events:none;';
    document.body.appendChild(noSleepVideo);
    noSleepVideo.play().catch(() => {});
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (streaming || authed)) acquireWakeLock(); });
window.addEventListener('focus',    () => { if (streaming || authed) acquireWakeLock(); });
window.addEventListener('pageshow', () => { if (streaming || authed) acquireWakeLock(); });
document.addEventListener('resume', () => { if (streaming || authed) acquireWakeLock(); });

// ════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════
window.addEventListener('load', () => {
    // Pre-fill key input if a saved session exists
    if (savedKey && el('stream-key')) el('stream-key').value = savedKey;
    connectWS();
});