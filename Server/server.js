'use strict';

const WebSocket  = require('ws');
const sqlite3    = require('sqlite3').verbose();
const fs         = require('fs');
const path       = require('path');
const readline   = require('readline');
const http       = require('http');

// ── Shared static middleware ────────────────────────────────────────────────
let serveStatic;
try {
    ({ serveStatic } = require('../shared-static'));
} catch (_) {
    try { ({ serveStatic } = require('../shared-static')); }
    catch (_) { serveStatic = () => false; }
}

// ══════════════════════════════════════════════════════════════════════════
//  MODE + CONFIG
// ══════════════════════════════════════════════════════════════════════════
const CFG = require('../shared/config');
const Logger = require('../shared/logger');
const IS_DEV = CFG.IS_DEV;

const CLIENT_WEB = CFG.STATIC_ROOT;

if (IS_DEV) {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  🛠️  DEVELOPMENT MODE                                     ║');
    console.log('║  Virtual SchoolNode + cameras embedded                   ║');
    console.log('║  Open:  http://localhost:5890/stream   (camera phone)    ║');
    console.log('║         http://localhost:5890/         (player)          ║');
    console.log('║         http://localhost:5890/host     (host panel)      ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
}

let DEBUG_MODE   = false;
const ADMIN_KEY  = CFG.ADMIN_KEY;
const STREAM_KEY = CFG.STREAM_KEY;
let   GAME_DURATION = CFG.GAME_DURATION;
const MAX_PLAYERS   = CFG.MAX_PLAYERS;

function debugLog(msg) { if (DEBUG_MODE) console.log(`[DEBUG] ${msg}`); }

// ══════════════════════════════════════════════════════════════════════════
//  DIRECTORIES + FILES
// ══════════════════════════════════════════════════════════════════════════
const DIRS = {
    logs: path.join(__dirname, 'logs'),
    db  : path.join(__dirname, 'db'),
    data: path.join(__dirname, 'data'),
};
Object.values(DIRS).forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const FILES = {
    mainLog    : path.join(DIRS.logs, 'server.log'),
    errorLog   : path.join(DIRS.logs, 'errors.log'),
    stateLog   : path.join(DIRS.logs, 'state.log'),
    mainDb     : path.join(DIRS.db,   'event.db'),
    textFile   : path.join(DIRS.data, 'text.txt'),
    spellFile  : path.join(DIRS.data, 'w.txt'),
    resultsFile: path.join(DIRS.data, 'results.txt'),
};

// ══════════════════════════════════════════════════════════════════════════
//  SCHOOL + CAMERA REGISTRIES
// ══════════════════════════════════════════════════════════════════════════
const schoolNodes             = new Map();  // schoolId → node
const allCameras              = new Map();  // `schoolId::camId` → cam info
const presentationAssignments = new Map();  // wsId → { schoolId, camId, camKey }
const presentationMultiCams   = new Map();  // presId → [{ schoolId, camId, camKey }, ...]
let   wsIdCounter = 0;
const nextWsId = () => 'ws_' + (++wsIdCounter);

// ── Virtual clients for proxied school players ─────────────────────────────
// When school-server proxies a local player, we create a VirtualClient keyed
// by _lcid. It has the same interface as a real WS from server.js's perspective.
class VirtualClient {
    constructor(lcid, schoolNodeWs, schoolId) {
        this._lcid      = lcid;
        this._nodeWs    = schoolNodeWs;  // the actual school node WS to send through
        this._schoolId  = schoolId;
        this.readyState = WebSocket.OPEN;
        // WebSocket-like metadata
        this.isAlive    = true;
        this.clientIp   = schoolId;
        this.messageCount = 0;
        // Routing metadata (same fields server.js attaches to real WSs)
        this._wsId      = null;
        this._viewerId  = null;
        this._viewingCam= null;
    }

    send(dataStr) {
        // Parse, tag with _lcid, re-stringify and send through the school node WS
        if (this._nodeWs?.readyState !== WebSocket.OPEN) return;
        try {
            const msg = JSON.parse(dataStr);
            msg._lcid = this._lcid;
            this._nodeWs.send(JSON.stringify(msg));
        } catch (_) {}
    }

    terminate() { this.readyState = WebSocket.CLOSED; }
    close()     { this.readyState = WebSocket.CLOSED; }
    ping()      {}
}

// Map: lcid → VirtualClient
const virtualClients = new Map();

function getOrCreateVirtualClient(lcid, nodeWs, schoolId) {
    if (!virtualClients.has(lcid)) {
        const vc = new VirtualClient(lcid, nodeWs, schoolId);
        virtualClients.set(lcid, vc);
    } else {
        // Update nodeWs in case the school node reconnected
        virtualClients.get(lcid)._nodeWs = nodeWs;
    }
    return virtualClients.get(lcid);
}

// ══════════════════════════════════════════════════════════════════════════
//  LOGGER
// ══════════════════════════════════════════════════════════════════════════
const logger = new Logger(DIRS.logs);
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
function sysLog(m) { logger.info(m); }

// ══════════════════════════════════════════════════════════════════════════
//  TIME SYNC
// ══════════════════════════════════════════════════════════════════════════
class TimeSync {
    constructor() { this.h = new Map(); }
    getServerTime() { return Date.now(); }
    recordSync(uid, offset, rtt) {
        if (!this.h.has(uid)) this.h.set(uid, []);
        const a = this.h.get(uid);
        a.push({ offset, rtt }); if (a.length > 10) a.shift();
    }
}
const timeSync = new TimeSync();

// ══════════════════════════════════════════════════════════════════════════
//  GAME STATE
// ══════════════════════════════════════════════════════════════════════════
class GameStateManager {
    constructor() {
        this.state = {
            phase: 'LOBBY', players: new Map(), text: '', spellText: '',
            mode: 'race', gameId: null, startTime: null, endTime: null,
            countdown: null, spellRoundActive: false, spellStartTime: null,
            currentRound: 0, maxRounds: 3, roundHistory: []
        };
        this.stateVersion = 0; this.stateLock = false;
        this.callbacks = []; this.endGameTimeout = null;
    }

    async transition(phase, data = {}) {
        if (this.stateLock) { sysLog(`⚠️ Blocked: ${this.state.phase}→${phase}`); return false; }
        this.stateLock = true;
        const old = this.state.phase;
        try {
            this.state.phase = phase; this.stateVersion++;
            Object.assign(this.state, data);
            sysLog(`🔄 ${old}→${phase} v${this.stateVersion}`);
            await this._snap();
            this.callbacks.forEach(cb => { try { cb(old, phase); } catch (_) {} });
            return true;
        } catch (e) { this.state.phase = old; return false; }
        finally     { this.stateLock = false; }
    }

    onTransition(cb) { this.callbacks.push(cb); }

    getState() {
        return {
            phase: this.state.phase, mode: this.state.mode, gameId: this.state.gameId,
            startTime: this.state.startTime, endTime: this.state.endTime,
            version: this.stateVersion, serverTime: timeSync.getServerTime(),
            playerCount : [...this.state.players.values()].filter(p => p.role === 'player').length,
            spellerCount: [...this.state.players.values()].filter(p => p.role === 'speller').length,
            currentRound: this.state.currentRound, maxRounds: this.state.maxRounds
        };
    }

    async _snap() {
        try {
            await fs.promises.writeFile(FILES.stateLog, JSON.stringify({
                version: this.stateVersion, phase: this.state.phase, mode: this.state.mode,
                gameId: this.state.gameId, startTime: this.state.startTime, timestamp: Date.now()
            }) + '\n');
        } catch (_) {}
    }

    async restoreLastState() {
        try {
            if (!fs.existsSync(FILES.stateLog)) return false;
            const s = JSON.parse((await fs.promises.readFile(FILES.stateLog, 'utf8')).trim());
            if ((s.phase === 'RACING' || s.phase === 'ROUND_END') && Date.now() - s.timestamp < 300000) {
                this.state.phase = 'ROUND_END'; this.state.mode = s.mode || 'race';
                this.state.gameId = s.gameId; this.stateVersion = s.version;
                sysLog(`📄 Restored ${s.phase}→ROUND_END`); return true;
            }
        } catch (_) {}
        return false;
    }

    cleanup() {
        let n = 0;
        for (const [ws] of this.state.players) {
            if (ws instanceof VirtualClient) {
                if (ws.readyState === WebSocket.CLOSED) { this.state.players.delete(ws); n++; }
            } else if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
                this.state.players.delete(ws); n++;
            }
        }
        return n;
    }
}
const gameState = new GameStateManager();

// ══════════════════════════════════════════════════════════════════════════
//  TEXT
// ══════════════════════════════════════════════════════════════════════════
const DEF_TEXT  = `În era digitală, tastarea rapidă a devenit o abilitate fundamentală, similară cu scrierea de mână în secolele trecute. De la programatori care scriu cod complex, până la scriitori care își transpun imaginația pe ecran, viteza cu care putem transfera gândurile noastre în format digital influențează direct productivitatea.`;
const DEF_SPELL = `This is a sample text for the spelling bee.`;

function loadText() {
    try { if (fs.existsSync(FILES.textFile)) { const t = fs.readFileSync(FILES.textFile,'utf8').trim(); if (t) return t; } } catch (_) {}
    try { fs.writeFileSync(FILES.textFile, DEF_TEXT, 'utf8'); } catch (_) {}
    return DEF_TEXT;
}
function loadSpellText() {
    try { if (fs.existsSync(FILES.spellFile)) { const t = fs.readFileSync(FILES.spellFile,'utf8').trim(); if (t) return t; } } catch (_) {}
    try { fs.writeFileSync(FILES.spellFile, DEF_SPELL, 'utf8'); } catch (_) {}
    return DEF_SPELL;
}
const saveText      = async t => { try { await fs.promises.writeFile(FILES.textFile,  t, 'utf8'); return true; } catch (_) { return false; } };
const saveSpellText = async t => { try { await fs.promises.writeFile(FILES.spellFile, t, 'utf8'); return true; } catch (_) { return false; } };

