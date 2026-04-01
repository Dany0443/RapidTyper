'use strict';
/**
 * logger.js — RapidTyper pretty logger
 *
 * Console output:  colored, sectioned, easy to scan at a glance
 * File output:     plain text (no ANSI codes), rotated at 5MB
 *
 * Sections (auto-detected from message prefix or passed explicitly):
 *   SYS  GAME  CAM  SCHOOL  WS  NET  HTTP  REC
 *
 * Usage:
 *   const Logger = require('./logger');
 *   const log = new Logger('./logs');
 *
 *   log.info('Server started');                    // [SYS ]
 *   log.cam('Camera cam-A3 is streaming');         // [CAM ]
 *   log.school('school-cluj registered');          // [SCHL]
 *   log.game('LOBBY→RACING');                      // [GAME]
 *   log.warn('MainServer reconnecting…');          // [WARN]
 *   log.error('Write failed: ENOENT');             // [ERR ]
 *   log.net('Attempt #3 in 4800ms');               // [NET ]
 *   log.banner(name, version, config);             // startup box
 */

const fs   = require('fs');
const path = require('path');

// ── ANSI palette ─────────────────────────────────────────────────────────────
const C = {
    reset   : '\x1b[0m',
    bold    : '\x1b[1m',
    dim     : '\x1b[2m',
    // foregrounds
    red     : '\x1b[31m',
    green   : '\x1b[32m',
    yellow  : '\x1b[33m',
    blue    : '\x1b[34m',
    magenta : '\x1b[35m',
    cyan    : '\x1b[36m',
    white   : '\x1b[37m',
    gray    : '\x1b[90m',
    // bright
    bred    : '\x1b[91m',
    bgreen  : '\x1b[92m',
    byellow : '\x1b[93m',
    bblue   : '\x1b[94m',
    bmagenta: '\x1b[95m',
    bcyan   : '\x1b[96m',
    bwhite  : '\x1b[97m',
};

// Whether the terminal supports color (disable in PM2 log files, but PM2
// generally strips them anyway — this keeps output clean in all cases)
const USE_COLOR = process.stdout.isTTY || process.env.FORCE_COLOR === '1';
const c = (code, str) => USE_COLOR ? `${code}${str}${C.reset}` : str;

// ── Section definitions ───────────────────────────────────────────────────────
// Each section has: a 4-char label, a color for the label, a color for the msg
const SECTIONS = {
    SYS  : { label: 'SYS ', color: C.bwhite,   msg: C.white   },
    GAME : { label: 'GAME', color: C.bblue,    msg: C.blue    },
    CAM  : { label: 'CAM ', color: C.bmagenta, msg: C.magenta },
    SCHOOL:{ label: 'SCHL', color: C.byellow,  msg: C.yellow  },
    WS   : { label: 'WS  ', color: C.bcyan,    msg: C.cyan    },
    NET  : { label: 'NET ', color: C.byellow,  msg: C.yellow  },
    HTTP : { label: 'HTTP', color: C.cyan,     msg: C.gray    },
    REC  : { label: 'REC ', color: C.bred,     msg: C.red     },
    WARN : { label: 'WARN', color: C.byellow,  msg: C.yellow  },
    ERR  : { label: 'ERR!', color: C.bred,     msg: C.bred    },
};

// Auto-detect section from emoji / keywords at start of message
function detectSection(msg) {
    const m = msg || '';
    if (/^(🔄|🎮|🏁|⌛|✅.*game|START|LOBBY|RACING|FINISH|ROUND|SPELL)/.test(m)) return 'GAME';
    if (/^(📷|📹|📡|🎥|▶️|⏹|👁️?|CAM|cam-|Camera|Viewer)/.test(m))              return 'CAM';
    if (/^(🏫|SCHOOL|school-|School|Registered|Re-register)/.test(m))           return 'SCHOOL';
    if (/^(🔗|💔|WS|Client|Session|ws_)/.test(m))                                return 'WS';
    if (/^(🔁|📶|Attempt|Reconnect|reconnect|MainServer)/.test(m))              return 'NET';
    if (/^(🌐|🔒|HTTP|HTTPS|GET|POST|:808)/.test(m))                             return 'HTTP';
    if (/^(💾|🔴.*[Rr]ec|REC|Recording|Transcod)/.test(m))                       return 'REC';
    return 'SYS';
}

class Logger {
    constructor(logDir) {
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        this._lf  = path.join(logDir, 'server.log');
        this._ef  = path.join(logDir, 'errors.log');
        this._max = 5 * 1024 * 1024;   // 5MB rotate
        // Touch files if they don't exist
        [this._lf, this._ef].forEach(f => {
            if (!fs.existsSync(f)) fs.writeFileSync(f, '');
        });
    }

    // ── Time helpers ──────────────────────────────────────────────────────────
    _ts()  { return new Date().toISOString(); }                        // file: full ISO
    _tsc() { return new Date().toISOString().substr(11, 12); }        // console: HH:MM:SS.mmm

    // ── Rotate ────────────────────────────────────────────────────────────────
    _rotate(p) {
        try {
            if (fs.existsSync(p) && fs.statSync(p).size > this._max) {
                fs.renameSync(p, p.replace(/\.log$/, `.${Date.now()}.log`));
                fs.writeFileSync(p, '');
            }
        } catch (_) {}
    }

