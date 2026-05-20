const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

function parseCsv(value) {
  if (!value) return [];
  return value.split(',').map((e) => e.trim()).filter(Boolean);
}

function buildIceServers() {
  const stunUrls = parseCsv(process.env.STUN_URLS);
  const turnUrls = parseCsv(process.env.TURN_URLS);
  const iceServers = [];

  if (stunUrls.length > 0) iceServers.push({ urls: stunUrls });

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
  // URL of the signaling server (socket.io)
  signalingUrl: process.env.SIGNALING_URL || 'http://localhost:3000',
  // URL of the joinee app — used to build the QR code join link
  joineeAppUrl: process.env.JOINEE_APP_URL || 'http://localhost:3002',
  iceServers: buildIceServers(),
};

app.use(express.static(path.join(__dirname, 'public')));

app.get('/config', (req, res) => {
  res.json(appConfig);
});

server.listen(PORT, () => {
  console.log(`Host app running on http://localhost:${PORT}`);
  console.log(`Signaling server: ${appConfig.signalingUrl}`);
  console.log(`Joinee app URL:   ${appConfig.joineeAppUrl}`);
  console.log(`ICE servers:      ${JSON.stringify(appConfig.iceServers)}`);
});
