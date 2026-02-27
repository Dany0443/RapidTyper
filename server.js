const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const http = require('http');


// ============ DEBUG MODE ============
let DEBUG_MODE = false;
function debugLog(msg) {
    if (DEBUG_MODE) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [DEBUG] ${msg}`);
    }
}

// ============ DIRECTORY STRUCTURE ============
const DIRS = {
    logs: path.join(__dirname, 'logs'),
    db: path.join(__dirname, 'db'),
    data: path.join(__dirname, 'data')
};

// Create directories if they don't exist
Object.values(DIRS).forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Created directory: ${dir}`);
    }
});

// ============ FILE PATHS ============
const FILES = {
    // Logs
    mainLog: path.join(DIRS.logs, 'server.log'),
    errorLog: path.join(DIRS.logs, 'errors.log'),
    stateLog: path.join(DIRS.logs, 'state.log'),
    
    // Database
    mainDb: path.join(DIRS.db, 'event.db'),
    
    // Data
    textFile: path.join(DIRS.data, 'text.txt'),
    spellFile: path.join(DIRS.data, 'w.txt'),
    resultsFile: path.join(DIRS.data, 'results.txt'),
};


const wss = new WebSocket.Server({ port: 5889 });
// Issue #15: Hardcoded admin key — load from env with fallback
const ADMIN_KEY = process.env.ADMIN_KEY || "1313";
let GAME_DURATION = 60; // mutable — host can change via SET_DURATION
const MAX_PLAYERS = 200; // Issue #20: Max player cap

// ============ TIME SYNCHRONIZATION ============
class TimeSync {
    constructor() {
        this.serverStartTime = Date.now();
        this.syncHistory = new Map();
    }

    getServerTime() {
        return Date.now();
    }

    calculateOffset(clientTime, roundTripTime) {
        return this.getServerTime() - clientTime - (roundTripTime / 2);
    }

    recordSync(userId, offset, rtt) {
        if (!this.syncHistory.has(userId)) {
            this.syncHistory.set(userId, []);
        }
        const history = this.syncHistory.get(userId);
        history.push({ offset, rtt, timestamp: Date.now() });
        if (history.length > 10) history.shift();
    }

    getAverageOffset(userId) {
        const history = this.syncHistory.get(userId);
        if (!history || history.length === 0) return 0;
        const sum = history.reduce((acc, h) => acc + h.offset, 0);
        return Math.round(sum / history.length);
    }
}

const timeSync = new TimeSync();

// ============ GAME STATE MANAGER ============
class GameStateManager {
    constructor() {
        this.state = {
            phase: 'LOBBY',
            players: new Map(),
            text: '',
            spellText: '',
            mode: 'race', // 'race' or 'spell'
            gameId: null,
            startTime: null,
            endTime: null,
            countdown: null,
            currentSpellWord: null,
            spellRoundActive: false,
            currentRound: 0,
            maxRounds: 3,
            roundHistory: []
        };
        this.stateVersion = 0;
        this.stateLock = false;
        this.transitionCallbacks = [];
    }

    async transition(newPhase, data = {}) {
        if (this.stateLock) {
            sysLog(`⚠️ State transition blocked: ${this.state.phase} -> ${newPhase}`);
            return false;
        }

        this.stateLock = true;
        const oldPhase = this.state.phase;
        
        try {
            this.state.phase = newPhase;
            this.stateVersion++;
            Object.assign(this.state, data);
            
            sysLog(`🔄 State: ${oldPhase} -> ${newPhase} (v${this.stateVersion})`);
            debugLog(`State transition complete: ${JSON.stringify(data)}`);
            
            await this.saveSnapshot();
            this.notifyTransition(oldPhase, newPhase);
            
            return true;
        } catch (err) {
            sysLog(`❌ State transition error: ${err.message}`);
            this.state.phase = oldPhase;
            return false;
        } finally {
            this.stateLock = false;
        }
    }

    notifyTransition(from, to) {
        this.transitionCallbacks.forEach(cb => {
            try {
                cb(from, to);
            } catch (err) {
                sysLog(`❌ Transition callback error: ${err.message}`);
            }
        });
    }

    onTransition(callback) {
        this.transitionCallbacks.push(callback);
    }

    getState() {
        return {
            phase: this.state.phase,
            mode: this.state.mode,
            gameId: this.state.gameId,
            startTime: this.state.startTime,
            endTime: this.state.endTime,
            version: this.stateVersion,
            serverTime: timeSync.getServerTime(),
            playerCount: Array.from(this.state.players.values()).filter(p => p.role === 'player').length,
            spellerCount: Array.from(this.state.players.values()).filter(p => p.role === 'speller').length,
            currentRound: this.state.currentRound,
            maxRounds: this.state.maxRounds
        };
    }

    async saveSnapshot() {
        const snapshot = {
            version: this.stateVersion,
            phase: this.state.phase,
            mode: this.state.mode,
            gameId: this.state.gameId,
            startTime: this.state.startTime,
            endTime: this.state.endTime,
            timestamp: Date.now(),
            playerCount: this.state.players.size
        };
        
        try {
            // Write single record (overwrite) — prevents unbounded log growth.
            // restoreLastState reads this one record directly.
            await fs.promises.writeFile(FILES.stateLog, JSON.stringify(snapshot) + '\n');
        } catch (err) {
            sysLog(`❌ Snapshot error: ${err.message}`);
        }
    }

    async restoreLastState() {
        try {
            if (!fs.existsSync(FILES.stateLog)) return false;
            
            const fileContent = await fs.promises.readFile(FILES.stateLog, 'utf8');
            const line = fileContent.trim();
            if (!line) return false;
            
            const lastSnapshot = JSON.parse(line);
            
            // Issue #14: Restoring directly to RACING leaves no active timer and misses players.
            // Restore to ROUND_END instead so the host can cleanly start the next round.
            if ((lastSnapshot.phase === 'RACING' || lastSnapshot.phase === 'ROUND_END') && 
                (Date.now() - lastSnapshot.timestamp) < 300000) {
                
                this.state.phase = 'ROUND_END';
                this.state.mode = lastSnapshot.mode || 'race';
                this.state.gameId = lastSnapshot.gameId;
                this.state.startTime = lastSnapshot.startTime;
                this.state.endTime = lastSnapshot.endTime;
                this.stateVersion = lastSnapshot.version;
                
                sysLog(`📄 Restored state: ${lastSnapshot.phase} → ROUND_END (v${lastSnapshot.version})`);
                return true;
            }
        } catch (err) {
            sysLog(`❌ Restore error: ${err.message}`);
        }
        return false;
    }

