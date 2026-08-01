const express = require('express');
const router = express.Router();
const { pool } = require('../db');

const ADMIN_USER = process.env.ANALYTICS_USER || 'rudysotohuum';
const ADMIN_PASS = process.env.ANALYTICS_PASS || 'huum2025admin';

function authMiddleware(req, res, next) {
  const { user, pass } = req.query;
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

// GET /api/analytics/dashboard
router.get('/dashboard', authMiddleware, async (req, res) => {
  try {
    const last7days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const last30days = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [activeUsers7, activeUsers30, recentMessages, activeRooms, totalRooms,
           imagesSent, reports, newUsersByDay, messagesByHour, messagesByDow,
           deviceStats, connectionHistory] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT sender_token) as count FROM messages WHERE created_at > $1`, [last7days]),
      pool.query(`SELECT COUNT(DISTINCT sender_token) as count FROM messages WHERE created_at > $1`, [last30days]),
      pool.query(`SELECT COUNT(*) as count FROM messages WHERE created_at > NOW() - INTERVAL '48 hours'`),
      pool.query(`SELECT COUNT(*) as count FROM rooms WHERE EXISTS (SELECT 1 FROM messages m WHERE m.room_id = rooms.id AND m.created_at > NOW() - INTERVAL '48 hours')`),
      pool.query(`SELECT COUNT(*) as count FROM rooms`),
      pool.query(`SELECT COUNT(*) as count FROM messages WHERE type IN ('image','image_e2e') AND created_at > $1`, [last30days]),
      pool.query(`SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'report_sent' AND created_at > $1`, [last30days]),
      pool.query(`SELECT DATE(created_at) as date, COUNT(*) as count FROM analytics_events WHERE event_type = 'new_user' AND created_at > $1 GROUP BY DATE(created_at) ORDER BY date ASC`, [last7days]),
      pool.query(`SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as count FROM messages WHERE created_at > $1 GROUP BY hour ORDER BY hour`, [last30days]),
      pool.query(`SELECT EXTRACT(DOW FROM created_at) as dow, COUNT(*) as count FROM messages WHERE created_at > $1 GROUP BY dow ORDER BY dow`, [last30days]),
      // Estadísticas por dispositivo
      pool.query(`SELECT device_type, COUNT(*) as count FROM analytics_events WHERE event_type = 'socket_connect' AND device_type IS NOT NULL AND created_at > $1 GROUP BY device_type ORDER BY count DESC`, [last30days]),
      // Historial de conexiones últimas 100
      pool.query(`SELECT created_at, device_type, duration_seconds, event_type FROM analytics_events WHERE event_type IN ('socket_connect','socket_disconnect') AND created_at > $1 ORDER BY created_at DESC LIMIT 100`, [last7days])
    ]);

    res.json({
      activeUsers7: parseInt(activeUsers7.rows[0].count),
      activeUsers30: parseInt(activeUsers30.rows[0].count),
      recentMessages: parseInt(recentMessages.rows[0].count),
      activeRooms: parseInt(activeRooms.rows[0].count),
      totalRooms: parseInt(totalRooms.rows[0].count),
      imagesSent: parseInt(imagesSent.rows[0].count),
      reports: parseInt(reports.rows[0].count),
      newUsersByDay: newUsersByDay.rows,
      messagesByHour: messagesByHour.rows,
      messagesByDow: messagesByDow.rows,
      deviceStats: deviceStats.rows,
      connectionHistory: connectionHistory.rows
    });
  } catch (err) {
    console.error('[analytics]', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/analytics/live — conexiones activas en tiempo real
router.get('/live', authMiddleware, async (req, res) => {
  try {
    // Obtener io desde app
    const io = req.app.get('io');
    const socketMeta = io?.socketMeta || new Map();

    const connected = [];
    const now = Date.now();

    for (const [socketId, meta] of socketMeta.entries()) {
      connected.push({
        device_type: meta.device_type || 'unknown',
        duration_seconds: Math.floor((now - meta.connected_at) / 1000),
        in_room: !!meta.room_id
      });
    }

    // Agrupar por tipo
    const byDevice = {};
    connected.forEach(c => {
      byDevice[c.device_type] = (byDevice[c.device_type] || 0) + 1;
    });

    res.json({
      total: connected.length,
      in_room: connected.filter(c => c.in_room).length,
      by_device: byDevice,
      connections: connected
    });
  } catch (err) {
    console.error('[analytics/live]', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
