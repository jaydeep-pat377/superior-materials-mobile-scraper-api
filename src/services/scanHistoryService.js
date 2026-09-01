/**
 * Scan History Service
 *
 * CRUD operations for user-scoped QR scan history.
 */

const { getPool } = require('../config/database');

const TABLE = 'scan_history';

/**
 * Get paginated scan records for a user, newest first.
 * @param {string} userId
 * @param {number} page - 1-based page number (default 1)
 * @param {number} limit - records per page (default 20, max 100)
 */
async function getHistory(userId, page = 1, limit = 20) {
  const pool = getPool();
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);
  const offset = (pageNum - 1) * limitNum;

  try {
    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM ${TABLE} WHERE user_id = $1`,
      [userId]
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated data
    const { rows } = await pool.query(
      `SELECT * FROM ${TABLE} WHERE user_id = $1 ORDER BY timestamp DESC LIMIT $2 OFFSET $3`,
      [userId, limitNum, offset]
    );

    console.log('[ScanHistory] getHistory -- userId:', userId, '| records:', rows?.length, '| count:', total, '| page:', pageNum, '| offset:', offset, '| limit:', limitNum);

    const totalPages = Math.ceil(total / limitNum);

    return {
      records: (rows || []).map(mapRowToRecord),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: totalPages,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1,
      },
    };
  } catch (err) {
    console.error('[ScanHistory] getHistory error:', err.message);
    throw new Error('Failed to fetch scan history');
  }
}

/**
 * Save a new scan record.
 */
async function saveScan(userId, record) {
  const pool = getPool();

  const row = {
    user_id: userId,
    scan_id: record.id,
    data: record.data,
    type: record.type || 'qr',
    timestamp: record.timestamp,
    label: record.label || null,
    verified: record.verified || null,
    tk_data: record.tkData || null,
    api_data: record.apiData || null,
  };

  try {
    const { rows } = await pool.query(
      `INSERT INTO ${TABLE} (user_id, scan_id, data, type, timestamp, label, verified, tk_data, api_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, scan_id) DO UPDATE SET
         data = EXCLUDED.data,
         type = EXCLUDED.type,
         timestamp = EXCLUDED.timestamp,
         label = EXCLUDED.label,
         verified = EXCLUDED.verified,
         tk_data = EXCLUDED.tk_data,
         api_data = EXCLUDED.api_data
       RETURNING *`,
      [row.user_id, row.scan_id, row.data, row.type, row.timestamp, row.label, row.verified, row.tk_data, row.api_data]
    );

    return mapRowToRecord(rows[0]);
  } catch (err) {
    console.error('[ScanHistory] saveScan error:', err.message);
    throw new Error('Failed to save scan record');
  }
}

/**
 * Delete a single scan record by client scan_id.
 */
async function deleteScan(userId, scanId) {
  const pool = getPool();

  try {
    const result = await pool.query(
      `DELETE FROM ${TABLE} WHERE user_id = $1 AND scan_id = $2`,
      [userId, scanId]
    );

    return { deleted: result.rowCount || 1 };
  } catch (err) {
    console.error('[ScanHistory] deleteScan error:', err.message);
    throw new Error('Failed to delete scan record');
  }
}

/**
 * Clear all scan history for a user.
 */
async function clearHistory(userId) {
  const pool = getPool();

  try {
    const result = await pool.query(
      `DELETE FROM ${TABLE} WHERE user_id = $1`,
      [userId]
    );

    return { deleted: result.rowCount || 0 };
  } catch (err) {
    console.error('[ScanHistory] clearHistory error:', err.message);
    throw new Error('Failed to clear scan history');
  }
}

/**
 * Map a database row to the ScanRecord shape expected by the mobile app.
 */
function mapRowToRecord(row) {
  return {
    id: row.scan_id,
    data: row.data,
    type: row.type,
    timestamp: row.timestamp,
    label: row.label || undefined,
    verified: row.verified || undefined,
    tkData: row.tk_data || undefined,
    apiData: row.api_data || undefined,
  };
}

module.exports = {
  getHistory,
  saveScan,
  deleteScan,
  clearHistory,
};
