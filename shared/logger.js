const fs = require('fs');
const path = require('path');

class Logger {
    constructor(logDir) {
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        this.lf = path.join(logDir, 'server.log');
        this.ef = path.join(logDir, 'errors.log');
        [this.lf, this.ef].forEach(f => { if (!fs.existsSync(f)) fs.writeFileSync(f, ''); });
        this.logMax = 5 * 1024 * 1024;
    }

    _ts() { return new Date().toISOString().substr(11, 12); }

    rotate(p) {
        try {
            if (fs.existsSync(p) && fs.statSync(p).size > this.logMax) {
                fs.renameSync(p, p.replace(/\.log$/, `.${Date.now()}.log`));
                fs.writeFileSync(p, '');
            }
        } catch (_) {}
    }

    log(msg, lvl = 'INFO') {
        const line = `[${new Date().toISOString()}] [${lvl}] ${msg}`;
        const consoleLine = `[${this._ts()}] [${lvl}] ${msg}`;
        
        if (lvl === 'INFO') console.log(consoleLine);
        else if (lvl === 'WARN') console.warn(consoleLine);
        else if (lvl === 'ERROR') console.error(consoleLine);

        this.rotate(this.lf);
        fs.appendFile(this.lf, line + '\n', () => {});
        if (lvl === 'ERROR') {
            this.rotate(this.ef);
            fs.appendFile(this.ef, line + '\n', () => {});
        }
    }

    info(m)  { this.log(m, 'INFO');  }
    warn(m)  { this.log(m, 'WARN');  }
    error(m) { this.log(m, 'ERROR'); }
}

module.exports = Logger;
