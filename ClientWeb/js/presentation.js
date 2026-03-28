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
let camPc             = null;
let camViewerId       = null;

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

        // ── Camera PiP ────────────────────────────────────────────────
        case 'PRESENTATION_CAM_ASSIGNED':
            startCamView(data.schoolId, data.camId, data.camKey);
            break;

        case 'PRESENTATION_CAM_REMOVED':
            closeCamView();
            break;

        case 'STREAM_OFFER':
            if (data.sdp && camPc) answerCamOffer(data.sdp, data.viewerId || camViewerId);
            break;

        case 'STREAM_ICE_FROM_CAM':
        case 'STREAM_ICE':
            if (data.candidate && camPc) camPc.addIceCandidate(data.candidate).catch(() => {});
            break;
    }
}

// ── Screens ──────────────────────────────────────────────────────────────────
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
}

function updateRoundBadges() {
    if (!currentRound || !maxRounds) {
        ['lobby-round-badge','racing-round-badge','results-round-badge','spell-round-badge'].forEach(id => {
            const el = document.getElementById(id); if (el) el.style.display = 'none';
        });
        return;
    }
    const txt = 'RUNDA ' + currentRound + ' / ' + maxRounds;
    ['lobby-round-badge','racing-round-badge','results-round-badge','spell-round-badge'].forEach(id => {
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
    if      (gamePhase === 'RACING')        { showScreen('racing-screen');       renderRacing();  }
    else if (gamePhase === 'FINISHED')      { showScreen('results-screen');      renderResults(); }
    else if (gamePhase === 'SPELL_ACTIVE')  { showScreen('spell-active-screen'); renderSpellActive(); }
    else                                    { showScreen('lobby-screen');        renderLobby();   }
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
function renderLobby() {
    renderLobbyModeBadge();
    const gradeGrid  = document.querySelector('.lobby-grades');
    const spellPanel = document.getElementById('lobby-spell-list');
    if (gameMode === 'spell') {
        if (gradeGrid)  gradeGrid.style.display  = 'none';
        if (spellPanel) spellPanel.style.display  = 'flex';
        renderSpellerLobby();
    } else {
        if (gradeGrid)  gradeGrid.style.display  = 'grid';
        if (spellPanel) spellPanel.style.display  = 'none';
        renderTyperLobby();
    }
}

function renderTyperLobby() {
    const groups = { '1-4': [], '5-9': [], '10-12': [] };
    players.forEach(p => { (groups[p.grade] || groups['10-12']).push(p); });
    const cnt = document.getElementById('lobby-count');
    if (cnt) cnt.textContent = players.length;
    ['1-4','5-9','10-12'].forEach(g => {
        const cntEl  = document.getElementById(`cnt-${g}`);
        const listEl = document.getElementById(`list-${g}`);
        if (cntEl) cntEl.textContent = groups[g].length;
        if (!listEl) return;
        listEl.innerHTML = groups[g].length === 0
            ? '<div class="grade-empty">—</div>'
            : groups[g].map(p => `<div class="lobby-player-row"><div class="player-dot"></div><div class="player-name-lbl">${esc(p.username)}</div></div>`).join('');
    });
}

function renderSpellerLobby() {
    const cnt = document.getElementById('lobby-count');
    if (cnt) cnt.textContent = spellers.length;
    const el = document.getElementById('lobby-spell-list');
    if (!el) return;
    if (spellers.length === 0) {
        el.innerHTML = '<div class="grade-empty" style="padding:3rem;text-align:center;width:100%">Niciun speler conectat</div>';
        return;
    }
    const sorted = [...spellers].sort((a,b) => (a.grade||'').localeCompare(b.grade||'') || (a.username||'').localeCompare(b.username||''));
    el.innerHTML = sorted.map(s => `
        <div class="spell-lobby-card">
            <div class="player-dot" style="background:var(--main);box-shadow:0 0 6px var(--main)"></div>
            <div class="spell-card-name">${esc(s.username)}</div>
            <div class="spell-card-grade">${esc(s.grade)}</div>
            ${s.submitted ? '<div class="spell-card-done">✓</div>' : ''}
        </div>`).join('');
}

// ── Spell active screen ───────────────────────────────────────────────────────
function renderSpellActive() {
    updateSpellSubmissions();
}

function updateSpellSubmissions() {
    const submitted = spellers.filter(s => s.submitted).length;
    const subEl     = document.getElementById('spell-submitted-count');
    const totalEl   = document.getElementById('spell-total-count');
    if (subEl)   subEl.textContent   = submitted;
    if (totalEl) totalEl.textContent = spellers.length;

    const grid = document.getElementById('spell-status-grid');
    if (!grid) return;
    grid.innerHTML = spellers.map(s => `
        <div class="spell-status-chip ${s.submitted ? 'done' : ''}">
            ${esc(s.username)}${s.submitted ? ' <span style="color:var(--green)">✓</span>' : ''}
        </div>`).join('');
}

// ── Racing ────────────────────────────────────────────────────────────────────
function renderRacing() {
    const sorted = [...players].sort((a, b) => (b.progress || 0) - (a.progress || 0));
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
        const list = players.filter(p => p.grade === grade).sort((a,b) => (b.wpm||0) - (a.wpm||0));
        const rcEl  = document.getElementById(`rcount-${grade}`);
        if (rcEl) rcEl.textContent = `${list.length} jucători`;

        const podEl  = document.getElementById(`podium-${grade}`);
        const restEl = document.getElementById(`rest-${grade}`);
        if (!podEl) return;

        if (list.length === 0) { podEl.innerHTML = '<div class="no-players-msg">Fără participanți</div>'; if (restEl) restEl.innerHTML = ''; return; }

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
            if (el) { const clone = el.cloneNode(true); clone.textContent = n; el.parentNode.replaceChild(clone, el); }
        } else {
            clearInterval(cdInterval); cdInterval = null;
            const el = document.getElementById('cd-number');
            const lb = document.getElementById('cd-label');
            if (el) el.textContent = '🏁';
            if (lb) lb.textContent = 'START!';
        }
    }, 1000);
}

