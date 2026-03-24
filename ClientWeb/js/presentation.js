/**
 * presentation.js — updated
 * Adds camera feed display to the presentation screen.
 * When a host assigns a camera to this screen, a WebRTC stream appears
 * as a picture-in-picture overlay on any screen, or full-screen if set.
 */

const WS_URL = `ws://${location.hostname || 'localhost'}:5889`;

let ws, gamePhase = 'LOBBY', players = [];
let raceStartTime = null, raceDuration = 20;
let timerInterval = null, confettiTriggered = false;
let reconnectAttempts = 0;
let currentRound = 0, maxRounds = 0;
let cdInterval = null;

// ── Camera feed state ──────────────────────────────────────────────────────
let camPc        = null;          // RTCPeerConnection
let camStream    = null;          // MediaStream from camera
let camAssigned  = null;          // { schoolId, camId }
let wsId         = null;          // our server-assigned WS ID
let pipMode      = 'pip';         // 'pip' | 'fullscreen'

function connect() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        reconnectAttempts = 0;
        ws.send(JSON.stringify({ type: 'PRESENTATION_JOIN' }));
        showScreen('lobby-screen');
    };

    ws.onclose = () => {
        showScreen('connecting-screen');
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000);
        reconnectAttempts++;
        setTimeout(connect, delay);
    };

    ws.onerror = () => {};

    ws.onmessage = (e) => {
        // Binary = video chunk (raw WebM from school relay)
        if (e.data instanceof Blob) {
            e.data.arrayBuffer().then(buf => handleBinaryMessage(buf));
            return;
        }
        try { handleMessage(JSON.parse(e.data)); } catch (_) {}
    };
}

function handleBinaryMessage(buf) {
    // Header = first 256 bytes (zero-padded JSON)
    const headerStr = new TextDecoder().decode(buf.slice(0,256)).replace(/\0+$/,'');
    try {
        const header = JSON.parse(headerStr);
        if (header.type === 'VIDEO_CHUNK') {
            // We have a raw webm chunk — pipe to MediaSource if we're using MSE fallback
            feedMseChunk(buf.slice(256));
        }
    } catch(e) {}
}

function handleMessage(data) {
    switch (data.type) {
        case 'FULL_STATE_SYNC':
            gamePhase = data.state?.phase || gamePhase;
            if (data.wsId) wsId = data.wsId;
            // Receive initial camera list (used when presentation first connects mid-session)
            if (data.cameras) updateCameraList(data.cameras);
            updateUI();
            break;

        case 'UPDATE_LOBBY':
            if (data.players) players = data.players;
            gamePhase = data.phase || gamePhase;
            updateRoundBadges();
            if (gamePhase === 'LOBBY' || gamePhase === 'COUNTDOWN') renderLobby();
            else if (gamePhase === 'RACING') renderRacing();
            break;

        case 'START_GAME':
            gamePhase = 'RACING';
            if (data.round) { currentRound = data.round; maxRounds = data.maxRounds || maxRounds; }
            raceStartTime = data.startTime || Date.now();
            raceDuration = data.duration || 20;
            confettiTriggered = false;
            updateRoundBadges();
            showScreen('racing-screen');
            startRaceTimer();
            break;

        case 'GAME_OVER':
            gamePhase = 'FINISHED';
            if (data.round) { currentRound = data.round; maxRounds = data.maxRounds || maxRounds; }
            stopRaceTimer();
            updateRoundBadges();
            showScreen('results-screen');
            renderResults();
            break;

        case 'SERIES_COMPLETE':
        case 'SERIES_OVER':
            setTimeout(() => {
                gamePhase = 'LOBBY';
                confettiTriggered = false;
                currentRound = 0; maxRounds = 0;
                updateRoundBadges();
                players = [];
                showScreen('lobby-screen');
                renderLobby();
            }, 15000);
            break;

        case 'FORCE_RESET':
            gamePhase = 'LOBBY';
            confettiTriggered = false;
            stopRaceTimer();
            currentRound = 0; maxRounds = 0;
            updateRoundBadges();
            players = [];
            showScreen('lobby-screen');
            renderLobby();
            break;

        case 'COUNTDOWN':
            if (data.round) { currentRound = data.round; maxRounds = data.maxRounds || maxRounds; }
            if (gamePhase !== 'RACING') {
                gamePhase = 'COUNTDOWN';
                runCountdown(data.count);
            }
            break;

        // ── Camera assignment from host ────────────────────────────────
        case 'PRESENTATION_CAM_ASSIGNED': {
            camAssigned = { schoolId: data.schoolId, camId: data.camId, camKey: data.camKey };
            showCamPip(`Camera: ${data.camId}`);
            // Camera will offer to us — just set up the PC ready to answer
            setupCamPeerConnection();
            break;
        }

        case 'PRESENTATION_CAM_REMOVED':
            teardownCamFeed();
            break;

        // WebRTC offer from camera (routed via MainServer → SchoolServer → here)
        case 'STREAM_OFFER': {
            if (camPc) {
                handleCamOffer(data.sdp, data.viewerId);
            }
            break;
        }

        case 'STREAM_ICE_FROM_CAM': {
            if (camPc && data.candidate) {
                camPc.addIceCandidate(data.candidate).catch(() => {});
            }
            break;
        }

        // Thumbnail update (JPEG preview, low-fps)
        case 'CAM_THUMBNAIL': {
            if (camAssigned && data.camKey === `${camAssigned.schoolId}::${camAssigned.camId}`) {
                updateCamThumbnail('data:image/jpeg;base64,' + data.jpeg);
            }
            break;
        }
    }
}

