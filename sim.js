const WebSocket = require('ws');

// CONFIG
const SERVER_URL = 'ws://localhost:5889'; // Make sure this matches your server path (e.g. /ws if needed)
const BOT_COUNT = 50;
const UPDATE_INTERVAL_MS = 1000; // Bots send updates every 1 second

function createBot(id) {
    const ws = new WebSocket(SERVER_URL);
    
    // Assign a "skill level" to this bot
    const targetWpm = Math.floor(Math.random() * 90) + 30; // Random WPM between 30 and 120
    const accuracy = 90 + Math.floor(Math.random() * 10); // Random accuracy 90-100%
    
    let gameTimer = null;
    let charsTyped = 0;
    let textLength = 0;

    ws.on('open', () => {
        // console.log(`Bot ${id} connected.`);
        ws.send(JSON.stringify({
            type: 'JOIN',
            userId: `bot_${id}`,
            username: `Bot_${id}_[${targetWpm}WPM]`,
            grade: ['1-4', '5-9', '10-12'][id % 3],
            role: 'player'
        }));
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            if (msg.type === 'START_GAME') {
                console.log(`Bot ${id} received START_GAME. Racing at ${targetWpm} WPM...`);
                
                // Reset State
                textLength = msg.text.length;
                charsTyped = 0;
                
                // Calculate characters per second based on WPM
                // Formula: (WPM * 5 chars per word) / 60 seconds
                const charsPerSecond = (targetWpm * 5) / 60;

                // Start the "Typing" loop
                if (gameTimer) clearInterval(gameTimer);
                
gameTimer = setInterval(() => {
                    charsTyped += charsPerSecond * (UPDATE_INTERVAL_MS / 1000);
                    
                    // Calculate percentage
                    let progress = Math.min(100, Math.round((charsTyped / textLength) * 100));

                    // Send Progress Update to Server
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'PROGRESS_UPDATE',
                            wpm: targetWpm,
                            acc: accuracy,
                            progress: progress,
                            // FIX: Send these live so they appear even if the bot doesn't finish!
                            errors: Math.floor(Math.random() * 5), 
                            consistency: 80 + Math.floor(Math.random() * 20) 
                        }));
                    }

                    // Check if finished
                    if (progress >= 100) {
                        finishGame();
                    }

                }, UPDATE_INTERVAL_MS);
            }

            if (msg.type === 'GAME_OVER') {
                if (gameTimer) clearInterval(gameTimer);
            }

        } catch (e) {
            console.error(`Bot ${id} error parsing message`, e);
        }
    });

    function finishGame() {
        if (gameTimer) clearInterval(gameTimer);
        console.log(`Bot ${id} FINISHED!`);
        
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'FINISH',
                wpm: targetWpm,
                accuracy: accuracy,
                raw: targetWpm + 5, // Fake raw slightly higher
                errors: Math.floor(Math.random() * 5),
                consistency: 80 + Math.floor(Math.random() * 20)
            }));
        }
    }

    ws.on('error', (err) => {
        // Silence errors to keep console clean, or log them if you want to see drops
        // console.error(`Bot ${id} connection error:`, err.message);
    });
    
    ws.on('close', () => {
        if (gameTimer) clearInterval(gameTimer);
    });
}

// === RUN SIMULATION ===
console.log(`Spawning ${BOT_COUNT} bots...`);
for (let i = 0; i < BOT_COUNT; i++) {
    // Stagger connections slightly (every 50ms) to avoid instant server freeze on connect
    setTimeout(() => createBot(i), i * 50);
}