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
    const now = new Date();
    const last7days = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const last30days = new Date(now - 30 * 24 * 60 * 60 * 1000);

    // Usuarios activos últimos 7 días (tokens únicos con mensajes)
    const activeUsers7 = await pool.query(`
      SELECT COUNT(DISTINCT sender_token) as count
      FROM messages WHERE created_at > $1
    `, [last7days]);

    // Usuarios activos últimos 30 días
    const activeUsers30 = await pool.query(`
      SELECT COUNT(DISTINCT sender_token) as count
      FROM messages WHERE created_at > $1
    `, [last30days]);

    // Total mensajes últimas 48h
    const recentMessages = await pool.query(`
      SELECT COUNT(*) as count FROM messages
      WHERE created_at > NOW() - INTERVAL '48 hours'
    `);

    // Salas activas ahora
    const activeRooms = await pool.query(`
      SELECT COUNT(*) as count FROM rooms
      WHERE EXISTS (
        SELECT 1 FROM messages m
        WHERE m.room_id = rooms.id
        AND m.created_at > NOW() - INTERVAL '48 hours'
      )
    `);

    // Total salas
    const totalRooms = await pool.query('SELECT COUNT(*) as count FROM rooms');

    // Nuevos usuarios por día últimos 7 días
    const newUsersByDay = await pool.query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM analytics_events
      WHERE event_type = 'new_user'
      AND created_at > $1
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [last7days]);

    // Mensajes por hora del día (mapa de calor)
    const messagesByHour = await pool.query(`
      SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as count
      FROM messages
      WHERE created_at > $1
      GROUP BY hour ORDER BY hour
    `, [last30days]);

    // Actividad por día de semana
    const messagesByDow = await pool.query(`
      SELECT EXTRACT(DOW FROM created_at) as dow, COUNT(*) as count
      FROM messages
      WHERE created_at > $1
      GROUP BY dow ORDER BY dow
    `, [last30days]);

    // Imágenes enviadas
    const imagesSent = await pool.query(`
      SELECT COUNT(*) as count FROM messages
      WHERE type = 'image' AND created_at > $1
    `, [last30days]);

    // Reportes recibidos
    const reports = await pool.query(`
      SELECT COUNT(*) as count FROM analytics_events
      WHERE event_type = 'report_sent'
      AND created_at > $1
    `, [last30days]);

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
      messagesByDow: messagesByDow.rows
    });
  } catch (err) {
    console.error('[analytics]', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