// ── Camera PiP ────────────────────────────────────────────────────────────

function setupCamPeerConnection() {
    closeCamPc();
    camPc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    });

    camPc.ontrack = (e) => {
        camStream = e.streams[0];
        const vid = document.getElementById('cam-pip-video');
        if (vid) {
            vid.srcObject = camStream;
            vid.style.display = 'block';
            document.getElementById('cam-pip-thumb').style.display = 'none';
        }
    };

    camPc.onicecandidate = (e) => {
        if (e.candidate && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'STREAM_ICE',
                candidate: e.candidate,
                from: 'presentation'
            }));
        }
    };

    camPc.onconnectionstatechange = () => {
        const state = camPc.connectionState;
        setCamStatus(state === 'connected' ? 'live' : state === 'failed' ? 'error' : 'connecting');
        if (state === 'failed' || state === 'disconnected') {
            // Retry after 3s
            setTimeout(setupCamPeerConnection, 3000);
        }
    };
}

async function handleCamOffer(sdp, viewerId) {
    if (!camPc) return;
    await camPc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await camPc.createAnswer();
    await camPc.setLocalDescription(answer);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'STREAM_ANSWER',
            sdp: answer.sdp,
            viewerId,
            from: 'presentation'
        }));
    }
}

function closeCamPc() {
    if (camPc) { try { camPc.close(); } catch(e) {} camPc = null; }
    camStream = null;
}

function teardownCamFeed() {
    closeCamPc();
    camAssigned = null;
    const pip = document.getElementById('cam-pip');
    if (pip) pip.style.display = 'none';
}

// ── PiP overlay UI helpers ─────────────────────────────────────────────────

function showCamPip(label) {
    let pip = document.getElementById('cam-pip');
    if (!pip) {
        pip = document.createElement('div');
        pip.id = 'cam-pip';
        pip.style.cssText = `
            position:fixed; bottom:1.5rem; right:1.5rem; z-index:200;
            width:320px; background:#1a1b1d; border-radius:10px;
            border:2px solid #22c55e; overflow:hidden;
            box-shadow:0 8px 32px rgba(0,0,0,0.5);
            transition: all 0.3s ease;
        `;
        pip.innerHTML = `
            <div style="position:relative">
                <video id="cam-pip-video" autoplay muted playsinline style="width:100%;aspect-ratio:16/9;display:none;background:#000"></video>
                <img  id="cam-pip-thumb" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#1a1b1d">
                <div id="cam-pip-status" style="position:absolute;top:6px;left:8px;font-size:0.6rem;font-family:Roboto Mono,monospace;font-weight:700;letter-spacing:0.08em;background:rgba(0,0,0,0.7);color:#22c55e;padding:2px 7px;border-radius:4px">CONNECTING</div>
                <div style="position:absolute;top:6px;right:8px;display:flex;gap:4px">
                    <button onclick="toggleCamPipSize()" style="background:rgba(0,0,0,0.6);border:none;color:#fff;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:0.7rem">⛶</button>
                    <button onclick="teardownCamFeed()" style="background:rgba(202,71,84,0.8);border:none;color:#fff;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:0.7rem">✕</button>
                </div>
            </div>
            <div style="padding:0.4rem 0.6rem;font-size:0.65rem;font-family:Roboto Mono,monospace;color:#646669;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="cam-pip-label"></div>
        `;
        document.body.appendChild(pip);
    }
    pip.style.display = 'block';
    const lbl = document.getElementById('cam-pip-label');
    if (lbl) lbl.textContent = label;
}

