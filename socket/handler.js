const { pool } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');

// Mapa de socket.id → { session_token, room_id, member_index }
const socketMeta = new Map();

/**
 * Calcula nombre a mostrar. Ver explicación en messages.js.
 */
function getDisplayName(senderToken, viewerToken, allMembers) {
  if (senderToken === viewerToken) return 'Yo';
  const others = allMembers
    .filter(m => m.session_token !== viewerToken)
    .sort((a, b) => a.member_index - b.member_index);
  const pos = others.findIndex(m => m.session_token === senderToken);
  if (pos === -1) return 'Invitado';
  return `Invitado ${pos + 1}`;
}

module.exports = function (io) {
  io.on('connection', (socket) => {

    // ── join_room ─────────────────────────────────────────────────────────────
    socket.on('join_room', async ({ room_id, session_token }) => {
      try {
        const member = await pool.query(
          'SELECT member_index FROM room_members WHERE room_id = $1 AND session_token = $2',
          [room_id, session_token]
        );

        if (member.rows.length === 0) {
          socket.emit('error', { message: 'No autorizado para esta sala' });
          return;
        }

        socket.join(room_id);
        socketMeta.set(socket.id, {
          session_token,
          room_id,
          member_index: member.rows[0].member_index
        });

      } catch (err) {
        console.error('[socket/join_room]', err);
      }
    });

    // ── send_message ──────────────────────────────────────────────────────────
    socket.on('send_message', async ({ room_id, session_token, content, type = 'text', media_url }) => {
      try {
        // Verificar membresía
        const memberResult = await pool.query(
          'SELECT member_index FROM room_members WHERE room_id = $1 AND session_token = $2',
          [room_id, session_token]
        );
        if (memberResult.rows.length === 0) return;

        const expires_at = new Date(Date.now() +2* 60 * 60 * 1000); // +12 hora
        const encrypted_content = (type === 'text' && content) ? encrypt(content) : null;

        const msgResult = await pool.query(
          `INSERT INTO messages (room_id, sender_token, content_encrypted, type, media_url, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, created_at, expires_at`,
          [room_id, session_token, encrypted_content, type, media_url || null, expires_at]
        );

        const saved = msgResult.rows[0];

        // Todos los miembros para calcular nombres
        const allMembers = await pool.query(
          'SELECT session_token, member_index FROM room_members WHERE room_id = $1 ORDER BY member_index',
          [room_id]
        );

        // Enviar mensaje personalizado a cada socket conectado en la sala
        const socketsInRoom = await io.in(room_id).fetchSockets();

        for (const s of socketsInRoom) {
          const meta = socketMeta.get(s.id);
          if (!meta) continue;

          const viewerToken = meta.session_token;

          s.emit('new_message', {
            id: saved.id,
            sender: getDisplayName(session_token, viewerToken, allMembers.rows),
            isMe: viewerToken === session_token,
            type,
            content: type === 'text' ? content : null,
            media_url: media_url || null,
            expires_at: saved.expires_at,
            created_at: saved.created_at
          });
        }

      } catch (err) {
        console.error('[socket/send_message]', err);
      }
    });

    // ── room_deleted — notifica a los miembros que la sala fue eliminada ──────
    socket.on('notify_room_deleted', ({ room_id }) => {
      socket.to(room_id).emit('room_closed');
    });

    // ── leave_room ────────────────────────────────────────────────────────────
    socket.on('leave_room', ({ room_id }) => {
      socket.leave(room_id);
      socketMeta.delete(socket.id);
    });

    socket.on('disconnect', () => {
      socketMeta.delete(socket.id);
    });
  });
};