    cleanup() {
        let cleaned = 0;
        for (let [ws, player] of this.state.players.entries()) {
            if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
                this.state.players.delete(ws);
                cleaned++;
            }
        }
        return cleaned;
    }
}

const gameState = new GameStateManager();

// ============ LOGGER ============
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap per log file

class Logger {
    constructor() {
        this.logFile = FILES.mainLog;
        this.errorFile = FILES.errorLog;
        this.ensureFiles();
    }
    ensureFiles() {
        if (!fs.existsSync(this.logFile)) fs.writeFileSync(this.logFile, '');
        if (!fs.existsSync(this.errorFile)) fs.writeFileSync(this.errorFile, '');
    }

    rotateIfNeeded(filePath) {
        try {
            const stat = fs.statSync(filePath);
            if (stat.size > LOG_MAX_BYTES) {
                const rotated = filePath.replace(/\.log$/, `.${Date.now()}.log`);
                fs.renameSync(filePath, rotated);
                fs.writeFileSync(filePath, '');
                console.log(`📦 Log rotated: ${path.basename(filePath)} → ${path.basename(rotated)}`);
            }
        } catch (e) { /* ignore */ }
    }

    log(msg, level = 'INFO') {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${level}] ${msg}`;
        console.log(logMessage);
        
        this.rotateIfNeeded(this.logFile);
        fs.appendFile(this.logFile, logMessage + '\n', (err) => {
            if (err) console.error('Log write error:', err);
        });

        if (level === 'ERROR') {
            this.rotateIfNeeded(this.errorFile);
            fs.appendFile(this.errorFile, logMessage + '\n', () => {});
        }
    }

    info(msg) { this.log(msg, 'INFO'); }
    warn(msg) { this.log(msg, 'WARN'); }
    error(msg) { this.log(msg, 'ERROR'); }
}

const logger = new Logger();
function sysLog(msg) { logger.info(msg); }

// ============ TEXT MANAGEMENT ============
const DEFAULT_TEXT = `În era digitală, tastarea rapidă a devenit o abilitate fundamentală, similară cu scrierea de mână în secolele trecute. De la programatori care scriu cod complex, până la scriitori care își transpun imaginația pe ecran, viteza cu care putem transfera gândurile noastre în format digital influențează direct productivitatea. Tastatura, acest instrument aparent simplu, este poarta noastră către vastul univers al internetului.`;

function loadText() {
    try {
        if (fs.existsSync(FILES.textFile)) {
            const text = fs.readFileSync(FILES.textFile, 'utf8').trim();
            if (text.length > 0) {
                sysLog(`📄 Text loaded (${text.length} chars)`);
                return text;
            }
        }
        fs.writeFileSync(FILES.textFile, DEFAULT_TEXT, 'utf8');
        sysLog(`📄 Created default text.txt`);
        return DEFAULT_TEXT;
    } catch (err) {
        logger.error(`Text load error: ${err.message}`);
        return DEFAULT_TEXT;
    }
}

function saveText(text) {
    try {
        fs.writeFileSync(FILES.textFile, text, 'utf8');
        sysLog(`💾 Text saved (${text.length} chars)`);
        return true;
    } catch (err) {
        logger.error(`Text save error: ${err.message}`);
        return false;
    }
}

const DEFAULT_SPELL_TEXT = `This is a sample text for the spelling bee. It is a long text that students must type correctly.`;

function loadSpellText() {
    try {
        if (fs.existsSync(FILES.spellFile)) {
            const text = fs.readFileSync(FILES.spellFile, 'utf8').trim();
            if (text.length > 0) {
                sysLog(`📄 Spell text loaded (${text.length} chars)`);
                return text;
            }
        }
        fs.writeFileSync(FILES.spellFile, DEFAULT_SPELL_TEXT, 'utf8');
        sysLog(`📄 Created default w.txt`);
        return DEFAULT_SPELL_TEXT;
    } catch (err) {
        logger.error(`Spell text load error: ${err.message}`);
        return DEFAULT_SPELL_TEXT;
    }
}

function saveSpellText(text) {
    try {
        fs.writeFileSync(FILES.spellFile, text, 'utf8');
        sysLog(`💾 Spell text saved (${text.length} chars)`);
        return true;
    } catch (err) {
        logger.error(`Spell text save error: ${err.message}`);
        return false;
    }
}

// ============ DATABASE ============
const db = new sqlite3.Database(FILES.mainDb, (err) => {
    if (err) logger.error("DB connection error: " + err.message);
    else sysLog("💾 Database connected");
});

db.serialize(() => {
    db.run("PRAGMA journal_mode = WAL;", err => { if (err) logger.error('PRAGMA WAL: ' + err.message); });
    db.run("PRAGMA synchronous = NORMAL;", err => { if (err) logger.error('PRAGMA sync: ' + err.message); });
    db.run("PRAGMA cache_size = 10000;");
    db.run("PRAGMA temp_store = MEMORY;");

    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT,
        grade TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, err => { if (err) logger.error('CREATE TABLE users: ' + err.message); });

    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        grade TEXT,
        wpm INTEGER,
        acc INTEGER,
        raw INTEGER,
        consistency INTEGER,
        errors INTEGER,
        completed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, err => { if (err) logger.error('CREATE TABLE sessions: ' + err.message); });

    db.run(`CREATE TABLE IF NOT EXISTS sync_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT,
        user_id TEXT,
        client_time INTEGER,
        server_time INTEGER,
        offset INTEGER,
        rtt INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, err => { if (err) logger.error('CREATE TABLE sync_events: ' + err.message); });

    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`, err => { if (err) logger.error('CREATE INDEX sessions: ' + err.message); });
    db.run(`CREATE INDEX IF NOT EXISTS idx_sync_user ON sync_events(user_id)`, err => { if (err) logger.error('CREATE INDEX sync: ' + err.message); });
});

function dbRunAsync(query, params = []) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function dbGetAsync(query, params = []) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// ============ RATE LIMITING ============
class RateLimiter {
    constructor() {
        this.limits = new Map();
        this.blacklist = new Set();
    }

    check(key, maxPerSecond = 10) {
        if (this.blacklist.has(key)) return false;

        const now = Date.now();
        const record = this.limits.get(key) || { count: 0, resetTime: now + 1000 };
        
        if (now > record.resetTime) {
            record.count = 0;
            record.resetTime = now + 1000;
        }
        
        record.count++;
        this.limits.set(key, record);
        
        if (record.count > maxPerSecond * 2) {
            this.blacklist.add(key);
            logger.warn(`🚫 Blacklisted: ${key} (rate limit abuse)`);
            setTimeout(() => this.blacklist.delete(key), 60000);
            return false;
        }
        
        return record.count <= maxPerSecond;
    }

    cleanup() {
        const now = Date.now();
        for (let [key, record] of this.limits.entries()) {
            if (now > record.resetTime + 10000) {
                this.limits.delete(key);
            }
        }
    }
}

const rateLimiter = new RateLimiter();
setInterval(() => rateLimiter.cleanup(), 60000);

// Issue #7: Removed broken broadcastPending flag; debouncing is handled by broadcastScheduled alone
let broadcastScheduled = null;

function broadcastLobbyState() {
    if (broadcastScheduled) {
        clearTimeout(broadcastScheduled);
    }
    
    broadcastScheduled = setTimeout(() => {
        broadcastScheduled = null;
        
        try {
            const playersList = Array.from(gameState.state.players.values())
                .filter(p => p.role === 'player')
                .map(p => ({
                    userId: p.userId,
                    username: p.username,
                    grade: p.grade,
                    finished: p.finished,
                    wpm: p.wpm || 0,
                    acc: p.acc || 0,
                    progress: p.progress || 0,
                    raw: p.raw || 0,
                    consistency: p.consistency || 0,
                    errors: p.errors || 0
                }));

            debugLog(`Broadcasting lobby state: ${playersList.length} players`);
            
            broadcast({
                type: 'UPDATE_LOBBY',
                count: playersList.length,
                players: playersList,
                gameActive: gameState.state.phase === 'RACING',
                phase: gameState.state.phase,
                stateVersion: gameState.stateVersion,
                serverTime: timeSync.getServerTime()
            });
        } catch (err) {
            logger.error(`broadcastLobbyState error: ${err.message}`);
        }
    }, 150);
}

function broadcastSpellerState() {
    const spellersList = Array.from(gameState.state.players.values())
        .filter(p => p.role === 'speller')
        .map(p => ({
            userId: p.userId,
            username: p.username,
            grade: p.grade,
            score: p.score || 0,
            status: p.status || 'connected',
            finished: p.finished || false
        }));

    debugLog(`Broadcasting speller state: ${spellersList.length} spellers`);
    
    broadcast({
        type: 'UPDATE_SPELLERS',
        count: spellersList.length,
        list: spellersList,
        spellRoundActive: gameState.state.spellRoundActive,
        serverTime: timeSync.getServerTime()
    });
}


function broadcast(msg, filter = null) {
    const data = JSON.stringify(msg);
    let sent = 0, failed = 0;
    
    debugLog(`Broadcasting message type: ${msg.type}`);
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            if (filter && !filter(client)) return;
            
            try {
                client.send(data);
                sent++;
            } catch (err) {
                failed++;
                logger.error(`Broadcast error: ${err.message}`);
            }
        }
    });
    
    debugLog(`Broadcast complete: ${sent} sent, ${failed} failed`);
    
    if (failed > 0) {
        logger.warn(`📡 Broadcast: ${sent} sent, ${failed} failed`);
    }
}

// ============ BROADCAST SPELLERS ============
// NOTE: broadcastSpellers() is an alias for broadcastSpellerState() to avoid
// the old bug where it used a separate empty `spellers` array.
function broadcastSpellers() {
    broadcastSpellerState();
}

// ============ CONNECTION HANDLING ============
wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.clientOffset = 0;
    ws.lastSyncTime = 0;
    ws.messageCount = 0;
    ws.clientIp = req.socket.remoteAddress;
    
    debugLog(`New connection from ${ws.clientIp}`);
    
    ws.send(JSON.stringify({
        type: 'SYNC_STATE',
        spellRoundActive: gameState.state.spellRoundActive,
        mode: gameState.state.mode,
        phase: gameState.state.phase,
        currentRound: gameState.state.currentRound,
        maxRounds: gameState.state.maxRounds
    }));

    ws.on('pong', () => { ws.isAlive = true; });

    ws.send(JSON.stringify({
        type: 'TIME_SYNC',
        serverTime: timeSync.getServerTime(),
        requestSync: true
    }));

    ws.on('message', async (message) => {
        ws.messageCount++;

        // Reject oversized messages before parsing to prevent memory exhaustion
        if (message.length > 64 * 1024) {
            logger.warn(`⚠️ Oversized message (${message.length} bytes) from ${ws.clientIp} — dropped`);
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Message too large' }));
            return;
        }
        
        try {
            const data = JSON.parse(message);
            debugLog(`Received message type: ${data.type} from ${ws.clientIp}`);
            await handleMessage(ws, data);
        } catch (e) {
            logger.error(`Parse error from ${ws.clientIp}: ${e.message}`);
            debugLog(`Parse error details: ${e.stack}`);
            ws.send(JSON.stringify({ 
                type: 'ERROR', 
                message: 'Invalid message format' 
            }));
        }
    });

    ws.on('close', () => {
        if (gameState.state.players.has(ws)) {
            const p = gameState.state.players.get(ws);
            if (p.role === 'player') {
                sysLog(`❌ Disconnect: ${p.username} (${ws.messageCount} msgs)`);
            } else if (p.role === 'speller') {
                sysLog(`❌ Speller Disconnect: ${p.username}`);
                setTimeout(broadcastSpellers, 100);
            }
            gameState.state.players.delete(ws);
            broadcastLobbyState();
        }
        debugLog(`Connection closed: ${ws.clientIp}`);
    });

    ws.on('error', (err) => {
        logger.error(`WebSocket error (${ws.clientIp}): ${err.message}`);
        debugLog(`WebSocket error details: ${err.stack}`);
    });
});

// Heartbeat
const heartbeatInterval = setInterval(() => {
    let terminated = 0;
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            ws.terminate();
            terminated++;
            return;
        }
        ws.isAlive = false;
        ws.ping();
    });
    if (terminated > 0) {
        sysLog(`💔 Terminated ${terminated} dead connections`);
    }
}, 30000);

// Cleanup disconnected players
const cleanupInterval = setInterval(() => {
    const cleaned = gameState.cleanup();
    if (cleaned > 0) {
        sysLog(`🧹 Cleaned ${cleaned} disconnected players`);
        broadcastLobbyState();
    }
}, 30000);

// Memory monitoring
const memoryInterval = setInterval(() => {
    const used = process.memoryUsage();
    const heapMB = Math.round(used.heapUsed / 1024 / 1024);
    if (heapMB > 500) {
        logger.warn(`⚠️ High memory usage: ${heapMB}MB`);
    }
}, 60000);

// ============ MESSAGE HANDLING ============
async function handleMessage(ws, data) {
    let player = null;
    
    try {
        const clientId = ws.clientIp;
        
        switch (data.type) {
            case 'GET_HOST_STATE':
                debugLog(`Host requesting state sync`);
                ws.send(JSON.stringify({
                    type: 'HOST_STATE_SYNC',
                    mode: gameState.state.mode || 'race',
                    phase: gameState.state.phase,
                    currentSpellText: gameState.state.spellText || ''
                }));
                break;
                
            case 'SET_GAME_MODE':
                if (gameState.state.players.get(ws)?.role === 'admin') {
                    const prevMode = gameState.state.mode;
                    gameState.state.mode = data.mode;
                    debugLog(`Game mode changed to: ${data.mode}`);
                    sysLog(`🎮 Mode changed to: ${data.mode}`);
                    if (prevMode !== data.mode) {
                        // Tell all connected clients (non-admin) to redirect
                        broadcast({
                            type: 'MODE_CHANGED',
                            mode: data.mode
                        }, client => {
                            const p = gameState.state.players.get(client);
                            return !p || p.role !== 'admin';
                        });
                    }
                }
                break;

            case 'NEXT_ROUND': {
                const nextAdmin = gameState.state.players.get(ws);
                if (nextAdmin?.role === 'admin' && gameState.state.phase === 'ROUND_END') {
                    await startGame();
                } else {
                    logger.warn(`NEXT_ROUND denied - role: ${nextAdmin?.role}, phase: ${gameState.state.phase}`);
                }
                break;
            }

            case 'END_SERIES': {
                const seriesAdmin = gameState.state.players.get(ws);
                if (seriesAdmin?.role === 'admin') {
                    gameState.state.currentRound = 0;
                    gameState.state.roundHistory = [];
                    await gameState.transition('LOBBY', { gameId: null, startTime: null, endTime: null });
                    sysLog('🏁 Series ended — reset to LOBBY');
                    broadcast({ type: 'SERIES_OVER', serverTime: timeSync.getServerTime() });
                    broadcastLobbyState();
                }
                break;
            }

            case 'TIME_SYNC_RESPONSE':
                await handleTimeSync(ws, data);
                break;

            case 'ADMIN_LOGIN':
                debugLog(`Admin login attempt with key: ${data.key}`);
                if (data.key === ADMIN_KEY) {
                    gameState.state.players.set(ws, { role: 'admin', username: 'HOST' });
                    ws.send(JSON.stringify({ 
                        type: 'AUTH_SUCCESS',
                        currentText: gameState.state.text,
                        currentSpellText: gameState.state.spellText,
                        gameState: gameState.getState()
                    }));
                    sysLog("👑 Host connected");
                    broadcastLobbyState();
                } else {
                    ws.send(JSON.stringify({ type: 'AUTH_FAIL' }));
                    logger.warn(`🚫 Failed admin login from ${clientId}`);
                }
                break;

            case 'START_REQUEST': {
                const sender = gameState.state.players.get(ws);
                debugLog(`Start request from: ${sender?.role}, phase: ${gameState.state.phase}`);
                if (sender?.role === 'admin' && gameState.state.phase === 'LOBBY') {
                    await startGame();
                } else {
                    logger.warn(`⚠️ Start denied - Role: ${sender?.role}, Phase: ${gameState.state.phase}`);
                }
                break;
            }

            case 'REQUEST_SPELLER_SYNC':
                broadcastSpellerState();
            break;
            
            case 'START_SPELL_ROUND': {
                const admin = gameState.state.players.get(ws);
                debugLog(`Spell round start request from: ${admin?.role}`);
                if (admin?.role === 'admin') {
                    gameState.state.spellRoundActive = true;
                    gameState.state.spellStartTime = timeSync.getServerTime();
                    sysLog("📖 Spelling round started");
                    
                    broadcast({ 
                        type: 'SPELL_START',
                        startTime: gameState.state.spellStartTime,
                        serverTime: timeSync.getServerTime()
                    }, client => 
                        gameState.state.players.get(client)?.role === 'speller'
                    );
                    
                    broadcastSpellerState();
                }
            break;
            }

            case 'FORCE_RESET': {
                const resetAdmin = gameState.state.players.get(ws);
                if (resetAdmin?.role === 'admin') {
                    // Issue #1 / #4: Clear endGame timeout on reset
                    if (gameState.endGameTimeout) {
                        clearTimeout(gameState.endGameTimeout);
                        gameState.endGameTimeout = null;
                    }
                    gameState.state.currentRound = 0;
                    gameState.state.roundHistory = [];
                    await gameState.transition('LOBBY', {
                        gameId: null,
                        startTime: null,
                        endTime: null
                    });
                    sysLog("🔄 Force reset to lobby by admin");
                    broadcast({ type: 'FORCE_RESET' });
                    broadcastLobbyState();
                }
                break;
            }

            case 'UPDATE_TEXT':
                if (gameState.state.players.get(ws)?.role === 'admin') {
                    debugLog(`Text update request, mode: ${data.mode}`);
                    if (data.mode === 'spell') {
                        gameState.state.spellText = data.text;
                        if (saveSpellText(data.text)) {
                            ws.send(JSON.stringify({ type: 'TEXT_UPDATE_SUCCESS' }));
                        } else {
                            ws.send(JSON.stringify({ type: 'TEXT_UPDATE_PARTIAL' }));
                        }
                    } else {
                        gameState.state.text = data.text;
                        if (saveText(data.text)) {
                            ws.send(JSON.stringify({ type: 'TEXT_UPDATE_SUCCESS' }));
                        } else {
                            ws.send(JSON.stringify({ type: 'TEXT_UPDATE_PARTIAL' }));
                        }
                    }
                }
                break;

            case 'PRESENTATION_JOIN':
                gameState.state.players.set(ws, { role: 'viewer', username: 'Screen' });
                ws.send(JSON.stringify({
                    type: 'FULL_STATE_SYNC',
                    state: gameState.getState()
                }));
                broadcastLobbyState();
                break;

            case 'JOIN':
            case 'RECONNECT':
                await handleJoin(ws, data);
                break;

            case 'JOIN_SPELL': {
                const rawSpellId = typeof data.userId === 'string' ? data.userId : '';
                const spellUserId = rawSpellId.replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 64) || ('sp_' + Date.now());
                const spellUsername = ((typeof data.username === 'string' ? data.username : 'Guest')
                    .replace(/[<>]/g, '').substring(0, 15).trim()) || 'Guest';
                const SPELL_VALID_GRADES = ['1-4', '5-9', '10-12'];
                const spellGrade = SPELL_VALID_GRADES.includes(data.grade) ? data.grade : '1-4';
                
                debugLog(`Speller join: ${spellUsername} (${spellGrade})`);
                
                // Remove any existing connection for this user
                for (let [socket, p] of gameState.state.players.entries()) {
                    if (p.userId === spellUserId && socket !== ws) {
                        gameState.state.players.delete(socket);
                        try { socket.close(); } catch (e) {}
                    }
                }
                
                // Store in main game state like regular players
                const speller = {
                    userId: spellUserId,
                    username: spellUsername,
                    grade: spellGrade,
                    role: 'speller',
                    score: 0,
                    status: 'connected',
                    finished: false,
                    joinTime: timeSync.getServerTime()
                };
                
                gameState.state.players.set(ws, speller);
                const totalSpellers = Array.from(gameState.state.players.values()).filter(p => p.role === 'speller').length;
                sysLog(`✅ Speller ${spellUsername} (${spellGrade}) joined - Total: ${totalSpellers}`);
                
                // If round already active, pull them in
                if (gameState.state.spellRoundActive) {
                    ws.send(JSON.stringify({ 
                        type: 'SPELL_START',
                        serverTime: timeSync.getServerTime()
                    }));
                }
                
                // Broadcast updated speller list
                broadcastSpellerState();
            break;
            }


            case 'STOP_SPELL_ROUND': {
                const stopAdmin = gameState.state.players.get(ws);
                if (stopAdmin?.role !== 'admin') {
                    logger.warn(`Unauthorized STOP_SPELL_ROUND attempt from ${ws.clientIp}`);
                    break;
                }
                gameState.state.spellRoundActive = false;
                
                // Notify everyone
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'SPELL_END' }));
                    }
                });
                sysLog('Spelling round forcefully stopped by host.');
            break;
            }

            case 'SET_DURATION': {
                const durAdmin = gameState.state.players.get(ws);
                if (durAdmin?.role === 'admin' && typeof data.duration === 'number') {
                    GAME_DURATION = Math.max(10, Math.min(600, data.duration));
                    sysLog(`⏱️ Game duration set to ${GAME_DURATION}s by host`);
                }
                break;
            }

            case 'SET_ROUNDS': {
                const roundsAdmin = gameState.state.players.get(ws);
                if (roundsAdmin?.role === 'admin' && typeof data.rounds === 'number') {
                    const newMax = Math.max(1, Math.min(10, Math.floor(data.rounds)));
                    gameState.state.maxRounds = newMax;
                    sysLog(`🔢 Max rounds set to ${newMax} by host`);
                    ws.send(JSON.stringify({ type: 'ROUNDS_UPDATED', maxRounds: newMax }));
                }
                break;
            }

            case 'KICK_PLAYER': {
                const kickAdmin = gameState.state.players.get(ws);
                if (kickAdmin?.role !== 'admin') break;
                const targetUserId = data.userId;
                let kicked = false;
                for (let [socket, p] of gameState.state.players.entries()) {
                    if (p.userId === targetUserId && p.role === 'player') {
                        // Tell the client it was kicked — it will clear localStorage and reload
                        try {
                            socket.send(JSON.stringify({ type: 'KICKED' }));
                        } catch(e) {}
                        setTimeout(() => {
                            try { socket.terminate(); } catch(e) {}
                        }, 500);
                        gameState.state.players.delete(socket);
                        kicked = true;
                        sysLog(`🦵 Kicked player: ${p.username}`);
                        break;
                    }
                }
                if (kicked) {
                    broadcastLobbyState();
                    // Notify host
                    ws.send(JSON.stringify({ type: 'PLAYER_KICKED', userId: targetUserId }));
                }
                break;
            }

            case 'KICK_SPELLER': {
                const kickSpellAdmin = gameState.state.players.get(ws);
                if (kickSpellAdmin?.role !== 'admin') break;
                const targetSpellId = data.userId;
                let spellerKicked = false;
                for (let [socket, p] of gameState.state.players.entries()) {
                    if ((p.userId === targetSpellId || p.username === targetSpellId) && p.role === 'speller') {
                        try {
                            socket.send(JSON.stringify({ type: 'KICKED' }));
                        } catch(e) {}
                        setTimeout(() => {
                            try { socket.terminate(); } catch(e) {}
                        }, 500);
                        gameState.state.players.delete(socket);
                        spellerKicked = true;
                        sysLog(`🦵 Kicked speller: ${p.username}`);
                        break;
                    }
                }
                if (spellerKicked) {
                    broadcastSpellerState();
                    ws.send(JSON.stringify({ type: 'PLAYER_KICKED', userId: targetSpellId }));
                }
                break;
            }






            case 'PROGRESS_UPDATE':
                player = gameState.state.players.get(ws);
                const limitKey = (player && player.userId) ? player.userId : clientId;

                if (!rateLimiter.check(`${limitKey}_progress`, 20)) {
                    if (!limitKey.includes('bot') && !limitKey.includes('127.0.0.1')) {
                        logger.warn(`🚫 Rate limit: ${limitKey}`);
                    }
                    return;
                }
                
                if (player?.role === 'player' && gameState.state.phase === 'RACING' && !player.finished) {
                    player.wpm = data.wpm || 0;
                    player.acc = data.acc || 0;
                    player.progress = data.progress || 0;
                    player.errors = data.errors || 0;
                    player.consistency = data.consistency || 0;
                    player.lastUpdate = timeSync.getServerTime();
                    
                    broadcastLobbyState();
                }
                break;

            case 'FINISH':
                await handleFinish(ws, data);
                break;

            case 'SPELL_SUBMIT_FULL':
                player = gameState.state.players.get(ws);
                debugLog(`Spell submission from: ${player?.username}`);

                // Guard: round must be active, and player must not have already submitted
                if (!gameState.state.spellRoundActive) {
                    logger.warn(`SPELL_SUBMIT ignored — no active round (${player?.username || ws.clientIp})`);
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'No active spelling round.' }));
                    break;
                }
                if (player?.finished) {
                    logger.warn(`Duplicate SPELL_SUBMIT from ${player.username} — ignored`);
                    break;
                }
                
                if (player && gameState.state.spellText) {
                    const targetText = gameState.state.spellText.trim();
                    const submittedText = (data.text || '').trim();
                    
                    const targetWords = targetText.split(/\s+/);
                    const submittedWords = submittedText.split(/\s+/);
                    
                    let correctCount = 0;
                    let diff = [];
                    
                    const maxLen = Math.max(targetWords.length, submittedWords.length);
                    
                    for(let i = 0; i < maxLen; i++) {
                        const t = targetWords[i] || "";
                        const s = submittedWords[i] || "";
                        
                        if(t === s) {
                            correctCount++;
                            diff.push({ word: s, status: 'correct' });
                        } else {
                            diff.push({ word: s, status: 'wrong', expected: t });
                        }
                    }
                    
                    const accuracy = Math.round((correctCount / targetWords.length) * 100);
                    
                    // Calculate percentile
                    const allSpellers = Array.from(gameState.state.players.values()).filter(p => p.role === 'speller');
                    const totalSpellers = allSpellers.length;
                    const myScore = accuracy;
                    
                    const lowerScores = allSpellers.filter(p => (p.score || 0) < myScore).length;
                    
                    let percentile = 0;
                    if (totalSpellers > 1) {
                        percentile = Math.round((lowerScores / (totalSpellers - 1)) * 100);
                    } else {
                        percentile = 100;
                    }
                    
                    player.score = accuracy;
                    player.finished = true;
                    
                    debugLog(`Spell result: ${player.username} - ${accuracy}% accuracy, ${percentile}% percentile`);
                    
                    ws.send(JSON.stringify({
                        type: 'SPELL_RESULT_FULL',
                        accuracy: accuracy,
                        diff: diff,
                        correctCount: correctCount,
                        totalWords: targetWords.length,
                        stats: {
                            correct: correctCount,
                            incorrect: targetWords.length - correctCount,
                            percentile: percentile
                        }
                    }));
                    
                    const adminWs = Array.from(gameState.state.players.keys()).find(k => gameState.state.players.get(k)?.role === 'admin');
                    if(adminWs && adminWs.readyState === WebSocket.OPEN) {
                        adminWs.send(JSON.stringify({ 
                            type: 'SPELL_LIVE_UPDATE', 
                            user: player.username, 
                            correct: accuracy >= 90
                        }));
                    }
                    
                    broadcastSpellers();
                }
                break;

            case 'REQUEST_STATE_SYNC':
                ws.send(JSON.stringify({
                    type: 'FULL_STATE_SYNC',
                    state: gameState.getState()
                }));
                break;

            case 'PING':
                ws.send(JSON.stringify({ 
                    type: 'PONG', 
                    serverTime: timeSync.getServerTime() 
                }));
                break;

            default:
                logger.warn(`Unknown message type: ${data.type}`);
                debugLog(`Unknown message details: ${JSON.stringify(data)}`);
        }
    } catch (error) {
        logger.error(`Message handler error: ${error.message}`);
        debugLog(`Message handler error stack: ${error.stack}`);
        ws.send(JSON.stringify({ 
            type: 'ERROR', 
            message: 'Server error occurred' 
        }));
    }
}

// ============ TIME SYNCHRONIZATION ============
async function handleTimeSync(ws, data) {
    const now = timeSync.getServerTime();
    
    if (data.step === 2) {
        ws.clientOffset = data.offset;
        ws.lastSyncTime = now;
        
        const player = gameState.state.players.get(ws);
        if (player?.userId) {
            timeSync.recordSync(player.userId, data.offset, data.rtt);
            debugLog(`Time sync for ${player.userId}: offset=${data.offset}ms, rtt=${data.rtt}ms`);
        }
        return;
    }

    ws.send(JSON.stringify({ 
        type: 'TIME_SYNC_RESULT', 
        serverTime: now, 
        t0: data.t0
    }));
}

// ============ JOIN HANDLING ============
async function handleJoin(ws, data) {
    if (data.role === 'admin') return;

    // Input validation — sanitise before anything else
    const rawUserId = typeof data.userId === 'string' ? data.userId : '';
    const userId = rawUserId.replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 64) || ('u_' + Date.now());
    const username = (typeof data.username === 'string' ? data.username : 'Guest')
        .replace(/[<>]/g, '').substring(0, 15).trim() || 'Guest';
    const VALID_GRADES = ['1-4', '5-9', '10-12'];
    const grade = VALID_GRADES.includes(data.grade) ? data.grade : '1-4';

    debugLog(`Join request: ${username} (${grade}) - userId: ${userId}`);

    // Check whether this is a reconnect (same userId already present)
    const isReconnect = Array.from(gameState.state.players.values())
        .some(p => p.userId === userId && p.role === 'player');

    // Enforce player cap BEFORE removing the old slot — reconnects don't count against cap
    if (!isReconnect) {
        const currentPlayerCount = Array.from(gameState.state.players.values())
            .filter(p => p.role === 'player').length;
        if (currentPlayerCount >= MAX_PLAYERS) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Server is full. Please try again later.' }));
            logger.warn(`Player cap reached (${MAX_PLAYERS}), rejected: ${username}`);
            return;
        }
    }

    // Remove stale connection for same userId
    for (let [socket, p] of gameState.state.players.entries()) {
        if (p.userId === userId && socket !== ws) {
            gameState.state.players.delete(socket);
            try { socket.close(); } catch (e) {}
        }
    }

    try {
        await dbRunAsync(
            `INSERT OR REPLACE INTO users (id, username, grade) VALUES (?, ?, ?)`,
            [userId, username, grade]
        );
    } catch (err) {
        logger.error(`DB error on join: ${err.message}`);
    }

    const player = {
        userId,
        username,
        grade,
        role: 'player',
        finished: false,
        wpm: 0,
        acc: 0,
        raw: 0,
        consistency: 0,
        errors: 0,
        progress: 0,
        joinTime: timeSync.getServerTime()
    };

    gameState.state.players.set(ws, player);
    const totalPlayers = Array.from(gameState.state.players.values()).filter(p => p.role === 'player').length;
    sysLog(`✅ Typer ${username} (${grade}) joined - Total: ${totalPlayers}`);

    if (gameState.state.phase === 'RACING') {
        const elapsed = Math.floor((timeSync.getServerTime() - gameState.state.startTime) / 1000);
        ws.send(JSON.stringify({
            type: 'GAME_IN_PROGRESS',
            text: gameState.state.text,
            duration: GAME_DURATION,
            elapsed: elapsed,
            startTime: gameState.state.startTime,
            gameId: gameState.state.gameId,
            round: gameState.state.currentRound,
            maxRounds: gameState.state.maxRounds,
            serverTime: timeSync.getServerTime(),
            stateVersion: gameState.stateVersion
        }));
    } else if (gameState.state.phase === 'COUNTDOWN') {
        ws.send(JSON.stringify({
            type: 'COUNTDOWN',
            count: gameState.state.countdown,
            serverTime: timeSync.getServerTime()
        }));
    } else {
        ws.send(JSON.stringify({ 
            type: 'JOIN_SUCCESS',
            serverTime: timeSync.getServerTime(),
            stateVersion: gameState.stateVersion,
            currentRound: gameState.state.currentRound,
            maxRounds: gameState.state.maxRounds
        }));
    }

    broadcastLobbyState();
}

// ============ FINISH HANDLING ============
async function handleFinish(ws, data) {
    const p = gameState.state.players.get(ws);
    // Ignore FINISH packets that arrive after the race has ended (stale network delivery)
    if (gameState.state.phase !== 'RACING' && gameState.state.phase !== 'ROUND_END') return;
    if (p?.role === 'player' && !p.finished) {
        p.finished = true;
        p.wpm = data.wpm || 0;
        p.acc = data.accuracy || 0;
        p.raw = data.raw || 0;
        p.consistency = data.consistency || 0;
        p.errors = data.errors || 0;
        p.finishTime = timeSync.getServerTime();

        sysLog(`🏁 ${p.username}: ${p.wpm} WPM, ${p.acc}% ACC, ${p.consistency}% CONS`);

        if (gameState.state.gameId) {
            try {
                await dbRunAsync(
                    `INSERT INTO sessions (id, user_id, grade, wpm, acc, raw, consistency, errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [`${gameState.state.gameId}_${p.userId}`, p.userId, p.grade, p.wpm, p.acc, p.raw, p.consistency, p.errors]
                );
            } catch (err) {
                logger.error(`DB insert error: ${err.message}`);
            }
        }
        
        broadcastLobbyState();
    }
}

