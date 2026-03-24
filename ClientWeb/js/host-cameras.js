/**
 * host-cameras.js
 * Camera routing, school node display, and presentation assignment UI.
 * This is loaded AFTER host.js on host.html.
 *
 * It piggybacks on the existing `ws` variable from host.js.
 * It also extends the `handleMessage` function by chaining.
 */

// ── State ──────────────────────────────────────────────────────────────────
const camState = {
    cameras: [],        // { key, camId, schoolId, label, streaming }
    nodes: [],          // { schoolId, cameras, online, httpPort }
    presentations: [],  // { wsId, schoolId?, camId? }
    assignments: {},    // wsId → { schoolId, camId, camKey }
    hostPreviewPc: null,
    hostPreviewCamKey: null,
};

// ── Hook into host.js message handler ─────────────────────────────────────
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
            updateCamBadges();
            break;

        case 'SCHOOL_NODES_UPDATE':
            camState.nodes = data.nodes || [];
            renderSchoolNodes();
            updateCamBadges();
            break;

        case 'PRESENTATION_ASSIGNMENTS':
            camState.assignments = data.assignments || {};
            renderPresAssignments();
            break;

        case 'CAM_THUMBNAIL': {
            // Update thumbnail in grid
            const img = document.getElementById('thumb-' + data.camKey?.replace(/[^a-z0-9]/gi,'_'));
            if (img && data.jpeg) {
                img.src = 'data:image/jpeg;base64,' + data.jpeg;
            }
            break;
        }

        case 'FULL_STATE_SYNC':
        case 'AUTH_SUCCESS': {
            // If server sends cameras/nodes on initial sync
            if (data.cameras) { camState.cameras = data.cameras; renderCameraGrid(); }
            if (data.schoolNodes) { camState.nodes = data.schoolNodes; renderSchoolNodes(); }
            updateCamBadges();
            break;
        }

        // WebRTC signaling for host preview
        case 'STREAM_OFFER': {
            if (camState.hostPreviewPc && data.camKey === camState.hostPreviewCamKey) {
                handlePreviewOffer(data.sdp);
            }
            break;
        }
        case 'STREAM_ICE_FROM_CAM': {
            if (camState.hostPreviewPc && data.camKey === camState.hostPreviewCamKey) {
                camState.hostPreviewPc.addIceCandidate(data.candidate).catch(() => {});
            }
            break;
        }
    }
}

// ── Tab switch extension ───────────────────────────────────────────────────
const _origSwitchView = window.switchView;
window.switchView = function(viewName) {
    _origSwitchView(viewName);
    // Also handle cameras tab
    const camView = document.getElementById('view-cameras');
    if (camView) camView.style.display = viewName === 'cameras' ? 'block' : 'none';

    const tabBtn = document.getElementById('tab-cameras');
    if (tabBtn) tabBtn.classList.toggle('active', viewName === 'cameras');

    if (viewName === 'cameras') {
        renderCameraGrid();
        renderSchoolNodes();
        renderPresAssignments();
    }
};

// ── Render School Nodes ───────────────────────────────────────────────────
function renderSchoolNodes() {
    const el = document.getElementById('school-nodes-list');
    const countEl = document.getElementById('nodes-count');
    if (!el) return;

    const online = camState.nodes.filter(n => n.online).length;
    if (countEl) countEl.textContent = online + ' online';

    if (!camState.nodes.length) {
        el.innerHTML = '<div class="text-xs text-center py-3" style="color:var(--sub)">No school nodes connected yet.</div>';
        return;
    }

    el.innerHTML = camState.nodes.map(node => `
        <div class="school-node-row">
            <div class="node-dot ${node.online ? 'online' : 'offline'}"></div>
            <div style="flex:1">
                <div class="text-sm font-bold">${esc(node.schoolId)}</div>
                <div class="text-xs" style="color:var(--sub)">${node.cameras} cameras</div>
            </div>
            <div class="text-xs px-2 py-0.5 rounded" style="background:rgba(255,255,255,0.05);color:var(--sub)">
                :${node.httpPort || '8080'}
            </div>
            <div class="status-pill ${node.online ? 'pill-green' : 'pill-gray'}">
                ${node.online ? 'ONLINE' : 'OFFLINE'}
            </div>
        </div>
    `).join('');
}

