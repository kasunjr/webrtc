const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.SIGNALING_CORS_ORIGIN || '*',
  },
});

const PORT = process.env.PORT || 3000;

function parseCsv(value) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildIceServers() {
  const stunUrls = parseCsv(process.env.STUN_URLS);
  const turnUrls = parseCsv(process.env.TURN_URLS);

  const iceServers = [];

  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls });
  }

  if (turnUrls.length > 0) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_PASSWORD || '',
    });
  }

  if (iceServers.length === 0) {
    iceServers.push({ urls: ['stun:stun.l.google.com:19302'] });
  }

  return iceServers;
}

const appConfig = {
  baseUrl: process.env.PUBLIC_BASE_URL || '',
  iceServers: buildIceServers(),
};

app.use(express.static(path.join(__dirname, 'public')));

app.get('/config', (req, res) => {
  res.json(appConfig);
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, displayName }) => {
    if (!roomId) {
      socket.emit('app-error', { message: 'Missing room id.' });
      return;
    }

    if (socket.data.roomId && socket.data.roomId !== roomId) {
      socket.leave(socket.data.roomId);
    }

    socket.data.roomId = roomId;
    socket.data.displayName = displayName || `User-${socket.id.slice(0, 5)}`;

    const room = io.sockets.adapter.rooms.get(roomId);
    const existingPeers = room ? Array.from(room).filter((id) => id !== socket.id) : [];

    socket.join(roomId);
    socket.emit('existing-peers', {
      peers: existingPeers,
      selfId: socket.id,
      roomId,
      displayName: socket.data.displayName,
    });

    socket.to(roomId).emit('peer-joined', {
      peerId: socket.id,
      displayName: socket.data.displayName,
    });
  });

  socket.on('signal', ({ to, payload }) => {
    if (!to || !payload) {
      return;
    }

    io.to(to).emit('signal', {
      from: socket.id,
      payload,
    });
  });

  socket.on('chat-fallback', ({ roomId, message }) => {
    if (!roomId || !message) {
      return;
    }

    socket.to(roomId).emit('chat-fallback', {
      from: socket.id,
      message,
    });
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) {
        continue;
      }

      socket.to(roomId).emit('peer-left', { peerId: socket.id });
    }
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`WebRTC QR chat server running on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log('Loaded ICE servers:', JSON.stringify(appConfig.iceServers));
});
