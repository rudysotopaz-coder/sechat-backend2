require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const cron = require('node-cron');
const { initDB } = require('./db');
const roomsRouter = require('./routes/rooms');
const messagesRouter = require('./routes/messages');
const { cleanupExpiredMessages } = require('./utils/cleanup');
const socketHandler = require('./socket/handler');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 15e6 // 15MB
});

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Health check — Railway lo usa para verificar que el servicio está vivo
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

app.use('/api/rooms', roomsRouter);
app.use('/api/messages', messagesRouter);

socketHandler(io);

// Limpieza de mensajes expirados cada 5 minutos
cron.schedule('*/5 * * * *', async () => {
  try {
    await cleanupExpiredMessages();
  } catch (err) {
    console.error('[Cron] Error en limpieza:', err.message);
  }
});

const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[SeChat] Backend activo en puerto ${PORT}`);
    });
  })
  .catch(err => {
    console.error('[SeChat] Error iniciando DB:', err);
    process.exit(1);
  });
