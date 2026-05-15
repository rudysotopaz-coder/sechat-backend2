
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
