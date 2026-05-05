const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        max_users INTEGER NOT NULL DEFAULT 2,
        created_by_token VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS room_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
        session_token VARCHAR(255) NOT NULL,
        member_index INTEGER NOT NULL,
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(room_id, session_token)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
        sender_token VARCHAR(255) NOT NULL,
        content_encrypted TEXT,
        type VARCHAR(20) DEFAULT 'text',
        media_url TEXT,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);
      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);
      CREATE INDEX IF NOT EXISTS idx_members_room ON room_members(room_id);
      CREATE INDEX IF NOT EXISTS idx_members_token ON room_members(session_token);
    `);
    console.log('[DB] Base de datos inicializada correctamente');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
