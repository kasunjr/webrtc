let appConfig = {
  signalingUrl: 'https://bea7532fbe927f.lhr.life',
  joineeAppUrl: 'https://kasunjr.github.io/webrtc/public',
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
};

let socket = null;
const peers = new Map();
const dataChannels = new Map();
const peerNames = new Map();

let selfId = null;
let roomId = null;
let displayName = `Host-${Math.floor(Math.random() * 1000)}`;

// DOM refs
const roomLabel = document.getElementById('roomLabel');
const peerCount = document.getElementById('peerCount');
const signalingStatus = document.getElementById('signalingStatus');
const nameInput = document.getElementById('nameInput');
const createRoomBtn = document.getElementById('createRoomBtn');
const copyUrlBtn = document.getElementById('copyUrlBtn');
const qrCanvas = document.getElementById('qrCanvas');
const joinUrlLabel = document.getElementById('joinUrl');
const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

nameInput.value = displayName;

const qr = new QRious({
  element: qrCanvas,
  value: window.location.href,
  size: 220,
  level: 'M',
});

function randomRoomId() {
  return Math.random().toString(36).slice(2, 10);
}

function updatePeerCount() {
  peerCount.textContent = String(dataChannels.size);
}

function addMessage({ sender, text, kind = 'remote' }) {
  const msg = document.createElement('div');
  msg.className = `message ${kind}`;
  msg.innerHTML = `<strong>${escapeHtml(sender)}</strong>: ${escapeHtml(text)}`;
  messagesEl.appendChild(msg);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(raw) {
  return String(raw)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getJoinUrl() {
  const base = appConfig.joineeAppUrl || window.location.origin;
  const url = new URL(base);
  url.searchParams.set('room', roomId);
  return url.toString();
}

function refreshQr() {
  if (!roomId) return;
  const joinUrl = getJoinUrl();
  joinUrlLabel.textContent = joinUrl;
  qr.value = joinUrl;
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  let sent = false;
  for (const [, dc] of dataChannels) {
    if (dc.readyState === 'open') {
      dc.send(data);
      sent = true;
    }
  }
  if (!sent && roomId) {
    socket.emit('chat-fallback', { roomId, message: payload });
  }
}

function teardownPeer(peerId) {
  const peer = peers.get(peerId);
  if (peer) {
    peer.close();
    peers.delete(peerId);
  }
  dataChannels.delete(peerId);
  peerNames.delete(peerId);
  updatePeerCount();
}

function setupDataChannel(peerId, channel) {
  dataChannels.set(peerId, channel);
  updatePeerCount();

  channel.onopen = () => {
    addMessage({
      sender: 'System',
      text: `Peer connected: ${peerNames.get(peerId) || peerId.slice(0, 6)}`,
      kind: 'system',
    });
  };

  channel.onclose = () => {
    dataChannels.delete(peerId);
    updatePeerCount();
    addMessage({
      sender: 'System',
      text: `Peer disconnected: ${peerNames.get(peerId) || peerId.slice(0, 6)}`,
      kind: 'system',
    });
  };

  channel.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'chat') {
        addMessage({
          sender: payload.sender || peerNames.get(peerId) || `Peer-${peerId.slice(0, 4)}`,
          text: payload.text || '',
          kind: 'remote',
        });
      }

      if (payload.type === 'keypress') {
        const sender = payload.sender || peerNames.get(peerId) || `Peer-${peerId.slice(0, 4)}`;
        const lastKeyEl = document.getElementById('lastKey');
        const lastKeyFromEl = document.getElementById('lastKeyFrom');
        if (lastKeyEl) {
          lastKeyEl.textContent = payload.key;
          lastKeyEl.classList.add('key-flash');
          setTimeout(() => lastKeyEl.classList.remove('key-flash'), 400);
        }
        if (lastKeyFromEl) {
          lastKeyFromEl.textContent = `from ${escapeHtml(sender)}`;
        }
        addMessage({ sender, text: `⌨ Key: ${escapeHtml(payload.key)}`, kind: 'keypress' });
      }
    } catch {
      addMessage({ sender: `Peer-${peerId.slice(0, 4)}`, text: event.data, kind: 'remote' });
    }
  };
}

