const runtimeParams = new URLSearchParams(window.location.search);
const runtimeBackendUrl = (runtimeParams.get('backend') || '').trim().replace(/\/$/, '');
const configBaseUrl = 'https://1edb4979e48d51.lhr.life';

let socket = null;

const peers = new Map();
const dataChannels = new Map();
const peerNames = new Map();

let selfId = null;
let roomId = null;
let displayName = `Guest-${Math.floor(Math.random() * 1000)}`;
let scannerInstance = null;
let appConfig = {
  signalingUrl: configBaseUrl,
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
};

const roleLabel = document.getElementById('roleLabel');
const roomLabel = document.getElementById('roomLabel');
const peerCount = document.getElementById('peerCount');
const nameInput = document.getElementById('nameInput');
const createRoomBtn = document.getElementById('createRoomBtn');
const scanQrBtn = document.getElementById('scanQrBtn');
const copyUrlBtn = document.getElementById('copyUrlBtn');
const qrCanvas = document.getElementById('qrCanvas');
const joinUrlLabel = document.getElementById('joinUrl');
const scannerWrap = document.getElementById('scannerWrap');
const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const mainPanel = createRoomBtn.closest('.panel');
const qrPanel = qrCanvas.closest('.panel');
const chatPanel = chatForm.closest('.panel');
const chatTitle = chatPanel?.querySelector('h2');
const keypadPanel = document.getElementById('keypadPanel');
const lastKeyDisplay = document.getElementById('lastKeyDisplay');
const keyDisplayMap = {
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
  Enter: 'ENTER',
};

const qr = new QRious({
  element: qrCanvas,
  value: window.location.href,
  size: 220,
  level: 'M',
});

nameInput.value = displayName;

function randomRoomId() {
  return Math.random().toString(36).slice(2, 10);
}

function updatePeerCount() {
  peerCount.textContent = String(dataChannels.size);
}

function addMessage({ sender, text, kind = 'remote' }) {
  const msg = document.createElement('div');
  msg.className = `message ${kind}`;
  msg.innerHTML = `<strong>${sender}</strong>: ${escapeHtml(text)}`;
  messagesEl.appendChild(msg);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(raw) {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getJoinUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  url.searchParams.delete('host');
  if (runtimeBackendUrl) {
    url.searchParams.set('backend', runtimeBackendUrl);
  } else {
    url.searchParams.delete('backend');
  }
  return url.toString();
}

function refreshQr() {
  const joinUrl = getJoinUrl();
  joinUrlLabel.textContent = joinUrl;
  qr.value = joinUrl;
}

function applyRoleLayout(isHost) {
  // Always hide the hero controls; keep the status-grid visible for both roles.
  mainPanel?.querySelector('.controls')?.classList.add('hidden');
  mainPanel?.querySelector('.eyebrow')?.classList.add('hidden');
  mainPanel?.querySelector('h1')?.classList.add('hidden');
  mainPanel?.querySelector('.subtitle')?.classList.add('hidden');

  if (isHost) {
    qrPanel?.classList.remove('hidden');
    chatPanel?.classList.add('hidden');
    scannerWrap.classList.add('hidden');
    if (scannerInstance) {
      scannerInstance.clear().catch(() => {});
      scannerInstance = null;
    }
    return;
  }

  // Joinee: show status panel + keypad; hide QR and chat.
  qrPanel?.classList.add('hidden');
  chatPanel?.classList.add('hidden');
  keypadPanel?.classList.remove('hidden');
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

function broadcast(payload) {
  const data = JSON.stringify(payload);

  let sent = false;
  for (const [, dc] of dataChannels) {
    if (dc.readyState === 'open') {
      dc.send(data);
      sent = true;
    }
  }

  if (!sent) {
    socket.emit('chat-fallback', {
      roomId,
      message: payload,
    });
  }
}

function setupDataChannel(peerId, channel) {
  dataChannels.set(peerId, channel);
  updatePeerCount();

  channel.onopen = () => {
    addMessage({ sender: 'System', text: `Peer connected (${peerId.slice(0, 6)})`, kind: 'system' });
  };

  channel.onclose = () => {
    dataChannels.delete(peerId);
    updatePeerCount();
    addMessage({ sender: 'System', text: `Peer disconnected (${peerId.slice(0, 6)})`, kind: 'system' });
  };

  channel.onmessage = (event) => {
    console.log('Received message from peer', peerId, event.data);
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'chat') {
        lastKeyDisplay.textContent = payload.text;
   
        addMessage({
          sender: payload.sender || peerNames.get(peerId) || `Peer-${peerId.slice(0, 4)}`,
          text: payload.text || '',
          kind: 'remote',
        });
      }
    } catch (error) {
      console.error('Error parsing message from peer', peerId, event.data, error);
      addMessage({ sender: `Peer-${peerId.slice(0, 4)}`, text: event.data, kind: 'remote' });
    }
  };
}

async function ensurePeer(peerId, isInitiator) {
  if (peers.has(peerId)) {
    return peers.get(peerId);
  }

  const pc = new RTCPeerConnection({ iceServers: appConfig.iceServers });
  peers.set(peerId, pc);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', {
        to: peerId,
        payload: { candidate: event.candidate },
      });
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

    socket.emit('signal', {
      to: peerId,
      payload: { description: pc.localDescription },
    });
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

      socket.emit('signal', {
        to: from,
        payload: { description: pc.localDescription },
      });
    }
  }

  if (payload.candidate) {
    try {
      await pc.addIceCandidate(payload.candidate);
    } catch (error) {
      console.error('Error adding ICE candidate for peer', from, payload.candidate, error);
      // Ignore race conditions from early ICE candidates.
    }
  }
}