// ══════════════════════════════════════════════════════════════════════════
//  DATABASE
// ══════════════════════════════════════════════════════════════════════════
const db = new sqlite3.Database(FILES.mainDb, e => {
    if (e) logger.error('DB: ' + e.message); else sysLog('💾 Database connected');
});
db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA synchronous = NORMAL;');
    db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT, grade TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT, grade TEXT, wpm INTEGER, acc INTEGER, raw INTEGER, consistency INTEGER, errors INTEGER, completed_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS sync_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, offset INTEGER, rtt INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_su ON sessions(user_id)`);
    db.run(`DELETE FROM sync_events WHERE created_at < datetime('now','-7 days')`);
});
setInterval(() => db.run(`DELETE FROM sync_events WHERE created_at < datetime('now','-7 days')`), 86400000);
const dbRun = (q, p = []) => new Promise((res, rej) => db.run(q, p, function (e) { if (e) rej(e); else res(this); }));

// ══════════════════════════════════════════════════════════════════════════
//  RATE LIMITER
// ══════════════════════════════════════════════════════════════════════════
class RateLimiter {
    constructor() { this.l = new Map(); this.bl = new Set(); }
    check(key, max = 10) {
        if (this.bl.has(key)) return false;
        const now = Date.now();
        const r = this.l.get(key) || { c: 0, t: now + 1000 };
        if (now > r.t) { r.c = 0; r.t = now + 1000; }
        r.c++; this.l.set(key, r);
        if (r.c > max * 2) { this.bl.add(key); setTimeout(() => this.bl.delete(key), 60000); return false; }
        return r.c <= max;
    }
    cleanup() { const n = Date.now(); for (const [k, r] of this.l) if (n > r.t + 10000) this.l.delete(k); }
}
const rl2 = new RateLimiter();
setInterval(() => rl2.cleanup(), 60000);

// ══════════════════════════════════════════════════════════════════════════
//  BROADCAST
// ══════════════════════════════════════════════════════════════════════════
let broadcastScheduled = null;

function broadcastLobbyState() {
    if (broadcastScheduled) clearTimeout(broadcastScheduled);
    broadcastScheduled = setTimeout(() => {
        broadcastScheduled = null;
        const players = [...gameState.state.players.values()]
            .filter(p => p.role === 'player')
            .map(p => ({ userId: p.userId, username: p.username, grade: p.grade, finished: p.finished,
                         wpm: p.wpm||0, acc: p.acc||0, progress: p.progress||0,
                         raw: p.raw||0, consistency: p.consistency||0, errors: p.errors||0 }));
        broadcast({ type: 'UPDATE_LOBBY', count: players.length, players,
                    gameActive: gameState.state.phase === 'RACING',
                    phase: gameState.state.phase, stateVersion: gameState.stateVersion,
                    serverTime: timeSync.getServerTime() });
    }, 150);
}

function broadcastSpellerState() {
    const list = [...gameState.state.players.values()]
        .filter(p => p.role === 'speller')
        .map(p => ({
            userId        : p.userId,
            username      : p.username,
            grade         : p.grade,
            score         : p.score         || 0,
            elapsedSec    : p.elapsedMs != null ? parseFloat((p.elapsedMs / 1000).toFixed(1)) : null,
            compositeScore: p.compositeScore || 0,
            status        : p.status         || 'connected',
            finished      : p.finished       || false,
        }))
        // Sort: finished first (by compositeScore desc), then unfinished
        .sort((a, b) => {
            if (a.finished && !b.finished) return -1;
            if (!a.finished && b.finished) return 1;
            return (b.compositeScore || 0) - (a.compositeScore || 0);
        });
    broadcast({ type: 'UPDATE_SPELLERS', count: list.length, list,
                spellRoundActive: gameState.state.spellRoundActive, serverTime: timeSync.getServerTime() });
}

function broadcast(msg, filter = null) {
    const data = JSON.stringify(msg);
    for (const [ws] of gameState.state.players) {
        if (ws instanceof VirtualClient) {
            if (ws.readyState === WebSocket.OPEN && (!filter || filter(ws))) {
                try { ws.send(data); } catch (_) {}
            }
        } else if (ws.readyState === WebSocket.OPEN && (!filter || filter(ws))) {
            try { ws.send(data); } catch (_) {}
        }
    }
    // Also send to presentation/viewer/admin WS that aren't in players map
    wss.clients.forEach(ws => {
        if (!gameState.state.players.has(ws)) return;
        // already handled above
    });
}

// Alias kept for backward compatibility with any code that calls broadcastSpellers()
function broadcastSpellers() { broadcastSpellerState(); 
    const data = JSON.stringify(msg);
    for (const [ws, p] of gameState.state.players) {
        if (p.role === 'admin') {
            if (ws instanceof VirtualClient) { try { ws.send(data); } catch (_) {} }
            else if (ws.readyState === WebSocket.OPEN) { try { ws.send(data); } catch (_) {} }
        }
    }
}
// ══════════════════════════════════════════════════════════════════════════
//  SCHOOL / CAMERA HELPERS
// ══════════════════════════════════════════════════════════════════════════
function getSchoolNodesSummary() {
    return [...schoolNodes.values()].map(n => ({
        schoolId : n.schoolId,
        cameras  : n.cameras.length,
        online   : n.isVirtual ? true : (n.ws?.readyState === WebSocket.OPEN),
        httpPort : n.httpPort,
        isVirtual: !!n.isVirtual,
    }));
}

function getCamerasSummary() {
    return [...allCameras.values()].map(c => ({
        key: c.key, camId: c.camId, schoolId: c.schoolId, label: c.label,
        streaming: c.streaming, recording: c.recording||false,
        bytesWritten: c.bytesWritten||0, recFilename: c.recFilename||null,
    }));
}

function getPresentationAssignments() {
    const out = {};
    for (const [k, v] of presentationAssignments) out[k] = v;
    return out;
}

function findViewerByViewerId(vid) {
    if (!vid) return null;
    for (const [ws] of gameState.state.players) {
        // Single-cam legacy path
        if (ws._viewerId === vid) return ws;
        // Multi-cam: viewerId stored per-camKey in a Map
        if (ws._viewerIds instanceof Map) {
            for (const v of ws._viewerIds.values()) {
                if (v === vid) return ws;
            }
        }
    }
    return null;
}

// ══════════════════════════════════════════════════════════════════════════
//  DEDUPLICATION
// ══════════════════════════════════════════════════════════════════════════
function deduplicateUsername(desired) {
    const taken = new Set(
        [...gameState.state.players.values()]
            .filter(p => p.role === 'player' || p.role === 'speller')
            .map(p => p.username.toLowerCase())
    );
    if (!taken.has(desired.toLowerCase())) return desired;
    for (let i = 2; i <= 99; i++) {
        const c = `${desired} ${i}`;
        if (!taken.has(c.toLowerCase())) return c;
    }
    return desired + '_' + Date.now();
}

function sanitiseName(raw) {
    return (typeof raw === 'string' ? raw : 'Guest').replace(/[<>]/g, '').substring(0, 15).trim() || 'Guest';
}

// ══════════════════════════════════════════════════════════════════════════
//  WEBSOCKET SERVER  :5889
// ══════════════════════════════════════════════════════════════════════════
const wss = new WebSocket.Server({ port: 5889 });

wss.on('connection', (ws, req) => {
    ws.isAlive = true; ws.messageCount = 0;
    ws.clientIp = req.socket.remoteAddress;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.send(JSON.stringify({
        type: 'SYNC_STATE', spellRoundActive: gameState.state.spellRoundActive,
        mode: gameState.state.mode, phase: gameState.state.phase,
        currentRound: gameState.state.currentRound, maxRounds: gameState.state.maxRounds
    }));
    ws.send(JSON.stringify({ type: 'TIME_SYNC', serverTime: timeSync.getServerTime(), requestSync: true }));

    ws.on('message', async message => {
        ws.messageCount++;

        // Binary = video chunk or thumbnail from a school node
        if (message instanceof Buffer && message.length > 0 && message[0] !== 0x7b) {
            handleBinaryFromSchool(message); return;
        }

        if (message.length > 64 * 1024) { ws.send(JSON.stringify({ type: 'ERROR', message: 'Too large' })); return; }

        let data;
        try { data = JSON.parse(message); }
        catch (_) { ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid JSON' })); return; }

        debugLog(`MSG ${data.type} from ${ws.clientIp}`);

        // ── School-proxied message ──────────────────────────────────────────
        // All messages from school-server arrive on the school node's WS.
        // We demux them using _lcid and route to the appropriate VirtualClient.
        if (data._schoolProxy && data._schoolId) {
            const node = schoolNodes.get(data._schoolId);
            if (!node) return; // unregistered school

            const lcid = data._lcid;
            if (!lcid) {
                // No _lcid — treat as a node-level message (SCHOOL_REGISTER, CAMERAS_UPDATE etc.)
                await handleMessage(ws, data).catch(e => logger.error(`Handler: ${e.message}`));
                return;
            }

            // Get or create the VirtualClient for this local client
            const vc = getOrCreateVirtualClient(lcid, ws, data._schoolId);

            // Strip proxy metadata before handling so handlers don't see it
            const { _schoolProxy, _schoolId, _lcid: _lc, ...clean } = data;
            await handleMessage(vc, clean).catch(e => logger.error(`VC Handler: ${e.message}`));
            return;
        }

        await handleMessage(ws, data).catch(e => {
            logger.error(`Handler: ${e.message}`);
            try { ws.send(JSON.stringify({ type: 'ERROR', message: 'Server error' })); } catch (_) {}
        });
    });

    ws.on('close', () => {
        const p = gameState.state.players.get(ws);
        if (p) {
            if (p.role === 'player')       { sysLog(`❌ ${p.username} disconnected`); broadcastLobbyState(); }
            else if (p.role === 'speller')  { setTimeout(broadcastSpellerState, 100); }
            else if (p.role === 'school_node') {
                const node = schoolNodes.get(p.schoolId);
                if (node) node.ws = null;
                // Mark all VirtualClients for this school as closed
                for (const [lcid, vc] of virtualClients) {
                    if (vc._schoolId === p.schoolId) {
                        vc.readyState = WebSocket.CLOSED;
                    }
                }
                sysLog(`🏫 School disconnected: ${p.schoolId}`);
                broadcast({ type: 'SCHOOL_NODES_UPDATE', nodes: getSchoolNodesSummary() });
            }
            gameState.state.players.delete(ws);
        }
    });

    ws.on('error', e => logger.error(`WS ${ws.clientIp}: ${e.message}`));
});

function handleBinaryFromSchool(message) {
    try {
        const headerStr = message.subarray(0, 256).toString().replace(/\0+$/, '');
        const header    = JSON.parse(headerStr);
        const payload   = message.subarray(256);
        const camKey    = header.camKey || `${header.schoolId}::${header.camId}`;

        if (header.type === 'CAM_THUMBNAIL') {
            const b64    = payload.toString('base64');
            const outMsg = JSON.stringify({
                type: 'CAM_THUMBNAIL', schoolId: header.schoolId, camId: header.camId,
                camKey, jpeg: b64, ts: header.ts
            });
            for (const [ws, p] of gameState.state.players) {
                if (p.role === 'admin' || p.role === 'viewer') {
                    if (ws instanceof VirtualClient) { try { ws.send(outMsg); } catch (_) {} }
                    else if (ws.readyState === WebSocket.OPEN) { try { ws.send(outMsg); } catch (_) {} }
                }
            }
        }

        if (header.type === 'VIDEO_CHUNK') {
            for (const [ws, p] of gameState.state.players) {
                if (p.role === 'viewer' && ws._viewingCam === camKey) {
                    if (!(ws instanceof VirtualClient) && ws.readyState === WebSocket.OPEN) {
                        try { ws.send(message); } catch (_) {}
                    }
                }
            }
        }
    } catch (_) {}
}

const heartbeat = setInterval(() => {
    let dead = 0;
    wss.clients.forEach(ws => {
        if (!ws.isAlive) { ws.terminate(); dead++; return; }
        ws.isAlive = false; ws.ping();
    });
    if (dead) sysLog(`💔 Terminated ${dead} dead connections`);
}, 30000);

setInterval(() => { const n = gameState.cleanup(); if (n > 0) broadcastLobbyState(); }, 30000);

// ══════════════════════════════════════════════════════════════════════════
//  MESSAGE HANDLER  (handles both real ws and VirtualClient)
// ══════════════════════════════════════════════════════════════════════════
async function handleMessage(ws, data) {
    const isVC = ws instanceof VirtualClient;

    function wsSend(obj) {
        const s = JSON.stringify(obj);
        if (isVC) { try { ws.send(s); } catch (_) {} }
        else if (ws.readyState === WebSocket.OPEN) { try { ws.send(s); } catch (_) {} }
    }

    switch (data.type) {

        case 'PING':
            wsSend({ type: 'PONG', serverTime: timeSync.getServerTime() }); break;

        case 'TIME_SYNC_RESPONSE': {
            const now = timeSync.getServerTime();
            if (data.step === 2) {
                ws.clientOffset = data.offset; ws.lastSyncTime = now;
                const p = gameState.state.players.get(ws);
                if (p?.userId) timeSync.recordSync(p.userId, data.offset, data.rtt);
            } else {
                wsSend({ type: 'TIME_SYNC_RESULT', serverTime: now, t0: data.t0 });
            }
            break;
        }

        case 'GET_HOST_STATE':
            wsSend({ type: 'HOST_STATE_SYNC', mode: gameState.state.mode, phase: gameState.state.phase, currentSpellText: gameState.state.spellText });
            break;

        case 'ADMIN_LOGIN':
            if (data.key === ADMIN_KEY) {
                gameState.state.players.set(ws, { role: 'admin', username: 'HOST' });
                ws._wsId = ws._wsId || nextWsId();
                wsSend({
                    type: 'AUTH_SUCCESS', currentText: gameState.state.text,
                    currentSpellText: gameState.state.spellText, gameState: gameState.getState(),
                    gameDuration: GAME_DURATION, maxRounds: gameState.state.maxRounds,
                    cameras: getCamerasSummary(), schoolNodes: getSchoolNodesSummary(), devMode: IS_DEV
                });
                sysLog('👑 Host connected');
                broadcastLobbyState();
            } else {
                wsSend({ type: 'AUTH_FAIL' });
                logger.warn(`🚫 Bad key from ${ws.clientIp}`);
            }
            break;

        case 'SET_GAME_MODE': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'admin') break;
            const prev = gameState.state.mode; gameState.state.mode = data.mode;
            if (prev !== data.mode) broadcast({ type: 'MODE_CHANGED', mode: data.mode },
                c => gameState.state.players.get(c)?.role !== 'admin');
            break;
        }

        case 'SET_DURATION': {
            const p = gameState.state.players.get(ws);
            if (p?.role === 'admin' && typeof data.duration === 'number')
                GAME_DURATION = Math.max(10, Math.min(600, data.duration));
            break;
        }

        case 'SET_ROUNDS': {
            const p = gameState.state.players.get(ws);
            if (p?.role === 'admin' && typeof data.rounds === 'number') {
                gameState.state.maxRounds = Math.max(1, Math.min(10, Math.floor(data.rounds)));
                wsSend({ type: 'ROUNDS_UPDATED', maxRounds: gameState.state.maxRounds });
            }
            break;
        }

        case 'UPDATE_TEXT':
            if (gameState.state.players.get(ws)?.role === 'admin') {
                if (data.mode === 'spell') { gameState.state.spellText = data.text; wsSend({ type: (await saveSpellText(data.text)) ? 'TEXT_UPDATE_SUCCESS' : 'TEXT_UPDATE_PARTIAL' }); }
                else                       { gameState.state.text = data.text;      wsSend({ type: (await saveText(data.text))      ? 'TEXT_UPDATE_SUCCESS' : 'TEXT_UPDATE_PARTIAL' }); }
            }
            break;

        case 'START_REQUEST': {
            const p = gameState.state.players.get(ws);
            if (p?.role === 'admin' && gameState.state.phase === 'LOBBY') await startGame(); break;
        }

        case 'NEXT_ROUND': {
            const p = gameState.state.players.get(ws);
            if (p?.role === 'admin' && gameState.state.phase === 'ROUND_END') await startGame(); break;
        }

        case 'END_SERIES': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'admin') break;
            gameState.state.currentRound = 0; gameState.state.roundHistory = [];
            await gameState.transition('LOBBY', { gameId: null, startTime: null, endTime: null });
            broadcast({ type: 'SERIES_OVER', serverTime: timeSync.getServerTime() });
            broadcastLobbyState(); break;
        }

        case 'FORCE_RESET': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'admin') break;
            if (gameState.endGameTimeout) { clearTimeout(gameState.endGameTimeout); gameState.endGameTimeout = null; }
            gameState.state.currentRound = 0; gameState.state.roundHistory = [];
            await gameState.transition('LOBBY', { gameId: null, startTime: null, endTime: null });
            broadcast({ type: 'FORCE_RESET' }); broadcastLobbyState(); break;
        }

        case 'KICK_PLAYER': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'admin') break;
            for (const [s, pl] of gameState.state.players) {
                if (pl.userId === data.userId && pl.role === 'player') {
                    if (s instanceof VirtualClient) { s.send(JSON.stringify({ type: 'KICKED' })); s.terminate(); }
                    else { try { s.send(JSON.stringify({ type: 'KICKED' })); } catch (_) {} setTimeout(() => { try { s.terminate(); } catch (_) {} }, 500); }
                    gameState.state.players.delete(s); broadcastLobbyState();
                    wsSend({ type: 'PLAYER_KICKED', userId: data.userId }); break;
                }
            }
            break;
        }

        case 'KICK_SPELLER': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'admin') break;
            for (const [s, pl] of gameState.state.players) {
                if ((pl.userId === data.userId || pl.username === data.userId) && pl.role === 'speller') {
                    if (s instanceof VirtualClient) { s.send(JSON.stringify({ type: 'KICKED' })); s.terminate(); }
                    else { try { s.send(JSON.stringify({ type: 'KICKED' })); } catch (_) {} setTimeout(() => { try { s.terminate(); } catch (_) {} }, 500); }
                    gameState.state.players.delete(s); broadcastSpellerState();
                    wsSend({ type: 'PLAYER_KICKED', userId: data.userId }); break;
                }
            }
            break;
        }

        case 'PRESENTATION_JOIN': {
            const presId = ws._wsId || (ws._wsId = nextWsId());
            gameState.state.players.set(ws, { role: 'viewer', username: 'Screen', wsId: presId });
            wsSend({
                type: 'FULL_STATE_SYNC', state: gameState.getState(), wsId: presId,
                cameras: getCamerasSummary(), schoolNodes: getSchoolNodesSummary(),
                assignments: getPresentationAssignments(),
            });
            // ── Re-assign cameras if this screen was previously on air ──────
            const prevCams = (typeof presentationMultiCams !== 'undefined') ? presentationMultiCams.get(presId) : null;
            if (prevCams && prevCams.length > 0) {
                sysLog(`🖥️  Presentation ${presId} reconnected — re-assigning ${prevCams.length} cam(s)`);
                prevCams.forEach((entry, idx) => {
                    if (!ws._viewerIds) ws._viewerIds = new Map();
                    if (!ws._viewingCams) ws._viewingCams = new Set();
                    const viewerId = 'pres-' + presId + '-rv-' + nextWsId();
                    ws._viewerIds.set(entry.camKey, viewerId);
                    ws._viewingCams.add(entry.camKey);
                    wsSend({ type: 'PRESENTATION_CAM_ADDED', schoolId: entry.schoolId, camId: entry.camId, camKey: entry.camKey, viewerId, slotIdx: idx, totalSlots: prevCams.length });
                    const node = schoolNodes.get(entry.schoolId);
                    if (node?.isVirtual) virtualHandleViewRequest(entry.camId, viewerId, ws);
                    else if (node?.ws?.readyState === WebSocket.OPEN)
                        node.ws.send(JSON.stringify({ type: 'VIEW_CAM_REQUEST', schoolId: entry.schoolId, camId: entry.camId, viewerId }));
                });
            }
            broadcastLobbyState();
            break;
        }

        case 'JOIN':
        case 'RECONNECT': {
            const orig = sanitiseName(data.username);
            const assigned = deduplicateUsername(orig);
            data.username = assigned;
            if (assigned !== orig) data._nameChanged = true;
            await handleJoin(ws, data); break;
        }

        case 'JOIN_SPELL': {
            const orig = sanitiseName(data.username);
            const assigned = deduplicateUsername(orig);
            data.username = assigned;
            if (assigned !== orig) data._nameChanged = true;
            await handleJoinSpell(ws, data); break;
        }

        case 'PROGRESS_UPDATE': {
            const p = gameState.state.players.get(ws);
            if (!rl2.check((p?.userId || ws.clientIp) + '_prog', 20)) break;
            if (p?.role === 'player' && gameState.state.phase === 'RACING' && !p.finished) {
                p.wpm = data.wpm||0; p.acc = data.acc||0; p.progress = data.progress||0;
                p.errors = data.errors||0; p.consistency = data.consistency||0;
                // Store raw char counts so server can recompute WPM authoritatively at finish
                if (typeof data.correctChars === 'number') p.correctChars = data.correctChars;
                if (typeof data.totalChars   === 'number') p.totalChars   = data.totalChars;
                broadcastLobbyState();
            }
            break;
        }

        case 'FINISH': await handleFinish(ws, data); break;

        case 'REQUEST_SPELLER_SYNC': broadcastSpellerState(); break;

        case 'START_SPELL_ROUND': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'admin') break;
            gameState.state.spellRoundActive = true;
            gameState.state.spellStartTime   = timeSync.getServerTime();
            const wc = gameState.state.spellText.trim().split(/\s+/).length;
            broadcast({ type: 'SPELL_START', startTime: gameState.state.spellStartTime, serverTime: timeSync.getServerTime(), wordCount: wc },
                c => gameState.state.players.get(c)?.role === 'speller');
            broadcastSpellerState(); break;
        }

        case 'STOP_SPELL_ROUND': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'admin') break;
            gameState.state.spellRoundActive = false;
            broadcast({ type: 'SPELL_END' }); break;
        }

        case 'SPELL_SUBMIT_FULL': await handleSpellSubmit(ws, data); break;

        // ── School node registration ─────────────────────────────────────────
        case 'SCHOOL_REGISTER': {
            const { schoolId, httpPort, localPort, videoPort, maxCams } = data;
            if (!schoolId) break;

            const realWs    = ws instanceof VirtualClient ? ws._nodeWs : ws;
            const isReRegister = schoolNodes.has(schoolId);

            if (isReRegister) {
                // ── Stale-state cleanup on reconnect ──────────────────────
                // 1. Purge all VirtualClients that belonged to this school
                let vcPurged = 0;
                for (const [lcid, vc] of virtualClients) {
                    if (vc._schoolId === schoolId) {
                        gameState.state.players.delete(vc);
                        vc.readyState = WebSocket.CLOSED;
                        virtualClients.delete(lcid);
                        vcPurged++;
                    }
                }
                // 2. Flush stale camera entries for this school
                let camPurged = 0;
                for (const [key, cam] of allCameras) {
                    if (cam.schoolId === schoolId) { allCameras.delete(key); camPurged++; }
                }
                // 3. Remove old player entry (old ws may already be closed)
                const oldNode = schoolNodes.get(schoolId);
                if (oldNode?.ws && oldNode.ws !== realWs) {
                    gameState.state.players.delete(oldNode.ws);
                }
                sysLog(`🏫 School RE-REGISTERED: ${schoolId}  (purged ${vcPurged} VCs, ${camPurged} cams)`);
            } else {
                sysLog(`🏫 School registered: ${schoolId}`);
            }

            gameState.state.players.set(realWs, { role: 'school_node', schoolId, username: schoolId });
            realWs._wsId = realWs._wsId || nextWsId();
            schoolNodes.set(schoolId, {
                ws: realWs, schoolId, httpPort, localPort, videoPort, maxCams,
                connectedAt: Date.now(), cameras: [],
                reconnects: isReRegister ? ((schoolNodes.get(schoolId)?.reconnects || 0) + 1) : 0,
            });
            realWs.send(JSON.stringify({ type: 'SCHOOL_REGISTER_OK', schoolId }));
            broadcast({ type: 'SCHOOL_NODES_UPDATE', nodes: getSchoolNodesSummary() });
            // Camera state will arrive via SCHOOL_CAMERAS_UPDATE shortly after
            break;
        }

        case 'SCHOOL_CAMERAS_UPDATE': {
            const node = schoolNodes.get(data.schoolId); if (!node) break;
            const newKeys = new Set();
            (data.cameras||[]).forEach(cam => {
                const key = `${data.schoolId}::${cam.camId}`; newKeys.add(key);
                allCameras.set(key, { ...cam, schoolId: data.schoolId, key, lastSeen: Date.now() });
            });
            for (const [k, c] of allCameras) if (c.schoolId === data.schoolId && !newKeys.has(k)) allCameras.delete(k);
            node.cameras = data.cameras || [];
            broadcast({ type: 'CAMERAS_UPDATE', cameras: getCamerasSummary() });
            break;
        }

        case 'SCHOOL_CLIENT_DISCONNECT': {
            // School node reports a local client disconnected — clean up virtual client
            const { schoolId, userId } = data;
            for (const [vc, p] of gameState.state.players) {
                if (vc instanceof VirtualClient && vc._schoolId === schoolId && p.userId === userId) {
                    gameState.state.players.delete(vc); vc.terminate(); break;
                }
            }
            broadcastLobbyState(); break;
        }

        case 'SCHOOL_STREAM_OFFER': {
            const v = findViewerByViewerId(data.viewerId);
            if (v) {
                const msg = { type: 'STREAM_OFFER', camId: data.camId, camKey: data.camKey || `${data.schoolId}::${data.camId}`, schoolId: data.schoolId, sdp: data.sdp, viewerId: data.viewerId };
                if (v instanceof VirtualClient) v.send(JSON.stringify(msg));
                else if (v.readyState === WebSocket.OPEN) v.send(JSON.stringify(msg));
            }
            break;
        }

        case 'SCHOOL_STREAM_ICE_FROM_CAM': {
            const v = findViewerByViewerId(data.viewerId);
            if (v) {
                const msg = { type: 'STREAM_ICE_FROM_CAM', camId: data.camId, camKey: data.camKey || `${data.schoolId}::${data.camId}`, schoolId: data.schoolId, candidate: data.candidate };
                if (v instanceof VirtualClient) v.send(JSON.stringify(msg));
                else if (v.readyState === WebSocket.OPEN) v.send(JSON.stringify(msg));
            }
            break;
        }

        case 'SCHOOL_STREAM_ANSWER':
        case 'SCHOOL_STREAM_ICE': {
            const node = schoolNodes.get(data.schoolId);
            if (node?.ws?.readyState === WebSocket.OPEN) node.ws.send(JSON.stringify(data));
            break;
        }

        case 'HOST_VIEW_CAM': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'admin') break;
            const viewerId = 'host-viewer-' + nextWsId();
            ws._viewerId = viewerId; ws._viewingCam = `${data.schoolId}::${data.camId}`;
            const node = schoolNodes.get(data.schoolId);
            if (!node) { wsSend({ type: 'CAM_NOT_FOUND', camId: data.camId }); break; }
            if (node.isVirtual) {
                virtualHandleViewRequest(data.camId, viewerId, ws);
            } else if (node.ws?.readyState === WebSocket.OPEN) {
                node.ws.send(JSON.stringify({ type: 'VIEW_CAM_REQUEST', schoolId: data.schoolId, camId: data.camId, viewerId }));
            }
            break;
        }

        // Legacy alias — original presentation screens used PRESENTATION_SET_CAM
        // New host-cameras.js uses HOST_ASSIGN_CAM_TO_PRESENTATION instead
        case 'PRESENTATION_SET_CAM': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'viewer') break;
            const presId = ws._wsId || (ws._wsId = nextWsId());
            presentationAssignments.set(presId, { schoolId: data.schoolId, camId: data.camId, camKey: `${data.schoolId}::${data.camId}` });
            ws._viewerId   = 'pres-' + presId;
            ws._viewingCam = `${data.schoolId}::${data.camId}`;
            const node = schoolNodes.get(data.schoolId);
            if (node?.isVirtual) virtualHandleViewRequest(data.camId, 'pres-' + presId, ws);
            else if (node?.ws?.readyState === WebSocket.OPEN) node.ws.send(JSON.stringify({ type: 'VIEW_CAM_REQUEST', schoolId: data.schoolId, camId: data.camId, viewerId: 'pres-' + presId }));
            broadcast({ type: 'PRESENTATION_ASSIGNMENTS', assignments: getPresentationAssignments() });
            break;
        }

        case 'HOST_ASSIGN_CAM_TO_PRESENTATION': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'admin') break;
            for (const [pws, pp] of gameState.state.players) {
                if (pp.role !== 'viewer') continue;
                const presId = pws._wsId || (pws._wsId = nextWsId());
                presentationAssignments.set(presId, { schoolId: data.schoolId, camId: data.camId, camKey: data.camKey });
                pws._viewerId = 'pres-' + presId; pws._viewingCam = data.camKey;
                const assignMsg = JSON.stringify({ type: 'PRESENTATION_CAM_ASSIGNED', schoolId: data.schoolId, camId: data.camId, camKey: data.camKey });
                if (pws instanceof VirtualClient) pws.send(assignMsg);
                else if (pws.readyState === WebSocket.OPEN) pws.send(assignMsg);
                const node = schoolNodes.get(data.schoolId);
                if (node?.isVirtual) virtualHandleViewRequest(data.camId, 'pres-' + presId, pws);
                else if (node?.ws?.readyState === WebSocket.OPEN) node.ws.send(JSON.stringify({ type: 'VIEW_CAM_REQUEST', schoolId: data.schoolId, camId: data.camId, viewerId: 'pres-' + presId }));
            }
            broadcast({ type: 'PRESENTATION_ASSIGNMENTS', assignments: getPresentationAssignments() });
            break;
        }

        case 'HOST_UNASSIGN_CAM': {
            for (const [pws, pp] of gameState.state.players) {
                if (pp.role === 'viewer' && pws._viewingCam === data.camKey) {
                    pws._viewingCam = null;
                    const msg = JSON.stringify({ type: 'PRESENTATION_CAM_REMOVED' });
                    if (pws instanceof VirtualClient) pws.send(msg);
                    else if (pws.readyState === WebSocket.OPEN) pws.send(msg);
                }
            }
            for (const [pid, a] of presentationAssignments) if (a.camKey === data.camKey) presentationAssignments.delete(pid);
            broadcast({ type: 'PRESENTATION_ASSIGNMENTS', assignments: getPresentationAssignments() });
            break;
        }

        case 'HOST_UNASSIGN_PRESENTATION': {
            presentationAssignments.delete(data.presId);
            for (const [pws, pp] of gameState.state.players) {
                if (pp.role === 'viewer' && pws._wsId === data.presId) {
                    pws._viewingCam = null;
                    const msg = JSON.stringify({ type: 'PRESENTATION_CAM_REMOVED' });
                    if (pws instanceof VirtualClient) pws.send(msg);
                    else if (pws.readyState === WebSocket.OPEN) pws.send(msg);
                }
            }
            broadcast({ type: 'PRESENTATION_ASSIGNMENTS', assignments: getPresentationAssignments() });
            break;
        }

        // ── Multi-cam: add one camera to all presentation screens ────────────
        case 'HOST_ADD_CAM_TO_PRESENTATION': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'admin') break;
            for (const [pws, pp] of gameState.state.players) {
                if (pp.role !== 'viewer') continue;
                const presId = pws._wsId || (pws._wsId = nextWsId());

                if (!presentationMultiCams.has(presId)) presentationMultiCams.set(presId, []);
                const cams = presentationMultiCams.get(presId);
                if (cams.find(c => c.camKey === data.camKey)) continue; // already assigned

                cams.push({ schoolId: data.schoolId, camId: data.camId, camKey: data.camKey });

                if (!pws._viewerIds) pws._viewerIds = new Map();
                if (!pws._viewingCams) pws._viewingCams = new Set();
                const viewerId = 'pres-' + presId + '-' + nextWsId();
                pws._viewerIds.set(data.camKey, viewerId);
                pws._viewingCams.add(data.camKey);
                // Keep legacy single field in sync for first cam
                if (cams.length === 1) { pws._viewingCam = data.camKey; pws._viewerId = viewerId; }

                const addMsg = JSON.stringify({
                    type: 'PRESENTATION_CAM_ADDED',
                    schoolId: data.schoolId, camId: data.camId, camKey: data.camKey,
                    viewerId, slotIdx: cams.length - 1, totalSlots: cams.length,
                });
                if (pws instanceof VirtualClient) pws.send(addMsg);
                else if (pws.readyState === WebSocket.OPEN) pws.send(addMsg);

                // Ask school to start streaming to this viewer
                const node = schoolNodes.get(data.schoolId);
                if (node?.isVirtual) virtualHandleViewRequest(data.camId, viewerId, pws);
                else if (node?.ws?.readyState === WebSocket.OPEN)
                    node.ws.send(JSON.stringify({ type: 'VIEW_CAM_REQUEST', schoolId: data.schoolId, camId: data.camId, viewerId }));
            }
            broadcast({ type: 'PRESENTATION_ASSIGNMENTS', assignments: getPresentationAssignments() });
            break;
        }

        // ── Multi-cam: remove one camera from all presentation screens ────────
        case 'HOST_REMOVE_CAM_FROM_PRES': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'admin') break;
            for (const [pws, pp] of gameState.state.players) {
                if (pp.role !== 'viewer') continue;
                pws._viewingCams?.delete(data.camKey);
                pws._viewerIds?.delete(data.camKey);
                if (pws._viewingCam === data.camKey) pws._viewingCam = null;
                const presId = pws._wsId;
                if (presId && presentationMultiCams.has(presId)) {
                    const updated = presentationMultiCams.get(presId).filter(c => c.camKey !== data.camKey);
                    updated.length ? presentationMultiCams.set(presId, updated) : presentationMultiCams.delete(presId);
                }
                const msg = JSON.stringify({ type: 'PRESENTATION_CAM_REMOVED', camKey: data.camKey });
                if (pws instanceof VirtualClient) pws.send(msg);
                else if (pws.readyState === WebSocket.OPEN) pws.send(msg);
            }
            for (const [pid, a] of presentationAssignments) if (a.camKey === data.camKey) presentationAssignments.delete(pid);
            broadcast({ type: 'PRESENTATION_ASSIGNMENTS', assignments: getPresentationAssignments() });
            break;
        }

        // ── Fullscreen toggle — broadcast to all presentation viewers ─────────
        case 'HOST_PRESENTATION_FULLSCREEN': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'admin') break;
            const msg = JSON.stringify({ type: 'PRESENTATION_FULLSCREEN', enabled: !!data.enabled });
            for (const [pws, pp] of gameState.state.players) {
                if (pp.role !== 'viewer') continue;
                if (pws instanceof VirtualClient) pws.send(msg);
                else if (pws.readyState === WebSocket.OPEN) pws.send(msg);
            }
            break;
        }

        // ── Announcement — host sends text to all presentation screens ────────
        case 'HOST_ANNOUNCEMENT': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'admin') break;
            const msg = JSON.stringify({
                type   : 'PRESENTATION_ANNOUNCEMENT',
                text   : (data.text || '').substring(0, 300),
                persist: !!data.persist,   // true = keep as small ticker after big display
                clear  : !!data.clear,     // true = clear any active announcement
            });
            for (const [pws, pp] of gameState.state.players) {
                if (pp.role !== 'viewer') continue;
                if (pws instanceof VirtualClient) pws.send(msg);
                else if (pws.readyState === WebSocket.OPEN) pws.send(msg);
            }
            break;
        }

        case 'RECORDING_START':
        case 'RECORDING_STOP': {
            const p = gameState.state.players.get(ws); if (p?.role !== 'admin') break;
            const node = schoolNodes.get(data.schoolId);
            if (node?.isVirtual) {
                const cam = allCameras.get(`${data.schoolId}::${data.camId}`);
                if (cam) { cam.recording = data.type === 'RECORDING_START'; broadcast({ type: 'CAMERAS_UPDATE', cameras: getCamerasSummary() }); }
            } else if (node?.ws?.readyState === WebSocket.OPEN) {
                node.ws.send(JSON.stringify(data));
            }
            break;
        }

        case 'STREAM_ANSWER': {
            // Resolve which school/cam this answer belongs to via viewerId
            let sid, cid, resolvedViewerId;
            resolvedViewerId = data.viewerId || ws._viewerId;

            // Multi-cam path: reverse-lookup camKey from ws._viewerIds Map
            if (ws._viewerIds instanceof Map && resolvedViewerId) {
                for (const [camKey, vid] of ws._viewerIds) {
                    if (vid === resolvedViewerId) {
                        [sid, cid] = camKey.split('::');
                        break;
                    }
                }
            }
            // Legacy single-cam fallback
            if (!sid && ws._viewingCam) {
                [sid, cid] = ws._viewingCam.split('::');
            }
            if (!sid || !cid) break;
            const node = schoolNodes.get(sid);
            if (node?.isVirtual) break;
            if (node?.ws?.readyState === WebSocket.OPEN)
                node.ws.send(JSON.stringify({ type: 'SCHOOL_STREAM_ANSWER', schoolId: sid, camId: cid, sdp: data.sdp, viewerId: resolvedViewerId }));
            break;
        }

        case 'STREAM_ICE': {
            const resolvedViewerId = data.viewerId || ws._viewerId;
            let sid, cid;

            // Multi-cam: reverse-lookup camKey from ws._viewerIds
            if (ws._viewerIds instanceof Map && resolvedViewerId) {
                for (const [camKey, vid] of ws._viewerIds) {
                    if (vid === resolvedViewerId) { [sid, cid] = camKey.split('::'); break; }
                }
            }
            // Legacy fallback
            if (!sid && ws._viewingCam) { [sid, cid] = ws._viewingCam.split('::'); }
            if (!sid || !cid) break;
            const node = schoolNodes.get(sid);
            if (node?.isVirtual) break;
            if (node?.ws?.readyState === WebSocket.OPEN)
                node.ws.send(JSON.stringify({ type: 'SCHOOL_STREAM_ICE', schoolId: sid, camId: cid, candidate: data.candidate, viewerId: resolvedViewerId }));
            break;
        }

        case 'REQUEST_STATE_SYNC':
            wsSend({ type: 'FULL_STATE_SYNC', state: gameState.getState() }); break;

        case 'STREAM_AUTH': {
            const ok = data.key === STREAM_KEY;
            wsSend({ type: ok ? 'STREAM_AUTH_OK' : 'STREAM_AUTH_FAIL' });
            if (ok) {
                const camKey = `direct::${data.camId}`;
                gameState.state.players.set(ws, { role: 'streamer', camId: data.camId, schoolId: 'direct' });
                ws._camKey = camKey;
                sysLog(`📡 Streamer authed: ${data.camId}`);
            } else {
                logger.warn(`🚫 Bad stream key from ${ws.clientIp}`);
            }
            break;
        }

        case 'STREAM_START': {
            const sp = gameState.state.players.get(ws);
            if (sp?.role !== 'streamer') break;
            const camKey = ws._camKey || `direct::${data.camId || sp.camId}`;
            const camId = data.camId || sp.camId;
            allCameras.set(camKey, {
                camId, schoolId: 'direct',
                label: data.label || camId,
                streaming: true, recording: false, bytesWritten: 0,
                key: camKey, lastSeen: Date.now()
            });
            broadcast({ type: 'CAMERAS_UPDATE', cameras: getCamerasSummary() });
            sysLog(`� Camera "${camId}" is now LIVE (direct connection)`);
            // Notify any presentation screens that a stream is available
            for (const [pws, pp] of gameState.state.players) {
                if (pp.role === 'viewer' && pws._viewingCam === camKey) {
                    const vid = pws._wsId || nextWsId();
                    const m = JSON.stringify({ type: 'VIEWER_JOINED', viewerId: vid });
                    if (pws instanceof VirtualClient) pws.send(m);
                    else if (pws.readyState === WebSocket.OPEN) pws.send(m);
                }
            }
            break;
        }

        case 'STREAM_STOP': {
            const sp = gameState.state.players.get(ws);
            if (sp?.role !== 'streamer') break;
            if (ws._camKey) allCameras.delete(ws._camKey);
            broadcast({ type: 'CAMERAS_UPDATE', cameras: getCamerasSummary() });
            sysLog(`📡 Stream stopped: ${sp.camId}`);
            break;
        }

        case 'STREAM_OFFER': {
            // Direct streamer → viewer signaling (non-school-proxy path)
            const p = gameState.state.players.get(ws);
            if (p?.role === 'streamer') {
                const target = findViewerByViewerId(data.viewerId);
                if (target) {
                    const m = JSON.stringify({ type: 'STREAM_OFFER', sdp: data.sdp, viewerId: data.viewerId, camId: data.camId, camKey: ws._camKey });
                    if (target instanceof VirtualClient) target.send(m);
                    else if (target.readyState === WebSocket.OPEN) target.send(m);
                }
            }
            break;
        }

        case 'STREAM_ICE': {
            const p = gameState.state.players.get(ws);
            if (p?.role === 'streamer') {
                // Streamer ICE → viewer
                const target = findViewerByViewerId(data.viewerId);
                if (target) {
                    const m = JSON.stringify({ type: 'STREAM_ICE_FROM_CAM', candidate: data.candidate, viewerId: data.viewerId });
                    if (target instanceof VirtualClient) target.send(m);
                    else if (target.readyState === WebSocket.OPEN) target.send(m);
                }
            } else {
                // Viewer ICE → streamer
                for (const [sws, sp] of gameState.state.players) {
                    if (sp.role === 'streamer' && !(sws instanceof VirtualClient) && sws.readyState === WebSocket.OPEN) {
                        sws.send(JSON.stringify({ type: 'STREAM_ICE', candidate: data.candidate, viewerId: data.viewerId }));
                    }
                }
            }
            break;
        }

        default:
            debugLog(`Unknown: ${data.type}`);
    }
}

// ══════════════════════════════════════════════════════════════════════════
//  JOIN / FINISH / SPELL
// ══════════════════════════════════════════════════════════════════════════
function wsSend(ws, obj) {
    const s = JSON.stringify(obj);
    if (ws instanceof VirtualClient) { try { ws.send(s); } catch (_) {} }
    else if (ws.readyState === WebSocket.OPEN) { try { ws.send(s); } catch (_) {} }
}

async function handleJoin(ws, data) {
    if (data.role === 'admin') return;
    const userId   = (typeof data.userId === 'string' ? data.userId : '').replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 64) || ('u_' + Date.now());
    const username = data.username || 'Guest';
    const grade    = ['1-4','5-9','10-12'].includes(data.grade) ? data.grade : '1-4';

    const isReconnect = [...gameState.state.players.values()].some(p => p.userId === userId && p.role === 'player');
    if (!isReconnect) {
        const count = [...gameState.state.players.values()].filter(p => p.role === 'player').length;
        if (count >= MAX_PLAYERS) { wsSend(ws, { type: 'ERROR', message: 'Server full' }); return; }
    }

    for (const [s, p] of gameState.state.players) {
        if (p.userId === userId && s !== ws) {
            if (s instanceof VirtualClient) s.terminate();
            else { try { s.close(); } catch (_) {} }
            gameState.state.players.delete(s);
        }
    }

    try { await dbRun(`INSERT OR REPLACE INTO users (id,username,grade) VALUES(?,?,?)`, [userId, username, grade]); } catch (_) {}

    gameState.state.players.set(ws, { userId, username, grade, role: 'player', finished: false, wpm: 0, acc: 0, raw: 0, consistency: 0, errors: 0, progress: 0, joinTime: timeSync.getServerTime() });
    sysLog(`✅ ${username} (${grade}) joined`);

    if (data._nameChanged) wsSend(ws, { type: 'USERNAME_CHANGED', assigned: username });

    if (gameState.state.phase === 'RACING') {
        const elapsed = Math.floor((timeSync.getServerTime() - gameState.state.startTime) / 1000);
        wsSend(ws, { type: 'GAME_IN_PROGRESS', text: gameState.state.text, duration: GAME_DURATION, elapsed, startTime: gameState.state.startTime, gameId: gameState.state.gameId, round: gameState.state.currentRound, maxRounds: gameState.state.maxRounds, serverTime: timeSync.getServerTime(), stateVersion: gameState.stateVersion });
    } else if (gameState.state.phase === 'COUNTDOWN') {
        wsSend(ws, { type: 'COUNTDOWN', count: gameState.state.countdown, serverTime: timeSync.getServerTime() });
    } else {
        wsSend(ws, { type: 'JOIN_SUCCESS', serverTime: timeSync.getServerTime(), stateVersion: gameState.stateVersion, currentRound: gameState.state.currentRound, maxRounds: gameState.state.maxRounds });
    }
    broadcastLobbyState();
}

async function handleJoinSpell(ws, data) {
    const userId   = (typeof data.userId === 'string' ? data.userId : '').replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 64) || ('sp_' + Date.now());
    const username = data.username || 'Guest';
    const grade    = ['1-4','5-9','10-12'].includes(data.grade) ? data.grade : '1-4';

    for (const [s, p] of gameState.state.players) {
        if (p.userId === userId && s !== ws) {
            if (s instanceof VirtualClient) s.terminate();
            else { try { s.close(); } catch (_) {} }
            gameState.state.players.delete(s);
        }
    }

    gameState.state.players.set(ws, { userId, username, grade, role: 'speller', score: 0, status: 'connected', finished: false, joinTime: timeSync.getServerTime() });
    sysLog(`✅ Speller ${username} (${grade}) joined`);

    if (data._nameChanged) wsSend(ws, { type: 'USERNAME_CHANGED', assigned: username });

    if (gameState.state.spellRoundActive) {
        const wc = gameState.state.spellText.trim().split(/\s+/).length;
        wsSend(ws, { type: 'SPELL_START', serverTime: timeSync.getServerTime(), wordCount: wc });
    }
    broadcastSpellerState();
}

async function handleFinish(ws, data) {
    const p = gameState.state.players.get(ws);
    // Accept FINISH during RACING or up to 3s into ROUND_END (late packets)
    if (gameState.state.phase !== 'RACING' && gameState.state.phase !== 'ROUND_END') return;
    if (p?.role !== 'player' || p.finished) return;

    p.finished    = true;
    p.finishTime  = timeSync.getServerTime();
    p.errors      = data.errors      || 0;
    p.consistency = data.consistency || 0;

    // ── Server-authoritative WPM calculation ──────────────────────────────
    // Use raw char counts if the client sent them (new protocol).
    // Fall back to the client's claimed WPM only if no char data available.
    const startTime = gameState.state.startTime || p.finishTime;

    if (typeof data.correctChars === 'number' && data.correctChars >= 0) {
        // New path: server owns the clock and the formula
        const elapsedMs  = Math.max(p.finishTime - startTime, 1000); // min 1s
        const elapsedMin = elapsedMs / 60000;
        const totalChars = typeof data.totalChars === 'number' ? data.totalChars : data.correctChars;
        p.correctChars   = data.correctChars;
        p.totalChars     = totalChars;
        p.wpm  = Math.round((data.correctChars / 5) / elapsedMin);
        p.raw  = Math.round((totalChars / 5) / elapsedMin);
        p.acc  = totalChars === 0 ? 100
               : Math.max(0, Math.round(((totalChars - p.errors) / totalChars) * 100));
    } else {
        // Legacy path: client sent pre-computed wpm (old clients / school proxy)
        p.wpm = data.wpm      || 0;
        p.raw = data.raw      || 0;
        p.acc = data.accuracy || data.acc || 0;
    }

    // Echo the server-computed WPM back to the client so its results screen matches
    const wsSend = obj => {
        const s = JSON.stringify(obj);
        if (ws instanceof VirtualClient) { try { ws.send(s); } catch (_) {} }
        else if (ws.readyState === WebSocket.OPEN) { try { ws.send(s); } catch (_) {} }
    };
    wsSend({ type: 'FINISH_ACK', wpm: p.wpm, raw: p.raw, acc: p.acc, errors: p.errors, consistency: p.consistency });

    sysLog(`🏁 ${p.username}: ${p.wpm} CPM  ${p.acc}%  (${typeof data.correctChars === 'number' ? 'server-calc' : 'client-claim'})`);

    if (gameState.state.gameId) {
        try {
            await dbRun(
                `INSERT INTO sessions(id,user_id,grade,wpm,acc,raw,consistency,errors)VALUES(?,?,?,?,?,?,?,?)`,
                [`${gameState.state.gameId}_${p.userId}`, p.userId, p.grade,
                 p.wpm, p.acc, p.raw, p.consistency, p.errors]
            );
        } catch (_) {}
    }
    broadcastLobbyState();
}

async function handleSpellSubmit(ws, data) {
    const player = gameState.state.players.get(ws);
    if (!gameState.state.spellRoundActive) { wsSend(ws, { type: 'ERROR', message: 'No active round.' }); return; }
    if (player?.finished || !player || !gameState.state.spellText) return;

    // ── Server-authoritative submit time ─────────────────────────────────────
    const submitTime   = timeSync.getServerTime();
    const roundStart   = gameState.state.spellStartTime || submitTime;
    const elapsedMs    = Math.max(submitTime - roundStart, 0);
    const elapsedSec   = (elapsedMs / 1000).toFixed(1);

    // ── Score the submission ──────────────────────────────────────────────────
    const tw   = gameState.state.spellText.trim().split(/\s+/);
    const sw   = (data.text || '').trim().split(/\s+/);
    const norm = w => w.toLowerCase().replace(/^[\W]+|[\W]+$/g, '');
    let correct = 0;
    const diff  = [];
    for (let i = 0; i < Math.max(tw.length, sw.length); i++) {
        const t  = tw[i] || '', s = sw[i] || '';
        const ok = t && s && norm(t) === norm(s);
        if (ok) { correct++; diff.push({ word: s, status: 'correct' }); }
        else    { diff.push({ word: s || '—', status: 'wrong', expected: t }); }
    }
    const acc = Math.round((correct / tw.length) * 100);

    // ── Composite score: accuracy is primary, elapsed time is tiebreaker ─────
    // Higher = better. Among equal accuracy, faster (lower ms) wins.
    // 1 point of accuracy is worth 10 minutes of time — accuracy always dominates.
    const compositeScore = acc * 600000 - elapsedMs;

    player.score          = acc;
    player.elapsedMs      = elapsedMs;
    player.compositeScore = compositeScore;
    player.submitTime     = submitTime;
    player.finished       = true;

    // ── Rank among all spellers who have already submitted ───────────────────
    const all      = [...gameState.state.players.values()].filter(p => p.role === 'speller');
    const finished = all.filter(p => p.finished);

    // Rank = how many finished players have a strictly better compositeScore + 1
    const rank = finished.filter(p => p !== player && (p.compositeScore || 0) > compositeScore).length + 1;

    // Percentile = how many submitted players scored strictly lower (out of non-self)
    const others = all.filter(p => p.finished && p !== player);
    const perc   = others.length === 0 ? 100
                 : Math.round((others.filter(p => (p.compositeScore || 0) < compositeScore).length / others.length) * 100);

    sysLog(`📝 ${player.username}: ${acc}% (${correct}/${tw.length}) in ${elapsedSec}s — rank #${rank}`);

    wsSend(ws, {
        type        : 'SPELL_RESULT_FULL',
        accuracy    : acc,
        diff,
        correctCount: correct,
        totalWords  : tw.length,
        elapsedSec  : parseFloat(elapsedSec),
        stats: {
            correct,
            incorrect  : tw.length - correct,
            percentile : perc,
            rank,
            totalSpellers: all.length,
            elapsedSec : parseFloat(elapsedSec),
        }
    });

    // Notify host live
    for (const [hws, hp] of gameState.state.players) {
        if (hp.role === 'admin') {
            const n = JSON.stringify({
                type: 'SPELL_LIVE_UPDATE',
                user: player.username, grade: player.grade,
                correct: acc >= 90, accuracy: acc,
                elapsedSec: parseFloat(elapsedSec),
            });
            if (hws instanceof VirtualClient) { try { hws.send(n); } catch (_) {} }
            else if (hws.readyState === WebSocket.OPEN) { try { hws.send(n); } catch (_) {} }
        }
    }

    broadcastSpellerState();
}

