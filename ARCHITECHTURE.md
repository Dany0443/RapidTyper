# RapidTyper — Event Platform

A real-time multiplayer typing competition and spelling bee platform built for live school events. Runs across multiple school laptops connected over **Tailscale**, with phone cameras streaming live video to a presentation screen.

---

## Architecture Overview

```
Internet / Tailscale VPN
        │
        ▼
┌─────────────────────────┐
│     MainServer          │  Node.js · runs on the event organiser's laptop
│  :5889  WS game port    │  All players, hosts, presentation screens connect here
│  :5890  HTTP dev/health │  Proxies school traffic, routes WebRTC signalling
└────────────┬────────────┘
             │  Tailscale WS  (ws://100.x.x.x:5889)
    ┌────────┴────────┐
    │   SchoolServer  │  Node.js · runs on each school laptop
    │  :8080  HTTP    │  Serves game pages locally over LAN
    │  :8443  HTTPS   │  Camera stream page (getUserMedia needs HTTPS)
    │  :5889  WS      │  Local game clients + camera phones connect here
    │  :5890  WS      │  Raw MediaRecorder binary chunks (recording)
    └────────┬────────┘
             │  LAN Wi-Fi (school hotspot)
    ┌────────┴────────────────┐
    │  Player phones          │  Open  http://<school-ip>:8080/
    │  Camera phones          │  Open  https://<school-ip>:8443/stream
    │  Host laptop            │  Open  http://<main-ip>:5890/host
    │  Presentation screen    │  Open  http://<main-ip>:5890/presentation
    └─────────────────────────┘
```

---

## Pages

| Page | URL | Who opens it |
|------|-----|--------------|
| Player join | `http://<school-ip>:8080/` | Students on phones |
| Spelling bee | `http://<school-ip>:8080/spell` | Students on phones |
| Camera stream | `https://<school-ip>:8443/stream` | Camera phone operator |
| Host panel | `http://<main-ip>:5890/host` | Event organiser |
| Presentation | `http://<main-ip>:5890/presentation` | Screen connected to projector |

> **Note:** The stream page **must** be opened on HTTPS. The school server generates a self-signed certificate on first run. Phones will see "Not private" — tap **Advanced → Proceed** once per phone. After that it works normally.

---

## Environment Variables (`.env` at project root)

```env
# ── Main Server ──────────────────────────────────────────────────────────────
NODE_ENV=production
ADMIN_KEY=your_admin_key          # Host panel login key
STREAM_KEY=your_stream_key        # Camera phone auth key

# ── School Server ────────────────────────────────────────────────────────────
MAIN_SERVER_WS=ws://100.x.x.x:5889   # Tailscale IP of the main server
SCHOOL_ID=school-cluj-01              # Unique ID for this school node
LOCAL_PORT=5889                       # Game WS port
HTTP_PORT=8080                        # HTTP static files port
HTTPS_PORT=8443                       # HTTPS camera port
VIDEO_PORT=5890                       # Raw video chunk WS port
MAX_CAMS=8                            # Max simultaneous cameras

# ── Paths ────────────────────────────────────────────────────────────────────
RECORDINGS_DIR=./SchoolServer/recordings
CERT_DIR=./SchoolServer/certs
FFMPEG_PATH=ffmpeg                    # or full path: C:\ffmpeg\bin\ffmpeg.exe
STATIC_ROOT=./ClientWeb
```

---

## PM2 — Start Everything

```bash
# Production start (reads .env + env_production block)
pm2 start ecosystem.config.js --env production

# Save so it survives reboot
pm2 save
pm2 startup   # follow the printed instruction once

# Useful commands
pm2 status                    # see all processes
pm2 logs                      # tail all logs
pm2 logs main                 # main server only
pm2 logs school               # school server only
pm2 reload ecosystem.config.js --env production   # reload after code change
```

### Start individual servers manually (dev/debug)

```bash
# From MainServer/
node server.js

# From SchoolServer/
node school-server.js

# Dev mode (virtual cameras, no school needed)
DEV=true node server.js
```

---

## File Structure