    // ── Core write ────────────────────────────────────────────────────────────
    _write(level, msg, section) {
        const sec  = SECTIONS[section] || SECTIONS.SYS;
        const errSec = SECTIONS.ERR;
        const isErr  = level === 'ERROR';
        const isWarn = level === 'WARN';
        const useSec = isErr ? errSec : (isWarn ? SECTIONS.WARN : sec);

        // ── Console line ────────────────────────────────────────────────────
        const ts    = c(C.gray + C.dim, this._tsc());
        const label = c(C.bold + useSec.color, `[${useSec.label}]`);
        const text  = c(useSec.msg, msg);
        const line  = `${ts} ${label} ${text}`;

        if (isErr)       process.stderr.write(line + '\n');
        else if (isWarn) process.stderr.write(line + '\n');
        else             process.stdout.write(line + '\n');

        // ── File line (no color) ─────────────────────────────────────────────
        const fileLine = `[${this._ts()}] [${level.padEnd(5)}] [${useSec.label}] ${msg}`;
        this._rotate(this._lf);
        fs.appendFile(this._lf, fileLine + '\n', () => {});
        if (isErr) {
            this._rotate(this._ef);
            fs.appendFile(this._ef, fileLine + '\n', () => {});
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────
    info  (msg, sec) { this._write('INFO',  msg, sec || detectSection(msg)); }
    warn  (msg, sec) { this._write('WARN',  msg, sec || 'WARN'); }
    error (msg, sec) { this._write('ERROR', msg, sec || 'ERR'); }

    // Shorthand section-specific methods
    game  (msg) { this._write('INFO', msg, 'GAME');   }
    cam   (msg) { this._write('INFO', msg, 'CAM');    }
    school(msg) { this._write('INFO', msg, 'SCHOOL'); }
    ws    (msg) { this._write('INFO', msg, 'WS');     }
    net   (msg) { this._write('INFO', msg, 'NET');    }
    http  (msg) { this._write('INFO', msg, 'HTTP');   }
    rec   (msg) { this._write('INFO', msg, 'REC');    }

    // ── Startup banner ────────────────────────────────────────────────────────
    /**
     * banner(name, version, rows)
     *   name:    'MainServer' | 'SchoolServer'
     *   version: '2.0'
     *   rows:    array of { key, value } or just strings for separator lines
     *
     * Example output:
     * ╔══════════════════════════════════════════════════════╗
     * ║  🚀  RapidTyper MainServer  v2.0                    ║
     * ╠══════════════════════════════════════════════════════╣
     * ║  port        5889                                   ║
     * ║  env         production                             ║
     * ║  pid         12345                                  ║
     * ╚══════════════════════════════════════════════════════╝
     */
    banner(name, version, rows = []) {
        const W   = 54;   // inner width
        const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));

        const tl = '╔', tr = '╗', bl = '╚', br = '╝';
        const hl = '═', vl = '║', sl = '╠', sr = '╣';
        const hline = hl.repeat(W);
        const sep   = `${sl}${hline}${sr}`;

        const title    = `🚀  RapidTyper ${name}  v${version}`;
        const titleRow = `${vl}  ${pad(title, W - 2)}${vl}`;
        const pidRow   = `${vl}  ${pad(`pid  ${process.pid}   node ${process.version}`, W - 2)}${vl}`;
        const timeRow  = `${vl}  ${pad(`started  ${new Date().toLocaleTimeString()}`, W - 2)}${vl}`;

        const dataRows = rows.map(r => {
            if (typeof r === 'string') return sep;  // '---' → separator
            const kv = `${String(r.key).padEnd(14)}${r.val}`;
            return `${vl}  ${pad(kv, W - 2)}${vl}`;
        });

        const lines = [
            `${tl}${hline}${tr}`,
            titleRow,
            pidRow,
            timeRow,
            sep,
            ...dataRows,
            `${bl}${hline}${br}`,
        ];

        const box = lines.join('\n');
        if (USE_COLOR) {
            process.stdout.write(c(C.bold + C.bcyan, box) + '\n\n');
        } else {
            process.stdout.write(box + '\n\n');
        }

        // Also log banner summary to file (plain)
        const summary = `===== ${name} v${version} started · pid ${process.pid} =====`;
        this._rotate(this._lf);
        fs.appendFile(this._lf, `[${this._ts()}] [INFO ] ${summary}\n`, () => {});
    }

    // ── Separator line ────────────────────────────────────────────────────────
    sep(label = '') {
        const line = label
            ? `── ${label} ${'─'.repeat(Math.max(0, 44 - label.length))}`
            : '─'.repeat(50);
        process.stdout.write(c(C.gray, line) + '\n');
    }

    // ── One-liner status block (for status command) ───────────────────────────
    statusBlock(rows) {
        this.sep('STATUS');
        rows.forEach(r => {
            const key   = c(C.bold + C.white,  String(r.key).padEnd(18));
            const val   = c(C.bgreen, String(r.val));
            const extra = r.sub ? c(C.gray, '  ' + r.sub) : '';
            process.stdout.write(`  ${key}${val}${extra}\n`);
        });
        this.sep();
    }
}

module.exports = Logger;