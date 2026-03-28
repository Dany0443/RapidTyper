const WS_URL = `ws://${location.hostname || "localhost"}:5889`;
        const LS_HOST_SESSION = "mt_host_session";

        let ws;
        let allPlayers  = [];
        let allSpellers = [];
        let currentFilter      = 'all';
        let currentSpellFilter = 'all';
        let raceActive      = false;
        let raceDuration    = 60;
        let isAuthenticated = false;
        let currentRound = 0;
        let maxRounds    = 3;
        let phase = 'LOBBY';
        let spellRoundActive = false;
        let perRoundTextEnabled = false;
        let perRoundTexts = [];  // Array indexed 0..maxRounds-1

        // ── Per-round text ────────────────────────────────────────────
        function togglePerRoundText() {
            perRoundTextEnabled = !perRoundTextEnabled;
            const toggle = document.getElementById('per-round-toggle');
            if (toggle) toggle.classList.toggle('on', perRoundTextEnabled);
            renderPerRoundAreas();
        }

        function renderPerRoundAreas() {
            const single = document.getElementById('single-text-area');
            const multi  = document.getElementById('per-round-text-areas');
            if (!single || !multi) return;

            // If only 1 round or toggle off — always show single
            if (!perRoundTextEnabled || maxRounds <= 1) {
                single.style.display = 'block';
                multi.style.display  = 'none';
                return;
            }

            single.style.display = 'none';
            multi.style.display  = 'block';

            // Build one textarea per round
            multi.innerHTML = Array.from({ length: maxRounds }, (_, i) => `
                <div class="mb-3">
                    <div class="text-xs font-bold uppercase mb-1" style="color:var(--sub)">
                        Runda ${i + 1}
                        <button onclick="saveRoundText(${i})" class="ml-2 btn text-xs py-0.5 px-2" style="font-size:0.6rem">
                            <i class="fa-solid fa-save mr-1"></i>Save R${i+1}
                        </button>
                    </div>
                    <textarea id="game-text-r${i}" class="host-textarea" rows="3"
                        placeholder="Text for round ${i+1}..."
                        oninput="_updateCount('game-text-r${i}','count-r${i}')"
                    >${perRoundTexts[i] || ''}</textarea>
                    <div id="count-r${i}" class="text-xs mt-0.5 text-right" style="color:var(--sub)">0 cuvinte</div>
                </div>
            `).join('');

            // Recount each
            for (let i = 0; i < maxRounds; i++) _updateCount(`game-text-r${i}`, `count-r${i}`);
        }

        function saveRoundText(idx) {
            const ta = document.getElementById(`game-text-r${idx}`);
            if (!ta || !ta.value.trim()) return;
            perRoundTexts[idx] = ta.value.trim();
            if (ws && ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: 'UPDATE_TEXT', text: ta.value.trim(), roundIndex: idx }));
            ta.style.borderColor = '#22c55e';
            setTimeout(() => ta.style.borderColor = '', 1500);
        }

        // ── Word/char counter for text areas ──────────────────────────
        function _updateCount(taId, countId) {
            const ta = document.getElementById(taId);
            const el = document.getElementById(countId);
            if (!ta || !el) return;
            const txt = ta.value.trim();
            const words = txt ? txt.split(/\s+/).length : 0;
            el.textContent = words + ' cuvinte · ' + ta.value.length + ' caractere';
        }

        // ── Duration ─────────────────────────────────────────────────
        function setDuration(sec, btn) {
            raceDuration = sec;
            document.querySelectorAll('#dur-btns .dur-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (ws && ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: 'SET_DURATION', duration: sec }));
        }

        function setRounds(n, btn) {
            maxRounds = n;
            document.querySelectorAll('#round-btns .dur-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (ws && ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: 'SET_ROUNDS', rounds: n }));
            updateRoundUI();
            renderPerRoundAreas();
        }

        // ── Grade filters ─────────────────────────────────────────────
        function setGradeFilter(g, btn) {
            currentFilter = g;
            document.querySelectorAll('#view-fast-typer .filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderPlayerGrid();
        }

        function setSpellFilter(g, btn) {
            currentSpellFilter = g;
            document.querySelectorAll('#view-spelling-bee .filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderSpellerGrid();
        }

        // ── Tab switch ────────────────────────────────────────────────
        function switchView(viewName) {
            ['fast-typer', 'spelling-bee'].forEach(s => {
                document.getElementById('view-' + s).style.display = s === viewName ? 'block' : 'none';
                document.getElementById('tab-' + s).classList.toggle('active', s === viewName);
            });
            // Only broadcast mode changes for actual game-mode tabs, never for 'cameras'
            if (ws && ws.readyState === WebSocket.OPEN && (viewName === 'fast-typer' || viewName === 'spelling-bee'))
                ws.send(JSON.stringify({ type: 'SET_GAME_MODE', mode: viewName === 'fast-typer' ? 'race' : 'spell' }));
        }

        // ── Inline confirm helper — two-click actions, no blocking confirm() ──────
        // arm(btn, label, cb, timeout=3000) — first click arms, second executes cb
        function arm(btn, armedLabel, cb, timeout = 3000) {
            if (btn.dataset.armed) { cb(); btn.dataset.armed = ''; return; }
            const orig = btn.innerHTML;
            const origColor = btn.style.color;
            btn.dataset.armed = '1';
            btn.innerHTML = armedLabel;
            btn.style.color = 'var(--error)';
            const t = setTimeout(() => {
                btn.dataset.armed = '';
                btn.innerHTML = orig;
                btn.style.color = origColor;
            }, timeout);
            btn._armTimer = t;
        }

        // ── Kick ──────────────────────────────────────────────────────
        function kickPlayer(userId, username) {
            // Kick button is inline — we need a temporary DOM button reference trick
            // Use a simple window-level flag keyed to userId
            const key = 'kick_' + userId;
            if (window[key]) {
                clearTimeout(window[key]);
                window[key] = null;
                if (ws && ws.readyState === WebSocket.OPEN)
                    ws.send(JSON.stringify({ type: 'KICK_PLAYER', userId }));
            } else {
                window[key] = setTimeout(() => { window[key] = null; }, 3000);
                // Show visual feedback on the kick button
                const btn = document.querySelector(`.kick-btn[onclick*="${userId}"]`);
                if (btn) {
                    btn.innerHTML = '<i class="fa-solid fa-check"></i>';
                    btn.style.color = 'var(--error)';
                    setTimeout(() => { if (btn) { btn.innerHTML = '<i class="fa-solid fa-xmark"></i>'; btn.style.color = ''; } }, 3000);
                }
            }
        }

        function kickSpeller(userId, username) {
            const key = 'kick_sp_' + userId;
            if (window[key]) {
                clearTimeout(window[key]);
                window[key] = null;
                if (ws && ws.readyState === WebSocket.OPEN)
                    ws.send(JSON.stringify({ type: 'KICK_SPELLER', userId }));
            } else {
                window[key] = setTimeout(() => { window[key] = null; }, 3000);
                const btn = document.querySelector(`.kick-btn[onclick*="${userId}"]`);
                if (btn) {
                    btn.innerHTML = '<i class="fa-solid fa-check"></i>';
                    btn.style.color = 'var(--error)';
                    setTimeout(() => { if (btn) { btn.innerHTML = '<i class="fa-solid fa-xmark"></i>'; btn.style.color = ''; } }, 3000);
                }
            }
        }

        // ── WS ────────────────────────────────────────────────────────
        window.onload = () => {
            if (localStorage.getItem(LS_HOST_SESSION))
                document.getElementById('logout-btn').style.display = 'block';
            connect();
        };

        function connect() {
            ws = new WebSocket(WS_URL);
            ws.onopen = () => {
                setStatus('green', 'Connected');
                const session = localStorage.getItem(LS_HOST_SESSION);
                if (session) ws.send(JSON.stringify({ type: 'ADMIN_LOGIN', key: JSON.parse(session).key }));
                ws.send(JSON.stringify({ type: 'GET_HOST_STATE' }));
                ws.send(JSON.stringify({ type: 'REQUEST_SPELLER_SYNC' }));
            };
            ws.onmessage = e => handleMessage(JSON.parse(e.data));
            ws.onclose   = () => { setStatus('red', 'Disconnected'); setTimeout(connect, 3000); };
            ws.onerror   = () => setStatus('red', 'Error');
        }

        function setStatus(color, text) {
            const colorMap = { green: '#22c55e', red: '#ef4444', yellow: '#eab308' };
            document.getElementById('status-dot').className = `w-2 h-2 rounded-full bg-${color}-500`;
            const txtEl = document.getElementById('status-text');
            txtEl.textContent = text;
            txtEl.style.color = colorMap[color] || 'var(--sub)';
        }

        // ── Messages ──────────────────────────────────────────────────
        function handleMessage(data) {
            switch (data.type) {

                case 'AUTH_SUCCESS':
                    isAuthenticated = true;
                    document.getElementById('logout-btn').style.display = 'block';
                    if (data.currentText) {
                        document.getElementById('game-text').value = data.currentText;
                        _updateCount('game-text', 'game-text-count');
                    }
                    if (data.currentSpellText) {
                        document.getElementById('spell-text').value = data.currentSpellText;
                        _updateCount('spell-text', 'spell-text-count');
                    }
                    if (data.gameState?.currentRound) {
                        currentRound = data.gameState.currentRound;
                        maxRounds    = data.gameState.maxRounds || 3;
                    }
                    phase = data.gameState?.phase || 'LOBBY';
                    // Restore duration button
                    if (data.gameDuration) {
                        raceDuration = data.gameDuration;
                        document.querySelectorAll('#dur-btns .dur-btn').forEach(b => {
                            const sec = parseInt(b.textContent) || (b.textContent.includes('2m') ? 120 : 0);
                            b.classList.toggle('active', sec === data.gameDuration);
                        });
                    }
                    // Restore rounds button
                    if (data.maxRounds) {
                        maxRounds = data.maxRounds;
                        document.querySelectorAll('#round-btns .dur-btn').forEach(b => {
                            b.classList.toggle('active', parseInt(b.textContent) === data.maxRounds);
                        });
                    }
                    updateRoundUI();
                    showScreen('lobby-screen');
                    break;

                case 'AUTH_FAIL':
                    localStorage.removeItem(LS_HOST_SESSION);
                    showScreen('auth-screen');
                    {
                        const keyInput = document.getElementById('host-key');
                        keyInput.style.borderColor = 'var(--error)';
                        keyInput.value = '';
                        keyInput.placeholder = 'Incorrect key — try again';
                        setTimeout(() => {
                            keyInput.style.borderColor = '';
                            keyInput.placeholder = '••••••';
                        }, 2500);
                    }
                    break;

                case 'HOST_STATE_SYNC':
                    if (data.mode === 'spell') {
                        switchView('spelling-bee');
                        if (data.currentSpellText) document.getElementById('spell-text').value = data.currentSpellText;
                    } else {
                        switchView('fast-typer');
                    }
                    break;

                case 'UPDATE_LOBBY':
                    allPlayers = data.players || [];
                    updateTyperUI();
                    break;

                case 'UPDATE_SPELLERS':
                    allSpellers = data.list || [];
                    document.getElementById('speller-count').textContent = data.count || allSpellers.length;
                    renderSpellerGrid();
                    break;

                case 'SPELL_LOBBY_UPDATE':
                    document.getElementById('speller-count').textContent = data.count || 0;
                    if (data.spellers) { allSpellers = data.spellers; renderSpellerGrid(); }
                    break;

                case 'SPELL_LIVE_UPDATE': {
                    const sp = allSpellers.find(s => s.username === data.user);
                    if (sp) { sp.submitted = true; sp.correct = data.correct; }
                    renderSpellerGrid();
                    break;
                }

                case 'SYNC_STATE':
                    if (data.spellRoundActive) { spellRoundActive = true; setSpellRunningState(true); }
                    if (data.currentSpellText) document.getElementById('spell-text').value = data.currentSpellText;
                    break;

                case 'SPELL_START':
                    spellRoundActive = true;
                    setSpellRunningState(true);
                    break;

                case 'SPELL_END':
                    spellRoundActive = false;
                    setSpellRunningState(false);
                    break;

                case 'START_GAME':
                    raceDuration = data.duration || raceDuration;
                    if (data.round) { currentRound = data.round; maxRounds = data.maxRounds || maxRounds; }
                    phase = 'RACING';
                    updateRoundUI();
                    startRaceUI();
                    break;

                case 'GAME_OVER':
                    if (data.round) { currentRound = data.round; maxRounds = data.maxRounds || maxRounds; }
                    phase = 'ROUND_END';
                    updateRoundUI();
                    finishGameUI();
                    break;

                case 'SERIES_COMPLETE':
                    phase = 'ROUND_END';
                    currentRound = data.round || maxRounds;
                    updateRoundUI();
                    finishGameUI();
                    break;

                case 'SERIES_OVER':
                case 'FORCE_RESET':
                    currentRound = 0; phase = 'LOBBY';
                    updateRoundUI();
                    showScreen('lobby-screen');
                    break;

                case 'PLAYER_KICKED':
                    allPlayers  = allPlayers.filter(p => p.userId !== data.userId);
                    allSpellers = allSpellers.filter(p => p.userId !== data.userId);
                    updateTyperUI();
                    renderSpellerGrid();
                    break;

                case 'TEXT_UPDATE_SUCCESS':
                case 'TEXT_UPDATE_PARTIAL':
                    // silent
                    break;

                case 'ROUNDS_UPDATED':
                    maxRounds = data.maxRounds || maxRounds;
                    updateRoundUI();
                    break;
            }
        }

        // ── Spell state UI ────────────────────────────────────────────
        function setSpellRunningState(running) {
            const stEl    = document.getElementById('spell-state-text');
            const startBtn = document.getElementById('start-spell-btn');
            const stopBtn  = document.getElementById('stop-spell-btn');
            stEl.textContent = running ? 'RUNNING' : 'IDLE';
            stEl.style.color = running ? '#22c55e' : 'var(--sub)';
            startBtn.style.display = running ? 'none'  : 'flex';
            stopBtn.style.display  = running ? 'flex'  : 'none';
        }

        // ── Fast Typer render ─────────────────────────────────────────
        function updateTyperUI() {
            document.getElementById('player-count').textContent = allPlayers.length;
            const startBtn = document.getElementById('start-btn');
            if (startBtn) startBtn.disabled = allPlayers.length === 0;
            updateRoundUI();
            if (raceActive) {
                let list = [...allPlayers];
                if (currentFilter !== 'all') list = list.filter(p => p.grade === currentFilter);
                list.sort((a, b) => (b.wpm || 0) - (a.wpm || 0));
                renderLiveList(list);
            } else {
                renderPlayerGrid();
            }
        }

        function renderPlayerGrid() {
            const grid = document.getElementById('player-grid');
            let list = [...allPlayers];
            if (currentFilter !== 'all') list = list.filter(p => p.grade === currentFilter);
            list.sort((a, b) => (b.wpm || 0) - (a.wpm || 0));

            if (list.length === 0) {
                grid.innerHTML = `<div class="col-span-full text-center py-12" style="color:var(--sub)">
                    <i class="fa-solid fa-hourglass text-3xl mb-3 block opacity-30"></i>No players yet</div>`;
                return;
            }
            grid.innerHTML = list.map(p => `
                <div class="player-card ${p.finished ? 'finished' : ''}">
                    <button class="kick-btn" onclick="kickPlayer('${p.userId}','${p.username}')" title="Kick">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                    <div class="font-bold text-white truncate pr-4" style="font-size:0.92rem">${p.username || 'Guest'}</div>
                    <div class="text-xs mb-2" style="color:var(--sub)">${p.grade || '—'}</div>
                    <div class="flex justify-between items-end">
                        <div class="font-bold" style="color:var(--main);font-size:1.35rem">${p.wpm || 0}<span class="text-xs font-normal ml-1" style="color:var(--sub)">wpm</span></div>
                        <div class="text-xs ${(p.acc||0)>=95?'text-green-400':'text-yellow-400'}">${p.acc||0}%</div>
                    </div>
                    <div class="progress-track">
                        <div class="progress-bar" style="width:${p.progress||0}%"></div>
                    </div>
                </div>
            `).join('');
        }

        function renderLiveList(list) {
            document.getElementById('live-list').innerHTML = list.map((p, i) => `
                <div class="px-4 py-3 grid grid-cols-12 gap-3 items-center" style="border-bottom:1px solid rgba(255,255,255,0.04)">
                    <div class="col-span-1 text-xs font-bold" style="color:var(--sub)">${i+1}</div>
                    <div class="col-span-3 font-bold text-white truncate text-sm">${p.username||'Guest'}</div>
                    <div class="col-span-2 text-xs" style="color:var(--sub)">${p.grade||'—'}</div>
                    <div class="col-span-4">
                        <div class="w-full h-1.5 rounded-full overflow-hidden" style="background:#1a1b1d">
                            <div class="h-full rounded-full" style="width:${p.progress||0}%;background:var(--main);transition:width 0.3s"></div>
                        </div>
                    </div>
                    <div class="col-span-2 text-right font-mono font-bold" style="color:var(--main)">${p.wpm||0}</div>
                </div>
            `).join('');
        }

        // ── Speller render ────────────────────────────────────────────
        function renderSpellerGrid() {
            const grid = document.getElementById('speller-grid');
            // Grade breakdown (always from full list)
            const _g = (grade) => allSpellers.filter(p => p.grade === grade).length;
            const _set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
            _set('sg-14',   _g('1-4'));
            _set('sg-59',   _g('5-9'));
            _set('sg-1012', _g('10-12'));
            _set('sg-sub',  allSpellers.filter(p => p.submitted).length);

            let list = [...allSpellers];
            if (currentSpellFilter !== 'all') list = list.filter(p => p.grade === currentSpellFilter);

            const submitted = list.filter(p => p.submitted).length;
            document.getElementById('spell-submitted-count').textContent = submitted;

            if (list.length === 0) {
                grid.innerHTML = `<div class="col-span-full text-center py-12" style="color:var(--sub)">
                    <i class="fa-solid fa-hourglass text-3xl mb-3 block opacity-30"></i>No spellers yet</div>`;
                return;
            }

            grid.innerHTML = list.map(p => {
                let accent = 'var(--sub)', pillClass = 'pill-gray', label = 'waiting';
                if (p.submitted && p.correct === true)  { accent='#22c55e'; pillClass='pill-green'; label='✓ correct'; }
                else if (p.submitted && p.correct===false) { accent='var(--error)'; pillClass='pill-red'; label='✗ wrong'; }
                else if (p.submitted) { accent='var(--main)'; pillClass='pill-yellow'; label='submitted'; }

                return `
                <div class="speller-card" style="border-left-color:${accent}">
                    <button class="kick-btn" onclick="kickSpeller('${p.userId||p.username}','${p.username}')" title="Kick">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                    <div class="font-bold text-white truncate pr-4" style="font-size:0.92rem">${p.username||'Guest'}</div>
                    <div class="text-xs mb-2" style="color:var(--sub)">${p.grade||'—'}</div>
                    <div class="flex justify-between items-end">
                        <span class="status-pill ${pillClass}">${label}</span>
                        <span class="font-bold text-xs" style="color:var(--main)">${p.score||0} pts</span>
                    </div>
                </div>`;
            }).join('');
        }

        // ── Spell controls ────────────────────────────────────────────
        function startSpellGame() {
            if (!ws || ws.readyState !== WebSocket.OPEN) { setStatus('red', 'Not connected'); return; }
            ws.send(JSON.stringify({ type: 'START_SPELL_ROUND' }));
            spellRoundActive = true;
            setSpellRunningState(true);
            allSpellers.forEach(s => { s.submitted = false; delete s.correct; });
            renderSpellerGrid();
        }

        function stopSpellGame() {
            if (!ws) return;
            const btn = document.getElementById('stop-spell-btn');
            arm(btn, '<i class="fa-solid fa-stop"></i> CONFIRM STOP', () => {
                ws.send(JSON.stringify({ type: 'STOP_SPELL_ROUND' }));
                spellRoundActive = false;
                setSpellRunningState(false);
            });
        }

        function updateSpellText() {
            const txt = document.getElementById('spell-text').value.trim();
            const ta  = document.getElementById('spell-text');
            if (!txt) {
                ta.style.borderColor = 'var(--error)';
                setTimeout(() => ta.style.borderColor = '', 1500);
                return;
            }
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                setStatus('red', 'Not connected');
                return;
            }
            ws.send(JSON.stringify({ type: 'UPDATE_TEXT', text: txt, mode: 'spell' }));
            ta.style.borderColor = '#22c55e';
            setTimeout(() => ta.style.borderColor = '', 1500);
        }

        function updateText() {
            const txt = document.getElementById('game-text').value.trim();
            const ta  = document.getElementById('game-text');
            if (!txt) {
                ta.style.borderColor = 'var(--error)';
                setTimeout(() => ta.style.borderColor = '', 1500);
                return;
            }
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                setStatus('red', 'Not connected');
                return;
            }
            ws.send(JSON.stringify({ type: 'UPDATE_TEXT', text: txt }));
            // Brief visual confirmation — border flashes green
            ta.style.borderColor = '#22c55e';
            setTimeout(() => ta.style.borderColor = '', 1500);
        }

        // ── Round UI ──────────────────────────────────────────────────
        function updateRoundUI() {
            const badge    = document.getElementById('round-status-badge');
            const nextBtn  = document.getElementById('next-round-btn');
            const endBtn   = document.getElementById('end-series-btn');
            const startBtn = document.getElementById('start-btn');
            if (!badge) return;

            if (currentRound === 0) {
                badge.textContent = `Round 1 / ${maxRounds}`;
                if (nextBtn)  nextBtn.style.display  = 'none';
                if (endBtn)   endBtn.style.display   = 'none';
                if (startBtn) { startBtn.style.display = 'inline-flex'; startBtn.disabled = allPlayers.length === 0; }
            } else if (phase === 'ROUND_END') {
                const isLast = currentRound >= maxRounds;
                badge.textContent = isLast ? `Round ${currentRound}/${maxRounds} — done` : `Round ${currentRound}/${maxRounds} — finished`;
                if (nextBtn)  nextBtn.style.display  = isLast ? 'none' : 'inline-flex';
                if (endBtn)   endBtn.style.display   = 'inline-flex';
                if (startBtn) startBtn.style.display = 'none';
            } else {
                badge.textContent = `Round ${currentRound} / ${maxRounds}`;
                if (nextBtn)  nextBtn.style.display  = 'none';
                if (endBtn)   endBtn.style.display   = 'none';
                if (startBtn) startBtn.style.display = 'inline-flex';
            }
        }

        function nextRound() {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const btn = document.getElementById('next-round-btn');
            arm(btn, `<i class="fa-solid fa-forward-step"></i> CONFIRM Round ${currentRound+1}`, () => {
                if (perRoundTextEnabled && maxRounds > 1) {
                    const nextRoundIdx = currentRound; // still on currentRound, about to go to currentRound+1
                    const roundText = perRoundTexts[nextRoundIdx];
                    if (roundText) ws.send(JSON.stringify({ type: 'UPDATE_TEXT', text: roundText }));
                }
                ws.send(JSON.stringify({ type: 'NEXT_ROUND' }));
            });
        }

        function endSeries() {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const btn = document.getElementById('end-series-btn');
            arm(btn, '<i class="fa-solid fa-flag-checkered"></i> CONFIRM END', () => {
                ws.send(JSON.stringify({ type: 'END_SERIES' }));
            }, 4000);
        }

        function startGame() {
            const btn = document.getElementById('start-btn');
            arm(btn, `<i class="fa-solid fa-play"></i> CONFIRM (${allPlayers.length}p)`, () => {
                if (ws && ws.readyState !== WebSocket.OPEN) return;
                // If per-round text mode: send text for the upcoming round first
                if (perRoundTextEnabled && maxRounds > 1) {
                    const nextRoundIdx = currentRound; // 0-based index for next round
                    const roundText = perRoundTexts[nextRoundIdx];
                    if (roundText) ws.send(JSON.stringify({ type: 'UPDATE_TEXT', text: roundText }));
                }
                ws.send(JSON.stringify({ type: 'START_REQUEST' }));
            });
        }

        // ── Force end race ────────────────────────────────────────────
        function forceEndRace() {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const btn = document.getElementById('force-end-btn');
            arm(btn, '<i class="fa-solid fa-stop"></i> CONFIRM END', () => {
                ws.send(JSON.stringify({ type: 'FORCE_RESET' }));
            });
        }

        // ── Race / Results ────────────────────────────────────────────
        function startRaceUI() {
            raceActive = true;
            showScreen('race-screen');
            let t = raceDuration;
            document.getElementById('race-timer').textContent = t;
            const int = setInterval(() => {
                t--;
                document.getElementById('race-timer').textContent = t;
                if (t <= 0 || !raceActive) clearInterval(int);
            }, 1000);
        }

        function finishGameUI() {
            raceActive = false;
            showScreen('results-screen');
            renderResults();
            setTimeout(() => {
                updateRoundUI();
                // Mirror next/end visibility onto the results-screen action bar
                const isLast = currentRound >= maxRounds;
                const rNext = document.getElementById('results-next-btn');
                const rEnd  = document.getElementById('results-end-btn');
                if (rNext) rNext.style.display = (!isLast && phase === 'ROUND_END') ? 'inline-flex' : 'none';
                if (rEnd)  rEnd.style.display  = (phase === 'ROUND_END') ? 'inline-flex' : 'none';
            }, 300);
        }

        function renderResults() {
            const sorted = [...allPlayers].sort((a,b) => (b.wpm||0)-(a.wpm||0));
            const pod = document.getElementById('podium-area');
            pod.innerHTML = '';
            const styles = [
                { cls:'rank-1', crown:'🥇', label:'1st' },
                { cls:'rank-2', crown:'🥈', label:'2nd' },
                { cls:'rank-3', crown:'🥉', label:'3rd' }
            ];
            [1,0,2].forEach(idx => {
                if (!sorted[idx]) return;
                const p=sorted[idx], s=styles[idx];
                pod.innerHTML += `
                    <div class="podium-step ${s.cls}">
                        <div class="crown">${s.crown}</div>
                        <div class="text-center mb-2">
                            <div class="font-bold text-white truncate w-28 text-sm">${p.username||'Guest'}</div>
                            <div class="text-xs" style="color:var(--sub)">${p.wpm||0} wpm</div>
                        </div>
                        <div class="podium-block">${s.label}</div>
                    </div>`;
            });
            document.getElementById('results-body').innerHTML = sorted.map((p,i) => `
                <tr>
                    <td class="font-bold text-sm" style="color:var(--sub)">#${i+1}</td>
                    <td class="font-bold text-white">${p.username||'Guest'}</td>
                    <td style="color:var(--sub)">${p.grade||'—'}</td>
                    <td class="num font-mono font-bold text-xl" style="color:var(--main)">${p.wpm||0}</td>
                    <td class="num text-sm text-gray-300">${p.acc||0}%</td>
                    <td class="num text-sm text-blue-400">${p.consistency||0}%</td>
                    <td class="num text-sm" style="color:var(--error)">${p.errors||0}</td>
                </tr>
            `).join('');
        }

        // ── Auth ──────────────────────────────────────────────────────
        function login() {
            const key = document.getElementById('host-key').value;
            if (!key) return;
            localStorage.setItem(LS_HOST_SESSION, JSON.stringify({ key }));
            if (ws && ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: 'ADMIN_LOGIN', key }));
        }

        function logout() {
            localStorage.removeItem(LS_HOST_SESSION);
            location.reload();
        }

        // ── Screen ────────────────────────────────────────────────────
        function showScreen(id) {
            document.querySelectorAll('.screen').forEach(s => {
                s.classList.remove('active');
                s.style.display = 'none';
            });
            const el = document.getElementById(id);
            el.style.display = 'block';
            setTimeout(() => el.classList.add('active'), 40);
        }

        // Live race list refresh
        setInterval(() => {
            if (raceActive) {
                let list = [...allPlayers];
                if (currentFilter !== 'all') list = list.filter(p => p.grade === currentFilter);
                list.sort((a,b) => (b.wpm||0)-(a.wpm||0));
                renderLiveList(list);
            }
        }, 1000);