```
RapidTyper/
├── ecosystem.config.js          # PM2 config — start everything from here
├── .env                         # All secrets and config (never commit this)
│
├── shared/
│   ├── config.js                # Loads .env, exports all config values
│   ├── logger.js                # Pretty colored logger with sections
│   ├── shared-static.js         # Static file middleware (shared by both servers)
│   └── config-endpoint.js       # /config.js auto WS URL detection for clients
│
├── MainServer/
│   ├── server.js                # Main game server — WS :5889, HTTP :5890
│   ├── logs/
│   │   ├── server.log
│   │   └── errors.log
│   └── db/
│       └── event.db             # SQLite — game state persistence across restarts
│
├── SchoolServer/
│   ├── school-server.js         # School node — proxies players, handles cameras
│   ├── certs/
│   │   ├── server.key           # Auto-generated TLS key (gitignore this)
│   │   └── server.crt           # Auto-generated TLS cert (gitignore this)
│   ├── recordings/              # Saved .webm and transcoded .mp4 files
│   └── logs/
│       ├── server.log
│       └── errors.log
│
└── ClientWeb/                   # All HTML/JS/CSS served to browsers
    ├── html/ (or pages/)
    │   ├── index.html           # Player join page
    │   ├── spell.html           # Spelling bee page
    │   ├── stream.html          # Camera phone page
    │   ├── host.html            # Host control panel
    │   └── presentation.html    # Projector screen
    ├── js/
    │   ├── stream.js            # Camera phone logic
    │   ├── host.js              # Host panel logic
    │   ├── host-cameras.js      # Camera grid UI (loaded after host.js)
    │   └── presentation.js      # Presentation screen logic
    └── css/
        └── stream.css           # Shared styles
```

---

## Game Modes

### Fast Typer (Race Mode)
Players type a given text as fast as possible. Progress shown as a real-time race on the presentation screen. Grades: `1-4`, `5-9`, `10-12`. Results show podium per grade category with CPM (characters per minute) and accuracy.

### Spelling Bee
Host presents a word, players submit their spelling. Host controls start/stop of each round. Submissions tracked live. Results scored by accuracy.

---

## Camera System

### How it works

1. Camera phone opens `https://<school-ip>:8443/stream`, enters the stream key
2. Phone authenticates via WebSocket on the game port
3. Phone starts streaming: `STREAM_START` message marks the camera as live
4. **Thumbnail**: phone captures a canvas frame every 2s and sends it as `CAM_THUMB` — host grid shows it immediately, no ffmpeg needed
5. **WebRTC preview**: host clicks 👁️ Preview → WebRTC peer connection opens directly to the phone → host sees live video
6. **Presentation feed**: host clicks 📺 Pe Ecran → server tells presentation to connect WebRTC to that camera → video appears as PiP or fullscreen
7. **Recording**: host clicks 🔴 Record → server tells phone to start `MediaRecorder` → binary chunks sent to school server on port 5890 → written to disk → transcoded to MP4 after stop

### Presentation camera layouts

| Cameras assigned | Layout |
|-----------------|--------|
| 1 | Bottom-right PiP, 320px wide |
| 2 | Bottom-right stacked PiPs, 240px each |
| 3–4 | Bottom-right column, 200px each |
| Any (Fullscreen mode) | Full-screen grid, 1–2 columns |

### Adding cameras from host

1. Open host panel → **Cameras** tab
2. Streaming cameras appear with thumbnail and buttons
3. **📺 Pe Ecran** — adds camera to all presentation screens (up to 4)
4. Click again to remove it
5. **⛶ Fullscreen** — switches all presentation screens to full-screen split
6. **👁️ Preview** — opens a local WebRTC preview in the host panel (does not affect presentation)
7. **🔴 Record / ⏹ Stop Rec** — starts/stops recording for that camera

---

## Recording

- Files saved to `SchoolServer/recordings/` as `.webm`
- After stop, server attempts to transcode to `.mp4` (H.264, fast preset, CRF 23)
- If re-encode fails, tries stream-copy as fallback
- If both fail, the `.webm` is kept (still playable in VLC, Chrome, Firefox)
- Download from host panel → Cameras tab → school node → **Recordings**

> **Why files were empty before:** `MediaRecorder` outputs an init segment as the very first chunk. If recording started *after* streaming had been running for a while, the first chunks were already discarded and the file had no container header → unreadable. Fixed by keeping a 20-chunk ring buffer per camera — recording always starts with the init segment.

---

## Announcements

Host can send a text announcement to all presentation screens at any time:

1. Host panel → type text in the announcement input → **Send**
2. Presentation: big yellow text slides up from the bottom (7vw font, full-width gradient)
3. After **7 seconds**: shrinks to a small ticker bar at the bottom
4. If **Persist** is checked: ticker stays until host clicks **Clear**
5. If not persisted: ticker fades out after 5 more seconds automatically

---

## WebRTC Signal Path

```
Camera phone (stream.js)
  │ STREAM_OFFER / STREAM_ICE
  ▼
SchoolServer (school-server.js)
  │ SCHOOL_STREAM_OFFER / SCHOOL_STREAM_ICE_FROM_CAM
  ▼
MainServer (server.js)  ←─ findViewerByViewerId(viewerId)
  │ STREAM_OFFER / STREAM_ICE_FROM_CAM
  ▼
Viewer (presentation.js or host-cameras.js)
  │ STREAM_ANSWER / STREAM_ICE
  ▼
MainServer (server.js)  ←─ reverse-lookup camKey from ws._viewerIds Map
  │ SCHOOL_STREAM_ANSWER / SCHOOL_STREAM_ICE
  ▼
SchoolServer
  │ STREAM_ANSWER / STREAM_ICE  (to camera phone)
  ▼
Camera phone  →  WebRTC connected  →  video flows peer-to-peer
```

