const { pool } = require('../db');
const { v2: cloudinary } = require('cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

/**
 * Extrae el public_id de una URL de Cloudinary.
 * Ejemplo: https://res.cloudinary.com/micloud/image/upload/v123/sechat/abc.jpg
 * → sechat/abc
 */
function extractPublicId(url) {
  try {
    const parts = url.split('/upload/');
    if (parts.length < 2) return null;
    // Quitar version (v1234/) si existe
    const rest = parts[1].replace(/^v\d+\//, '');
    // Quitar extensión
    return rest.replace(/\.[^/.]+$/, '');
  } catch {
    return null;
  }
}

/**
 * Elimina todos los mensajes cuya fecha de expiración ya pasó.
 * Si el mensaje tiene imagen, la elimina de Cloudinary primero.
 * Se ejecuta cada 5 minutos via cron.
 */
async function cleanupExpiredMessages() {
  // Obtener mensajes expirados con sus URLs de imagen
  const result = await pool.query(
    `DELETE FROM messages 
     WHERE expires_at < NOW() 
     RETURNING id, type, media_url`
  );

  if (result.rowCount === 0) return 0;

  console.log(`[Cleanup] ${result.rowCount} mensajes expirados eliminados`);

  // Eliminar imágenes de Cloudinary
  const imageMessages = result.rows.filter(m => m.type === 'image' && m.media_url);

  if (imageMessages.length > 0 && process.env.CLOUDINARY_CLOUD_NAME) {
    for (const msg of imageMessages) {
      const publicId = extractPublicId(msg.media_url);
      if (!publicId) continue;
      try {
        await cloudinary.uploader.destroy(publicId);
        console.log(`[Cleanup] Imagen eliminada de Cloudinary: ${publicId}`);
      } catch (err) {
        console.error(`[Cleanup] Error eliminando imagen ${publicId}:`, err.message);
      }
    }
  }

  return result.rowCount;
}

module.exports = { cleanupExpiredMessages };
