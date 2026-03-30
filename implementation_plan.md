# RapidTyper Codebase Restructuring & Scenario Optimization

This plan outlines the refactoring of RapidTyper to support multiple deployment scenarios (School, Development, Production) more cleanly, reduce code duplication, and improve configuration management.

## User Review Required

> [!IMPORTANT]
> This refactor involves moving files and changing how the applications are started. It will require updating any existing deployment scripts or manual startup procedures.
> 
> [!WARNING]
> The current "magic" patching of JS files in `shared-static.js` will be replaced with a more robust `/config.js` endpoint. This is a breaking change for the client-side loading sequence.

## Proposed Changes

The goal is to move from a "scattered" structure to a more unified and modular one.

### 1. Project Root & Shared Utilities

#### [NEW] [config.js](file:///c:/Users/Dan/Documents/RapidTyper/shared/config.js)
A central configuration module that loads `.env` variables and defines defaults. It supports different "profiles".

#### [NEW] [logger.js](file:///c:/Users/Dan/Documents/RapidTyper/shared/logger.js)
A shared logging utility to replace the duplicated logging logic in `server.js` and `school-server.js`.

---

### 2. Main Server Refactoring

#### [MODIFY] [server.js](file:///c:/Users/Dan/Documents/RapidTyper/Server/server.js)
- Import `shared/config.js` and `shared/logger.js`.
- Break down the 1400+ line file into modules (optional but recommended for long-term health).
- Add a GET `/config.js` endpoint to serve dynamic configuration to clients (WS URL, etc.).

---

### 3. School Server Refactoring

#### [MODIFY] [school-server.js](file:///c:/Users/Dan/Documents/RapidTyper/SchoolServer/school-server.js)
- Import `shared/config.js` and `shared/logger.js`.
- Align configuration keys with `MainServer`.
- Ensure it uses the same static file serving logic as `MainServer`.

---

### 4. Client-Side Changes

#### [MODIFY] [ClientWeb/index.html](file:///c:/Users/Dan/Documents/RapidTyper/ClientWeb/index.html) (and other HTML files)
- Add `<script src="/config.js"></script>` at the top to load dynamic config.
- Remove dependence on `shared-static.js` patching if possible.

#### [MODIFY] [shared-static.js](file:///c:/Users/Dan/Documents/RapidTyper/shared-static.js)
- Simplify or remove the JS patching logic in favor of the `/config.js` endpoint.

## Open Questions

- **Nginx/Caddy usage**: In production, `ARCHITECHTURE.md` says Nginx serves static files. Should we ensure the `/config.js` endpoint is still routed to the Node.js server, or generate a static file on startup?
- **FFMPEG installation**: The `SchoolServer` depends on `ffmpeg`. Should we add a check for its existence on startup with a helpful error message?

## Verification Plan

### Automated Tests
- I'll add a basic health check suite to verify that both `MainServer` and `SchoolServer` start and respond correctly in their respective modes.

### Manual Verification
- Simulation: Running `npm run dev` and then `node Server/sim.js` to see if bots connect and play.
- Browser test: Opening `http://localhost:5890` in the browser tool to verify the frontend loads and connects to the correct WS URL.