function toggleCamPipSize() {
    const pip = document.getElementById('cam-pip');
    if (!pip) return;
    if (pip.style.width === '100vw') {
        pip.style.cssText = pip.style.cssText
            .replace('width:100vw','width:320px')
            .replace('bottom:0','bottom:1.5rem')
            .replace('right:0','right:1.5rem')
            .replace('border-radius:0','border-radius:10px');
    } else {
        pip.style.width = '100vw';
        pip.style.bottom = '0';
        pip.style.right = '0';
        pip.style.borderRadius = '0';
    }
}

function setCamStatus(state) {
    const el = document.getElementById('cam-pip-status');
    if (!el) return;
    const map = { live: ['LIVE','#22c55e'], connecting: ['CONNECTING','#e2b714'], error: ['ERROR','#ca4754'] };
    const [txt, col] = map[state] || ['—','#646669'];
    el.textContent = txt; el.style.color = col;
}

function updateCamThumbnail(src) {
    const img = document.getElementById('cam-pip-thumb');
    const vid = document.getElementById('cam-pip-video');
    if (img && (!vid || !vid.srcObject)) {
        img.src = src;
        img.style.display = 'block';
    }
}

function updateCameraList(cameras) {
    // No-op here — just stored for reference if needed
}

// ── MSE fallback for raw WebM chunks ──────────────────────────────────────
let mseSource = null, mseBuffer = null, mseQueue = [];

