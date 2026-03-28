# RapidTyper Architecture & Technical Deep Dive

This document outlines the internal architecture, networking flow, and data protocols for the RapidTyper platform.

---

## 1. System Architecture

The platform is split into three main operational scopes: a central game server, an optional local proxy server for school contest environments, and the client web interfaces.

```text
┌─────────────────────────────────────────────────────────┐
│                     INTERNET / TAILSCALE                │
└────────────────────────┬────────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │    MainServer       │
              │  server.js          │
              │  WS  :5889          │
              │  HTTP :5890 (dev)   │
              │  SQLite DB          │
              └──┬──────────────┬───┘
                 │              │
        ┌────────▼────┐  ┌──────▼────────┐
        │ SchoolServer│  │ Direct clients│
        │school-server│  │ (players,host,│
        │ Game WS:5889│  │ presentation) │
        │ HTTP   :8080│  └───────────────┘
        │ VideoWS:5890│
        └──────┬──────┘
               │ WiFi hotspot
        ┌──────▼──────────────────┐
        │   Phone browsers        │
        │  index.html  (player)   │
        │  spell.html  (speller)  │
        │  stream.html (camera)   │
        └─────────────────────────┘
```

### Component Breakdown
* **MainServer (`Server/server.js`):** The central hub hosted in the cloud or on a primary contest machine. It runs the game logic, manages the SQLite database (`event.db`), and acts as the WebRTC signaling hub.
* **SchoolServer (`SchoolServer/school-server.js`):** A proxy node running on a local school laptop. It multiplexes local WS connections to the MainServer, relays video chunks, writes video to disk, and serves static files to locally connected phones via a Wi-Fi hotspot.
* **ClientWeb:** Static HTML/CSS/JS files served either locally by the SchoolServer, or by an upstream reverse proxy (like Nginx) in production.

---

## 2. School Proxy Multiplexing

To prevent overwhelming the MainServer and to bypass local network restrictions, multiple phones share a single upstream WebSocket from the school laptop to the MainServer.

**The `_lcid` Routing Tag:**
Each local client connected to the `SchoolServer` gets a stable Local Client ID (`_lcid`). 
Every proxied message sent upstream is tagged with:
* `_schoolProxy: true`
* `_schoolId: "school-1"`
* `_lcid: "school-1::lc3"`

The MainServer creates a lightweight `VirtualClient` object per `_lcid`. Any replies intended for that client are tagged with the same `_lcid` and routed correctly back down the single WebSocket connection by the SchoolServer.

---

## 3. Camera & Recording Data Flow

The system transforms mobile phones into live broadcast cameras capable of both WebRTC low-latency streaming and high-quality server-side recording.

1.  **Auth & Stream Initialization:**
    * `stream.html` connects via WS `:5889` -> sends `STREAM_AUTH` -> receives `STREAM_AUTH_OK`.
    * Sends `STREAM_START` to announce live status to the host.
2.  **WebRTC (Live View):**
    * Signaling (`STREAM_OFFER`, `STREAM_ICE`) happens over the primary WS `:5889`.
    * Host assigns camera -> WebRTC peer connection established -> presentation PiP displays feed.
3.  **MediaRecorder (Saving to Disk):**
    * Host clicks "Record". `MainServer` tells `SchoolServer` to prepare a file.
    * `stream.html` opens a *second* WebSocket to `:5890` (Video WS).
    * `MediaRecorder` sends 1-second WebM/VP9 binary chunks over `:5890` to `SchoolServer`.
    * `SchoolServer` saves as `.webm`. Upon recording stop, an async `ffmpeg` process transcodes it to an H.265 `.mp4`.

---

## 4. Session Persistence & Dynamic Routing

### State Recovery
If a device momentarily drops off the Wi-Fi, it must reconnect without user intervention.
* **Player (`index.html`):** Saves `userId`, `username`, and `grade` to `localStorage` under the key `mt_session`.
* **Speller (`spell.html`):** Saves session data plus an active word draft (`mt_spell_draft_v2`) to survive accidental page refreshes.
* **Camera (`stream.html`):** Saves `stream key` and a stable `camId` (`rt_stream_session`) so the phone retains its identity in the host panel.

### WS URL Auto-Detection
`shared-static.js` intercepts static file requests and injects a script block before `</head>`. This sets `window.__WS_URL__` dynamically based on the requested host and port, ensuring zero configuration for clients joining local IP hotspots (e.g., `192.168.1.5:8080` automatically maps to `ws://192.168.1.5:5889`).

---

## 5. WebSocket Protocol Reference

All standard messages are JSON payloads. Binary frames on port `5890` are strictly reserved for video chunking.

### Client ➔ Server
| Type | Sender | Description |
|---|---|---|
| `JOIN` / `JOIN_SPELL` | Player/Speller | Join the lobby with credentials |
| `RECONNECT` | Player/Speller | Rejoin after a disconnect |
| `PROGRESS_UPDATE` | Player | Live CPM, accuracy, and progress % |
| `FINISH` | Player | Submit final race stats |
| `SPELL_SUBMIT_FULL` | Speller | Submit completed dictation words |
| `ADMIN_LOGIN` | Host | Authenticate using `ADMIN_KEY` |
| `START_REQUEST` / `NEXT_ROUND`| Host | Trigger race/round phases |
| `UPDATE_TEXT` | Host | Update competition or spell text |
| `STREAM_AUTH` | Camera | Authenticate using `STREAM_KEY` |
| `STREAM_START` / `STREAM_STOP`| Camera | Broadcast state toggle |
| `STREAM_OFFER` / `STREAM_ICE` | Camera | WebRTC signaling data |
| `PRESENTATION_JOIN` | Big Screen | Register as a viewer display |
| `RECORDING_START` / `STOP` | Host | Trigger remote recording |

### Server ➔ Client
| Type | Recipient | Description |
|---|---|---|
| `SYNC_STATE` | All | Initial application state on connect |
| `UPDATE_LOBBY` / `SPELLERS` | All | Roster updates and game state |
| `COUNTDOWN` | All | 3-2-1 tick |
| `START_GAME` / `SPELL_START` | Players/Spellers| Race/Dictation begins (includes text) |
| `GAME_OVER` / `SPELL_END` | All | Phase ended (includes rankings/diffs) |
| `MODE_CHANGED` | Players | Forces redirect to active game mode URL |
| `AUTH_SUCCESS` / `FAIL` | Host | Admin login response |
| `STREAM_AUTH_OK` / `FAIL` | Camera | Camera login response |
| `RECORDING_STARTED` / `STOPPED`| Camera | Triggers local `MediaRecorder` |
| `CAMERAS_UPDATE` | Host/Screen | Live camera roster updates |
| `CAM_THUMBNAIL` | Host | Base64 JPEG frame at ~2fps |
| `PRESENTATION_CAM_ASSIGNED` | Screen | Instructions to display WebRTC PiP |