// ══════════════════════════════════════════════════════════════════════════
//  GAME START / END
// ══════════════════════════════════════════════════════════════════════════
async function startGame() {
    const newRound = gameState.state.phase === 'ROUND_END' ? gameState.state.currentRound + 1 : 1;
    if (!await gameState.transition('COUNTDOWN', { gameId: Date.now().toString(), countdown: 3, currentRound: newRound })) return;
    for (const p of gameState.state.players.values()) if (p.role === 'player') { p.finished=false; p.wpm=0; p.acc=0; p.raw=0; p.consistency=0; p.errors=0; p.progress=0; }
    const count = [...gameState.state.players.values()].filter(p => p.role==='player').length;
    sysLog(`🚦 Round ${newRound}/${gameState.state.maxRounds} — ${count} players`);
    for (let i = 3; i > 0; i--) {
        gameState.state.countdown = i;
        broadcast({ type: 'COUNTDOWN', count: i, round: newRound, maxRounds: gameState.state.maxRounds, serverTime: timeSync.getServerTime() });
        await new Promise(r => setTimeout(r, 1000));
    }
    const startTime = timeSync.getServerTime();
    await gameState.transition('RACING', { startTime, endTime: startTime + GAME_DURATION * 1000 });
    broadcast({ type: 'START_GAME', text: gameState.state.text, duration: GAME_DURATION, startTime, gameId: gameState.state.gameId, round: newRound, maxRounds: gameState.state.maxRounds, serverTime: timeSync.getServerTime() });
    if (gameState.endGameTimeout) clearTimeout(gameState.endGameTimeout);
    gameState.endGameTimeout = setTimeout(endGame, GAME_DURATION * 1000);
}

