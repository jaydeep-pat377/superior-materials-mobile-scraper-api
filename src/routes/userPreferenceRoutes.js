const express = require('express');
const router = express.Router();
const { authenticate, invalidateTzPrefCache } = require('../middleware/auth');
const { getPool } = require('../config/database');

// Resolve central-auth UUID to the UUID that exists in users/auth.users (FK target)
async function resolveDbUserId(jwtUserId, email) {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COALESCE(
        (SELECT id FROM users WHERE id = $1::uuid),
        (SELECT id FROM users WHERE LOWER(email) = LOWER($2) LIMIT 1)
      ) as resolved_id`, [jwtUserId, email || '']
    );
    return rows?.[0]?.resolved_id || jwtUserId;
  } catch { return jwtUserId; }
}

/**
 * @route   GET /api/user-preferences/:key
 * @desc    Get a single user preference by key
 * @access  Private
 */
router.get('/:key', authenticate, async (req, res) => {
  try {
    const userId = await resolveDbUserId(req.user.id, req.user.email);
    const { key } = req.params;

    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT preference_value FROM user_preferences WHERE user_id = $1 AND preference_key = $2 LIMIT 1',
      [userId, key]
    );

    return res.status(200).json({
      success: true,
      data: rows[0] ? rows[0].preference_value : null,
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
    const userId = await resolveDbUserId(req.user.id, req.user.email);
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      return res.status(400).json({ success: false, message: 'value is required' });
    }

    const pool = getPool();
    // JSON.stringify + ::jsonb handles any value type (string/number/boolean/object/array)
    const { rows } = await pool.query(
      `INSERT INTO user_preferences (user_id, preference_key, preference_value, updated_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (user_id, preference_key)
       DO UPDATE SET preference_value = EXCLUDED.preference_value, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [userId, key, JSON.stringify(value), new Date().toISOString()]
    );

    const data = rows[0] || null;

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