// ── Render Camera Grid ─────────────────────────────────────────────────────
function renderCameraGrid() {
    const el = document.getElementById('cam-grid');
    const streamCount = document.getElementById('streaming-count');
    if (!el) return;

    const streaming = camState.cameras.filter(c => c.streaming).length;
    if (streamCount) streamCount.textContent = streaming + ' streaming';

    if (!camState.cameras.length) {
        el.innerHTML = `
            <div class="text-center py-16" style="color:var(--sub);grid-column:1/-1">
                <i class="fa-solid fa-video-slash text-4xl block mb-3 opacity-30"></i>
                <div>No cameras connected yet.</div>
                <div class="text-xs mt-2">Phones connect to stream.html on the school server.</div>
            </div>`;
        return;
    }

    el.innerHTML = camState.cameras.map(cam => {
        const safeKey = cam.key.replace(/[^a-z0-9]/gi, '_');
        const isAssigned = Object.values(camState.assignments).some(a => a.camKey === cam.key);
        return `
        <div class="cam-card ${cam.streaming ? 'streaming' : ''} ${isAssigned ? 'assigned' : ''}" id="camcard-${safeKey}">
            ${cam.streaming
                ? `<img class="cam-thumb" id="thumb-${safeKey}" src="" alt="cam" onerror="this.style.display='none'">`
                : `<div class="cam-thumb-placeholder"><i class="fa-solid fa-video-slash"></i></div>`
            }
            <div class="cam-footer">
                <div class="${cam.streaming ? 'cam-live-dot' : 'cam-offline-dot'}"></div>
                <div style="flex:1;min-width:0">
                    <div class="cam-name">${esc(cam.label || cam.camId)}</div>
                    <div class="cam-school">${esc(cam.schoolId)}</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-end">
                    ${cam.streaming ? `
                    <button class="cam-assign-btn ${isAssigned ? 'active-assign' : ''}"
                            onclick="assignCamToPresentation('${esc(cam.schoolId)}','${esc(cam.camId)}','${esc(cam.key)}',this)">
                        📺 Prezentare
                    </button>
                    <button class="cam-assign-btn"
                            onclick="previewCamOnHost('${esc(cam.schoolId)}','${esc(cam.camId)}','${esc(cam.key)}',this)">
                        👁️ Preview
                    </button>
                    ` : `<span class="text-xs" style="color:var(--sub)">offline</span>`}
                </div>
            </div>
        </div>`;
    }).join('');
}

// ── Render Presentation Assignments ───────────────────────────────────────
function renderPresAssignments() {
    const el = document.getElementById('pres-assignments-list');
    const countEl = document.getElementById('pres-count');
    if (!el) return;

    const keys = Object.keys(camState.assignments);
    if (countEl) countEl.textContent = keys.length + ' connected';

    if (!keys.length) {
        el.innerHTML = '<div class="text-xs text-center py-3" style="color:var(--sub)">No presentation screens connected.</div>';
        return;
    }

    el.innerHTML = keys.map(presId => {
        const a = camState.assignments[presId];
        return `
        <div class="pres-assignment-row">
            <i class="fa-solid fa-display text-xs" style="color:var(--main)"></i>
            <div style="flex:1" class="text-xs font-bold">${esc(presId)}</div>
            ${a ? `
            <div class="text-xs" style="color:var(--sub)">
                ${esc(a.schoolId)} · <span style="color:var(--main)">${esc(a.camId)}</span>
            </div>
            <button class="cam-assign-btn" onclick="unassignPresentation('${esc(presId)}')">✕ Detach</button>
            ` : '<div class="text-xs" style="color:var(--sub)">No camera assigned</div>'}
        </div>`;
    }).join('');
}

