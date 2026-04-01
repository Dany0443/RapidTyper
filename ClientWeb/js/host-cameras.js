/**
 * host-cameras.js
 * Camera routing UI for host.html — loaded after host.js.
 *
 * Changes in this version:
 *  • Thumbnail cache (thumbCache) — thumbnails survive grid re-renders
 *  • Multi-camera support — host can assign N cameras to presentation
 *  • HOST_ADD_CAM_TO_PRESENTATION / HOST_REMOVE_CAM_FROM_PRES message types
 *  • Fullscreen command button (HOST_PRESENTATION_FULLSCREEN)
 */

// ══════════════════════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════════════════════
const camState = {
    cameras         : [],   // { key, camId, schoolId, label, streaming, recording, bytesWritten, recFilename }
    nodes           : [],   // { schoolId, cameras, online, httpPort }
    assignments     : {},   // presId → { schoolId, camId, camKey }   (server state, single-cam compat)
    assignedCamKeys : new Set(), // camKeys currently assigned to presentation (multi-cam local state)
    hostPreviewPc   : null,
    hostPreviewKey  : null,
};

let isPresFullscreen = false;

// ── Thumbnail cache: survives renderCameraGrid() rebuilds ──────────────────
// Map<safeKey, dataURI>
const thumbCache = new Map();

function applyThumb(safeKey, src) {
    const img = document.getElementById('thumb-' + safeKey);
    if (!img) return;
    img.src          = src;
    img.style.display = 'block';
    img.onerror      = () => { img.style.display = 'none'; };
    const ph = document.getElementById('ph-' + safeKey);
    if (ph) ph.style.display = 'none';
}

// ══════════════════════════════════════════════════════════════════════════════
//  HOOK INTO host.js message handler
// ══════════════════════════════════════════════════════════════════════════════
const _origHandleMessage = window.handleMessage || (() => {});
window.handleMessage = function(data) {
    _origHandleMessage(data);
    handleCameraMessage(data);
};