async function endGame() {
    if (gameState.state.phase !== 'RACING') return;
    const round = gameState.state.currentRound, isLast = round >= gameState.state.maxRounds;
    const endTime = timeSync.getServerTime();
    await gameState.transition('ROUND_END', { endTime });

    // ── Compute final WPM for players whose timer fired (never sent FINISH) ──
    // They've been sending PROGRESS_UPDATE with correctChars so we have the data.
    const startTime   = gameState.state.startTime || endTime;
    const elapsedMin  = Math.max(endTime - startTime, 1000) / 60000;
    for (const p of gameState.state.players.values()) {
        if (p.role !== 'player' || p.finished) continue;
        // Player ran out of time — compute from the last known char counts
        if (typeof p.correctChars === 'number') {
            p.wpm = Math.round((p.correctChars / 5) / elapsedMin);
            p.raw = typeof p.totalChars === 'number'
                ? Math.round((p.totalChars / 5) / elapsedMin)
                : p.wpm;
            if (typeof p.totalChars === 'number' && p.totalChars > 0) {
                p.acc = Math.max(0, Math.round(((p.totalChars - (p.errors||0)) / p.totalChars) * 100));
            }
        }
        p.finished   = true;
        p.finishTime = endTime;
        // Persist to DB
        if (gameState.state.gameId) {
            dbRun(
                `INSERT OR IGNORE INTO sessions(id,user_id,grade,wpm,acc,raw,consistency,errors)VALUES(?,?,?,?,?,?,?,?)`,
                [`${gameState.state.gameId}_${p.userId}`, p.userId, p.grade,
                 p.wpm||0, p.acc||0, p.raw||0, p.consistency||0, p.errors||0]
            ).catch(() => {});
        }
    }

    saveResults();
    const rankings = [...gameState.state.players.values()]
        .filter(p => p.role === 'player')
        .sort((a,b) => (b.wpm||0) - (a.wpm||0))
        .map((p,i) => ({ userId: p.userId, rank: i+1 }));
    broadcast({ type: 'GAME_OVER', round, maxRounds: gameState.state.maxRounds, isLastRound: isLast, rankings, totalPlayers: rankings.length, serverTime: timeSync.getServerTime() });
    if (isLast) broadcast({ type: 'SERIES_COMPLETE', round, maxRounds: gameState.state.maxRounds, serverTime: timeSync.getServerTime() });
    sysLog(isLast ? '🏁 Series complete' : `⏳ Round ${round} done`);
}

