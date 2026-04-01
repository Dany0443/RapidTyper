'use strict';

const WS_URL = window.__WS_URL__ || (() => {
    const proto  = location.protocol === 'https:' ? 'wss' : 'ws';
    const host   = location.hostname || 'localhost';
    const wsPort = (location.port === '5890' || location.port === '8080') ? ':5889'
                 : location.port ? ':' + location.port : '';
    return `${proto}://${host}${wsPort}`;
})();

let ws;
let gamePhase         = 'LOBBY';
let gameMode          = 'race';
let players           = [];
let spellers          = [];
let raceStartTime     = null;
let raceDuration      = 20;
let timerInterval     = null;
let confettiTriggered = false;
let reconnectAttempts = 0;
let currentRound      = 0;
let maxRounds         = 0;
let cdInterval        = null;

// ── Multi-camera state ────────────────────────────────────────────────────────
// Map<camKey, { pc: RTCPeerConnection, viewerId: string, videoEl: HTMLVideoElement|null }>
const camConnections = new Map();
let fullscreenMode   = false;

// ══════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET
// ══════════════════════════════════════════════════════════════════════════════
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
    ws.onmessage = e => { try { handleMessage(JSON.parse(e.data)); } catch (_) {} };
}

function handleMessage(data) {
    switch (data.type) {

        case 'FULL_STATE_SYNC':
            gamePhase = data.state?.phase || gamePhase;
            gameMode  = data.state?.mode  || gameMode;
            updateUI();
            break;

        case 'UPDATE_LOBBY':
            if (data.players) players = data.players;
            gamePhase = data.phase || gamePhase;
            if (data.mode) gameMode = data.mode;
            updateRoundBadges();
            if (gamePhase === 'LOBBY' || gamePhase === 'COUNTDOWN') renderLobby();
            else if (gamePhase === 'RACING') renderRacing();
            break;

        case 'UPDATE_SPELLERS':
            if (data.spellers) spellers = data.spellers;
            if (gameMode === 'spell') {
                const cnt = document.getElementById('lobby-count');
                if (cnt) cnt.textContent = spellers.length;
                renderSpellerLobby();
                if (gamePhase === 'SPELL_ACTIVE') updateSpellSubmissions();
            }
            break;

        case 'MODE_CHANGED':
            gameMode = data.mode || gameMode;
            renderLobbyModeBadge();
            if (gamePhase === 'LOBBY') renderLobby();
            break;

        case 'SPELL_START':
            gamePhase = 'SPELL_ACTIVE';
            if (data.round) { currentRound = data.round; maxRounds = data.maxRounds || maxRounds; }
            updateRoundBadges();
            showScreen('spell-active-screen');
            renderSpellActive();
            break;

        case 'SPELL_END':
            gamePhase = 'LOBBY';
            showScreen('lobby-screen');
            renderLobby();
            break;

        case 'START_GAME':
            gamePhase = 'RACING';
            if (data.round) { currentRound = data.round; maxRounds = data.maxRounds || maxRounds; }
            raceStartTime = data.startTime || Date.now();
            raceDuration  = data.duration  || 20;
            confettiTriggered = false;
            updateRoundBadges();
            showScreen('racing-screen');
            startRaceTimer();
            break;

        case 'GAME_OVER':
            gamePhase = 'FINISHED';
            if (data.round) { currentRound = data.round; maxRounds = data.maxRounds || maxRounds; }
            if (data.players) players = data.players;
            stopRaceTimer();
            updateRoundBadges();
            showScreen('results-screen');
            renderResults();
            break;

        case 'SERIES_COMPLETE':
        case 'SERIES_OVER':
            setTimeout(() => {
                gamePhase = 'LOBBY'; confettiTriggered = false;
                currentRound = 0; maxRounds = 0;
                updateRoundBadges(); players = [];
                showScreen('lobby-screen'); renderLobby();
            }, 15000);
            break;

        case 'FORCE_RESET':
            gamePhase = 'LOBBY'; confettiTriggered = false;
            stopRaceTimer(); currentRound = 0; maxRounds = 0;
            updateRoundBadges(); players = []; spellers = [];
            showScreen('lobby-screen'); renderLobby();
            break;

        case 'COUNTDOWN':
            if (data.round) { currentRound = data.round; maxRounds = data.maxRounds || maxRounds; }
            if (gamePhase !== 'RACING') { gamePhase = 'COUNTDOWN'; runCountdown(data.count); }
            break;

        // ── Camera messages ───────────────────────────────────────────────────

        // Legacy single-cam: treated as ADD (non-destructive)
        case 'PRESENTATION_CAM_ASSIGNED':
            addCamView(data.schoolId, data.camId, data.camKey, null /* no server viewerId */);
            break;

        // New multi-cam: server has already set up routing; viewerId included
        case 'PRESENTATION_CAM_ADDED':
            addCamView(data.schoolId, data.camId, data.camKey, data.viewerId || null);
            break;

        // Remove a specific camera (camKey provided) or all (legacy, no camKey)
        case 'PRESENTATION_CAM_REMOVED':
            if (data.camKey) {
                removeCamView(data.camKey);
            } else {
                closeAllCamViews();
            }
            break;

        // Host sends fullscreen on/off
        case 'PRESENTATION_FULLSCREEN':
            fullscreenMode = !!data.enabled;
            updateCamLayout();
            break;

        // ── Announcement from host ────────────────────────────────────────────
        case 'PRESENTATION_ANNOUNCEMENT':
            if (data.clear) {
                clearAnnouncement();
            } else if (data.text) {
                showAnnouncement(data.text, !!data.persist);
            }
            break;

        // ── WebRTC signaling ─────────────────────────────────────────────────
        case 'STREAM_OFFER':
            if (!data.sdp) break;
            // Match by viewerId to the right connection
            for (const [, conn] of camConnections) {
                if (conn.viewerId === data.viewerId) {
                    answerOffer(conn.pc, data.sdp, data.viewerId);
                    break;
                }
            }
            break;

        case 'STREAM_ICE_FROM_CAM':
        case 'STREAM_ICE': {
            if (!data.candidate) break;
            let matched = false;
            // Try viewerId match first
            for (const [, conn] of camConnections) {
                if (conn.viewerId === data.viewerId) {
                    conn.pc.addIceCandidate(data.candidate).catch(() => {});
                    matched = true; break;
                }
            }
            // Fallback: no viewerId → apply to all (legacy behaviour)
            if (!matched && !data.viewerId) {
                for (const [, conn] of camConnections) {
                    conn.pc.addIceCandidate(data.candidate).catch(() => {});
                }
            }
            break;
        }
    }
}

