
    // ════════════════════════════════════════════════════════════
    //  CONFIG
    // ════════════════════════════════════════════════════════════
    const WS_URL = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? `ws://${location.hostname}:5889` 
    : `wss://typer.webjuniors.org/ws`;

    // ════════════════════════════════════════════════════════════
    //  STATE
    // ════════════════════════════════════════════════════════════
    let ws            = null;
    let authed        = false;   // true only after STREAM_AUTH_OK
    let localStream   = null;
    let peerConns     = {};      // viewerId -> RTCPeerConnection
    let streaming     = false;
    let facingMode    = 'environment';
    let camId         = 'cam-' + Math.random().toString(36).substr(2, 5).toUpperCase();
    let quality       = { width: 1280, height: 720 };
    let reconnectAttempts = 0;
    let pingInterval  = null;

    const qualityMap = {
        hd:  { width: 1280, height: 720  },
        fhd: { width: 1920, height: 1080 },
        '4k':{ width: 3840, height: 2160 }
    };

    // ════════════════════════════════════════════════════════════
    //  SCREEN MANAGEMENT
    // ════════════════════════════════════════════════════════════
    function showScreen(id) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(id).classList.add('active');
    }

    // ════════════════════════════════════════════════════════════
    //  TOAST
    // ════════════════════════════════════════════════════════════
    let toastTimer = null;
    function showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
    }

    // ════════════════════════════════════════════════════════════
    //  STATUS DOT
    // ════════════════════════════════════════════════════════════
    function setStatus(state, text) {
        // state: 'green' | 'yellow' | 'red'
        const dot = document.getElementById('status-dot');
        dot.className = 'status-indicator status-' + state;
        document.getElementById('status-text').textContent = text;
    }

    // ════════════════════════════════════════════════════════════
    //  WEBSOCKET — connects on page load, NOT gated by auth
    //  but NO stream data flows until authed = true
    // ════════════════════════════════════════════════════════════
    function connectWS() {
        setStatus('yellow', 'connecting...');
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            reconnectAttempts = 0;
            setStatus('yellow', 'connected · needs auth');
            // WS is open — now show the auth form
            showScreen('auth-screen');
            startPing();
        };

        ws.onmessage = (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            handleServerMessage(msg);
        };

        ws.onclose = () => {
            setStatus('red', 'disconnected');
            authed = false;
            stopPing();
            // If mid-stream, stop cleanly
            if (streaming) forceStopStream();
            // Show connecting screen, retry
            showScreen('connecting-screen');
            const delay = Math.min(1500 * Math.pow(1.5, reconnectAttempts), 20000);
            reconnectAttempts++;
            setTimeout(connectWS, delay);
        };

        ws.onerror = () => setStatus('red', 'error');
    }

    // ════════════════════════════════════════════════════════════
    //  SERVER MESSAGE HANDLER
    //  SECURITY: all stream-related messages are ignored until
    //  authed === true. The server also enforces this on its side.
    // ════════════════════════════════════════════════════════════
    async function handleServerMessage(msg) {
        switch (msg.type) {

            // ── AUTH RESPONSE ────────────────────────────────────
            case 'STREAM_AUTH_OK':
                authed = true;
                setStatus('green', 'autentificat');
                hideAuthWaiting();
                // ONLY NOW request camera and show stream UI
                await initCamera();
                showScreen('stream-screen');
                document.getElementById('cam-id-display').textContent = camId;
                // Start keeping screen on from this point forward
                await acquireWakeLock();
                log('cameră pornită · pregătit de stream');
                break;

            case 'STREAM_AUTH_FAIL':
                authed = false;
                hideAuthWaiting();
                setStatus('yellow', 'connected · needs auth');
                showAuthError('Cheie incorectă. Încearcă din nou.');
                re_enableAuthBtn();
                break;

            // ── STREAM SIGNALING (only processed if authed) ──────
            case 'VIEWER_JOINED':
                if (!authed) return;
                log('viewer conectat · ' + msg.viewerId.substr(0, 8));
                await createOffer(msg.viewerId);
                break;

            case 'STREAM_ANSWER':
                if (!authed) return;
                if (peerConns[msg.viewerId]) {
                    await peerConns[msg.viewerId]
                          .setRemoteDescription({ type: 'answer', sdp: msg.sdp })
                          .catch(() => {});
                }
                break;

            case 'STREAM_ICE':
                if (!authed) return;
                if (peerConns[msg.viewerId] && msg.candidate) {
                    peerConns[msg.viewerId]
                        .addIceCandidate(msg.candidate)
                        .catch(() => {});
                }
                break;

            case 'VIEWER_LEFT':
                if (!authed) return;
                closePeer(msg.viewerId);
                break;
        }
    }

    // ════════════════════════════════════════════════════════════
    //  AUTH FLOW
    // ════════════════════════════════════════════════════════════
    function submitAuth() {
        const key = document.getElementById('stream-key').value.trim();
        if (!key) {
            shakeInput();
            return;
        }
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            showToast('Nu ești conectat la server');
            return;
        }

        // Disable button + show spinner while waiting for server
        document.getElementById('auth-btn').disabled = true;
        document.getElementById('auth-waiting').style.display = 'block';
        document.getElementById('auth-error').style.display = 'none';

        // Send key to server — response comes back as STREAM_AUTH_OK / STREAM_AUTH_FAIL
        ws.send(JSON.stringify({
            type: 'STREAM_AUTH',
            key: key,
            camId: camId,
            role: 'streamer'
        }));
    }

    function hideAuthWaiting() {
        document.getElementById('auth-waiting').style.display = 'none';
    }

    function showAuthError(msg) {
        const el = document.getElementById('auth-error');
        el.textContent = msg;
        el.style.display = 'block';
        shakeInput();
    }

    function re_enableAuthBtn() {
        const btn = document.getElementById('auth-btn');
        btn.disabled = false;
    }

    function shakeInput() {
        const el = document.getElementById('stream-key');
        el.classList.add('error');
        el.value = '';
        setTimeout(() => el.classList.remove('error'), 500);
    }

    // ════════════════════════════════════════════════════════════
    //  CAMERA — only called after auth success
    // ════════════════════════════════════════════════════════════
    async function initCamera() {
        try {
            if (localStream) localStream.getTracks().forEach(t => t.stop());

            // iOS requires exact constraints to be minimal — start with ideal
            const constraints = {
                video: {
                    facingMode: { ideal: facingMode },
                    width:  { ideal: quality.width  },
                    height: { ideal: quality.height },
                    // helps on older iPhones
                    frameRate: { ideal: 30, max: 60 }
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    // avoid issues on some Android devices
                    channelCount: 1
                }
            };

            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            const vid = document.getElementById('preview-video');
            vid.srcObject = localStream;

            // iOS sometimes needs a manual play() call
            try { await vid.play(); } catch (_) {}

        } catch (err) {
            log('eroare cameră: ' + err.message);
            showToast('Eroare cameră: ' + err.message);
        }
    }

    function setQuality(key, btn) {
        if (streaming) { showToast('Oprește stream-ul mai întâi'); return; }
        document.querySelectorAll('.q-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        quality = qualityMap[key];
        // Re-init camera with new quality (only if already authed)
        if (authed && localStream) initCamera();
    }

    function flipCamera() {
        if (streaming) { showToast('Oprește stream-ul pentru a schimba camera'); return; }
        facingMode = facingMode === 'environment' ? 'user' : 'environment';
        if (authed) initCamera();
    }

    // ════════════════════════════════════════════════════════════
    //  STREAM START / STOP
    //  Security: send() is wrapped — silently ignored if !authed
    // ════════════════════════════════════════════════════════════
    function safeSend(payload) {
        if (!authed || !ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(payload));
    }

    async function startStream() {
        if (!authed)        { showToast('Autentifică-te mai întâi'); return; }
        if (!localStream)   { showToast('Nicio cameră disponibilă'); return; }
        if (streaming)      return;

        streaming = true;
        document.getElementById('start-btn').style.display = 'none';
        document.getElementById('stop-btn').style.display  = 'flex';
        document.getElementById('live-badge').classList.add('active');
        document.getElementById('flip-btn').disabled = true;

        safeSend({ type: 'STREAM_START', camId, label: camId });
        await acquireWakeLock();
        log('live · stream activ');
    }

    function stopStream() {
        if (!streaming) return;
        streaming = false;

        document.getElementById('start-btn').style.display = 'flex';
        document.getElementById('stop-btn').style.display  = 'none';
        document.getElementById('live-badge').classList.remove('active');
        document.getElementById('flip-btn').disabled = false;

        Object.keys(peerConns).forEach(id => closePeer(id));

        safeSend({ type: 'STREAM_STOP', camId });
        log('stream oprit');
    }

    function forceStopStream() {
        streaming = false;
        Object.keys(peerConns).forEach(id => closePeer(id));
        document.getElementById('start-btn').style.display  = 'flex';
        document.getElementById('stop-btn').style.display   = 'none';
        document.getElementById('live-badge').classList.remove('active');
        document.getElementById('flip-btn').disabled = false;
    }

    // ════════════════════════════════════════════════════════════
    //  WebRTC
    // ════════════════════════════════════════════════════════════
    async function createOffer(viewerId) {
        if (!streaming || !localStream || !authed) return;

        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302'  },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        });
        peerConns[viewerId] = pc;

        // Add all tracks
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                safeSend({
                    type: 'STREAM_ICE',
                    candidate: e.candidate,
                    viewerId,
                    from: 'streamer',
                    camId
                });
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                closePeer(viewerId);
            }
        };

        const offer = await pc.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: false
        });
        await pc.setLocalDescription(offer);

        safeSend({ type: 'STREAM_OFFER', sdp: offer.sdp, viewerId, camId });
    }

    function closePeer(viewerId) {
        if (peerConns[viewerId]) {
            try { peerConns[viewerId].close(); } catch (_) {}
            delete peerConns[viewerId];
        }
    }

    // ════════════════════════════════════════════════════════════
    //  HELPERS
    // ════════════════════════════════════════════════════════════
    function log(msg) {
        document.getElementById('status-log').textContent = msg;
    }

    function startPing() {
        stopPing();
        pingInterval = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: 'PING' }));
        }, 25000);
    }

    function stopPing() {
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    }

    // ════════════════════════════════════════════════════════════
    //  WAKE LOCK — aggressive, always-on once streaming starts
    //  Tries every possible method to keep the screen alive.
    //  Re-acquires automatically on any release event.
    // ════════════════════════════════════════════════════════════
    let wakeLock = null;
    let wakeLockRetryTimer = null;

    async function acquireWakeLock() {
        // Method 1: Screen Wake Lock API (Chrome 84+, Safari 16.4+)
        if ('wakeLock' in navigator) {
            try {
                if (wakeLock && wakeLock.released === false) return; // already held
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener('release', () => {
                    // Re-acquire immediately if it got released by the OS
                    if (streaming || authed) {
                        scheduleWakeLockRetry();
                    }
                });
                return; // success
            } catch (_) {}
        }

        // Method 2: NoSleep fallback — play a tiny silent video loop
        // This keeps the screen on in browsers that don't support Wake Lock API
        startNoSleepVideo();
    }

    function scheduleWakeLockRetry() {
        if (wakeLockRetryTimer) clearTimeout(wakeLockRetryTimer);
        // Retry after 500ms — handles the case where OS releases it momentarily
        wakeLockRetryTimer = setTimeout(acquireWakeLock, 500);
    }

    // NoSleep fallback: a 1x1 transparent video loop tricks browsers
    // into thinking media is playing, preventing sleep
    let noSleepVideo = null;
    function startNoSleepVideo() {
        if (noSleepVideo) return;
        noSleepVideo = document.createElement('video');
        noSleepVideo.setAttribute('playsinline', '');
        noSleepVideo.setAttribute('webkit-playsinline', '');
        noSleepVideo.muted = true;
        noSleepVideo.loop = true;
        // Minimal valid MP4 — a 1×1 black frame, 1s, base64
        noSleepVideo.src = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAA3JtZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE1NSByMjkwMSBhOWY5NmE4IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAxOCAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAFZliIQAV/8EKAAABQAA=';
        noSleepVideo.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0.01;pointer-events:none;';
        document.body.appendChild(noSleepVideo);
        noSleepVideo.play().catch(() => {});
    }

    function stopNoSleepVideo() {
        if (noSleepVideo) {
            noSleepVideo.pause();
            noSleepVideo.remove();
            noSleepVideo = null;
        }
    }

    // Re-acquire on every possible lifecycle event
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && (streaming || authed)) {
            acquireWakeLock();
        }
    });
    window.addEventListener('focus', () => {
        if (streaming || authed) acquireWakeLock();
    });
    window.addEventListener('pageshow', () => {
        if (streaming || authed) acquireWakeLock();
    });
    // Some Android browsers fire this when the screen un-dims
    document.addEventListener('resume', () => {
        if (streaming || authed) acquireWakeLock();
    });

    // ════════════════════════════════════════════════════════════
    //  INIT — connect to WS immediately on load
    // ════════════════════════════════════════════════════════════
    window.addEventListener('load', () => {
        connectWS();
    });
    