function saveResults() {
    const players = [...gameState.state.players.values()].filter(p => p.role==='player');
    let out = `\n${'='.repeat(70)}\nRound ${gameState.state.currentRound}/${gameState.state.maxRounds} — ${new Date().toLocaleString('ro-RO')}\n${'='.repeat(70)}\n`;
    const g = {'1-4':[],'5-9':[],'10-12':[]};
    players.forEach(p => (g[p.grade]||g['10-12']).push(p));
    for (const [grade, list] of Object.entries(g)) {
        if (!list.length) continue;
        out += `\nClasa ${grade}:\n`;
        list.sort((a,b)=>b.wpm-a.wpm).forEach((p,i)=>{
            out += `${['🥇','🥈','🥉'][i]||'  '} #${i+1} ${p.username.padEnd(20)} ${p.wpm} CPM  ${p.acc}%\n`;
        });
    }
    fs.appendFile(FILES.resultsFile, out, ()=>{});
}

// ══════════════════════════════════════════════════════════════════════════
//  DEV — VIRTUAL SCHOOL NODE + CAMERAS
// ══════════════════════════════════════════════════════════════════════════
const DEV_SCHOOL_ID = 'dev-school';
const virtualCams   = new Map();    // camId → { label }
const thumbTimers   = new Map();    // camId → intervalId