function enterRoom(nextRoomId, isHost) {
  roomId = nextRoomId;

  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  if (isHost) {
    url.searchParams.set('host', '1');
  } else {
    url.searchParams.delete('host');
  }
  window.history.replaceState({}, '', url);

  roleLabel.textContent = isHost ? 'Device A (Host)' : 'Device B/C (Joiner)';
  roomLabel.textContent = roomId;
  applyRoleLayout(isHost);
  refreshQr();

  socket.emit('join-room', { roomId, displayName });
}

function boot() {
  const params = new URLSearchParams(window.location.search);
  const queryRoom = params.get('room');
  const isHost = params.get('host') === '1' || !queryRoom;

  if (queryRoom) {
    enterRoom(queryRoom, isHost);
  } else {
    enterRoom(randomRoomId(), true);
  }
}

async function loadAppConfig() {
  try {
    const response = await fetch(new URL('/config', configBaseUrl), { cache: 'no-store' });
    if (!response.ok) {
      return;
    }

    const data = await response.json();
    // URL param ?backend= always takes priority over the config file.
    if (!runtimeBackendUrl && data.signalingUrl) {
      appConfig.signalingUrl = data.signalingUrl;
    }
    if (data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      appConfig.iceServers = data.iceServers;
    }
  } catch {
    // Keep defaults if config endpoint is unavailable.
  }
}

createRoomBtn.addEventListener('click', () => {
  for (const [peerId] of peers) {
    teardownPeer(peerId);
  }

  enterRoom(randomRoomId(), true);
  addMessage({ sender: 'System', text: 'Created a new room. Share QR now.', kind: 'system' });
});

copyUrlBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(getJoinUrl());
    addMessage({ sender: 'System', text: 'Join link copied to clipboard.', kind: 'system' });
  } catch {
    addMessage({ sender: 'System', text: 'Unable to copy. Copy manually from the link text.', kind: 'system' });
  }
});

scanQrBtn.addEventListener('click', () => {
  scannerWrap.classList.toggle('hidden');

  if (scannerWrap.classList.contains('hidden')) {
    if (scannerInstance) {
      scannerInstance.clear().catch(() => {});
      scannerInstance = null;
    }
    return;
  }

  scannerInstance = new Html5QrcodeScanner('scanner', { fps: 8, qrbox: { width: 220, height: 220 } }, false);
  scannerInstance.render(
    (decodedText) => {
      if (decodedText.startsWith('http://') || decodedText.startsWith('https://')) {
        window.location.href = decodedText;
      } else {
        addMessage({ sender: 'System', text: 'QR is not a valid URL.', kind: 'system' });
      }
      scannerInstance.clear().catch(() => {});
      scannerWrap.classList.add('hidden');
      scannerInstance = null;
    },
    () => {}
  );
});

nameInput.addEventListener('change', () => {
  const clean = nameInput.value.trim();
  displayName = clean || displayName;
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();

  if (!text) {
    return;
  }

  const payload = {
    type: 'chat',
    sender: displayName,
    text,
    ts: Date.now(),
  };

  addMessage({ sender: 'You', text, kind: 'local' });
  broadcast(payload);
  chatInput.value = '';
});

function initSocket() {
  socket = io(appConfig.signalingUrl);

  socket.on('existing-peers', async ({ peers: existing, selfId: id }) => {
    selfId = id;
    addMessage({ sender: 'System', text: `Connected to signaling server as ${selfId.slice(0, 6)}.`, kind: 'system' });

    for (const peerId of existing) {
      await ensurePeer(peerId, true);
    }
  });

  socket.on('peer-joined', ({ peerId }) => {
    addMessage({ sender: 'System', text: `Peer joined: ${peerId.slice(0, 6)}.`, kind: 'system' });
  });

  socket.on('peer-left', ({ peerId }) => {
    teardownPeer(peerId);
    addMessage({ sender: 'System', text: `Peer left: ${peerId.slice(0, 6)}.`, kind: 'system' });
  });

  socket.on('signal', async (payload) => {
    try {
      await handleSignal(payload);
    } catch (error) {
      addMessage({ sender: 'System', text: 'Signal handling failed for one peer message.', kind: 'system' });
    }
  });

  socket.on('chat-fallback', ({ from, message }) => {
    addMessage({ sender: message.sender || `Peer-${from.slice(0, 4)}`, text: message.text || '', kind: 'remote' });
  });

  socket.on('app-error', ({ message }) => {
    addMessage({ sender: 'System', text: message, kind: 'system' });
  });
}

document.querySelectorAll('.key-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.key;
    if (!key) return;

    if (lastKeyDisplay) {
      lastKeyDisplay.textContent = keyDisplayMap[key] || key;
    }

    btn.classList.add('key-pressed');
    setTimeout(() => btn.classList.remove('key-pressed'), 150);

    broadcast({
      type: 'keypress',
      key,
      sender: displayName,
      ts: Date.now(),
    });
  });
});

loadAppConfig().finally(() => {
  initSocket();
  boot();
});
