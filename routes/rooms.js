const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../db');

function normalizeName(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, '_');
}

const VALID_DURATIONS = [0, 1, 6, 12, 24, 48]; // 0 = al leer
const VALID_COLORS = ['#ffffff', '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3', '#54a0ff'];

// ── POST /api/rooms/create ────────────────────────────────────────────────────
router.post('/create', async (req, res) => {
  let { name, password, max_users, session_token, message_duration, color } = req.body;

  if (!name || !password || !session_token) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  name = normalizeName(name);
  if (name.length < 2) return res.status(400).json({ error: 'Nombre de sala muy corto' });

  const maxUsers = Math.min(Math.max(parseInt(max_users) || 2, 2), 20);
  const duration = VALID_DURATIONS.includes(parseInt(message_duration)) ? parseInt(message_duration) : 48;
  const roomColor = VALID_COLORS.includes(color) ? color : '#ffffff';

  try {
    const existing = await pool.query('SELECT id FROM rooms WHERE name = $1', [name]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'El nombre de sala ya existe, elige otro' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const roomResult = await pool.query(
      `INSERT INTO rooms (name, password_hash, max_users, created_by_token, message_duration, color)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, max_users, message_duration, color`,
      [name, password_hash, maxUsers, session_token, duration, roomColor]
    );

    const room = roomResult.rows[0];

    await pool.query(
      'INSERT INTO room_members (room_id, session_token, member_index) VALUES ($1, $2, 1)',
      [room.id, session_token]
    );

    // Analítica anónima
    try {
      const now = new Date();
      await pool.query(
        'INSERT INTO analytics_events (event_type, hour_of_day, day_of_week) VALUES ($1, $2, $3)',
        ['room_created', now.getHours(), now.getDay()]
      );
    } catch {}

    res.json({
      room_id: room.id,
      name: room.name,
      max_users: room.max_users,
      message_duration: room.message_duration,
      color: room.color,
      member_index: 1,
      is_creator: true,
      notice: 'Esta sala se eliminará automáticamente si no tiene actividad por 7 días.'
    });
  } catch (err) {
    console.error('[rooms/create]', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/rooms/join ──────────────────────────────────────────────────────
router.post('/join', async (req, res) => {
  let { name, password, session_token } = req.body;

  if (!name || !password || !session_token) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  name = normalizeName(name);

  try {
    const roomResult = await pool.query('SELECT * FROM rooms WHERE name = $1', [name]);
    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Sala no encontrada' });
    }

    const room = roomResult.rows[0];
    const valid = await bcrypt.compare(password, room.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    const existingMember = await pool.query(
      'SELECT member_index FROM room_members WHERE room_id = $1 AND session_token = $2',
      [room.id, session_token]
    );

    if (existingMember.rows.length > 0) {
      return res.json({
        room_id: room.id,
        name: room.name,
        max_users: room.max_users,
        message_duration: room.message_duration || 48,
        color: room.color || '#ffffff',
        member_index: existingMember.rows[0].member_index,
        is_creator: room.created_by_token === session_token
      });
    }

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM room_members WHERE room_id = $1',
      [room.id]
    );

    if (parseInt(countResult.rows[0].count) >= room.max_users) {
      return res.status(403).json({ error: 'La sala está llena' });
    }

    const maxIdxResult = await pool.query(
      'SELECT COALESCE(MAX(member_index), 0) AS max_idx FROM room_members WHERE room_id = $1',
      [room.id]
    );

    const newIndex = parseInt(maxIdxResult.rows[0].max_idx) + 1;

    await pool.query(
      'INSERT INTO room_members (room_id, session_token, member_index) VALUES ($1, $2, $3)',
      [room.id, session_token, newIndex]
    );

    // Analítica anónima
    try {
      const now = new Date();
      await pool.query(
        'INSERT INTO analytics_events (event_type, hour_of_day, day_of_week) VALUES ($1, $2, $3)',
        ['room_joined', now.getHours(), now.getDay()]
      );
    } catch {}

    res.json({
      room_id: room.id,
      name: room.name,
      max_users: room.max_users,
      message_duration: room.message_duration || 48,
      color: room.color || '#ffffff',
      member_index: newIndex,
      is_creator: false
    });
  } catch (err) {
    console.error('[rooms/join]', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/rooms/:room_id ────────────────────────────────────────────────
router.delete('/:room_id', async (req, res) => {
  const { room_id } = req.params;
  const { session_token } = req.body;

  try {
    const room = await pool.query(
      'SELECT id FROM rooms WHERE id = $1 AND created_by_token = $2',
      [room_id, session_token]
    );

    if (room.rows.length === 0) {
      return res.status(403).json({ error: 'Solo el creador puede eliminar la sala' });
    }

    await pool.query('DELETE FROM rooms WHERE id = $1', [room_id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[rooms/delete]', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/rooms/my/:session_token ─────────────────────────────────────────
router.get('/my/:session_token', async (req, res) => {
  const { session_token } = req.params;

  try {
    const result = await pool.query(`
      SELECT r.id, r.name, r.max_users, rm.member_index,
             (r.created_by_token = $1) AS is_creator,
             r.created_at, r.message_duration, r.color
      FROM rooms r
      JOIN room_members rm ON r.id = rm.room_id
      WHERE rm.session_token = $1
      ORDER BY rm.joined_at DESC
    `, [session_token]);

    res.json(result.rows);
  } catch (err) {
    console.error('[rooms/my]', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/rooms/qr/:room_id ────────────────────────────────────────────────
router.get('/qr/:room_id', async (req, res) => {
  const { room_id } = req.params;
  const { session_token } = req.query;

  try {
    const room = await pool.query(
      'SELECT id, name FROM rooms WHERE id = $1 AND created_by_token = $2',
      [room_id, session_token]
    );

    if (room.rows.length === 0) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // Devolver datos para QR — el frontend genera el QR
    res.json({
      room_id: room.rows[0].id,
      name: room.rows[0].name,
      expires: Date.now() + 10 * 60 * 1000 // expira en 10 min
    });
  } catch (err) {
    console.error('[rooms/qr]', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