function setupVirtualNode() {
    schoolNodes.set(DEV_SCHOOL_ID, {
        ws: null, schoolId: DEV_SCHOOL_ID, httpPort: 5890, localPort: 5889,
        videoPort: null, maxCams: 4, connectedAt: Date.now(), cameras: [], isVirtual: true
    });
    sysLog(`🔧 DEV: virtual school node "${DEV_SCHOOL_ID}" ready`);
    broadcast({ type: 'SCHOOL_NODES_UPDATE', nodes: getSchoolNodesSummary() });
}

function startVirtualCamera(camId, label) {
    if (virtualCams.size >= 4) { sysLog('DEV: max 4 virtual cameras'); return false; }
    const key = `${DEV_SCHOOL_ID}::${camId}`;
    virtualCams.set(camId, { label: label || camId });
    allCameras.set(key, { camId, schoolId: DEV_SCHOOL_ID, label: label||camId, streaming: true, recording: false, bytesWritten: 0, key, lastSeen: Date.now() });
    const node = schoolNodes.get(DEV_SCHOOL_ID);
    if (node) node.cameras = [...allCameras.values()].filter(c => c.schoolId === DEV_SCHOOL_ID);
    sysLog(`🔧 DEV: virtual cam "${camId}" started`);
    broadcast({ type: 'CAMERAS_UPDATE', cameras: getCamerasSummary() });
    startThumbLoop(camId, label || camId);
    return true;
}

