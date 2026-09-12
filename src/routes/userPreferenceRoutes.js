const express = require('express');
const router = express.Router();
const { authenticate, invalidateTzPrefCache } = require('../middleware/auth');
const { getPool } = require('../config/database');

/**
 * @route   GET /api/user-preferences/:key
 * @desc    Get a single user preference by key
 * @access  Private
 */
router.get('/:key', authenticate, async (req, res) => {
  try {
    // Use req.user.id (the JWT's id) so the saved preference is keyed by the SAME
    // id the auth middleware reads it back by (middleware/auth.js: .eq('user_id', decoded.id)).
    // Using a resolved/email-mapped id here caused timezone changes to never reflect
    // for multi-tenant users (saved under one id, read under another).
    const userId = req.user.id;
    const { key } = req.params;

    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT preference_value FROM user_preferences WHERE user_id = $1 AND preference_key = $2 LIMIT 1',
      [userId, key]
    );

    return res.status(200).json({
      success: true,
      data: rows.length > 0 ? rows[0].preference_value : null,
    });
  } catch (err) {
    console.error('[UserPreferences] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch preference' });
  }
});

/**
 * @route   PUT /api/user-preferences/:key
 * @desc    Set/update a single user preference
 * @access  Private
 */
router.put('/:key', authenticate, async (req, res) => {
  try {
    // Use req.user.id (the JWT's id) so the saved preference is keyed by the SAME
    // id the auth middleware reads it back by (middleware/auth.js: .eq('user_id', decoded.id)).
    // Using a resolved/email-mapped id here caused timezone changes to never reflect
    // for multi-tenant users (saved under one id, read under another).
    const userId = req.user.id;
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      return res.status(400).json({ success: false, message: 'value is required' });
    }

    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO user_preferences (user_id, preference_key, preference_value, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, preference_key) DO UPDATE SET preference_value = $3, updated_at = $4
       RETURNING *`,
      [userId, key, JSON.stringify(value), new Date().toISOString()]
    );

    if (rows.length === 0) {
      console.error('[UserPreferences] PUT error: no row returned');
      return res.status(500).json({ success: false, message: 'Failed to save preference' });
    }

    const data = rows[0];

    // Immediately invalidate timezone cache so next request uses new value
    if (key === 'timezone') {
      invalidateTzPrefCache(userId);
    }

    return res.status(200).json({
      success: true,
      data: data,
    });
  } catch (err) {
    console.error('[UserPreferences] Catch error:', err.message, err.stack);
    return res.status(500).json({ success: false, message: 'Failed to save preference', error: err.message });
  }
});

module.exports = router;