// ── Update Badges ─────────────────────────────────────────────────────────
function updateCamBadges() {
    const badge = document.getElementById('cam-count-badge');
    if (badge) badge.textContent = camState.cameras.length;
}

// ── Assign Camera to Presentation ─────────────────────────────────────────
function assignCamToPresentation(schoolId, camId, camKey, btn) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Check if already assigned — toggle off
    const alreadyAssigned = Object.values(camState.assignments).some(a => a.camKey === camKey);
    if (alreadyAssigned && btn.classList.contains('active-assign')) {
        // Unassign: tell all presentations to stop showing this cam
        ws.send(JSON.stringify({
            type: 'HOST_UNASSIGN_CAM',
            camKey,
            schoolId,
            camId
        }));
        btn.classList.remove('active-assign');
        return;
    }

    ws.send(JSON.stringify({
        type: 'HOST_ASSIGN_CAM_TO_PRESENTATION',
        schoolId,
        camId,
        camKey
    }));

    // Optimistic UI
    btn.classList.add('active-assign');
    btn.textContent = '✓ Prezentare';
    showHostToast(`Camera ${camId} → Presentation`);
}

// ── Host Preview via WebRTC ────────────────────────────────────────────────
async function previewCamOnHost(schoolId, camId, camKey, btn) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Close existing preview
    closeHostPreview();

    camState.hostPreviewCamKey = camKey;

    // Create RTCPeerConnection (answer side — camera will offer)
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    });
    camState.hostPreviewPc = pc;

    pc.ontrack = (e) => {
        const vid = document.getElementById('host-preview-video');
        if (vid && e.streams[0]) vid.srcObject = e.streams[0];
    };

    pc.onicecandidate = (e) => {
        if (e.candidate && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'STREAM_ICE',
                candidate: e.candidate
            }));
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            closeHostPreview();
        }
    };

    // Ask MainServer to trigger camera offer to us
    ws.send(JSON.stringify({
        type: 'HOST_VIEW_CAM',
        schoolId,
        camId,
        camKey
    }));

    // Show modal
    const modal = document.getElementById('host-preview-modal');
    const title = document.getElementById('preview-modal-title');
    if (modal) { modal.style.display = 'flex'; }
    if (title) title.textContent = `Camera: ${camId} (${schoolId})`;
}

async function handlePreviewOffer(sdp) {
    if (!camState.hostPreviewPc) return;
    const pc = camState.hostPreviewPc;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'STREAM_ANSWER',
            sdp: answer.sdp
        }));
    }
}

function closeHostPreview() {
    if (camState.hostPreviewPc) {
        try { camState.hostPreviewPc.close(); } catch(e) {}
        camState.hostPreviewPc = null;
    }
    camState.hostPreviewCamKey = null;
    const modal = document.getElementById('host-preview-modal');
    if (modal) modal.style.display = 'none';
    const vid = document.getElementById('host-preview-video');
    if (vid) vid.srcObject = null;
}

function unassignPresentation(presId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'HOST_UNASSIGN_PRESENTATION', presId }));
    delete camState.assignments[presId];
    renderPresAssignments();
}

// ── Toast helper ─────────────────────────────────────────────────────────
let _hostToastTimer = null;
function showHostToast(msg) {
    let t = document.getElementById('host-cam-toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'host-cam-toast';
        t.style.cssText = 'position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);background:rgba(226,183,20,0.9);color:#323437;font:700 0.78rem Roboto Mono,monospace;padding:0.5rem 1.25rem;border-radius:6px;z-index:9999;transition:opacity 0.3s;pointer-events:none';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    if (_hostToastTimer) clearTimeout(_hostToastTimer);
    _hostToastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2500);
}

function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}