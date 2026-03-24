        const WS_URL = `ws://${location.hostname || "localhost"}:5889`;
        const LS_SESSION = "mt_session"; // shared key with spell.html
        
        let ws;
        let selectedGrade = null;
        let reconnectAttempts = 0;
        let maxReconnectDelay = 30000;
        let serverTimeOffset = 0;
        let lastSyncTime = 0;
        let stateVersion = 0;
        // True if user has valid saved session data (previous OR current session)
        let hasJoined = !!JSON.parse(localStorage.getItem(LS_SESSION) || 'null')?.userId;
        let currentRound = 0;
        let maxRounds = 3;
        
        let gameState = {
            active: false,
            words: [],
            history: [],
            wordIndex: 0,
            inputVal: "",
            startTime: 0,
            duration: 60,
            timer: null,
            reloadTimer: null,
            myRank: null,
            totalPlayers: 0,
            stats: {
                correctChars: 0,
                totalChars: 0,
                errors: 0,
                wpmSnapshots: []
            }
        };

        const els = {
            screens: document.querySelectorAll('.screen'),
            input: document.getElementById('hidden-input'),
            scrollWrapper: document.getElementById('scroll-wrapper'),
            wordsContainer: document.getElementById('words-container'),
            caret: document.getElementById('caret'),
            overlay: document.getElementById('blur-overlay')
        };

        window.onload = () => {
            const user = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
            if (user && user.username) {
                document.getElementById('username-input').value = user.username;
                if (user.grade) selectGrade(user.grade, null);
                // grade-display element removed (was in old debug-info div)
                document.getElementById('display-name').textContent = user.username;
            }
            // Start connecting — login screen shown only after connection succeeds
            connect();
        };

        function getServerTime() {
            return Date.now() + serverTimeOffset;
        }

        function updateRoundBadge() {
            if (!currentRound) return;
            const badge = document.getElementById('round-badge');
            const waitInfo = document.getElementById('waiting-round-info');
            const resInfo = document.getElementById('res-round-info');
            const txt = `RUNDA ${currentRound} / ${maxRounds}`;
            if (badge)   { badge.textContent = txt; badge.style.display = 'block'; }
            if (waitInfo) waitInfo.textContent = txt;
            if (resInfo)  resInfo.textContent  = txt;
        }

        function selectGrade(grade, btn) {
            selectedGrade = grade;
            document.querySelectorAll('.grade-btn').forEach(b => b.classList.remove('selected'));
            if (btn) {
                btn.classList.add('selected');
            } else {
                document.querySelectorAll('.grade-btn').forEach(b => { 
                    // Button text is "1 - 4" but grade values are "1-4" — normalise both before comparing
                    const btnGrade = b.textContent.trim().replace(/\s*-\s*/g, '-');
                    if (btnGrade === grade) b.classList.add('selected'); 
                });
            }
        }

        function switchScreen(id) {
            els.screens.forEach(s => s.classList.remove('active'));
            document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
            const t = document.getElementById(id);
            if (t) { 
                t.style.display = 'block'; 
                setTimeout(() => t.classList.add('active'), 50); 
            }
        }

        function connect() {
            ws = new WebSocket(WS_URL);
            
            ws.onopen = () => {
                reconnectAttempts = 0;
                document.getElementById('status-dot').className = 'status-indicator status-green';
                document.getElementById('status-text').textContent = 'Conectat';
                
                const user = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
                if (user && user.userId && user.username) {
                    // Has saved session — auto-rejoin silently
                    hasJoined = true;
                    ws.send(JSON.stringify({ 
                        type: 'RECONNECT', 
                        userId: user.userId,
                        username: user.username,
                        grade: user.grade || '5-9',
                        role: 'player'
                    }));
                    document.getElementById('display-name').textContent = user.username;
                    // JOIN_SUCCESS from server will switch to waiting-screen
                } else {
                    // Fresh user — show login form
                    switchScreen('login-screen');
                }
            };
            
            ws.onmessage = (e) => handleServerMessage(JSON.parse(e.data));
            
            ws.onclose = () => { 
                document.getElementById('status-dot').className = 'status-indicator status-red';
                
                const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), maxReconnectDelay);
                reconnectAttempts++;
                
                document.getElementById('status-text').textContent = `Reconnecting in ${Math.floor(delay/1000)}s...`;
                
                // Show connecting screen only if we have no user data at all
                const user = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
                if (!user?.userId) {
                    switchScreen('connecting-screen');
                }
                
                setTimeout(connect, delay);
            };
            
            ws.onerror = () => {
                document.getElementById('status-dot').className = 'status-indicator status-red';
                document.getElementById('status-text').textContent = 'Connection Error';
            };
        }

        function handleServerMessage(data) {
            switch (data.type) {
                case 'TIME_SYNC':
                    if (data.requestSync) {
                        const t0 = Date.now();
                        ws.send(JSON.stringify({
                            type: 'TIME_SYNC_RESPONSE',
                            clientTime: Date.now(),
                            t0: t0
                        }));
                    }
                    break;

                case 'TIME_SYNC_RESULT':
                    const now = Date.now();
                    const rtt = now - data.t0; // Client Time - Client Time = Real RTT
                    const offset = data.serverTime - (now - (rtt / 2)); // Standard NTP Offset
                    
                    serverTimeOffset = offset;
                    lastSyncTime = now;
                    
                    // Send calculated stats back to server for logging (Step 2)
                    ws.send(JSON.stringify({
                        type: 'TIME_SYNC_RESPONSE',
                        step: 2,
                        rtt: rtt,
                        offset: offset
                    }));

                    const syncText = `Sync: ${offset > 0 ? '+' : ''}${Math.round(offset)}ms | Ping: ${rtt}ms`;
                    document.getElementById('sync-indicator').textContent = syncText;
                    
                    if (rtt > 200) {
                        document.getElementById('status-dot').className = 'status-indicator status-yellow';
                    } else {
                        document.getElementById('status-dot').className = 'status-indicator status-green';
                    }
    break;
                    
                case 'FULL_STATE_SYNC':
                    stateVersion = data.state?.version || stateVersion;
                    if (data.state?.currentRound) currentRound = data.state.currentRound;
                    if (data.state?.maxRounds)    maxRounds   = data.state.maxRounds;
                    if (data.state.phase === 'RACING' && !gameState.active) {
                        const elapsed = Math.floor((getServerTime() - data.state.startTime) / 1000);
                        if (elapsed < data.state.duration) {
                            switchScreen('game-screen');
                        }
                    }
                    break;
                
                case 'JOIN_SUCCESS':
                    if (data.currentRound) { currentRound = data.currentRound; maxRounds = data.maxRounds || maxRounds; }
                    switchScreen('waiting-screen');
                    document.getElementById('change-name-btn').style.display = 'block';
                    if (data.stateVersion) stateVersion = data.stateVersion;
                    updateRoundBadge();
                    break;
                    
                case 'UPDATE_LOBBY': 
                    document.getElementById('waiting-count').textContent = data.count;
                    // Keep local stateVersion in sync so we don't endlessly request syncs
                    if (data.stateVersion) stateVersion = data.stateVersion;
                    break;
                    
                case 'COUNTDOWN':
                    if (data.round) { currentRound = data.round; maxRounds = data.maxRounds || maxRounds; }
                    runCountdown(data.count);
                    break;
                    
                case 'START_GAME':
                    if (data.round) { currentRound = data.round; maxRounds = data.maxRounds || maxRounds; }
                    updateRoundBadge();
                    startGame(data.text, data.duration, data.startTime);
                    break;
                    
                case 'GAME_IN_PROGRESS':
                    if (data.round) { currentRound = data.round; maxRounds = data.maxRounds || maxRounds; }
                    updateRoundBadge();
                    const remaining = data.duration - data.elapsed;
                    if (remaining > 0) {
                        startGame(data.text, data.duration, data.startTime);
                    } else {
                        switchScreen('waiting-screen');
                    }
                    break;
                    
                case 'GAME_OVER':
                    if (data.round) currentRound = data.round;
                    // Store rank from server payload before any screen switch
                    if (data.rankings && data.rankings.length) {
                        const _sess = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
                        if (_sess?.userId) {
                            const _me = data.rankings.find(r => r.userId === _sess.userId);
                            if (_me) { gameState.myRank = _me.rank; gameState.totalPlayers = data.totalPlayers; }
                        }
                    }
                    // If game still running client-side, finalize WITHOUT re-sending FINISH
                    // (sending FINISH again would overwrite real scores with 0s for idle players)
                    if (gameState.active) {
                        gameState.active = false;
                        clearInterval(gameState.timer);
                        if (gameState.reloadTimer) { clearInterval(gameState.reloadTimer); gameState.reloadTimer = null; }
                        // Compute final stats from what we have
                        const _el = Math.max(1, (getServerTime() - gameState.startTime) / 1000);
                        const _mins = _el / 60;
                        const _wpm = Math.round((gameState.stats.correctChars / 5) / _mins);
                        const _raw = Math.round((gameState.stats.totalChars / 5) / _mins);
                        const _tt  = gameState.stats.totalChars;
                        const _acc = _tt === 0 ? 0 : Math.round(((_tt - gameState.stats.errors) / _tt) * 100);
                        let _cons = 0;
                        const _sn = gameState.stats.wpmSnapshots;
                        if (_sn.length >= 2) {
                            const _m = _sn.reduce((a,b)=>a+b,0)/_sn.length;
                            const _v = _sn.map(v=>Math.pow(v-_m,2)).reduce((a,b)=>a+b,0)/_sn.length;
                            _cons = Math.max(0,Math.min(100,Math.round((1-Math.sqrt(_v)/(_m||1))*100)));
                        }
                        document.getElementById('res-wpm').textContent = _wpm;
                        document.getElementById('res-acc').textContent = Math.max(0,_acc)+'%';
                        document.getElementById('res-raw').textContent = _raw;
                        document.getElementById('res-cons').textContent = _cons+'%';
                        updateRoundBadge();
                        _showRank();
                        switchScreen('results-screen');
                    }
                    // Multi-round: hide reload bar; last round: keep it visible
                    const _reloadSec = document.getElementById('reload-section');
                    if (_reloadSec) _reloadSec.style.display = data.isLastRound ? 'block' : 'none';
                    if (!data.isLastRound && gameState.reloadTimer) {
                        clearInterval(gameState.reloadTimer); gameState.reloadTimer = null;
                    }
                    break;

                case 'MODE_CHANGED':
                    // Issue #10: Don't redirect mid-game — only redirect when idle
                    if (!gameState.active && data.mode === 'spell') window.location.href = 'spell.html';
                    break;

                case 'SYNC_STATE':
                    // Don't redirect mid-game — only when not actively typing
                    if (data.mode === 'spell' && !gameState.active) { window.location.href = 'spell.html'; return; }
                    if (data.currentRound) currentRound = data.currentRound;
                    if (data.maxRounds)   maxRounds   = data.maxRounds;
                    break;

                case 'SERIES_COMPLETE':
                case 'SERIES_OVER':
                    const st = document.getElementById('res-round-info');
                    if (st) st.textContent = 'Toate rundele complete!';
                    break;

                case 'FORCE_RESET':
                    // Issue #4: cancel any pending reload timer
                    if (gameState.reloadTimer) {
                        clearInterval(gameState.reloadTimer);
                        gameState.reloadTimer = null;
                    }
                    gameState.active = false;
                    currentRound = 0;
                    location.reload();
                    break;
                    
                case 'KICKED':
                    // Host kicked this player — clear session and show inline message
                    localStorage.removeItem(LS_SESSION);
                    {
                        // Show a visible message without blocking alert()
                        const kickMsg = document.createElement('div');
                        kickMsg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:1rem;font-family:Roboto Mono,monospace;color:#d1d0c5';
                        kickMsg.innerHTML = '<i class="fa-solid fa-ban" style="font-size:3rem;color:#ca4754"></i><p style="font-size:1.25rem;font-weight:700">Removed by host</p><p style="color:#646669;font-size:0.875rem">Reloading...</p>';
                        document.body.appendChild(kickMsg);
                        setTimeout(() => location.reload(), 2000);
                    }
                    break;

                case 'SERVER_SHUTDOWN':
                    {
                        document.getElementById('status-dot').className = 'status-indicator status-yellow';
                        document.getElementById('status-text').textContent = 'Server restarting...';
                        // Non-blocking shutdown notice
                        const shutMsg = document.createElement('div');
                        shutMsg.style.cssText = 'position:fixed;bottom:5rem;left:50%;transform:translateX(-50%);background:#2c2e31;border:1px solid var(--main);color:var(--text);padding:0.75rem 1.5rem;border-radius:8px;z-index:9999;font-family:Roboto Mono,monospace;font-size:0.875rem;text-align:center;';
                        shutMsg.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2" style="color:var(--main)"></i>' + (data.message || 'Server restarting…');
                        document.body.appendChild(shutMsg);
                        setTimeout(() => shutMsg.remove(), 8000);
                    }
                    break;
                    
                case 'ERROR':
                    console.error('Server error:', data.message);
                    break;
            }
        }

    function joinGame() {
    const name = document.getElementById('username-input').value.trim();
    const nameInput = document.getElementById('username-input');
    const gradeButtons = document.getElementById('grade-buttons');
    
    if (!name || !selectedGrade) {
        if (!name) {
            nameInput.classList.add('animate-shake');
            setTimeout(() => nameInput.classList.remove('animate-shake'), 600);
        }
        if (!selectedGrade) {
            gradeButtons.classList.add('animate-shake');
            setTimeout(() => gradeButtons.classList.remove('animate-shake'), 600);
        }
        return;
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        nameInput.style.borderColor = 'var(--error)';
        setTimeout(() => nameInput.style.borderColor = 'var(--sub)', 2000);
        document.getElementById('status-text').textContent = 'Nu ești conectat...';
        return;
    }
    
    // Reuse existing userId if same name, otherwise generate new one
    const existing = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
    const userId = (existing && existing.username === name)
        ? existing.userId
        : 'u_' + name.replace(/\s+/g, '_') + '_' + Date.now();

    const userData = { userId, username: name, grade: selectedGrade };
    localStorage.setItem(LS_SESSION, JSON.stringify(userData));
    // grade-display element removed (was in old debug-info div)
    document.getElementById('display-name').textContent = name;
    
    hasJoined = true;
    ws.send(JSON.stringify({ 
        type: 'JOIN', 
        userId: userId, 
        username: name, 
        grade: selectedGrade, 
        role: 'player' 
    }));
}

        function _showRank() {
            const el = document.getElementById('res-rank');
            if (!el) return;
            if (gameState.myRank && gameState.totalPlayers) {
                const medals = ['🥇','🥈','🥉'];
                const medal = medals[gameState.myRank - 1] || '';
                el.textContent = medal + ' Locul #' + gameState.myRank + ' din ' + gameState.totalPlayers + ' jucători';
                el.style.display = 'block';
            } else {
                el.style.display = 'none';
            }
        }

        function changeName() {
            localStorage.removeItem(LS_SESSION);
            location.reload();
        }

        function runCountdown(num) {
            const el = document.getElementById('countdown-overlay');
            const txt = document.getElementById('countdown-number');
            el.style.display = 'flex';
            let c = num; 
            txt.textContent = c;
            const int = setInterval(() => {
                c--;
                if (c > 0) {
                    txt.textContent = c;
                } else { 
                    clearInterval(int); 
                    el.style.display = 'none'; 
                    focusInput(); 
                }
            }, 1000);
        }

        function startGame(text, duration, startTime) {
            gameState.active = true;
            gameState.duration = duration;
            gameState.startTime = startTime;
            
            gameState.words = text.split(' ');
            gameState.history = [];
            gameState.wordIndex = 0;
            gameState.inputVal = "";
            gameState.stats = {
                correctChars: 0,
                totalChars: 0,
                errors: 0,
                wpmSnapshots: []
            };

            els.wordsContainer.innerHTML = '';
            // Pre-render all word divs with default state (no input yet)
            gameState.words.forEach((word, i) => {
                const wDiv = document.createElement('div');
                renderWordDiv(wDiv, word, null, false);
                els.wordsContainer.appendChild(wDiv);
            });

            els.scrollWrapper.style.transform = 'translateY(0px)';
            switchScreen('game-screen');
            
            setTimeout(() => {
                focusInput();
                updateUI();
            }, 100);
            
            if (gameState.timer) clearInterval(gameState.timer);
            gameState.timer = setInterval(gameLoop, 1000);
        }

        els.input.addEventListener('keydown', (e) => {
            if (!gameState.active) return;
            
            if (e.key === 'Backspace' && els.input.value.length === 0 && gameState.wordIndex > 0) {
                e.preventDefault();
                gameState.wordIndex--;
                const prev = gameState.history.pop();
                gameState.inputVal = prev; 
                els.input.value = prev;
                updateUI();
            }
        });

        els.input.addEventListener('input', (e) => {
            if (!gameState.active) return;
            
            const val = els.input.value;
            
            if (val.endsWith(' ')) {
                const typed = val.trim();
                gameState.history.push(typed);
                
                const target = gameState.words[gameState.wordIndex];
                const maxLen = Math.max(typed.length, target.length);
                
                for (let i = 0; i < maxLen; i++) {
                    gameState.stats.totalChars++;
                    if (typed[i] === target[i]) {
                        gameState.stats.correctChars++;
                    } else {
                        gameState.stats.errors++;
                    }
                }

                gameState.wordIndex++;
                gameState.inputVal = "";
                els.input.value = "";
            } else {
                gameState.inputVal = val;
            }
            
            updateUI();
            
            if (gameState.wordIndex >= gameState.words.length) {
                endGame();
            }
        });

        // Render a single word div given typed string vs target string
        function renderWordDiv(div, wStr, comp, isActive) {
            div.innerHTML = '';
            div.className = 'word';
            if (isActive) div.classList.add('active');

            if (comp !== null) {
                const maxLen = Math.max(comp.length, wStr.length);
                for (let j = 0; j < maxLen; j++) {
                    const span = document.createElement('span');
                    span.className = 'letter';
                    if (j < wStr.length) {
                        span.textContent = wStr[j];
                        if (j < comp.length) {
                            span.classList.add(comp[j] === wStr[j] ? 'correct' : 'incorrect');
                        }
                    } else {
                        span.textContent = comp[j];
                        span.classList.add('extra');
                    }
                    div.appendChild(span);
                }
                if (comp.length > wStr.length) div.classList.add('error-underline');
            } else {
                for (let j = 0; j < wStr.length; j++) {
                    const span = document.createElement('span');
                    span.className = 'letter';
                    span.textContent = wStr[j];
                    div.appendChild(span);
                }
            }
        }

        function updateUI() {
            const divs = els.wordsContainer.children;
            const idx = gameState.wordIndex;
            const input = gameState.inputVal;

            // Only re-render the active word and the word just completed (previous).
            // All other words are already rendered correctly from the last update.
            // On first render (idx===0, no history) we need to render everything once —
            // that is handled by buildWordDivs which pre-populates all divs.
            const toUpdate = new Set([idx]);
            if (idx > 0) toUpdate.add(idx - 1);

            for (const i of toUpdate) {
                const div = divs[i];
                if (!div) continue;
                const wStr = gameState.words[i];
                let comp = null;
                if (i < idx) { comp = gameState.history[i]; }
                else if (i === idx) { comp = input; }
                renderWordDiv(div, wStr, comp, i === idx);
            }

            updateCaretPosition();
            updateScroll();
        }

        function updateCaretPosition() {
            const curDiv = els.wordsContainer.children[gameState.wordIndex];
            if (!curDiv) return;

            const input = gameState.inputVal;
            let caretX, caretY;
            caretY = curDiv.offsetTop;

            if (input.length === 0) {
                caretX = curDiv.offsetLeft;
            } else {
                const spans = Array.from(curDiv.querySelectorAll('span.letter'));
                const targetIndex = input.length - 1;
                
                if (spans[targetIndex]) {
                    const targetSpan = spans[targetIndex];
                    const spanRect = targetSpan.getBoundingClientRect();
                    const containerRect = els.wordsContainer.getBoundingClientRect();
                    caretX = (spanRect.left - containerRect.left) + spanRect.width;
                } else {
                    caretX = curDiv.offsetLeft + curDiv.offsetWidth;
                }
            }

            els.caret.style.transform = `translate(${caretX}px, ${caretY + 5}px)`;
        }

        function updateScroll() {
            const curDiv = els.wordsContainer.children[gameState.wordIndex];
            if (!curDiv) return;

            const lineHeight = 40;
            const wordTop = curDiv.offsetTop;
            const currentLine = Math.floor(wordTop / lineHeight);
            
            let scrollAmount = 0;
            if (currentLine >= 2) {
                scrollAmount = (currentLine - 1) * lineHeight;
            }
            
            els.scrollWrapper.style.transform = `translateY(-${scrollAmount}px)`;
        }

        function gameLoop() {
            if (!gameState.active) return;
            
            const now = getServerTime();
            const elapsed = (now - gameState.startTime) / 1000;
            const remaining = Math.max(0, Math.round(gameState.duration - elapsed));
            document.getElementById('timer').textContent = remaining;

            if (elapsed > 0) {
                const mins = elapsed / 60;
                const wpm = Math.round((gameState.stats.correctChars / 5) / mins);
                document.getElementById('live-wpm').textContent = wpm;
                
                gameState.stats.wpmSnapshots.push(wpm);
                
                const totalTyped = gameState.stats.totalChars;
                const acc = totalTyped === 0 ? 100 : Math.round(((totalTyped - gameState.stats.errors) / totalTyped) * 100);
                document.getElementById('live-acc').textContent = Math.max(0, acc) + '%';

                const progress = Math.round((gameState.wordIndex / gameState.words.length) * 100);

                if (ws && ws.readyState === WebSocket.OPEN) {
                    // Calculate Consistency LIVE
                    let liveCons = 0;
                    const snaps = gameState.stats.wpmSnapshots;
                    if (snaps.length >= 2) {
                        const mean = snaps.reduce((a, b) => a + b, 0) / snaps.length;
                        const squaredDiffs = snaps.map(val => Math.pow(val - mean, 2));
                        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / snaps.length;
                        const stdDev = Math.sqrt(variance);
                        const cv = mean > 0 ? (stdDev / mean) : 0;
                        liveCons = Math.max(0, Math.min(100, Math.round((1 - cv) * 100)));
                    }
                    ws.send(JSON.stringify({ 
                        type: 'PROGRESS_UPDATE', 
                        wpm: wpm, 
                        acc: Math.max(0, acc), 
                        progress: progress,
                        errors: gameState.stats.errors,
                        consistency: liveCons
                    }));
                }
            }
            
            if (remaining <= 0) {
                endGame();
            }
        }

        function endGame() {
            if (!gameState.active) return;
            
            gameState.active = false;
            clearInterval(gameState.timer);
            
            // Issue #3: cancel any existing reload timer before starting a new one
            if (gameState.reloadTimer) {
                clearInterval(gameState.reloadTimer);
                gameState.reloadTimer = null;
            }

            const elapsed = (getServerTime() - gameState.startTime) / 1000;
            const mins = elapsed / 60;
            
            const wpm = Math.round((gameState.stats.correctChars / 5) / mins);
            const rawWpm = Math.round((gameState.stats.totalChars / 5) / mins);
            
            const totalTyped = gameState.stats.totalChars;
            const acc = totalTyped === 0 ? 0 : Math.round(((totalTyped - gameState.stats.errors) / totalTyped) * 100);
            
            let consistency = 0;
            const snapshots = gameState.stats.wpmSnapshots;
            if (snapshots.length >= 2) {
                const mean = snapshots.reduce((a, b) => a + b, 0) / snapshots.length;
                const squaredDiffs = snapshots.map(val => Math.pow(val - mean, 2));
                const variance = squaredDiffs.reduce((a, b) => a + b, 0) / snapshots.length;
                const stdDev = Math.sqrt(variance);
                const coefficientOfVariation = mean > 0 ? (stdDev / mean) : 0;
                consistency = Math.max(0, Math.min(100, Math.round((1 - coefficientOfVariation) * 100)));
            }

            document.getElementById('res-wpm').textContent = wpm;
            document.getElementById('res-acc').textContent = Math.max(0, acc) + '%';
            document.getElementById('res-raw').textContent = rawWpm;
            document.getElementById('res-cons').textContent = consistency + '%';
            updateRoundBadge();
            _showRank();
            // Show reload section by default — GAME_OVER handler will hide if not last round
            const _rs = document.getElementById('reload-section');
            if (_rs) _rs.style.display = 'block';
            
            switchScreen('results-screen');
            
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'FINISH',
                    wpm: wpm,
                    accuracy: Math.max(0, acc),
                    raw: rawWpm,
                    errors: gameState.stats.errors,
                    consistency: consistency
                }));
            }

            // Issue #8: Only start reload countdown if this is the last round.
            // For multi-round flows the server GAME_OVER handler moves to waiting-screen.
            let secondsLeft = 20; 
            const bar = document.getElementById('reload-bar');
            const secondsDisplay = document.getElementById('reload-seconds');
            
            gameState.reloadTimer = setInterval(() => {
                secondsLeft--;
                if (secondsDisplay) secondsDisplay.textContent = secondsLeft;
                if (bar) bar.style.width = ((secondsLeft / 20) * 100) + '%';
                
                if (secondsLeft <= 0) { 
                    clearInterval(gameState.reloadTimer);
                    gameState.reloadTimer = null;
                    location.reload(); 
                }
            }, 1000);
        }

        function focusInput() {
            if (gameState.active) {
                els.input.value = gameState.inputVal;
                els.input.focus();
                els.overlay.classList.remove('active');
                els.caret.classList.add('active');
                els.caret.classList.remove('animate');
                setTimeout(updateUI, 10);
            }
        }
        
        els.input.onblur = () => { 
            if (gameState.active) { 
                els.overlay.classList.add('active'); 
                els.caret.classList.remove('active');
                els.caret.classList.add('animate');
            }
        };

        // Periodic time sync
        setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                const timeSinceSync = Date.now() - lastSyncTime;
                if (timeSinceSync > 30000) {
                    ws.send(JSON.stringify({ type: 'PING' }));
                }
            }
        }, 15000);