// ============ GAME START ============
async function startGame() {
    // Increment round — if coming from LOBBY it's round 1, from ROUND_END it continues
    const newRound = (gameState.state.phase === 'ROUND_END')
        ? gameState.state.currentRound + 1
        : 1;

    const success = await gameState.transition('COUNTDOWN', {
        gameId: Date.now().toString(),
        countdown: 3,
        currentRound: newRound
    });
    
    if (!success) return;

    for (let p of gameState.state.players.values()) {
        if (p.role === 'player') {
            p.finished = false;
            p.wpm = 0;
            p.acc = 0;
            p.raw = 0;
            p.consistency = 0;
            p.errors = 0;
            p.progress = 0;
        }
    }

    const playerCount = Array.from(gameState.state.players.values()).filter(p => p.role === 'player').length;
    sysLog(`🚦 Starting Round ${newRound}/${gameState.state.maxRounds} with ${playerCount} players`);
    
    for (let i = 3; i > 0; i--) {
        gameState.state.countdown = i;
        broadcast({ 
            type: 'COUNTDOWN', 
            count: i,
            round: newRound,
            maxRounds: gameState.state.maxRounds,
            serverTime: timeSync.getServerTime()
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const startTime = timeSync.getServerTime();
    await gameState.transition('RACING', {
        startTime: startTime,
        endTime: startTime + (GAME_DURATION * 1000)
    });

    sysLog(`🔫 Round ${newRound} started!`);
    broadcast({
        type: 'START_GAME',
        text: gameState.state.text,
        duration: GAME_DURATION,
        startTime: startTime,
        gameId: gameState.state.gameId,
        round: newRound,
        maxRounds: gameState.state.maxRounds,
        serverTime: timeSync.getServerTime()
    });

    // Issue #1: Store timeout reference so FORCE_RESET can clear it
    if (gameState.endGameTimeout) clearTimeout(gameState.endGameTimeout);
    gameState.endGameTimeout = setTimeout(async () => {
        await endGame();
    }, GAME_DURATION * 1000);
}

async function endGame() {
    if (gameState.state.phase !== 'RACING') return;
    
    const round = gameState.state.currentRound;
    const maxRounds = gameState.state.maxRounds;
    const isLastRound = round >= maxRounds;

    await gameState.transition('ROUND_END', {
        endTime: timeSync.getServerTime()
    });

    // Save this round's results to history
    const roundPlayers = Array.from(gameState.state.players.values())
        .filter(p => p.role === 'player')
        .map(p => ({ userId: p.userId, username: p.username, grade: p.grade, wpm: p.wpm, acc: p.acc, raw: p.raw, consistency: p.consistency, errors: p.errors }));

    gameState.state.roundHistory.push({ round, mode: gameState.state.mode, results: roundPlayers });

    sysLog(`🛑 Round ${round}/${maxRounds} finished`);
    saveResultsToFile();

    broadcast({ 
        type: 'GAME_OVER',
        round,
        maxRounds,
        isLastRound,
        serverTime: timeSync.getServerTime()
    });

    if (isLastRound) {
        sysLog('🏁 All rounds complete — waiting for host to end series');
        broadcast({ type: 'SERIES_COMPLETE', round, maxRounds, serverTime: timeSync.getServerTime() });
    } else {
        sysLog(`⏳ Round ${round} done — host can start Round ${round + 1}`);
    }
}

// ============ RESULTS SAVING ============
function saveResultsToFile() {
    const players = Array.from(gameState.state.players.values()).filter(p => p.role === 'player');
    const groups = { "1-4": [], "5-9": [], "10-12": [] };
    
    players.forEach(p => {
        if (groups[p.grade]) groups[p.grade].push(p);
        else groups["10-12"].push(p);
    });

    let output = `\n${'='.repeat(80)}\n`;
    output += `REZULTATE - ${new Date().toLocaleString('ro-RO')}\n`;
    output += `Session ID: ${gameState.state.gameId}\n`;
    output += `Round: ${gameState.state.currentRound} / ${gameState.state.maxRounds}\n`;
    output += `Total Players: ${players.length}\n`;
    output += `${'='.repeat(80)}\n`;
    
    for (const [g, list] of Object.entries(groups)) {
        if (list.length === 0) continue;
        
        output += `\n┌─ CLASA ${g} (${list.length} ${list.length === 1 ? 'participant' : 'participanți'}) ─┐\n`;
        
        list.sort((a, b) => b.wpm - a.wpm).forEach((p, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
            output += `${medal} #${i + 1} ${p.username.padEnd(20)} │ `;
            output += `WPM: ${String(p.wpm).padStart(3)} │ `;
            output += `ACC: ${String(p.acc).padStart(3)}% │ `;
            output += `CONS: ${String(p.consistency).padStart(3)}% │ `;
            output += `ERR: ${String(p.errors).padStart(3)}\n`;
        });
        output += `└${'─'.repeat(78)}┘\n`;
    }
    
    const allSorted = players.sort((a, b) => b.wpm - a.wpm);
    output += `\n🏆 TOP 3 OVERALL:\n`;
    allSorted.slice(0, 3).forEach((p, i) => {
        const medal = ['🥇', '🥈', '🥉'][i];
        output += `${medal} ${p.username} (${p.grade}) - ${p.wpm} WPM, ${p.acc}% ACC, ${p.consistency}% CONS\n`;
    });
    output += `\n`;
    
    const sessionTag = (gameState.state.gameId || Date.now().toString()).substring(0, 13);
    const sessionResultsFile = path.join(DIRS.data, `results_${sessionTag}.txt`);
    // Also append to master results file for full history
    fs.appendFile(FILES.resultsFile, output, (err) => {
        if (err) logger.error(`Master results write error: ${err.message}`);
        else sysLog(`✅ Results appended to ${FILES.resultsFile}`);
    });
    fs.appendFile(sessionResultsFile, output, (err) => {
        if (err) logger.error(`Session results write error: ${err.message}`);
        else sysLog(`✅ Session results saved to ${sessionResultsFile}`);
    });
}

// ============ HEALTH CHECK ============
const healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        const health = {
            status: 'ok',
            phase: gameState.state.phase,
            mode: gameState.state.mode,
            players: Array.from(gameState.state.players.values()).filter(p => p.role === 'player').length,
            spellers: Array.from(gameState.state.players.values()).filter(p => p.role === 'speller').length,
            stateVersion: gameState.stateVersion,
            uptime: process.uptime(),
            memory: {
                heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
                heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
            },
            connections: wss.clients.size,
            debugMode: DEBUG_MODE
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health, null, 2));
    } else if (req.url === '/stats') {
        db.all(`SELECT 
            COUNT(*) as total_sessions,
            AVG(wpm) as avg_wpm,
            MAX(wpm) as max_wpm,
            AVG(acc) as avg_acc
            FROM sessions WHERE completed_at > datetime('now', '-1 day')`,
            (err, rows) => {
                if (err) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: err.message }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(rows[0], null, 2));
                }
            });
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

