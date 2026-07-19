import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { networkInterfaces } from 'os';
import QRCode from 'qrcode';
import { Table } from './poker.js';
import { register, login, userOf, logout } from './auth.js';

const PORT = process.env.PORT || 3000;

// pick a LAN IPv4 so phones can reach us (prefer 192.168.* / 10.* / 172.*)
function lanIP() {
  const cands = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) cands.push(n.address);
    }
  }
  return cands.find((a) => /^(192\.168|10\.|172\.)/.test(a)) || cands[0] || 'localhost';
}
const HOST_IP = lanIP();
const ORIGIN = `http://${HOST_IP}:${PORT}`;

const app = express();
app.use(express.json());
app.post('/api/register', (req, res) => {
  try { register(req.body.username, req.body.password); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/login', (req, res) => {
  try { const token = login(req.body.username, req.body.password); res.json({ token, username: userOf(token) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/logout', (req, res) => { logout(req.body?.token); res.json({ ok: true }); });
app.use(express.static('public'));
const http = createServer(app);
const io = new Server(http);

const rooms = new Map(); // code -> { table, hostSocket, sockets:Map(pid->sid), controllers:Set(sid) }

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

async function attachQR(table, code) {
  table.urls = { join: `${ORIGIN}/player.html?c=${code}`, control: `${ORIGIN}/control.html?c=${code}` };
  table.qr = {
    join: await QRCode.toDataURL(table.urls.join, { margin: 1, width: 320 }),
    control: await QRCode.toDataURL(table.urls.control, { margin: 1, width: 220 }),
  };
}

function broadcast(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.hostSocket) io.to(room.hostSocket).emit('state', room.table.view(null));
  for (const [pid, sid] of room.sockets) io.to(sid).emit('state', room.table.view(pid));
  for (const sid of room.controllers) io.to(sid).emit('state', room.table.view(null));
}

io.on('connection', (socket) => {
  socket.on('host:create', async (payload, cb) => {
    const { token, ...opts } = payload || {};
    const username = userOf(token);
    if (!username) return cb?.({ error: 'auth' }); // not logged in
    const code = makeCode();
    const table = new Table(opts);
    table.code = code;
    table.owner = username;
    await attachQR(table, code);
    rooms.set(code, { table, hostSocket: socket.id, sockets: new Map(), controllers: new Set() });
    socket.data = { code, isHost: true, username };
    cb?.({ code });
    broadcast(code);
  });

  socket.on('host:resume', ({ code, token }, cb) => {
    if (!userOf(token)) return cb?.({ error: 'auth' });
    const room = rooms.get(code);
    if (!room) return cb?.({ error: '방을 찾을 수 없어' });
    room.hostSocket = socket.id;
    socket.data = { code, isHost: true, username: userOf(token) };
    cb?.({ code });
    broadcast(code);
  });

  socket.on('player:join', ({ code, name, playerId }, cb) => {
    code = (code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ error: '방 코드를 확인해줘' });
    const p = room.table.addPlayer(playerId, name);
    room.sockets.set(playerId, socket.id);
    socket.data = { code, playerId };
    cb?.({ ok: true, playerId, name: p.name, controlMode: room.table.controlMode });
    broadcast(code);
  });

  // host's phone joins as the betting controller
  socket.on('control:join', ({ code }, cb) => {
    code = (code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ error: '방 코드를 확인해줘' });
    room.controllers.add(socket.id);
    socket.data = { code, isController: true };
    cb?.({ ok: true, controlMode: room.table.controlMode });
    broadcast(code);
  });

  socket.on('host:setMode', ({ mode }, cb) => {
    const room = rooms.get(socket.data?.code);
    if (!room || !socket.data.isHost) return;
    if (mode === 'host' || mode === 'guest') { room.table.controlMode = mode; broadcast(room.table.code); }
    cb?.({ ok: true });
  });

  socket.on('host:setBlinds', ({ sb, bb }, cb) => {
    const room = rooms.get(socket.data?.code);
    if (!room || !socket.data.isHost) return;
    try { room.table.setBlinds(+sb, +bb); broadcast(room.table.code); cb?.({ ok: true }); }
    catch (e) { cb?.({ error: e.message }); }
  });

  socket.on('host:start', (_, cb) => {
    const room = rooms.get(socket.data?.code);
    if (!room || !socket.data.isHost) return;
    try { room.table.startHand(); broadcast(room.table.code); }
    catch (e) { cb?.({ error: e.message }); }
  });

  socket.on('player:action', (action, cb) => {
    const room = rooms.get(socket.data?.code);
    if (!room) return;
    if (room.table.controlMode !== 'guest') return cb?.({ error: '이 방은 호스트가 조작해' });
    try { room.table.act(socket.data.playerId, action); broadcast(room.table.code); }
    catch (e) { cb?.({ error: e.message }); }
  });

  socket.on('control:act', (action, cb) => {
    const room = rooms.get(socket.data?.code);
    if (!room || !socket.data?.isController) return;
    if (room.table.controlMode !== 'host') return cb?.({ error: '이 방은 게스트가 조작해' });
    try { room.table.hostAct(action); broadcast(room.table.code); }
    catch (e) { cb?.({ error: e.message }); }
  });

  socket.on('disconnect', () => {
    const { code, playerId, isHost, isController } = socket.data || {};
    const room = rooms.get(code);
    if (!room) return;
    if (isHost) room.hostSocket = null;
    else if (isController) room.controllers.delete(socket.id);
    else if (playerId) {
      room.table.setConnected(playerId, false);
      if (room.sockets.get(playerId) === socket.id) room.sockets.delete(playerId);
      broadcast(code);
    }
  });
});

http.listen(PORT, () => console.log(`홀덤 서버: ${ORIGIN}  (localhost도 가능)`));
