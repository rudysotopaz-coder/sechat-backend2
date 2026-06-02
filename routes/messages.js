const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { pool } = require('../db');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

function getDisplayName(senderToken, viewerToken, allMembers) {
  if (senderToken === viewerToken) return 'Yo';
  const others = allMembers
    .filter(m => m.session_token !== viewerToken)
    .sort((a, b) => a.member_index - b.member_index);
  const pos = others.findIndex(m => m.session_token === senderToken);
  if (pos === -1) return 'Invitado';
  return `Invitado ${pos + 1}`;
}

// ── GET /api/messages/:room_id ────────────────────────────────────────────────
router.get('/:room_id', async (req, res) => {
  const { room_id } = req.params;
  const { session_token } = req.query;

  try {
    const memberResult = await pool.query(
      'SELECT member_index FROM room_members WHERE room_id = $1 AND session_token = $2',
      [room_id, session_token]
    );
    if (memberResult.rows.length === 0) {
      return res.status(403).json({ error: 'No eres miembro de esta sala' });
    }

    const allMembers = await pool.query(
      'SELECT session_token, member_index FROM room_members WHERE room_id = $1 ORDER BY member_index',
      [room_id]
    );

    // Incluir mensajes efímeros (expires_at IS NULL = read_once)
    const messages = await pool.query(
      `SELECT id, sender_token, content_encrypted, type, media_url, expires_at, created_at, reactions, reply_to_id
       FROM messages
       WHERE room_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at ASC`,
      [room_id]
    );

    const replyIds = messages.rows.filter(m => m.reply_to_id).map(m => m.reply_to_id);
    let replyMap = {};
    if (replyIds.length > 0) {
      const replies = await pool.query(
        'SELECT id, content_encrypted, type, sender_token FROM messages WHERE id = ANY($1)',
        [replyIds]
      );
      replies.rows.forEach(r => { replyMap[r.id] = r; });
    }

    // Obtener duración de la sala para identificar read_once
    const roomData = await pool.query('SELECT message_duration FROM rooms WHERE id = $1', [room_id]);
    const roomDuration = roomData.rows[0]?.message_duration ?? 48;

    const result = messages.rows.map(msg => {
      let reply_to = null;
      if (msg.reply_to_id && replyMap[msg.reply_to_id]) {
        const rm = replyMap[msg.reply_to_id];
        reply_to = {
          id: rm.id,
          type: rm.type,
          // Pasar contenido cifrado — cliente descifra
          content: rm.content_encrypted,
          sender: getDisplayName(rm.sender_token, session_token, allMembers.rows)
        };
      }

      return {
        id: msg.id,
        sender: getDisplayName(msg.sender_token, session_token, allMembers.rows),
        isMe: msg.sender_token === session_token,
        type: msg.type,
        // Pasar contenido cifrado tal como está — cliente descifra E2E
        content: msg.content_encrypted,
        media_url: msg.media_url || null,
        expires_at: msg.expires_at,
        created_at: msg.created_at,
        reactions: msg.reactions || {},
        reply_to,
        read_once: msg.expires_at === null && roomDuration === 0
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[messages/get]', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/messages/upload (Cloudinary — imágenes grandes) ─────────────────
router.post('/upload', upload.single('file'), async (req, res) => {
  const { session_token, room_id } = req.body;

  try {
    if (session_token && room_id) {
      const member = await pool.query(
        'SELECT id FROM room_members WHERE room_id = $1 AND session_token = $2',
        [room_id, session_token]
      );
      if (member.rows.length === 0) {
        return res.status(403).json({ error: 'No autorizado' });
      }
    }

    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      return res.status(503).json({ error: 'Almacenamiento no configurado' });
    }

    const b64 = req.file.buffer.toString('base64');
    const dataURI = `data:${req.file.mimetype};base64,${b64}`;

    const result = await cloudinary.uploader.upload(dataURI, {
      folder: 'sechat',
      resource_type: 'image',
      use_filename: false,
      unique_filename: true,
      transformation: [
        { quality: 'auto:good', fetch_format: 'auto' },
        { width: 1200, crop: 'limit' }
      ]
    });

    res.json({ url: result.secure_url });
  } catch (err) {
    console.error('[messages/upload]', err);
    res.status(500).json({ error: 'Error al subir imagen' });
  }
});

module.exports = router;