Multi-cam: each camera assignment gets its own `viewerId`. The presentation WS stores all of them in `ws._viewerIds` (Map: camKey → viewerId). Routing uses viewerId, not the old single `_viewingCam` string.

---

## School Node Reconnect

If the school server loses connection to the main server:
- Exponential backoff: 1s → 1.8s → 3.2s … capped at 30s
- On reconnect: sends `SCHOOL_REGISTER` → waits 300ms → sends `SCHOOL_CAMERAS_UPDATE`
- Main server on re-register: **purges all stale VirtualClients and camera entries** for that school, then registers fresh
- If `SCHOOL_REGISTER_OK` not received in 5s: retries registration once
- Heartbeat: if main server is silent for 60s (ghost connection), school server terminates and forces reconnect

---

## Production Checklist

### Before the event

- [ ] Both laptops connected to the same Tailscale network
- [ ] `.env` set on both machines — especially `MAIN_SERVER_WS` on school server
- [ ] Run `pm2 start ecosystem.config.js --env production` on both
- [ ] Run `pm2 save` + `pm2 startup` on both
- [ ] Open `http://<main-ip>:5890/health` — should return `{"status":"ok"}`
- [ ] Open `http://<school-ip>:8080/health` — should return school status with `mainConnected: true`
- [ ] Test one camera phone: open `https://<school-ip>:8443/stream`, accept cert, enter stream key, tap Start
- [ ] Verify thumbnail appears in host panel → Cameras tab
- [ ] Test WebRTC preview from host
- [ ] Test presentation feed from host → presentation screen should show video
- [ ] Test recording: record 10s, stop, verify .mp4 appears in Recordings list and is playable
- [ ] Test announcement: type text in host → presentation shows it
- [ ] Test a full game round with at least 2 players

### Common issues

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| School not connected to main | Wrong `MAIN_SERVER_WS` in `.env` | Check Tailscale IP, confirm port 5889 open |
| Camera auth fails | Wrong `STREAM_KEY` | Make sure `.env` is the same on main and school |
| Camera page shows "need HTTPS" | Phone opened HTTP stream page | Open `https://` not `http://`, accept cert |
| Thumbnail never appears | Phone canvas capture not running | Check `stream.js` is latest version with `startThumbCapture()` |
| Presentation black box | WebRTC failed | Check browser console on presentation screen for ICE errors |
| Recording unreadable | Old school-server.js | Latest version has chunk ring-buffer fix |
| Transcode fails | ffmpeg not found or wrong codec | Check `FFMPEG_PATH`, `.webm` is still kept |
| PM2 not loading `.env` | PM2 started before `.env` created | `pm2 delete all`, then `pm2 start ecosystem.config.js --env production` |

---

## Logger — Console Sections

The logger uses colored section tags for fast scanning:

| Tag | Color | Meaning |
|-----|-------|---------|
| `[SYS ]` | White | Server startup, general info |
| `[GAME]` | Blue | Game state changes, phase transitions |
| `[CAM ]` | Magenta | Camera connect/stream/view events |
| `[SCHL]` | Yellow | School node registration/reconnect |
| `[NET ]` | Yellow | Network reconnect attempts, delays |
| `[REC ]` | Red | Recording start/stop/transcode |
| `[HTTP]` | Cyan | HTTP requests |
| `[WARN]` | Yellow | Warnings (non-fatal) |
| `[ERR!]` | Bright Red | Errors — check `errors.log` |

Type `status` in the server console for a live status block.
Type `debug-on` / `debug-off` to toggle verbose WS message logging (main server only).

---

## Dependencies

```json
{
  "ws": "WebSocket server and client",
  "sqlite3": "Game state persistence",
  "dotenv": "Environment variable loading"
}
```

**External:**
- **Node.js** ≥ 18
- **ffmpeg** — for recording transcode (optional; .webm is kept if missing)
- **PM2** — process manager (`npm install -g pm2`)
- **Tailscale** — VPN for school→main connection over internet

---

## Security Notes

- `ADMIN_KEY` and `STREAM_KEY` are the only auth tokens. Keep them out of version control.
- The self-signed TLS cert is fine for a closed event — phones just need to accept it once.
- No rate limiting on the admin login endpoint (low risk for an internal event).
- All game WS traffic is unencrypted on the school LAN (HTTP/WS, not HTTPS/WSS). For a public event, run everything behind a reverse proxy with real TLS.

---

*Last updated: 2026. Built for RapidTyper competitive typing events.*