// ── Screens ───────────────────────────────────────────────────────────────────
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
}

function updateRoundBadges() {
    if (!currentRound || !maxRounds) {
        ['lobby-round-badge','racing-round-badge','results-round-badge','spell-round-badge']
            .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
        return;
    }
    const txt = 'RUNDA ' + currentRound + ' / ' + maxRounds;
    ['lobby-round-badge','racing-round-badge','results-round-badge','spell-round-badge']
        .forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.textContent = txt; el.style.display = 'inline-block'; }
        });
}

function renderLobbyModeBadge() {
    const badge = document.getElementById('lobby-mode-badge');
    if (!badge) return;
    if (gameMode === 'spell') {
        badge.textContent = '🐝  SPELLING BEE';
        badge.className = 'header-badge mode-spell';
    } else {
        badge.textContent = '⌨  FAST TYPER';
        badge.className = 'header-badge';
    }
}

function updateUI() {
    renderLobbyModeBadge();
    if      (gamePhase === 'RACING')       { showScreen('racing-screen');       renderRacing();      }
    else if (gamePhase === 'FINISHED')     { showScreen('results-screen');      renderResults();     }
    else if (gamePhase === 'SPELL_ACTIVE') { showScreen('spell-active-screen'); renderSpellActive(); }
    else                                   { showScreen('lobby-screen');        renderLobby();       }
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
function renderLobby() {
    renderLobbyModeBadge();
    const gradeGrid  = document.querySelector('.lobby-grades');
    const spellPanel = document.getElementById('lobby-spell-list');
    if (gameMode === 'spell') {
        if (gradeGrid)  gradeGrid.style.display  = 'none';
        if (spellPanel) spellPanel.style.display  = 'block';
        renderSpellerLobby();
    } else {
        if (gradeGrid)  gradeGrid.style.display  = '';
        if (spellPanel) spellPanel.style.display  = 'none';
        const grades = ['1-4','5-9','10-12'];
        grades.forEach(g => {
            const cnt = document.getElementById(`count-${g}`);
            if (cnt) cnt.textContent = players.filter(p => p.grade === g).length;
        });
        const lobbyCount = document.getElementById('lobby-count');
        if (lobbyCount) lobbyCount.textContent = players.length;
    }
}

function renderSpellerLobby() {
    const el = document.getElementById('lobby-spell-list');
    if (!el) return;
    el.innerHTML = spellers.map(s => `
        <div class="spell-status-chip ${s.submitted ? 'done' : ''}">
            ${esc(s.username)}${s.submitted ? ' <span style="color:var(--green)">✓</span>' : ''}
        </div>`).join('');
}

function renderSpellActive() {
    const el = document.getElementById('spell-submissions');
    if (!el) return;
    updateSpellSubmissions();
}

function updateSpellSubmissions() {
    const el = document.getElementById('spell-submissions');
    if (!el) return;
    el.innerHTML = spellers.map(s => `
        <div class="spell-status-chip ${s.submitted ? 'done' : ''}">
            ${esc(s.username)}${s.submitted ? ' <span style="color:var(--green)">✓</span>' : ''}
        </div>`).join('');
}

// ── Racing ────────────────────────────────────────────────────────────────────
function renderRacing() {
    const sorted   = [...players].sort((a, b) => (b.progress || 0) - (a.progress || 0));
    const tracksEl = document.getElementById('race-tracks');
    if (!tracksEl) return;

    tracksEl.innerHTML = sorted.map((p, i) => {
        const prog = p.progress || 0;
        const lead = i === 0 && prog > 0;
        const rc   = ['r1','r2','r3'][i] || '';
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

    const sp = document.getElementById('stat-players');
    const sf = document.getElementById('stat-finished');
    if (sp) sp.textContent = players.length;
    if (sf) sf.textContent = players.filter(p => p.finished).length;

    const leader     = sorted[0];
    const leaderCard = document.getElementById('leader-card');
    if (leaderCard && leader && (leader.progress || 0) > 0) {
        leaderCard.innerHTML = `
            <div class="leader-name">${esc(leader.username)}</div>
            <div class="leader-meta">Clasa ${esc(leader.grade)} · ${leader.acc || 0}% acc</div>
            <div class="leader-wpm">${leader.wpm || 0} <span style="font-size:0.8rem;color:var(--sub)">CPM</span></div>`;
    }
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startRaceTimer() {
    stopRaceTimer();
    timerInterval = setInterval(() => {
        const elapsed = (Date.now() - raceStartTime) / 1000;
        const rem = Math.max(0, Math.round(raceDuration - elapsed));
        const el  = document.getElementById('race-timer');
        if (el) { el.textContent = rem; el.classList.toggle('urgent', rem <= 5 && rem > 0); }
        if (rem <= 0) stopRaceTimer();
    }, 250);
}

function stopRaceTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── Results ───────────────────────────────────────────────────────────────────
function renderResults() {
    ['1-4','5-9','10-12'].forEach(grade => {
        const list  = players.filter(p => p.grade === grade).sort((a,b) => (b.wpm||0) - (a.wpm||0));
        const rcEl  = document.getElementById(`rcount-${grade}`);
        if (rcEl) rcEl.textContent = `${list.length} jucători`;

        const podEl  = document.getElementById(`podium-${grade}`);
        const restEl = document.getElementById(`rest-${grade}`);
        if (!podEl) return;

        if (!list.length) {
            podEl.innerHTML = '<div class="no-players-msg">Fără participanți</div>';
            if (restEl) restEl.innerHTML = '';
            return;
        }

        const slots = [
            { p: list[1], rank: 2, icon: '🥈', cls: 'p2' },
            { p: list[0], rank: 1, icon: '👑', cls: 'p1' },
            { p: list[2], rank: 3, icon: '🥉', cls: 'p3' },
        ];
        podEl.innerHTML = slots.map(s => s.p ? `
            <div class="podium-slot ${s.cls}">
                <div class="podium-avatar">${s.icon}</div>
                <div class="podium-uname">${esc(s.p.username)}</div>
                <div class="podium-block">
                    <div class="podium-rank-lbl">#${s.rank}</div>
                    <div class="podium-wpm-val">${s.p.wpm || 0}</div>
                    <div class="podium-wpm-unit">CPM</div>
                    <div class="podium-acc-val">${s.p.acc || 0}% acc</div>
                </div>
            </div>` : '<div class="podium-slot"></div>').join('');

        if (restEl) restEl.innerHTML = list.slice(3).map((p,i) => `
            <div class="rest-row" style="animation-delay:${i*0.05}s">
                <div class="rest-rank">${i+4}</div>
                <div class="rest-name">${esc(p.username)}</div>
                <div class="rest-wpm">${p.wpm||0}</div>
                <div class="rest-acc">${p.acc||0}%</div>
            </div>`).join('');
    });

    if (!confettiTriggered) {
        confettiTriggered = true;
        const end = Date.now() + 3500;
        (function burst() {
            confetti({ particleCount:4, angle:60,  spread:55, origin:{x:0}, colors:['#e2b714','#fff','#f5c842'] });
            confetti({ particleCount:4, angle:120, spread:55, origin:{x:1}, colors:['#e2b714','#fff','#b0b8c8'] });
            if (Date.now() < end) requestAnimationFrame(burst);
        })();
    }
}

// ── Countdown ─────────────────────────────────────────────────────────────────
function runCountdown(startNum) {
    if (cdInterval) clearInterval(cdInterval);
    showScreen('countdown-screen');
    let n = startNum || 3;
    const numEl = document.getElementById('cd-number');
    const lblEl = document.getElementById('cd-label');
    if (numEl) numEl.textContent = n;
    if (lblEl) lblEl.textContent = 'Pregătește-te!';
    cdInterval = setInterval(() => {
        n--;
        if (n > 0) {
            const el = document.getElementById('cd-number');
            if (el) {
                const clone = el.cloneNode(true);
                clone.textContent = n;
                el.parentNode.replaceChild(clone, el);
            }
        } else {
            clearInterval(cdInterval); cdInterval = null;
            const el = document.getElementById('cd-number');
            const lb = document.getElementById('cd-label');
            if (el) el.textContent = '🏁';
            if (lb) lb.textContent = 'START!';
        }
    }, 1000);
}

// ══════════════════════════════════════════════════════════════════════════════
//  MULTI-CAMERA SYSTEM
// ══════════════════════════════════════════════════════════════════════════════

/**
 * addCamView — opens a new WebRTC connection for a camera.
 *  serverViewerId: if provided (new HOST_ADD_CAM_TO_PRESENTATION flow),
 *                  the server already sent VIEW_CAM_REQUEST with this id.
 *                  if null (legacy PRESENTATION_CAM_ASSIGNED flow),
 *                  we send PRESENTATION_SET_CAM ourselves.
 */
function addCamView(schoolId, camId, camKey, serverViewerId) {
    // Ignore duplicates
    if (camConnections.has(camKey)) return;

    const viewerId = serverViewerId || ('pres-' + Math.random().toString(36).substr(2, 8));

    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302'  },
            { urls: 'stun:stun1.l.google.com:19302' },
        ],
    });

    const conn = { pc, viewerId, videoEl: null };
    camConnections.set(camKey, conn);

    pc.ontrack = e => {
        if (!e.streams[0]) return;
        const vid = getOrCreateVideoEl(camKey);
        vid.srcObject = e.streams[0];
        vid.play().catch(() => {});
        conn.videoEl = vid;
        updateCamLayout();
    };

    pc.onicecandidate = e => {
        if (e.candidate && ws?.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'STREAM_ICE', candidate: e.candidate, viewerId }));
    };

    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'failed' || s === 'disconnected') removeCamView(camKey);
    };

    if (!serverViewerId) {
        // Legacy flow: register ourselves as viewer so server can route STREAM_OFFER
        if (ws?.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'PRESENTATION_SET_CAM', schoolId, camId, camKey, viewerId }));
    }

    updateCamLayout();
}

