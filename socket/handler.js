const { pool } = require('../db');

const socketMeta = new Map();
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW = 60 * 1000;

function checkRateLimit(token) {
  const now = Date.now();
  const entry = rateLimitMap.get(token);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(token, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) rateLimitMap.delete(token);
  }
}, 5 * 60 * 1000);

function getDisplayName(senderToken, viewerToken, allMembers) {
  if (senderToken === viewerToken) return 'Yo';
  const others = allMembers
    .filter(m => m.session_token !== viewerToken)
    .sort((a, b) => a.member_index - b.member_index);
  const pos = others.findIndex(m => m.session_token === senderToken);
  if (pos === -1) return 'Invitado';
  return `Invitado ${pos + 1}`;
}

function calcExpiresAt(durationHours) {
  if (durationHours === 0) return null;
  const hours = [1, 6, 12, 24, 48].includes(durationHours) ? durationHours : 48;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

module.exports = function (io) {
  io.on('connection', (socket) => {

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
          session_token, room_id,
          member_index: member.rows[0].member_index
        });
      } catch (err) {
        console.error('[socket/join_room]', err);
      }
    });

    socket.on('send_message', async ({ room_id, session_token, content, type = 'text', media_url, reply_to_id }) => {
      try {
        if (!checkRateLimit(session_token)) {
          socket.emit('rate_limited', { message: 'Demasiados mensajes. Espera un momento.' });
          return;
        }

        const memberResult = await pool.query(
          'SELECT member_index FROM room_members WHERE room_id = $1 AND session_token = $2',
          [room_id, session_token]
        );
        if (memberResult.rows.length === 0) return;

        const roomResult = await pool.query(
          'SELECT message_duration FROM rooms WHERE id = $1',
          [room_id]
        );
        const duration = roomResult.rows[0]?.message_duration ?? 48;
        const expires_at = calcExpiresAt(duration);

        // Servidor almacena el contenido tal como viene (E2E cifrado o legacy)
        // Para text/image_e2e: content tiene el payload cifrado
        // Para image (Cloudinary): media_url tiene la URL
        const storedContent = content || null;

        const msgResult = await pool.query(
          `INSERT INTO messages (room_id, sender_token, content_encrypted, type, media_url, expires_at, reply_to_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, created_at, expires_at`,
          [room_id, session_token, storedContent, type, media_url || null, expires_at, reply_to_id || null]
        );

        const saved = msgResult.rows[0];

        let replyToData = null;
        if (reply_to_id) {
          const replyMsg = await pool.query(
            'SELECT id, content_encrypted, type, sender_token FROM messages WHERE id = $1',
            [reply_to_id]
          );
          if (replyMsg.rows.length > 0) replyToData = replyMsg.rows[0];
        }

        const allMembers = await pool.query(
          'SELECT session_token, member_index FROM room_members WHERE room_id = $1 ORDER BY member_index',
          [room_id]
        );

        const socketsInRoom = await io.in(room_id).fetchSockets();

        for (const s of socketsInRoom) {
          const meta = socketMeta.get(s.id);
          if (!meta) continue;
          const viewerToken = meta.session_token;

          let reply_to = null;
          if (replyToData) {
            reply_to = {
              id: replyToData.id,
              type: replyToData.type,
              // Pasar el contenido cifrado tal como está — el cliente lo descifra
              content: replyToData.content_encrypted,
              sender: getDisplayName(replyToData.sender_token, viewerToken, allMembers.rows)
            };
          }

          const isReadOnce = duration === 0;

          s.emit('new_message', {
            id: saved.id,
            sender: getDisplayName(session_token, viewerToken, allMembers.rows),
            isMe: viewerToken === session_token,
            type,
            // Pasar contenido cifrado tal como está — cliente descifra
            content: storedContent,
            media_url: media_url || null,
            expires_at: saved.expires_at,
            created_at: saved.created_at,
            reactions: {},
            reply_to,
            read_once: isReadOnce
          });
        }

        // Analítica anónima
        try {
          const now = new Date();
          await pool.query(
            'INSERT INTO analytics_events (event_type, hour_of_day, day_of_week) VALUES ($1, $2, $3)',
            ['message_sent', now.getHours(), now.getDay()]
          );
        } catch {}

      } catch (err) {
        console.error('[socket/send_message]', err);
      }
    });

    socket.on('message_read', async ({ message_id, room_id, session_token }) => {
      try {
        const member = await pool.query(
          'SELECT id FROM room_members WHERE room_id = $1 AND session_token = $2',
          [room_id, session_token]
        );
        if (member.rows.length === 0) return;

        const msg = await pool.query(
          `SELECT m.id FROM messages m
           JOIN rooms r ON r.id = m.room_id
           WHERE m.id = $1 AND r.message_duration = 0
           AND m.sender_token != $2`,
          [message_id, session_token]
        );

        if (msg.rows.length > 0) {
          setTimeout(async () => {
            try {
              await pool.query('DELETE FROM messages WHERE id = $1', [message_id]);
              io.to(room_id).emit('message_deleted', { message_id });
            } catch {}
          }, 15000);
        }
      } catch (err) {
        console.error('[socket/message_read]', err);
      }
    });

    socket.on('add_reaction', async ({ room_id, session_token, message_id, emoji }) => {
      try {
        const member = await pool.query(
          'SELECT id FROM room_members WHERE room_id = $1 AND session_token = $2',
          [room_id, session_token]
        );
        if (member.rows.length === 0) return;

        const msg = await pool.query('SELECT reactions FROM messages WHERE id = $1', [message_id]);
        if (!msg.rows.length) return;

        const reactions = msg.rows[0].reactions || {};
        const tokens = reactions[emoji] ? [...reactions[emoji]] : [];
        const idx = tokens.indexOf(session_token);
        if (idx >= 0) tokens.splice(idx, 1);
        else tokens.push(session_token);
        if (tokens.length === 0) delete reactions[emoji];
        else reactions[emoji] = tokens;

        await pool.query('UPDATE messages SET reactions = $1 WHERE id = $2', [JSON.stringify(reactions), message_id]);
        io.to(room_id).emit('reaction_updated', { message_id, reactions });
      } catch (err) {
        console.error('[socket/add_reaction]', err);
      }
    });

    socket.on('notify_room_deleted', ({ room_id }) => {
      socket.to(room_id).emit('room_closed');
    });

    socket.on('leave_room', ({ room_id }) => {
      socket.leave(room_id);
      socketMeta.delete(socket.id);
    });

    socket.on('disconnect', () => {
      socketMeta.delete(socket.id);
    });
  });
};