healthServer.listen(5890);

// ============ INITIALIZATION ============
(async () => {
    gameState.state.text = loadText();
    gameState.state.spellText = loadSpellText();
    
    const restored = await gameState.restoreLastState();
    if (restored) {
        sysLog("📄 Server recovered from restart");
    }
    
    sysLog(`🚀 Server running on ws://localhost:5889`);
    sysLog(`🏥 Health check: http://localhost:5890/health`);
    sysLog(`📊 Stats endpoint: http://localhost:5890/stats`);
    sysLog(`📊 Initial state: ${gameState.state.phase}`);
})();

// ============ GRACEFUL SHUTDOWN ============
const rl = readline.createInterface({ 
    input: process.stdin, 
    output: process.stdout 
});

rl.on('line', async (input) => {
    const cmd = input.trim();
    
    if (cmd === 'debug-on') {
        DEBUG_MODE = true;
        console.log('🐛 DEBUG MODE ENABLED - Extensive logging activated');
        sysLog('Debug mode enabled');
    }
    
    if (cmd === 'debug-off') {
        DEBUG_MODE = false;
        console.log('🐛 DEBUG MODE DISABLED');
        sysLog('Debug mode disabled');
    }
    
    if (cmd === 'stop') {
        sysLog("🛑 Graceful shutdown initiated...");
        
        await gameState.saveSnapshot();
        
        broadcast({ 
            type: 'SERVER_SHUTDOWN',
            message: 'Server is shutting down. Please reconnect in a moment.'
        });
        
        clearInterval(heartbeatInterval);
        clearInterval(cleanupInterval);
        clearInterval(memoryInterval);
        
        setTimeout(() => {
            db.close();
            sysLog("👋 Server stopped");
            process.exit(0);
        }, 1000);
    }
    
    if (cmd === 'status') {
        const players = Array.from(gameState.state.players.values()).filter(p => p.role === 'player');
        const spellers = Array.from(gameState.state.players.values()).filter(p => p.role === 'speller');
        console.log('\n=== SERVER STATUS ===');
        console.log(`Phase: ${gameState.state.phase}`);
        console.log(`Mode: ${gameState.state.mode}`);
        console.log(`Players: ${players.length}`);
        console.log(`Spellers: ${spellers.length}`);
        console.log(`State Version: ${gameState.stateVersion}`);
        console.log(`WebSocket Clients: ${wss.clients.size}`);
        console.log(`Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
        console.log(`Uptime: ${Math.floor(process.uptime() / 60)} minutes`);
        console.log(`Debug Mode: ${DEBUG_MODE ? 'ON' : 'OFF'}`);
        if (players.length > 0) {
            console.log('\nPlayers:');
            players.forEach(p => {
                console.log(`  - ${p.username} (${p.grade}): ${p.wpm} WPM`);
            });
        }
        if (spellers.length > 0) {
            console.log('\nSpellers:');
            spellers.forEach(p => {
                console.log(`  - ${p.username} (${p.grade}): ${p.score} score`);
            });
        }
        console.log('====================\n');
    }
    
    if (cmd === 'force-end') {
        if (gameState.state.phase === 'RACING') {
            await endGame();
            console.log('Game force-ended');
        } else {
            console.log('No active game');
        }
    }
});

// ── Graceful shutdown on SIGTERM / SIGINT (PM2, systemd, Ctrl-C) ──────────────
async function gracefulShutdown(signal) {
    sysLog(`⚠️ ${signal} received — shutting down gracefully...`);
    await gameState.saveSnapshot();
    broadcast({
        type: 'SERVER_SHUTDOWN',
        message: 'Server is restarting. Please reconnect in a moment.'
    });
    clearInterval(heartbeatInterval);
    clearInterval(cleanupInterval);
    clearInterval(memoryInterval);
    setTimeout(() => {
        db.close(() => {
            sysLog('👋 Server stopped cleanly');
            process.exit(0);
        });
    }, 1000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled rejection at ${promise}: ${reason}`);
});