function stopVirtualCamera(camId) {
    virtualCams.delete(camId);
    allCameras.delete(`${DEV_SCHOOL_ID}::${camId}`);
    if (thumbTimers.has(camId)) { clearInterval(thumbTimers.get(camId)); thumbTimers.delete(camId); }
    const node = schoolNodes.get(DEV_SCHOOL_ID);
    if (node) node.cameras = [...allCameras.values()].filter(c => c.schoolId === DEV_SCHOOL_ID);
    sysLog(`🔧 DEV: virtual cam "${camId}" stopped`);
    broadcast({ type: 'CAMERAS_UPDATE', cameras: getCamerasSummary() });
}

function startThumbLoop(camId, label) {
    if (thumbTimers.has(camId)) clearInterval(thumbTimers.get(camId));
    // Derive a stable colour from camId
    let hash = 0; for (const c of camId) hash = ((hash * 31) + c.charCodeAt(0)) >>> 0;
    const hue = hash % 360;
    const colour = `hsl(${hue},60%,35%)`;
    const light  = `hsl(${hue},60%,70%)`;

    const timer = setInterval(() => {
        if (!virtualCams.has(camId)) { clearInterval(timer); thumbTimers.delete(camId); return; }
        const now = new Date().toLocaleTimeString();
        const svg = [
            `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">`,
            `<rect width="320" height="180" fill="${colour}"/>`,
            `<rect x="0" y="148" width="320" height="32" fill="rgba(0,0,0,0.6)"/>`,
            `<text x="160" y="65"  font="700 20px monospace" fill="${light}"   text-anchor="middle">📷 ${label}</text>`,
            `<text x="160" y="95"  font="700 13px monospace" fill="rgba(255,255,255,.55)" text-anchor="middle">DEV CAMERA · LIVE</text>`,
            `<text x="160" y="168" font="700 11px monospace" fill="rgba(255,255,255,.85)" text-anchor="middle">${now}</text>`,
            `</svg>`,
        ].join('');
        // Send as data:image/svg+xml so host-cameras can use it directly as img src
        const outMsg = JSON.stringify({
            type: 'CAM_THUMBNAIL', schoolId: DEV_SCHOOL_ID, camId,
            camKey: `${DEV_SCHOOL_ID}::${camId}`,
            // Full data URI — host-cameras.js uses this as img.src directly
            jpeg: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
            isSvg: true, ts: Date.now()
        });
        for (const [ws, p] of gameState.state.players) {
            if (p.role === 'admin' || p.role === 'viewer') {
                if (ws instanceof VirtualClient) { try { ws.send(outMsg); } catch (_) {} }
                else if (ws.readyState === WebSocket.OPEN) { try { ws.send(outMsg); } catch (_) {} }
            }
        }
    }, 500);
    thumbTimers.set(camId, timer);
}

