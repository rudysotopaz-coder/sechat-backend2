const express = require('express');
const router = express.Router();
const { pool } = require('../db');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const reportRateLimit = new Map();

function checkReportLimit(ip) {
  const now = Date.now();
  const entry = reportRateLimit.get(ip);
  if (!entry || now > entry.resetAt) {
    reportRateLimit.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 3) return false;
  entry.count++;
  return true;
}

router.post('/', async (req, res) => {
  const { message, captcha_answer, captcha_expected } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (parseInt(captcha_answer) !== parseInt(captcha_expected)) {
    return res.status(400).json({ error: 'CAPTCHA incorrecto' });
  }

  if (!message || message.trim().length < 10) {
    return res.status(400).json({ error: 'El mensaje es muy corto' });
  }

  if (message.length > 1000) {
    return res.status(400).json({ error: 'El mensaje es muy largo' });
  }

  if (!checkReportLimit(ip)) {
    return res.status(429).json({ error: 'Demasiados reportes. Intenta más tarde.' });
  }

  try {
    const text = `🔔 *Nuevo reporte Huum*\n\n${message.trim()}\n\n_${new Date().toLocaleString('es-GT')}_`;

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown'
      })
    });

    if (!response.ok) throw new Error('Telegram API error');

    // Analítica
    try {
      await pool.query(
        'INSERT INTO analytics_events (event_type, hour_of_day, day_of_week) VALUES ($1, $2, $3)',
        ['report_sent', new Date().getHours(), new Date().getDay()]
      );
    } catch {}

    res.json({ success: true });
  } catch (err) {
    console.error('[report]', err);
    res.status(500).json({ error: 'Error enviando reporte' });
  }
});

module.exports = router;
