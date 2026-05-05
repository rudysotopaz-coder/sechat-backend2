const { pool } = require('../db');

/**
 * Elimina todos los mensajes cuya fecha de expiración ya pasó.
 * Se ejecuta cada 5 minutos via cron.
 */
async function cleanupExpiredMessages() {
  const result = await pool.query(
    'DELETE FROM messages WHERE expires_at < NOW() RETURNING id'
  );
  if (result.rowCount > 0) {
    console.log(`[Cleanup] ${result.rowCount} mensajes expirados eliminados`);
  }
  return result.rowCount;
}

module.exports = { cleanupExpiredMessages };