function handleCameraMessage(data) {
    switch (data.type) {

        case 'CAMERAS_UPDATE':
            camState.cameras = data.cameras || [];
            renderCameraGrid();
            updateCamBadge();
            break;

        case 'SCHOOL_NODES_UPDATE':
            camState.nodes = data.nodes || [];
            renderSchoolNodes();
            updateCamBadge();
            break;

        case 'PRESENTATION_ASSIGNMENTS':
            camState.assignments = data.assignments || {};
            // Sync assignedCamKeys from server state (single-cam assignments)
            // Multi-cam assignments are tracked locally via assignedCamKeys
            renderPresAssignments();
            break;

        case 'RECORDING_STATE_CHANGED': {
            const cam = camState.cameras.find(c => c.key === data.camKey);
            if (cam) {
                cam.recording    = data.recording;
                cam.bytesWritten = data.bytesWritten || 0;
                cam.recFilename  = data.recFilename  || null;
                updateCamCardRecordingState(data.camKey, data.recording);
            }
            break;
        }

        // ── Thumbnail received ─────────────────────────────────────────────
        // data.jpeg is either:
        //   a full data URI (dev virtual cams: "data:image/svg+xml;...")
        //   raw base64 JPEG string (real school cameras)
        case 'CAM_THUMBNAIL': {
            if (!data.jpeg) break;
            const safeKey = (data.camKey || '').replace(/[^a-z0-9]/gi, '_');
            const src     = data.jpeg.startsWith('data:')
                ? data.jpeg
                : 'data:image/jpeg;base64,' + data.jpeg;

            // Always cache — so re-renders can re-apply
            thumbCache.set(safeKey, src);
            applyThumb(safeKey, src);
            break;
        }

        case 'FULL_STATE_SYNC':
        case 'AUTH_SUCCESS':
            if (data.cameras)    { camState.cameras = data.cameras;    renderCameraGrid();  }
            if (data.schoolNodes){ camState.nodes   = data.schoolNodes; renderSchoolNodes(); }
            if (data.assignments){ camState.assignments = data.assignments; renderPresAssignments(); }
            updateCamBadge();
            break;

        // WebRTC signaling for host live preview
        case 'STREAM_OFFER':
            if (camState.hostPreviewPc && data.camKey === camState.hostPreviewKey)
                answerPreviewOffer(data.sdp, data.viewerId);
            break;

        case 'STREAM_ICE_FROM_CAM':
            if (camState.hostPreviewPc && data.camKey === camState.hostPreviewKey)
                camState.hostPreviewPc.addIceCandidate(data.candidate).catch(() => {});
            break;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  TAB SWITCH EXTENSION
// ══════════════════════════════════════════════════════════════════════════════
const _origSwitchView = window.switchView;
window.switchView = function(viewName) {
    _origSwitchView(viewName);
    const camView = document.getElementById('view-cameras');
    const tabBtn  = document.getElementById('tab-cameras');
    if (camView) camView.style.display = viewName === 'cameras' ? 'block' : 'none';
    if (tabBtn)  tabBtn.classList.toggle('active', viewName === 'cameras');
    if (viewName === 'cameras') {
        renderCameraGrid();
        renderSchoolNodes();
        renderPresAssignments();
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  RENDER — SCHOOL NODES
// ══════════════════════════════════════════════════════════════════════════════
function renderSchoolNodes() {
    const el      = document.getElementById('school-nodes-list');
    const countEl = document.getElementById('nodes-count');
    if (!el) return;

    const online = camState.nodes.filter(n => n.online).length;
    if (countEl) countEl.textContent = `${online} online`;

    if (!camState.nodes.length) {
        el.innerHTML = '<div class="cam-empty-msg">No school nodes connected yet.</div>';
        return;
    }

    el.innerHTML = camState.nodes.map(n => `
        <div class="school-node-row">
            <div class="node-dot ${n.online ? 'online' : 'offline'}"></div>
            <div style="flex:1">
                <span class="text-sm font-bold">${esc(n.schoolId)}</span>
                <span class="ml-2 text-xs" style="color:var(--sub)">${n.cameras} camera${n.cameras !== 1 ? 's' : ''}</span>
            </div>
            <div class="text-xs" style="color:var(--sub)">:${n.httpPort || 8080}</div>
            <button class="cam-assign-btn" onclick="openRecordingsBrowser('${esc(n.schoolId)}','${n.httpPort || 8080}')">
                <i class="fa-solid fa-folder-open" style="margin-right:3px"></i>Recordings
            </button>
            <div class="status-pill ${n.online ? 'pill-green' : 'pill-gray'}">${n.online ? 'ONLINE' : 'OFFLINE'}</div>
        </div>
    `).join('');
}

// ══════════════════════════════════════════════════════════════════════════════
//  RENDER — CAMERA GRID
// ══════════════════════════════════════════════════════════════════════════════
function renderCameraGrid() {
    const el          = document.getElementById('cam-grid');
    const streamCount = document.getElementById('streaming-count');
    if (!el) return;

    const streaming = camState.cameras.filter(c => c.streaming).length;
    const recording = camState.cameras.filter(c => c.recording).length;
    if (streamCount) streamCount.textContent =
        `${streaming} streaming` + (recording ? ` · ${recording} recording` : '');

    if (!camState.cameras.length) {
        el.innerHTML = `
            <div class="cam-empty-msg" style="grid-column:1/-1">
                <i class="fa-solid fa-video-slash" style="font-size:2.5rem;display:block;margin-bottom:0.75rem;opacity:0.3"></i>
                No cameras connected yet. Phones open stream.html on the school server.
            </div>`;
        return;
    }

    el.innerHTML = camState.cameras.map(cam => {
        const safeKey    = cam.key.replace(/[^a-z0-9]/gi, '_');
        const isAssigned = camState.assignedCamKeys.has(cam.key);
        const sizeMB     = cam.bytesWritten ? (cam.bytesWritten / 1024 / 1024).toFixed(1) : '0';

        return `
        <div class="cam-card ${cam.streaming ? 'streaming' : ''} ${isAssigned ? 'assigned' : ''} ${cam.recording ? 'recording-active' : ''}"
             id="camcard-${safeKey}">

            ${cam.streaming ? `
                <!-- Thumbnail: hidden until first frame arrives; cache re-applies it -->
                <img  id="thumb-${safeKey}"
                      class="cam-thumb"
                      src=""
                      alt="${esc(cam.label || cam.camId)}"
                      style="display:none"
                      draggable="false">
                <div  id="ph-${safeKey}" class="cam-thumb-placeholder">
                    <i class="fa-solid fa-circle-notch fa-spin" style="font-size:1.5rem"></i>
                </div>
            ` : `
                <div class="cam-thumb-placeholder">
                    <i class="fa-solid fa-video-slash"></i>
                </div>
            `}

            ${cam.recording ? `
                <div class="cam-rec-badge">
                    <span class="rec-dot"></span> REC ${sizeMB}MB
                </div>
            ` : ''}

            <div class="cam-footer">
                <div class="${cam.streaming ? 'cam-live-dot' : 'cam-offline-dot'}"></div>
                <div class="cam-info">
                    <div class="cam-name">${esc(cam.label || cam.camId)}</div>
                    <div class="cam-school">${esc(cam.schoolId)}</div>
                </div>

                ${cam.streaming ? `
                <div class="cam-actions">
                    <button id="assign-btn-${safeKey}"
                            class="cam-assign-btn ${isAssigned ? 'active-assign' : ''}"
                            onclick="toggleAssignCam('${esc(cam.schoolId)}','${esc(cam.camId)}','${esc(cam.key)}','${safeKey}')">
                        ${isAssigned ? '✓ Pe Ecran' : '📺 Pe Ecran'}
                    </button>
                    ${cam.recording ? `
                        <button id="rec-btn-${safeKey}"
                                class="cam-assign-btn rec-stop-btn"
                                onclick="stopCamRecording('${esc(cam.schoolId)}','${esc(cam.camId)}')">
                            ⏹ Stop Rec
                        </button>
                    ` : `
                        <button id="rec-btn-${safeKey}"
                                class="cam-assign-btn rec-start-btn"
                                onclick="startCamRecording('${esc(cam.schoolId)}','${esc(cam.camId)}')">
                            🔴 Record
                        </button>
                    `}
                    <button class="cam-assign-btn"
                            onclick="openHostPreview('${esc(cam.schoolId)}','${esc(cam.camId)}','${esc(cam.key)}')">
                        👁️ Preview
                    </button>
                </div>
                ` : `<span class="text-xs" style="color:var(--sub)">offline</span>`}
            </div>
        </div>`;
    }).join('');

    // ── Re-apply cached thumbnails after DOM rebuild ───────────────────────
    for (const [safeKey, src] of thumbCache) {
        applyThumb(safeKey, src);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  RENDER — PRESENTATION ASSIGNMENTS
// ══════════════════════════════════════════════════════════════════════════════
function renderPresAssignments() {
    const el      = document.getElementById('pres-assignments-list');
    const countEl = document.getElementById('pres-count');
    if (!el) return;

    const assignedCount = camState.assignedCamKeys.size;
    const presCount     = Object.keys(camState.assignments).length;
    if (countEl) countEl.textContent =
        `${presCount} screen${presCount !== 1 ? 's' : ''} · ${assignedCount} cam${assignedCount !== 1 ? 's' : ''} on air`;

    const keys = Object.keys(camState.assignments);

    // Fullscreen control row (always show if any presentation is connected)
    const fsRow = `
        <div class="pres-row" style="justify-content:space-between;margin-bottom:0.5rem">
            <div class="text-xs font-bold" style="color:var(--sub)">PRESENTATION CONTROLS</div>
            <button id="fullscreen-toggle-btn"
                    class="cam-assign-btn ${isPresFullscreen ? 'active-assign' : ''}"
                    onclick="togglePresFullscreen()">
                ${isPresFullscreen ? '⛶ Exit Fullscreen' : '⛶ Fullscreen'}
            </button>
        </div>`;

    if (!keys.length && assignedCount === 0) {
        el.innerHTML = fsRow + '<div class="cam-empty-msg">No presentation screens connected.</div>';
        return;
    }

    const presRows = keys.map(presId => {
        const a = camState.assignments[presId];
        return `
        <div class="pres-row">
            <i class="fa-solid fa-display" style="color:var(--main);font-size:0.8rem"></i>
            <div class="text-xs font-bold" style="flex:1">${esc(presId)}</div>
            ${a
                ? `<div class="text-xs" style="color:var(--sub)">${esc(a.schoolId)} · <span style="color:var(--main)">${esc(a.camId)}</span></div>
                   <button class="cam-assign-btn" onclick="unassignPresentation('${esc(presId)}')">✕ Detach</button>`
                : `<div class="text-xs" style="color:var(--sub)">no camera</div>`
            }
        </div>`;
    }).join('');

    // Show assigned cam keys (multi-cam list)
    const camList = assignedCount > 0
        ? `<div class="pres-row" style="flex-wrap:wrap;gap:0.35rem">
               <div class="text-xs font-bold" style="color:var(--sub);width:100%;margin-bottom:0.2rem">
                   CAMS ON AIR (${assignedCount})
               </div>
               ${[...camState.assignedCamKeys].map(k => {
                   const cam = camState.cameras.find(c => c.key === k);
                   const lbl = cam ? esc(cam.label || cam.camId) : esc(k);
                   return `<span class="status-pill pill-green" style="cursor:pointer"
                                 onclick="removeAssignedCam('${esc(k)}')"
                                 title="Click to remove from presentation">
                               📺 ${lbl} ✕
                           </span>`;
               }).join('')}
           </div>`
        : '';

    el.innerHTML = fsRow + camList + presRows;
}

// ══════════════════════════════════════════════════════════════════════════════
//  BADGE
// ══════════════════════════════════════════════════════════════════════════════
function updateCamBadge() {
    const b = document.getElementById('cam-count-badge');
    if (b) b.textContent = camState.cameras.length;
}

// ══════════════════════════════════════════════════════════════════════════════
//  MULTI-CAM ASSIGNMENT
// ══════════════════════════════════════════════════════════════════════════════

/**
 * toggleAssignCam — adds or removes a camera from the live presentation feed.
 *   Uses new HOST_ADD_CAM_TO_PRESENTATION / HOST_REMOVE_CAM_FROM_PRES messages.
 *   Server must handle these (see server-patch.js).
 */
function toggleAssignCam(schoolId, camId, camKey, safeKey) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (camState.assignedCamKeys.has(camKey)) {
        // Remove from presentation
        ws.send(JSON.stringify({ type: 'HOST_REMOVE_CAM_FROM_PRES', camKey, schoolId, camId }));
        camState.assignedCamKeys.delete(camKey);
        hostToast(`Camera ${camId} removed from presentation`);
    } else {
        // Add to presentation
        ws.send(JSON.stringify({ type: 'HOST_ADD_CAM_TO_PRESENTATION', schoolId, camId, camKey }));
        camState.assignedCamKeys.add(camKey);
        hostToast(`Camera ${camId} → presentation (${camState.assignedCamKeys.size} total)`);
    }

    // Update the button immediately (optimistic)
    const btn = document.getElementById('assign-btn-' + safeKey);
    const isNowAssigned = camState.assignedCamKeys.has(camKey);
    if (btn) {
        btn.classList.toggle('active-assign', isNowAssigned);
        btn.textContent = isNowAssigned ? '✓ Pe Ecran' : '📺 Pe Ecran';
    }
    const card = document.getElementById('camcard-' + safeKey);
    if (card) card.classList.toggle('assigned', isNowAssigned);

    renderPresAssignments();
}

function removeAssignedCam(camKey) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const cam = camState.cameras.find(c => c.key === camKey);
    const camId    = cam?.camId    || camKey.split('::')[1] || camKey;
    const schoolId = cam?.schoolId || camKey.split('::')[0] || '';
    ws.send(JSON.stringify({ type: 'HOST_REMOVE_CAM_FROM_PRES', camKey, schoolId, camId }));
    camState.assignedCamKeys.delete(camKey);
    hostToast(`Camera ${camId} removed`);
    renderCameraGrid();
    renderPresAssignments();
}

function unassignPresentation(presId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'HOST_UNASSIGN_PRESENTATION', presId }));
    delete camState.assignments[presId];
    renderPresAssignments();
}

// ══════════════════════════════════════════════════════════════════════════════
//  FULLSCREEN COMMAND
// ══════════════════════════════════════════════════════════════════════════════
function togglePresFullscreen() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    isPresFullscreen = !isPresFullscreen;
    ws.send(JSON.stringify({ type: 'HOST_PRESENTATION_FULLSCREEN', enabled: isPresFullscreen }));
    hostToast(isPresFullscreen ? '⛶ Presentation → Fullscreen' : '⛶ Presentation → PiP');

    const btn = document.getElementById('fullscreen-toggle-btn');
    if (btn) {
        btn.classList.toggle('active-assign', isPresFullscreen);
        btn.textContent = isPresFullscreen ? '⛶ Exit Fullscreen' : '⛶ Fullscreen';
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  RECORDING CONTROLS
// ══════════════════════════════════════════════════════════════════════════════
function startCamRecording(schoolId, camId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'RECORDING_START', schoolId, camId }));
    hostToast(`🔴 Recording started: ${camId}`);
    const cam = camState.cameras.find(c => c.camId === camId && c.schoolId === schoolId);
    if (cam) { cam.recording = true; renderCameraGrid(); }
}