function virtualHandleViewRequest(camId, viewerId, viewerWs) {
    const msg = JSON.stringify({ type: 'CAM_VIRTUAL_NOTICE', camId, message: 'DEV: virtual camera — thumbnails only, no WebRTC stream' });
    if (viewerWs instanceof VirtualClient) { try { viewerWs.send(msg); } catch (_) {} }
    else if (viewerWs?.readyState === WebSocket.OPEN) { try { viewerWs.send(msg); } catch (_) {} }
}

// ══════════════════════════════════════════════════════════════════════════
//  HTTP SERVER  :5890
// ══════════════════════════════════════════════════════════════════════════
const httpServer = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    if (IS_DEV) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const pp = [...gameState.state.players.values()];
        return res.end(JSON.stringify({
            status       : 'ok',
            phase        : gameState.state.phase,
            mode         : gameState.state.mode,
            players      : pp.filter(p => p.role === 'player').length,
            spellers     : pp.filter(p => p.role === 'speller').length,
            stateVersion : gameState.stateVersion,
            uptime       : process.uptime(),
            memory       : {
                heapUsed  : Math.round(process.memoryUsage().heapUsed  / 1024 / 1024) + 'MB',
                heapTotal : Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB',
            },
            connections  : wss.clients.size,
            debugMode    : DEBUG_MODE,
            devMode      : IS_DEV,
            schoolNodes  : getSchoolNodesSummary(),
            cameras      : getCamerasSummary(),
            virtualClients: virtualClients.size,
        }, null, 2));
    }

    if (url === '/stats') {
        db.get(`SELECT COUNT(*) as total,AVG(wpm) as avg_wpm,MAX(wpm) as max_wpm,AVG(acc) as avg_acc FROM sessions WHERE completed_at>datetime('now','-1 day')`, (e, r) => {
            if (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
            else   { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r, null, 2)); }
        });
        return;
    }

    // ── Dev-only ───────────────────────────────────────────────────────────
    if (IS_DEV) {
        if (url === '/dev/cam/list') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ schoolId: DEV_SCHOOL_ID, cams: getCamerasSummary() }, null, 2));
        }

        if (url === '/dev/cam/start' && req.method === 'POST') {
            let body = ''; req.on('data', d => body += d);
            req.on('end', () => {
                try {
                    const { camId = 'cam-' + Date.now(), label } = JSON.parse(body || '{}');
                    const ok = startVirtualCamera(camId, label || camId);
                    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok, camId, schoolId: DEV_SCHOOL_ID }));
                } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
            });
            return;
        }

        if (url.startsWith('/dev/cam/') && req.method === 'DELETE') {
            const camId = url.replace('/dev/cam/', '');
            stopVirtualCamera(camId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, camId }));
        }
    }

    // Proxy school server recordings list
    if (url.startsWith('/school-proxy/')) {
        const parts = url.split('/'); // ['','school-proxy',schoolId,...rest]
        const schoolId = parts[2];
        const rest = parts.slice(3).join('/');
        const node = schoolNodes.get(schoolId);
        if (!node || node.isVirtual) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(node?.isVirtual ? '[]' : JSON.stringify({ error: 'School not found' }));
            return;
        }
        const target = `http://127.0.0.1:${node.httpPort}/${rest}`;
        http.get(target, upstream => {
            res.writeHead(upstream.statusCode, { 'Content-Type': upstream.headers['content-type'] || 'application/json' });
            upstream.pipe(res);
        }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
        return;
    }

    // Static ClientWeb files
    const handled = serveStatic(CLIENT_WEB, req, res);
    if (!handled) { res.writeHead(404); res.end('Not found'); }
});

httpServer.listen(5890, '0.0.0.0', () => {
    sysLog(`🏥 Health: http://localhost:5890/health`);
    if (IS_DEV) {
        sysLog(`🌐 http://localhost:5890/          — Player`);
        sysLog(`🌐 http://localhost:5890/stream    — Camera phone`);
        sysLog(`🌐 http://localhost:5890/spell     — Spelling`);
        sysLog(`🌐 http://localhost:5890/host      — Host panel`);
        sysLog(`🌐 http://localhost:5890/presentation — Presentation`);
        sysLog(`📷 POST http://localhost:5890/dev/cam/start   { camId, label }`);
        sysLog(`📷 GET  http://localhost:5890/dev/cam/list`);
        sysLog(`📷 DEL  http://localhost:5890/dev/cam/<id>`);
    }
});

// ══════════════════════════════════════════════════════════════════════════
//  READLINE
// ══════════════════════════════════════════════════════════════════════════
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', async line => {
    const cmd = line.trim();
    if (cmd === 'debug-on')  { DEBUG_MODE = true;  console.log('🐛 Debug ON'); }
    if (cmd === 'debug-off') { DEBUG_MODE = false; console.log('🐛 Debug OFF'); }
    if (cmd === 'stop')      await gracefulShutdown('stop');
    if (cmd === 'force-end' && gameState.state.phase === 'RACING') await endGame();
    if (cmd === 'status') {
        const pp       = [...gameState.state.players.values()];
        const players  = pp.filter(p => p.role === 'player');
        const spellers = pp.filter(p => p.role === 'speller');
        const schools  = [...schoolNodes.values()].map(n =>
            `${n.schoolId}:${n.ws?.readyState === 1 ? '🟢' : '🔴'}`
        ).join('  ') || 'none';
        logger.statusBlock([
            { key: 'Phase',        val: gameState.state.phase, sub: `mode: ${gameState.state.mode}  v${gameState.stateVersion}` },
            { key: 'Players',      val: players.length },
            { key: 'Spellers',     val: spellers.length },
            { key: 'WS clients',   val: wss.clients.size },
            { key: 'Schools',      val: schoolNodes.size, sub: schools },
            { key: 'Cameras',      val: allCameras.size },
            { key: 'VirtualCls',   val: virtualClients.size },
            { key: 'Memory',       val: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB' },
            { key: 'Uptime',       val: Math.floor(process.uptime() / 60) + ' min' },
            { key: 'Debug',        val: DEBUG_MODE ? '🟡 ON' : 'off' },
            { key: 'Dev mode',     val: IS_DEV ? '🟡 YES' : 'no' },
        ]);
        if (players.length > 0) {
            logger.sep('players');
            players.forEach(p => logger.info(`  ${p.username.padEnd(20)} ${p.grade}  ${p.wpm||0} CPM  ${p.progress||0}%`, 'GAME'));
        }
        if (spellers.length > 0) {
            logger.sep('spellers');
            spellers.forEach(p => logger.info(`  ${p.username.padEnd(20)} ${p.grade}  ${p.score||0}% acc`, 'GAME'));
        }
    }
    if (IS_DEV) {
        if (cmd.startsWith('cam add '))  { const [,,id,...r]=cmd.split(' '); startVirtualCamera(id||('c'+Date.now()), r.join(' ')||id); }
        if (cmd.startsWith('cam stop ')){ const [,,id]=cmd.split(' '); stopVirtualCamera(id); }
        if (cmd === 'cam list')          { console.log('Virtual cams:', [...virtualCams.keys()]); }
    }
});

// ══════════════════════════════════════════════════════════════════════════
//  SHUTDOWN
// ══════════════════════════════════════════════════════════════════════════
async function gracefulShutdown(signal) {
    sysLog(`⚠️ ${signal} — shutting down`);
    await gameState._snap();
    broadcast({ type: 'SERVER_SHUTDOWN', message: 'Server restarting.' });
    clearInterval(heartbeat);
    for (const t of thumbTimers.values()) clearInterval(t);
    setTimeout(() => { db.close(); sysLog('👋 Stopped'); process.exit(0); }, 1000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('uncaughtException',  e => logger.error(`Uncaught: ${e.message}\n${e.stack}`));
process.on('unhandledRejection', r => logger.error(`Rejection: ${r}`));

// ══════════════════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════════════════
(async () => {
    gameState.state.text      = loadText();
    gameState.state.spellText = loadSpellText();
    const restored = await gameState.restoreLastState();

    logger.banner('MainServer', '2.0', [
        { key: 'WS port',     val: ':5889' },
        { key: 'HTTP port',   val: ':5890' },
        { key: 'env',         val: IS_DEV ? 'DEVELOPMENT' : 'production' },
        '---',
        { key: 'admin key',   val: (ADMIN_KEY || '').slice(0,2) + '****' },
        { key: 'stream key',  val: (STREAM_KEY || '').slice(0,2) + '****' },
        { key: 'max players', val: MAX_PLAYERS },
        '---',
        { key: 'static root', val: CLIENT_WEB },
        { key: 'db',          val: FILES.mainDb },
        { key: 'state',       val: restored ? '📄 restored from last save' : 'fresh start' },
    ]);

    if (IS_DEV) {
        setupVirtualNode();
        setTimeout(() => {
            startVirtualCamera('dev-cam-1', 'Camera 1');
            startVirtualCamera('dev-cam-2', 'Camera 2');
            logger.cam('🔧 DEV: 2 virtual cameras started');
        }, 800);
    }
})();