function removeCamView(camKey) {
    const conn = camConnections.get(camKey);
    if (!conn) return;
    try { conn.pc.close(); } catch (_) {}
    if (conn.videoEl) {
        conn.videoEl.srcObject = null;
        conn.videoEl.remove();
    }
    camConnections.delete(camKey);
    updateCamLayout();
}

function closeAllCamViews() {
    for (const camKey of [...camConnections.keys()]) removeCamView(camKey);
}

async function answerOffer(pc, sdp, viewerId) {
    try {
        await pc.setRemoteDescription({ type: 'offer', sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (ws?.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'STREAM_ANSWER', sdp: answer.sdp, viewerId }));
    } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
//  CAMERA OVERLAY LAYOUT
// ══════════════════════════════════════════════════════════════════════════════

function getOrCreateVideoEl(camKey) {
    const safeKey = camKey.replace(/[^a-z0-9]/gi, '_');
    const id      = 'presv-' + safeKey;
    let vid       = document.getElementById(id);
    if (!vid) {
        vid            = document.createElement('video');
        vid.id         = id;
        vid.autoplay   = true;
        vid.muted      = true;
        vid.playsInline = true;
        getOrCreateOverlay().appendChild(vid);
    }
    return vid;
}

function getOrCreateOverlay() {
    let el = document.getElementById('cam-overlay');
    if (!el) {
        el    = document.createElement('div');
        el.id = 'cam-overlay';
        document.body.appendChild(el);
    }
    return el;
}

/**
 * updateCamLayout — recalculates overlay position and video sizing
 *   based on camConnections.size and fullscreenMode.
 *
 *   Modes:
 *     fullscreen  → black, full-screen grid (1 col for 1 cam, 2 cols for 2+)
 *     1 cam       → bottom-right PiP  320 px wide
 *     2 cams      → bottom-right stacked PiPs  240 px wide
 *     3-4 cams    → bottom-right stacked PiPs  200 px wide
 */
function updateCamLayout() {
    const overlay = getOrCreateOverlay();
    const count   = camConnections.size;

    if (count === 0) {
        overlay.style.cssText = 'display:none';
        return;
    }

    if (fullscreenMode) {
        const cols = count === 1 ? 1 : 2;
        const rows = count > 2  ? 2 : 1;
        overlay.style.cssText = `
            position:fixed; inset:0; z-index:9998;
            background:#000;
            display:grid;
            grid-template-columns:repeat(${cols},1fr);
            grid-template-rows:repeat(${rows},1fr);
            gap:2px;
        `;
        for (const [, conn] of camConnections) {
            if (conn.videoEl)
                conn.videoEl.style.cssText = `
                    width:100%; height:100%;
                    object-fit:cover; background:#000;
                    border-radius:0; border:none; display:block;
                `;
        }
    } else {
        const w      = count === 1 ? '320px' : count === 2 ? '240px' : '200px';
        const disp   = count === 1 ? 'block' : 'flex';
        overlay.style.cssText = `
            position:fixed;
            bottom:calc(1.5rem + env(safe-area-inset-bottom));
            right:1.5rem;
            width:${w};
            z-index:9998;
            display:${disp};
            flex-direction:column;
            gap:6px;
        `;
        const border = count === 1
            ? 'rgba(226,183,20,0.55)'
            : 'rgba(226,183,20,0.3)';
        const radius = count === 1 ? '10px' : '8px';
        for (const [, conn] of camConnections) {
            if (conn.videoEl)
                conn.videoEl.style.cssText = `
                    width:100%; aspect-ratio:16/9;
                    object-fit:cover; background:#000;
                    border-radius:${radius};
                    border:2px solid ${border};
                    box-shadow:0 4px 32px rgba(0,0,0,0.8);
                    display:block;
                `;
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ANNOUNCEMENT OVERLAY
//  Flow:
//    1. showAnnouncement(text, persist)
//       – Overlay appears full-screen with BIG text (font-size: 8vw)
//       – After 7s the overlay shrinks to a bottom ticker bar (font-size: 1.4rem)
//       – If persist=true it stays as ticker until clearAnnouncement() is called
//       – If persist=false the ticker fades out after another 5s
//    2. clearAnnouncement() — removes everything immediately
// ══════════════════════════════════════════════════════════════════════════════

let _annBigTimer    = null;
let _annTickerTimer = null;
let _annEl          = null;

function _ensureAnnEl() {
    if (_annEl && _annEl.isConnected) return _annEl;

    _annEl = document.createElement('div');
    _annEl.id = 'pres-announcement';
    _annEl.style.cssText = `
        position: fixed;
        bottom: 0; left: 0; right: 0;
        z-index: 9990;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
        pointer-events: none;
        transition: none;
    `;

    // Big text layer
    const big = document.createElement('div');
    big.id = 'pres-ann-big';
    big.style.cssText = `
        width: 100%;
        padding: 4vh 6vw;
        background: linear-gradient(to top, rgba(30,31,34,0.97) 0%, rgba(30,31,34,0.85) 70%, transparent 100%);
        color: #e2b714;
        font-family: 'Roboto Mono', monospace;
        font-size: 7vw;
        font-weight: 700;
        letter-spacing: 0.02em;
        line-height: 1.2;
        text-align: center;
        text-shadow: 0 2px 24px rgba(0,0,0,0.9);
        opacity: 0;
        transform: translateY(40px);
        transition: opacity 0.5s ease, transform 0.5s ease;
        word-break: break-word;
    `;

    // Ticker bar layer (hidden initially)
    const ticker = document.createElement('div');
    ticker.id = 'pres-ann-ticker';
    ticker.style.cssText = `
        width: 100%;
        padding: 0.7rem 2rem;
        background: rgba(30,31,34,0.96);
        border-top: 2px solid rgba(226,183,20,0.5);
        color: #e2b714;
        font-family: 'Roboto Mono', monospace;
        font-size: 1.4rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-align: center;
        opacity: 0;
        transition: opacity 0.6s ease;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: none;
    `;

    _annEl.appendChild(big);
    _annEl.appendChild(ticker);
    document.body.appendChild(_annEl);
    return _annEl;
}

function showAnnouncement(text, persist) {
    clearAnnouncement(false); // clear timers but don't remove DOM yet — we're about to repopulate

    const el     = _ensureAnnEl();
    const big    = el.querySelector('#pres-ann-big');
    const ticker = el.querySelector('#pres-ann-ticker');

    big.textContent    = text;
    ticker.textContent = '◆  ' + text + '  ◆';

    // Reset to big-text state
    ticker.style.display = 'none';
    ticker.style.opacity = '0';
    big.style.display    = 'flex';

    // Animate big text in (next frame so transition fires)
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            big.style.opacity   = '1';
            big.style.transform = 'translateY(0)';
        });
    });

    // After 7s: slide big text out and show ticker
    _annBigTimer = setTimeout(() => {
        big.style.opacity   = '0';
        big.style.transform = 'translateY(20px)';

        setTimeout(() => {
            big.style.display    = 'none';
            ticker.style.display = 'block';
            requestAnimationFrame(() => {
                requestAnimationFrame(() => { ticker.style.opacity = '1'; });
            });

            if (!persist) {
                // Non-persistent: fade ticker out after 5s
                _annTickerTimer = setTimeout(() => {
                    ticker.style.opacity = '0';
                    setTimeout(() => {
                        if (_annEl) _annEl.remove();
                        _annEl = null;
                    }, 700);
                }, 5000);
            }
            // Persistent: ticker stays until host sends clear
        }, 550);
    }, 7000);
}

function clearAnnouncement(removeEl = true) {
    if (_annBigTimer)    { clearTimeout(_annBigTimer);    _annBigTimer    = null; }
    if (_annTickerTimer) { clearTimeout(_annTickerTimer); _annTickerTimer = null; }
    if (removeEl && _annEl) {
        _annEl.remove();
        _annEl = null;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  UTILITY
// ══════════════════════════════════════════════════════════════════════════════
function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

connect();