async function ensurePeer(peerId, isInitiator) {
  if (peers.has(peerId)) return peers.get(peerId);

  const pc = new RTCPeerConnection({ iceServers: appConfig.iceServers });
  peers.set(peerId, pc);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { to: peerId, payload: { candidate: event.candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      teardownPeer(peerId);
    }
  };

  pc.ondatachannel = (event) => {
    setupDataChannel(peerId, event.channel);
  };

  if (isInitiator) {
    const channel = pc.createDataChannel('chat');
    setupDataChannel(peerId, channel);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { to: peerId, payload: { description: pc.localDescription } });
  }

  return pc;
}

async function handleSignal({ from, payload }) {
  const pc = await ensurePeer(from, false);

  if (payload.description) {
    await pc.setRemoteDescription(payload.description);
    if (payload.description.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, payload: { description: pc.localDescription } });
    }
  }

  if (payload.candidate) {
    try {
      await pc.addIceCandidate(payload.candidate);
    } catch (err) {
      console.error('ICE candidate error:', err);
    }
  }
}

function enterRoom(nextRoomId) {
  roomId = nextRoomId;
  roomLabel.textContent = roomId;
  refreshQr();
  socket.emit('join-room', { roomId, displayName });
}

function initSocket() {
  socket = io(appConfig.signalingUrl);

  socket.on('connect', () => {
    signalingStatus.textContent = 'Connected';
  });

  socket.on('disconnect', () => {
    signalingStatus.textContent = 'Disconnected';
  });

  socket.on('existing-peers', async ({ peers: existing, selfId: id }) => {
    selfId = id;
    addMessage({ sender: 'System', text: `Room ready. Waiting for joinees…`, kind: 'system' });
    for (const peerId of existing) {
      await ensurePeer(peerId, true);
    }
  });

  socket.on('peer-joined', ({ peerId, displayName: peerName }) => {
    peerNames.set(peerId, peerName);
    addMessage({ sender: 'System', text: `${peerName || peerId.slice(0, 6)} joined the room.`, kind: 'system' });
  });

  socket.on('peer-left', ({ peerId }) => {
    teardownPeer(peerId);
    addMessage({ sender: 'System', text: `Peer left: ${peerId.slice(0, 6)}.`, kind: 'system' });
  });

  socket.on('signal', async (payload) => {
    try {
      await handleSignal(payload);
    } catch (err) {
      console.error('Signal handling error:', err);
      addMessage({ sender: 'System', text: 'Signal handling failed for one peer.', kind: 'system' });
    }
  });

  socket.on('chat-fallback', ({ from, message }) => {
    addMessage({
      sender: message.sender || `Peer-${from.slice(0, 4)}`,
      text: message.text || '',
      kind: 'remote',
    });
  });

  socket.on('app-error', ({ message }) => {
    addMessage({ sender: 'System', text: message, kind: 'system' });
  });
}

// ── Event listeners ──────────────────────────────────────────────────────────

createRoomBtn.addEventListener('click', () => {
  for (const [peerId] of peers) teardownPeer(peerId);
  enterRoom(randomRoomId());
  addMessage({ sender: 'System', text: 'New room created. Share the QR code with joinees.', kind: 'system' });
});

copyUrlBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(getJoinUrl());
    addMessage({ sender: 'System', text: 'Join link copied to clipboard.', kind: 'system' });
  } catch {
    addMessage({ sender: 'System', text: 'Unable to copy — copy manually from the link below.', kind: 'system' });
  }
});

nameInput.addEventListener('change', () => {
  const clean = nameInput.value.trim();
  if (clean) displayName = clean;
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  const payload = { type: 'chat', sender: displayName, text, ts: Date.now() };
  addMessage({ sender: 'You', text, kind: 'local' });
  broadcast(payload);
  chatInput.value = '';
});

// ── Boot ─────────────────────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const res = await fetch('/config', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data.signalingUrl) appConfig.signalingUrl = data.signalingUrl;
      if (data.joineeAppUrl) appConfig.joineeAppUrl = data.joineeAppUrl;
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        appConfig.iceServers = data.iceServers;
      }
    }
  } catch {
    // Keep defaults
  }
}

loadConfig().then(() => {
  initSocket();
  // Auto-create a room on load
  enterRoom(randomRoomId());
});
