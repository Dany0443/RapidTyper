# RapidTyper ⌨️🐝

A real-time competitive typing and spelling bee platform built for live school contests. Players join via their phones or laptops, race through texts, and watch live results on a big-screen presentation display. 

---

## Key Features

* **Dual Game Modes:** Switch seamlessly between Fast Typer (speed racing) and Spelling Bee (dictation).
* **Live Big Screen:** Real-time CPM, accuracy, race tracks, and podium results shown on a projector.
* **Phones as Cameras:** Turn any smartphone into a live broadcast camera with WebRTC streaming and server-side recording.
* **Host Control Panel:** Admin interface to manage rounds, update texts, kick players, and assign camera feeds.
* **Resilient Sessions:** Built-in auto-reconnect and session persistence so students survive spotty Wi-Fi.

---

## Quick Start (Dev Mode)

You can run the entire stack on a single machine to test it out without setting up the school proxy node.

1. Navigate to the `Server` directory.
2. Copy the example environment file: `cp .env.example .env`
3. Install the dependencies: `npm install`
4. Start the server: `node server.js`

**Access the platform in your browser:**

| Interface | Local URL |
|---|---|
| **Player Game** | `http://localhost:5890/` |
| **Spelling Bee** | `http://localhost:5890/spell` |
| **Host Panel** | `http://localhost:5890/host` |
| **Big Screen** | `http://localhost:5890/presentation` |
| **Camera Feed** | `http://localhost:5890/stream` |

---

## Architecture at a Glance

| Component | Role |
|---|---|
| **MainServer** | Node.js/WebSocket hub managing game logic, state, and the SQLite database. |
| **SchoolServer** | Optional local proxy for contest days to relay camera feeds and handle local video recording. |
| **ClientWeb** | Pure HTML/CSS/JS front-end interfaces for players, hosts, and presentation screens. |

*(For production deployment, multi-node setups, and WebSocket protocol details, see the advanced documentation).*
