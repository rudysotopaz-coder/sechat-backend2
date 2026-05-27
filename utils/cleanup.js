const { pool } = require('../db');
const { v2: cloudinary } = require('cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

function extractPublicId(url) {
  try {
    const parts = url.split('/upload/');
    if (parts.length < 2) return null;
    const rest = parts[1].replace(/^v\d+\//, '');
    return rest.replace(/\.[^/.]+$/, '');
  } catch { return null; }
}

async function deleteCloudinaryImages(messages) {
  if (!process.env.CLOUDINARY_CLOUD_NAME) return;
  for (const msg of messages) {
    if (msg.type === 'image' && msg.media_url) {
      const publicId = extractPublicId(msg.media_url);
      if (publicId) {
        try { await cloudinary.uploader.destroy(publicId); } catch {}
      }
    }
  }
}

async function cleanupExpiredMessages() {
  const result = await pool.query(
    `DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < NOW()
     RETURNING id, type, media_url`
  );
  if (result.rowCount === 0) return 0;
  console.log(`[Cleanup] ${result.rowCount} mensajes expirados eliminados`);
  await deleteCloudinaryImages(result.rows);
  return result.rowCount;
}

async function cleanupInactiveRooms() {
  try {
    const inactiveRooms = await pool.query(`
      SELECT r.id FROM rooms r
      WHERE NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.room_id = r.id
        AND m.created_at > NOW() - INTERVAL '7 days'
      )
      AND r.created_at < NOW() - INTERVAL '7 days'
    `);

    if (inactiveRooms.rows.length === 0) return 0;

    for (const room of inactiveRooms.rows) {
      const images = await pool.query(
        `SELECT media_url, type FROM messages
         WHERE room_id = $1 AND type = 'image' AND media_url IS NOT NULL`,
        [room.id]
      );
      await deleteCloudinaryImages(images.rows);
      await pool.query('DELETE FROM rooms WHERE id = $1', [room.id]);
      console.log(`[Cleanup] Sala inactiva eliminada: ${room.id}`);
    }

    return inactiveRooms.rows.length;
  } catch (err) {
    console.error('[Cleanup] Error limpiando salas:', err.message);
    return 0;
  }
}

module.exports = { cleanupExpiredMessages, cleanupInactiveRooms };