function feedMseChunk(chunk) {
    // Only used if WebRTC is not available
    if (!camAssigned) return;
    const vid = document.getElementById('cam-pip-video');
    if (!vid || vid.srcObject) return; // WebRTC is active, ignore MSE

    if (!mseSource) {
        mseSource = new MediaSource();
        vid.src = URL.createObjectURL(mseSource);
        vid.style.display = 'block';
        mseSource.addEventListener('sourceopen', () => {
            mseBuffer = mseSource.addSourceBuffer('video/webm; codecs="vp9,opus"');
            mseBuffer.addEventListener('updateend', () => {
                if (mseQueue.length > 0 && !mseBuffer.updating) {
                    mseBuffer.appendBuffer(mseQueue.shift());
                }
            });
        });
    }

    if (mseBuffer) {
        if (!mseBuffer.updating) {
            mseBuffer.appendBuffer(new Uint8Array(chunk));
        } else {
            mseQueue.push(new Uint8Array(chunk));
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════
//  EXISTING PRESENTATION LOGIC (unchanged from original)
// ══════════════════════════════════════════════════════════════════════════

function updateRoundBadges() {
    if (!currentRound || !maxRounds) {
        ['lobby-round-badge','racing-round-badge','results-round-badge'].forEach(id => {
            const el = document.getElementById(id); if (el) el.style.display = 'none';
        });
        return;
    }
    const txt = 'RUNDA ' + currentRound + ' / ' + maxRounds;
    ['lobby-round-badge','racing-round-badge','results-round-badge'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.textContent = txt; el.style.display = 'inline-block'; }
    });
}

function runCountdown(startNum) {
    if (cdInterval) clearInterval(cdInterval);
    showScreen('countdown-screen');
    let n = startNum || 3;
    document.getElementById('cd-number').textContent = n;
    document.getElementById('cd-label').textContent = 'Pregătește-te!';
    cdInterval = setInterval(() => {
        n--;
        if (n > 0) {
            const el = document.getElementById('cd-number');
            const clone = el.cloneNode(true);
            el.parentNode.replaceChild(clone, el);
            clone.textContent = n;
        } else {
            clearInterval(cdInterval); cdInterval = null;
            document.getElementById('cd-number').textContent = '🏁';
            document.getElementById('cd-label').textContent = 'START!';
        }
    }, 1000);
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

function updateUI() {
    if (gamePhase === 'RACING')       { showScreen('racing-screen');  renderRacing();  }
    else if (gamePhase === 'FINISHED') { showScreen('results-screen'); renderResults(); }
    else                               { showScreen('lobby-screen');   renderLobby();   }
}

function renderLobby() {
    const groups = { '1-4': [], '5-9': [], '10-12': [] };
    players.forEach(p => { (groups[p.grade] || groups['10-12']).push(p); });
    document.getElementById('lobby-count').textContent = players.length;
    ['1-4', '5-9', '10-12'].forEach(g => {
        document.getElementById(`cnt-${g}`).textContent = groups[g].length;
        const el = document.getElementById(`list-${g}`);
        if (!el) return;
        el.innerHTML = groups[g].length === 0
            ? '<div style="text-align:center;color:var(--sub);padding:2rem;font-size:0.8rem;letter-spacing:2px;text-transform:uppercase;">—</div>'
            : groups[g].map(p => `
                <div class="lobby-player-row">
                    <div class="player-dot"></div>
                    <div class="player-name-lbl">${esc(p.username)}</div>
                </div>`).join('');
    });
}

function renderRacing() {
    const sorted = [...players].sort((a, b) => (b.progress || 0) - (a.progress || 0));
    document.getElementById('race-tracks').innerHTML = sorted.map((p, i) => {
        const prog = p.progress || 0;
        const lead = i === 0 && prog > 0;
        const rc = ['r1','r2','r3'][i] || '';
        return `
        <div class="race-row ${lead ? 'leading' : ''}">
            <div class="race-rank ${rc}">${i + 1}</div>
            <div class="race-name">${esc(p.username)}</div>
            <div class="race-grade-tag">${esc(p.grade)}</div>
            <div class="race-track-bar">
                <div class="race-fill ${lead ? 'is-leading' : ''}" style="width:${prog}%">
                    <span class="race-car">🚗</span>
                </div>
            </div>
            <div class="race-wpm">
                <div class="race-wpm-val">${p.wpm || 0}</div>
                <div class="race-wpm-lbl">CPM</div>
            </div>
            ${p.finished ? '<div class="race-done-badge">✓ GATA</div>' : ''}
        </div>`;
    }).join('');

    document.getElementById('stat-players').textContent = players.length;
    document.getElementById('stat-finished').textContent = players.filter(p => p.finished).length;

    const leader = sorted[0];
    if (leader && (leader.progress || 0) > 0) {
        document.getElementById('leader-card').innerHTML = `
            <div class="leader-name">${esc(leader.username)}</div>
            <div class="leader-meta">Clasa ${esc(leader.grade)} · ${leader.acc || 0}% acc</div>
            <div class="leader-wpm">${leader.wpm || 0} <span style="font-size:0.8rem;color:var(--sub)">CPM</span></div>`;
    }
}

function startRaceTimer() {
    stopRaceTimer();
    timerInterval = setInterval(() => {
        const elapsed = (Date.now() - raceStartTime) / 1000;
        const rem = Math.max(0, Math.round(raceDuration - elapsed));
        const el = document.getElementById('race-timer');
        el.textContent = rem;
        el.classList.toggle('urgent', rem <= 5 && rem > 0);
        if (rem <= 0) stopRaceTimer();
    }, 250);
}

function stopRaceTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function renderResults() {
    ['1-4', '5-9', '10-12'].forEach(grade => {
        const list = players.filter(p => p.grade === grade)
            .sort((a, b) => (b.wpm || 0) - (a.wpm || 0));

        document.getElementById(`rcount-${grade}`).textContent = `${list.length} jucători`;

        const podiumEl = document.getElementById(`podium-${grade}`);
        const restEl   = document.getElementById(`rest-${grade}`);

        if (list.length === 0) {
            podiumEl.innerHTML = '<div class="no-players-msg">Fără participanți</div>';
            restEl.innerHTML = '';
            return;
        }

        const slots = [
            { p: list[1], rank: 2, icon: '🥈', cls: 'p2' },
            { p: list[0], rank: 1, icon: '👑', cls: 'p1' },
            { p: list[2], rank: 3, icon: '🥉', cls: 'p3' },
        ];

        podiumEl.innerHTML = slots.map(s => s.p ? `
            <div class="podium-slot ${s.cls}">
                <div class="podium-avatar">${s.icon}</div>
                <div class="podium-uname">${esc(s.p.username)}</div>
                <div class="podium-block">
                    <div class="podium-rank-lbl">#${s.rank}</div>
                    <div class="podium-wpm-val">${s.p.wpm || 0}</div>
                    <div class="podium-wpm-unit">CPM</div>
                    <div class="podium-acc-val">${s.p.acc || 0}% acc</div>
                </div>
            </div>` : `<div class="podium-slot"></div>`).join('');

        restEl.innerHTML = list.slice(3).map((p, i) => `
            <div class="rest-row" style="animation-delay:${i * 0.05}s">
                <div class="rest-rank">${i + 4}</div>
                <div class="rest-name">${esc(p.username)}</div>
                <div class="rest-wpm">${p.wpm || 0}</div>
                <div class="rest-acc">${p.acc || 0}%</div>
            </div>`).join('');
    });

    if (!confettiTriggered) {
        confettiTriggered = true;
        const end = Date.now() + 3500;
        (function burst() {
            confetti({ particleCount: 4, angle: 60,  spread: 55, origin: { x: 0 }, colors: ['#e2b714','#fff','#f5c842'] });
            confetti({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1 }, colors: ['#e2b714','#fff','#b0b8c8'] });
            if (Date.now() < end) requestAnimationFrame(burst);
        })();
    }
}

function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

connect();