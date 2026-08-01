require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const cron = require('node-cron');
const { initDB } = require('./db');
const roomsRouter = require('./routes/rooms');
const messagesRouter = require('./routes/messages');
const reportRouter = require('./routes/report');
const analyticsRouter = require('./routes/analytics');
const { cleanupExpiredMessages, cleanupInactiveRooms } = require('./utils/cleanup');
const socketHandler = require('./socket/handler');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 15e6
});

// Exponer io para rutas
app.set('io', io);

app.use(cors());
app.use(express.json({ limit: '15mb' }));

const ipRequestMap = new Map();
function apiRateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const now = Date.now();
  const entry = ipRequestMap.get(ip);
  if (!entry || now > entry.resetAt) {
    ipRequestMap.set(ip, { count: 1, resetAt: now + 60000 });
    return next();
  }
  if (entry.count >= 60) return res.status(429).json({ error: 'Demasiadas solicitudes.' });
  entry.count++;
  next();
}

app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

app.get('/api/version', (req, res) => {
  res.json({
    android: process.env.APP_VERSION_ANDROID || '1.0.0',
    web: process.env.APP_VERSION_WEB || '1.0.0',
    message: process.env.APP_UPDATE_MESSAGE || ''
  });
});

app.use('/api/rooms', apiRateLimit, roomsRouter);
app.use('/api/messages', apiRateLimit, messagesRouter);
app.use('/api/report', reportRouter);
app.use('/api/analytics', analyticsRouter);

socketHandler(io);

cron.schedule('*/5 * * * *', async () => {
  try { await cleanupExpiredMessages(); } catch {}
});

cron.schedule('0 0 * * *', async () => {
  try { await cleanupInactiveRooms(); } catch {}
});

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipRequestMap.entries()) {
    if (now > entry.resetAt) ipRequestMap.delete(ip);
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;

initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`[Huum] Backend activo en puerto ${PORT}`);
  });
}).catch(err => {
  console.error('[Huum] Error iniciando DB:', err);
  process.exit(1);
});