// ── Camera PiP ────────────────────────────────────────────────────────────────
function startCamView(schoolId, camId, camKey) {
    closeCamView();
    camViewerId = 'pres-view-' + Math.random().toString(36).substr(2, 6);

    camPc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302'  },
            { urls: 'stun:stun1.l.google.com:19302' },
        ],
    });

    camPc.ontrack = e => {
        const pip = getOrCreatePip();
        if (pip && e.streams[0]) { pip.srcObject = e.streams[0]; pip.style.display = 'block'; pip.play().catch(()=>{}); }
    };

    camPc.onicecandidate = e => {
        if (e.candidate && ws?.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'STREAM_ICE', candidate: e.candidate, viewerId: camViewerId }));
    };

    camPc.onconnectionstatechange = () => {
        if (camPc && (camPc.connectionState === 'failed' || camPc.connectionState === 'disconnected')) closeCamView();
    };

    if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'PRESENTATION_SET_CAM', schoolId, camId, camKey, viewerId: camViewerId }));
}

async function answerCamOffer(sdp, viewerId) {
    if (!camPc) return;
    try {
        await camPc.setRemoteDescription({ type: 'offer', sdp });
        const answer = await camPc.createAnswer();
        await camPc.setLocalDescription(answer);
        if (ws?.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'STREAM_ANSWER', sdp: answer.sdp, viewerId: viewerId || camViewerId }));
    } catch (_) {}
}

function closeCamView() {
    if (camPc) { try { camPc.close(); } catch (_) {} camPc = null; }
    const pip = document.getElementById('cam-pip');
    if (pip) { pip.srcObject = null; pip.style.display = 'none'; }
    camViewerId = null;
}

function getOrCreatePip() {
    let pip = document.getElementById('cam-pip');
    if (!pip) {
        pip = document.createElement('video');
        pip.id = 'cam-pip'; pip.autoplay = true; pip.muted = true; pip.playsInline = true;
        pip.style.cssText = 'position:fixed;bottom:1.5rem;right:1.5rem;width:320px;border-radius:10px;box-shadow:0 4px 32px rgba(0,0,0,0.8);border:2px solid rgba(226,183,20,0.5);z-index:9998;background:#000;aspect-ratio:16/9;object-fit:cover;display:none;';
        document.body.appendChild(pip);
    }
    return pip;
}

function esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

connect();