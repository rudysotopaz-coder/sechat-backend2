const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY debe ser 64 caracteres hexadecimales (32 bytes)');
  }
  return Buffer.from(keyHex, 'hex');
}

/**
 * Cifra texto con AES-256-GCM.
 * Formato de salida: iv_hex:authTag_hex:ciphertext_hex
 */
function encrypt(text) {
  if (!text) return null;
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(String(text), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Descifra texto cifrado con encrypt().
 */
function decrypt(encryptedData) {
  if (!encryptedData) return null;
  try {
    const key = getKey();
    const parts = encryptedData.split(':');
    if (parts.length !== 3) return '[error de formato]';
    const [ivHex, authTagHex, ciphertext] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[Crypto] Error al descifrar:', err.message);
    return '[mensaje cifrado]';
  }
}

module.exports = { encrypt, decrypt };