function stopCamRecording(schoolId, camId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'RECORDING_STOP', schoolId, camId }));
    hostToast(`⏹ Recording stopped: ${camId}`);
    const cam = camState.cameras.find(c => c.camId === camId && c.schoolId === schoolId);
    if (cam) { cam.recording = false; renderCameraGrid(); }
}

function updateCamCardRecordingState(camKey, recording) {
    const safeKey = camKey.replace(/[^a-z0-9]/gi, '_');
    const card    = document.getElementById('camcard-' + safeKey);
    if (!card) return;
    card.classList.toggle('recording-active', recording);
    const btn = document.getElementById('rec-btn-' + safeKey);
    if (!btn) return;
    const [schoolId, camId] = camKey.split('::');
    if (recording) {
        btn.className   = 'cam-assign-btn rec-stop-btn';
        btn.textContent = '⏹ Stop Rec';
        btn.setAttribute('onclick', `stopCamRecording('${esc(schoolId)}','${esc(camId)}')`);
    } else {
        btn.className   = 'cam-assign-btn rec-start-btn';
        btn.textContent = '🔴 Record';
        btn.setAttribute('onclick', `startCamRecording('${esc(schoolId)}','${esc(camId)}')`);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  RECORDINGS BROWSER MODAL
// ══════════════════════════════════════════════════════════════════════════════
let _recBrowserSchoolId = null;
let _recBrowserHttpPort = 8080;

function openRecordingsBrowser(schoolId, httpPort) {
    _recBrowserSchoolId = schoolId;
    _recBrowserHttpPort = httpPort;

    let modal = document.getElementById('rec-browser-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id        = 'rec-browser-modal';
        modal.className = 'cam-modal-overlay';
        modal.innerHTML = `
            <div class="cam-modal">
                <div class="cam-modal-header">
                    <div class="font-bold" id="rec-modal-title">Recordings</div>
                    <div class="flex gap-2">
                        <button class="cam-assign-btn" onclick="refreshRecordingsList()">
                            <i class="fa-solid fa-rotate-right"></i> Refresh
                        </button>
                        <button class="cam-assign-btn" onclick="closeRecordingsBrowser()">✕ Close</button>
                    </div>
                </div>
                <div id="rec-list-body" style="overflow-y:auto;max-height:480px;padding:0.5rem">
                    <div class="cam-empty-msg">Loading...</div>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }

    modal.style.display = 'flex';
    document.getElementById('rec-modal-title').textContent = `Recordings — ${schoolId}`;
    refreshRecordingsList();
}

function refreshRecordingsList() {
    const el = document.getElementById('rec-list-body');
    if (!el) return;
    el.innerHTML = '<div class="cam-empty-msg">Loading...</div>';

    const schoolHttpUrl = getSchoolHttpUrl(_recBrowserHttpPort);

    fetch(`${schoolHttpUrl}/recordings`)
        .then(r => r.json())
        .then(items => {
            if (!items.length) {
                el.innerHTML = '<div class="cam-empty-msg">No recordings yet.</div>';
                return;
            }
            el.innerHTML = items.map(item => {
                const isMp4 = item.name.endsWith('.mp4');
                return `
                <div class="rec-row">
                    <i class="fa-solid ${isMp4 ? 'fa-film' : 'fa-video'}" style="color:${isMp4 ? '#22c55e' : 'var(--sub)'}"></i>
                    <div style="flex:1;min-width:0">
                        <div class="text-xs font-bold" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.name)}</div>
                        <div class="text-xs" style="color:var(--sub)">${item.sizeMB} MB · ${new Date(item.mtime).toLocaleString()}</div>
                    </div>
                    <a href="${schoolHttpUrl}/recordings/${encodeURIComponent(item.name)}"
                       download="${item.name}"
                       class="cam-assign-btn"
                       style="text-decoration:none">
                        <i class="fa-solid fa-download" style="margin-right:3px"></i>Download
                    </a>
                </div>`;
            }).join('');
        })
        .catch(() => {
            el.innerHTML = `<div class="cam-empty-msg" style="color:var(--error)">
                Could not reach school server.<br>
                <span style="font-size:0.7rem">Try: ${getSchoolHttpUrl(_recBrowserHttpPort)}/recordings</span>
            </div>`;
        });
}

function closeRecordingsBrowser() {
    const modal = document.getElementById('rec-browser-modal');
    if (modal) modal.style.display = 'none';
}

function getSchoolHttpUrl(httpPort) {
    const base = location.protocol + '//' + location.hostname;
    return `${base}:${httpPort}`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  HOST LIVE PREVIEW  (WebRTC — single cam modal, unchanged)
// ══════════════════════════════════════════════════════════════════════════════
function openHostPreview(schoolId, camId, camKey) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    closeHostPreview();

    camState.hostPreviewKey = camKey;

    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302'  },
            { urls: 'stun:stun1.l.google.com:19302' },
        ],
    });
    camState.hostPreviewPc = pc;

    pc.ontrack = e => {
        const vid = document.getElementById('host-preview-video');
        if (vid && e.streams[0]) { vid.srcObject = e.streams[0]; }
    };

    pc.onicecandidate = e => {
        if (e.candidate && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'STREAM_ICE', candidate: e.candidate }));
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')
            closeHostPreview();
    };

    ws.send(JSON.stringify({ type: 'HOST_VIEW_CAM', schoolId, camId, camKey }));

    let modal = document.getElementById('host-preview-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id        = 'host-preview-modal';
        modal.className = 'cam-modal-overlay';
        modal.innerHTML = `
            <div class="cam-modal">
                <div class="cam-modal-header">
                    <div class="font-bold" id="preview-modal-title">Camera Preview</div>
                    <button class="cam-assign-btn" onclick="closeHostPreview()">✕ Close</button>
                </div>
                <video id="host-preview-video" autoplay muted playsinline
                       style="width:100%;border-radius:8px;background:#000;aspect-ratio:16/9;display:block"></video>
                <div id="preview-status" class="text-xs mt-2" style="color:var(--sub);text-align:center">Connecting...</div>
            </div>`;
        document.body.appendChild(modal);
    }

    modal.style.display = 'flex';
    document.getElementById('preview-modal-title').textContent = `${camId} (${schoolId})`;

    pc.addEventListener('connectionstatechange', () => {
        const s = document.getElementById('preview-status');
        if (s) s.textContent = pc.connectionState;
    });
}

async function answerPreviewOffer(sdp, viewerId) {
    const pc = camState.hostPreviewPc;
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'STREAM_ANSWER', sdp: answer.sdp, viewerId }));
}

function closeHostPreview() {
    if (camState.hostPreviewPc) {
        try { camState.hostPreviewPc.close(); } catch (_) {}
        camState.hostPreviewPc  = null;
        camState.hostPreviewKey = null;
    }
    const modal = document.getElementById('host-preview-modal');
    if (modal) modal.style.display = 'none';
    const vid = document.getElementById('host-preview-video');
    if (vid) vid.srcObject = null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  TOAST
// ══════════════════════════════════════════════════════════════════════════════
let _toastTimer = null;
function hostToast(msg) {
    let t = document.getElementById('_host_cam_toast');
    if (!t) {
        t    = document.createElement('div');
        t.id = '_host_cam_toast';
        t.style.cssText = [
            'position:fixed', 'bottom:1.5rem', 'left:50%',
            'transform:translateX(-50%)',
            'background:rgba(226,183,20,0.92)', 'color:#323437',
            'font:700 0.78rem/1.4 Roboto Mono,monospace',
            'padding:0.5rem 1.25rem', 'border-radius:6px',
            'z-index:10000', 'transition:opacity 0.3s',
            'pointer-events:none', 'white-space:nowrap',
        ].join(';');
        document.body.appendChild(t);
    }
    t.textContent   = msg;
    t.style.opacity = '1';
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2800);
}

// ══════════════════════════════════════════════════════════════════════════════
//  INLINE STYLES
// ══════════════════════════════════════════════════════════════════════════════
(function injectStyles() {
    const s = document.createElement('style');
    s.textContent = `
        /* ── Camera grid ── */
        .cam-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:0.85rem; }
        .cam-empty-msg { text-align:center; padding:2rem 1rem; color:var(--sub); font-size:0.8rem; }

        /* ── Camera card ── */
        .cam-card {
            background:var(--card); border-radius:10px;
            border:2px solid rgba(255,255,255,0.06);
            overflow:hidden; transition:border-color 0.2s; position:relative;
        }
        .cam-card.streaming      { border-color:#22c55e55; }
        .cam-card.assigned       { border-color:var(--main); box-shadow:0 0 12px rgba(226,183,20,0.15); }
        .cam-card.recording-active { border-color:#ca4754; }

        /* ── Thumbnail ── */
        .cam-thumb {
            width:100%; aspect-ratio:16/9; object-fit:cover;
            display:block; background:#111;
        }
        .cam-thumb-placeholder {
            width:100%; aspect-ratio:16/9; background:#1a1b1d;
            display:flex; align-items:center; justify-content:center;
            color:var(--sub); font-size:2rem;
        }

        /* ── Recording badge overlay ── */
        .cam-rec-badge {
            position:absolute; top:6px; left:8px;
            background:rgba(202,71,84,0.85); color:#fff;
            font:700 0.6rem Roboto Mono,monospace; letter-spacing:0.08em;
            padding:2px 8px; border-radius:4px;
            display:flex; align-items:center; gap:5px;
        }
        .rec-dot {
            width:6px; height:6px; border-radius:50%; background:#fff;
            animation:recblink 1s ease-in-out infinite;
        }
        @keyframes recblink { 0%,100%{opacity:1} 50%{opacity:0.2} }

        /* ── Card footer ── */
        .cam-footer { padding:0.55rem 0.7rem; display:flex; align-items:center; gap:0.5rem; }
        .cam-live-dot    { width:7px; height:7px; border-radius:50%; background:#22c55e; animation:recblink 1.2s infinite; flex-shrink:0; }
        .cam-offline-dot { width:7px; height:7px; border-radius:50%; background:var(--sub); flex-shrink:0; }
        .cam-info  { flex:1; min-width:0; }
        .cam-name  { font-size:0.78rem; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .cam-school{ font-size:0.6rem; color:var(--sub); letter-spacing:0.05em; }
        .cam-actions { display:flex; flex-direction:column; gap:3px; align-items:flex-end; }

        /* ── Buttons (camera panel) ── */
        .cam-assign-btn {
            padding:0.22rem 0.55rem; border-radius:5px;
            border:1px solid var(--sub); background:transparent; color:var(--sub);
            font:700 0.63rem Roboto Mono,monospace; cursor:pointer;
            transition:all 0.15s; white-space:nowrap;
        }
        .cam-assign-btn:hover { border-color:var(--text); color:var(--text); }
        .cam-assign-btn.active-assign { border-color:var(--main); color:var(--bg); background:var(--main); }
        .cam-assign-btn.rec-start-btn { border-color:#ca4754; color:#ca4754; }
        .cam-assign-btn.rec-start-btn:hover { background:#ca4754; color:#fff; }
        .cam-assign-btn.rec-stop-btn  { border-color:#ca4754; color:#fff; background:#ca4754; }

        /* ── School node row ── */
        .school-node-row {
            display:flex; align-items:center; gap:0.6rem; padding:0.5rem 0.75rem;
            border-radius:7px; background:rgba(255,255,255,0.02);
            border:1px solid rgba(255,255,255,0.04); margin-bottom:0.4rem;
        }
        .node-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
        .node-dot.online  { background:#22c55e; box-shadow:0 0 5px #22c55e; }
        .node-dot.offline { background:var(--sub); }

        /* ── Presentation row ── */
        .pres-row {
            display:flex; align-items:center; gap:0.6rem; padding:0.45rem 0.7rem;
            border-radius:7px; background:rgba(255,255,255,0.02);
            border:1px solid rgba(255,255,255,0.04); margin-bottom:0.35rem;
        }

        /* ── Recordings row ── */
        .rec-row {
            display:flex; align-items:center; gap:0.75rem; padding:0.6rem 0.5rem;
            border-bottom:1px solid rgba(255,255,255,0.05);
        }
        .rec-row:last-child { border-bottom:none; }

        /* ── Modals ── */
        .cam-modal-overlay {
            display:none; position:fixed; inset:0;
            background:rgba(0,0,0,0.85); z-index:1000;
            align-items:center; justify-content:center;
        }
        .cam-modal {
            background:var(--card); border-radius:12px; padding:1.25rem;
            max-width:700px; width:94vw; max-height:90vh; overflow-y:auto;
            border:1px solid rgba(255,255,255,0.08);
        }
        .cam-modal-header {
            display:flex; justify-content:space-between; align-items:center;
            margin-bottom:0.85rem; padding-bottom:0.75rem;
            border-bottom:1px solid rgba(255,255,255,0.07);
        }
    `;
    document.head.appendChild(s);
})();

// ══════════════════════════════════════════════════════════════════════════════
//  UTIL
// ══════════════════════════════════════════════════════════════════════════════
function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}