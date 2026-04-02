const WS_URL       = window.__WS_URL__ || `ws://${location.hostname || 'localhost'}:5889`;
    const LS_SESSION   = 'mt_session';
    const LS_DRAFT     = 'mt_spell_draft_v2'; // new key — v2 stores JSON array

    let ws, reconnectAttempts = 0;
    let hasJoined  = !!JSON.parse(localStorage.getItem(LS_SESSION) || 'null')?.userId;
    let selectedGrade = null;
    let myData     = { username: '', userId: '', grade: '' };
    let currentRound = 0, maxRounds = 3;

    // ── Dictation state ────────────────────────────────────────────────────
    let D = {
        active:    false,
        wordCount: 0,       // received from server
        inputs:    [],      // HTMLInputElement[]
        submitted: false
    };

    const allScreens = document.querySelectorAll('.screen');

    // ── Boot ───────────────────────────────────────────────────────────────
    window.onload = () => {
        const user = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
        if (user?.username && user?.grade) {
            document.getElementById('username-input').value = user.username;
            document.getElementById('display-name').textContent = user.username;
            selectedGrade = user.grade;
            selectGrade(user.grade, null);
            myData = user;
        }
        connect();
    };

    // ── Helpers ────────────────────────────────────────────────────────────
    function selectGrade(grade, btn) {
        selectedGrade = grade;
        document.querySelectorAll('.grade-btn').forEach(b => b.classList.remove('selected'));
        if (btn) { btn.classList.add('selected'); return; }
        document.querySelectorAll('.grade-btn').forEach(b => {
            if (b.textContent.trim().replace(/\s*-\s*/g, '-') === grade) b.classList.add('selected');
        });
    }

    function switchScreen(id) {
        allScreens.forEach(s => { s.classList.remove('active'); s.style.display = 'none'; });
        const t = document.getElementById(id);
        if (t) { t.style.display = 'block'; setTimeout(() => t.classList.add('active'), 50); }
    }

    function updateRoundBadge() {
        if (!currentRound) return;
        const txt = `RUNDA ${currentRound} / ${maxRounds}`;
        ['spell-round-badge','spell-wait-round','res-round-badge'].forEach(id => {
            const el = document.getElementById(id); if (el) el.textContent = txt;
        });
    }

    // ── WebSocket ──────────────────────────────────────────────────────────
    function connect() {
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            document.getElementById('status-dot').className = 'status-indicator status-green';
            document.getElementById('status-text').textContent = 'Conectat';
            reconnectAttempts = 0;
            const si = document.getElementById('sync-indicator');
            if (si) si.textContent = 'Connected';

            const user = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
            if (user?.userId && user?.username) {
                hasJoined = true; myData = user; selectedGrade = user.grade;
                document.getElementById('display-name').textContent = user.username;
                document.getElementById('change-name-btn').style.display = 'block';
                ws.send(JSON.stringify({ type:'JOIN_SPELL', userId:user.userId, username:user.username, grade:user.grade||'1-4' }));
                switchScreen('waiting-screen');
            } else {
                switchScreen('login-screen');
            }
        };

        ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch(_){} };

        ws.onclose = () => {
            document.getElementById('status-dot').className = 'status-indicator status-red';
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
            reconnectAttempts++;
            document.getElementById('status-text').textContent = `Reconnecting in ${Math.floor(delay/1000)}s...`;
            const user = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
            if (!user?.userId) switchScreen('connecting-screen');
            setTimeout(connect, delay);
        };

        ws.onerror = () => {
            document.getElementById('status-dot').className = 'status-indicator status-red';
            document.getElementById('status-text').textContent = 'Connection Error';
        };
    }

    // ── Message handler ────────────────────────────────────────────────────
    function handleMsg(data) {
        switch (data.type) {
            case 'UPDATE_SPELLERS':
            case 'SPELL_LOBBY_UPDATE':
                document.getElementById('waiting-count').textContent = data.count || 0;
                break;

            case 'SYNC_STATE':
                if (data.mode === 'race' && !D.active) { window.location.href = 'index.html'; return; }
                if (data.currentRound) currentRound = data.currentRound;
                if (data.maxRounds)   maxRounds   = data.maxRounds;
                if (data.spellRoundActive && hasJoined) switchScreen('waiting-screen');
                break;

            case 'MODE_CHANGED':
                if (!D.active && data.mode === 'race') window.location.href = 'index.html';
                break;

            case 'SPELL_START':
                startDictation(data);
                break;

            case 'SPELL_RESULT_FULL':
                showResult(data);
                break;

            case 'SPELL_END':
                D.active = false;
                localStorage.removeItem(LS_DRAFT);
                switchScreen('waiting-screen');
                document.getElementById('waiting-title').textContent = 'Runda s-a terminat';
                document.getElementById('spell-wait-round').textContent = 'Așteptați instrucțiunile hostului';
                break;

            case 'SERIES_COMPLETE':
            case 'SERIES_OVER':
                switchScreen('waiting-screen');
                document.getElementById('waiting-title').textContent = '🏁 Seria s-a terminat!';
                document.getElementById('spell-wait-round').textContent = '';
                break;

            case 'JOIN_SUCCESS':
                switchScreen('waiting-screen');
                document.getElementById('change-name-btn').style.display = 'block';
                break;

            case 'USERNAME_CHANGED': {
                // Server renamed us because our chosen name was already taken.
                const assigned = data.assigned;
                if (!assigned) break;
                const _sess = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
                if (_sess) { _sess.username = assigned; localStorage.setItem(LS_SESSION, JSON.stringify(_sess)); }
                document.getElementById('display-name').textContent = assigned;
                const _t = document.createElement('div');
                _t.style.cssText = 'position:fixed;bottom:5rem;left:50%;transform:translateX(-50%);background:#2c2e31;border:1px solid var(--main);color:var(--text);padding:0.6rem 1.25rem;border-radius:8px;z-index:9999;font-family:Roboto Mono,monospace;font-size:0.8rem;text-align:center;white-space:nowrap;';
                _t.textContent = `Nume ocupat — ai primit: ${assigned}`;
                document.body.appendChild(_t);
                setTimeout(() => _t.remove(), 4500);
                break;
            }

            case 'KICKED':
                localStorage.removeItem(LS_SESSION);
                localStorage.removeItem(LS_DRAFT);
                {
                    const msg = document.createElement('div');
                    msg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:1rem;font-family:Roboto Mono,monospace;color:#d1d0c5';
                    msg.innerHTML = '<i class="fa-solid fa-ban" style="font-size:3rem;color:#ca4754"></i><p style="font-size:1.25rem;font-weight:700">Removed by host</p><p style="color:#646669;font-size:0.875rem">Reloading...</p>';
                    document.body.appendChild(msg);
                    setTimeout(() => location.reload(), 2000);
                }
                break;
        }
    }

    // ── Join ───────────────────────────────────────────────────────────────
    function joinGame() {
        const name = document.getElementById('username-input').value.trim();
        const ni   = document.getElementById('username-input');
        const gb   = document.getElementById('grade-buttons');
        if (!name || !selectedGrade) {
            if (!name)        { ni.classList.add('animate-shake'); setTimeout(()=>ni.classList.remove('animate-shake'),500); }
            if (!selectedGrade) { gb.classList.add('animate-shake'); setTimeout(()=>gb.classList.remove('animate-shake'),500); }
            return;
        }
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            document.getElementById('status-text').textContent = 'Nu ești conectat...';
            return;
        }
        const existing = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
        const userId   = (existing?.username === name) ? existing.userId : ('sp_' + name.replace(/\s+/g,'_') + '_' + Date.now());
        const userData = { userId, username:name, grade:selectedGrade };
        localStorage.setItem(LS_SESSION, JSON.stringify(userData));
        myData = userData;
        document.getElementById('display-name').textContent = name;
        hasJoined = true;
        ws.send(JSON.stringify({ type:'JOIN_SPELL', userId, username:name, grade:selectedGrade }));
        switchScreen('waiting-screen');
        document.getElementById('change-name-btn').style.display = 'block';
    }

    function changeName() {
        localStorage.removeItem(LS_SESSION);
        localStorage.removeItem(LS_DRAFT);
        location.reload();
    }

    // ── Dictation: build word grid ─────────────────────────────────────────
    function startDictation(data) {
        localStorage.removeItem(LS_DRAFT);
        if (data.round) { currentRound = data.round; maxRounds = data.maxRounds || maxRounds; }

        const wc = data.wordCount || 0;
        D = { active:true, wordCount:wc, inputs:[], submitted:false };

        updateRoundBadge();
        document.getElementById('total-count').textContent = wc || '?';
        document.getElementById('filled-count').textContent = '0';
        document.getElementById('game-prog').style.width = '0%';

        buildGrid(wc);
        resetSubmitBtn();
        switchScreen('game-screen');

        // Restore draft (JSON array of strings)
        try {
            const raw = localStorage.getItem(LS_DRAFT);
            if (raw) {
                const vals = JSON.parse(raw);
                if (Array.isArray(vals)) {
                    vals.forEach((v, i) => { if (D.inputs[i] && v) D.inputs[i].value = v; });
                    updateProgress();
                }
            }
        } catch(_) {}

        setTimeout(() => { if (D.inputs[0]) D.inputs[0].focus(); }, 150);
    }

    function buildGrid(wordCount) {
        const grid = document.getElementById('word-grid');
        grid.innerHTML = '';
        D.inputs = [];

        const n = wordCount > 0 ? wordCount : 1; // at least 1 slot
        for (let i = 0; i < n; i++) {
            const { slot, input } = makeSlot(i);
            D.inputs.push(input);
            grid.appendChild(slot);
        }
    }

    function makeSlot(idx) {
        const slot  = document.createElement('div');
        slot.className = 'word-slot';
        slot.style.animationDelay = Math.min(idx * 0.025, 0.6) + 's';

        const num   = document.createElement('div');
        num.className = 'word-num';
        num.textContent = idx + 1;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'word-input';
        input.autocomplete = 'off';
        input.autocorrect  = 'off';
        input.autocapitalize = 'none';
        input.spellcheck   = false;
        input.placeholder  = '···';
        input.dataset.idx  = idx;

        const hint = document.createElement('div');
        hint.className = 'word-hint';

        // Dynamic width
        input.addEventListener('input', () => {
            sizeInput(input);
            saveDraft();
            updateProgress();
        });

        // Navigation: Tab/Enter → next, Shift+Tab → prev
        input.addEventListener('keydown', e => {
            if (e.key === 'Tab' || e.key === 'Enter') {
                e.preventDefault();
                const next = parseInt(input.dataset.idx) + (e.shiftKey ? -1 : 1);
                if (D.inputs[next]) D.inputs[next].focus();
            }
        });

        slot.appendChild(num);
        slot.appendChild(input);
        slot.appendChild(hint);
        return { slot, input };
    }

    function sizeInput(input) {
        const len = Math.max(input.value.length, 3);
        input.style.minWidth = Math.min(len * 12 + 28, 200) + 'px';
    }

    function updateProgress() {
        const filled = D.inputs.filter(i => i.value.trim() !== '').length;
        const total  = D.inputs.length || 1;
        document.getElementById('filled-count').textContent = filled;
        document.getElementById('game-prog').style.width = (filled / total * 100) + '%';
    }

    function saveDraft() {
        if (!D.active) return;
        localStorage.setItem(LS_DRAFT, JSON.stringify(D.inputs.map(i => i.value)));
    }

    function resetSubmitBtn() {
        const btn = document.getElementById('submit-btn');
        btn.disabled = false;
        btn.dataset.armed = '';
        btn.innerHTML = '<i class="fa-solid fa-paper-plane mr-2"></i> Trimite';
        btn.style.background = '';
        btn.style.color = '';
    }

    // ── Submit ─────────────────────────────────────────────────────────────
    function submitDictation() {
        if (!D.active || D.submitted) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            document.getElementById('status-text').textContent = 'Nu ești conectat...';
            return;
        }

        const words   = D.inputs.map(i => i.value.trim());
        const hasAny  = words.some(w => w !== '');
        if (!hasAny) {
            D.inputs.forEach(i => {
                i.style.borderColor = 'var(--wrong)';
                setTimeout(() => { i.style.borderColor = ''; }, 1000);
            });
            if (D.inputs[0]) D.inputs[0].focus();
            return;
        }

        const btn = document.getElementById('submit-btn');

        if (!btn.dataset.armed) {
            // Arm: show warning if blanks remain
            btn.dataset.armed = '1';
            const blanks = words.filter(w => w === '').length;
            const label  = blanks > 0
                ? `<i class="fa-solid fa-triangle-exclamation mr-2"></i>${blanks} necompletate — Confirmă`
                : `<i class="fa-solid fa-check mr-2"></i> Confirmă Trimiterea`;
            btn.innerHTML = label;
            btn.style.background = 'var(--main)';
            btn.style.color = '#323437';
            setTimeout(() => {
                if (btn.dataset.armed) { btn.dataset.armed = ''; resetSubmitBtn(); }
            }, 4000);
            return;
        }

        // Confirmed — submit
        D.submitted = true;
        D.active    = false;
        btn.dataset.armed = '';
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-check mr-2"></i> Trimis!';
        btn.style.background = '';
        btn.style.color = '';
        D.inputs.forEach(i => { i.disabled = true; });
        localStorage.removeItem(LS_DRAFT);

        ws.send(JSON.stringify({ type:'SPELL_SUBMIT_FULL', text: words.join(' ') }));
    }

    // ── Result display ─────────────────────────────────────────────────────
    function showResult(data) {
        switchScreen('result-screen');

        document.getElementById('res-accuracy').textContent   = data.accuracy ?? 0;
        document.getElementById('res-correct').textContent    = data.correctCount ?? 0;
        document.getElementById('res-total').textContent      = data.totalWords ?? 0;
        document.getElementById('res-percentile').textContent = data.stats?.percentile ?? '—';

        // Show time if available
        const timeEl = document.getElementById('res-time');
        if (timeEl) {
            const sec = data.elapsedSec ?? data.stats?.elapsedSec;
            timeEl.textContent = sec != null ? sec + 's' : '—';
        }

        const rankEl = document.getElementById('res-rank-display');
        if (data.stats?.rank && data.stats?.totalSpellers) {
            const medals = ['🥇','🥈','🥉'];
            const medal  = medals[data.stats.rank - 1] || '';
            rankEl.textContent = `${medal} #${data.stats.rank} / ${data.stats.totalSpellers}`;
            rankEl.style.color = data.stats.rank <= 3 ? 'var(--main)' : 'var(--text)';
        } else {
            rankEl.textContent = '—';
        }

        if (currentRound) {
            const rb = document.getElementById('res-round-badge');
            if (rb) rb.textContent = `RUNDA ${currentRound} / ${maxRounds}`;
        }

        // Build diff
        const container = document.getElementById('diff-view');
        container.innerHTML = '';
        if (data.diff && Array.isArray(data.diff)) {
            data.diff.forEach((item, i) => {
                const chip = document.createElement('div');
                chip.className = 'diff-chip';

                const num = document.createElement('div');
                num.className = 'diff-num';
                num.textContent = i + 1;

                const word = document.createElement('div');
                word.className = 'diff-word ' + (item.status === 'correct' ? 'ok' : 'bad');
                word.textContent = item.word || '—';

                chip.appendChild(num);
                chip.appendChild(word);

                if (item.status !== 'correct' && item.expected) {
                    const exp = document.createElement('div');
                    exp.className = 'diff-exp';
                    exp.textContent = item.expected;
                    chip.appendChild(exp);
                }

                container.appendChild(chip);
            });
        }

        // Confetti
        const acc = data.accuracy || 0;
        if (acc === 100) {
            confetti({ particleCount:200, spread:100, origin:{y:0.6} });
        } else if (acc >= 80) {
            confetti({ particleCount:60, spread:60, origin:{y:0.7}, colors:['#e2b714','#fff'] });
        }
    }