const { getNotificationPool } = require('../config/notificationDatabase');

/**
 * Get notifications for a user filtered by tenant with pagination.
 *
 * userId can be a single UUID or an array of UUIDs (to handle central auth
 * vs tenant-local UUID mismatch — notifications may be stored under either).
 *
 * @param {string|string[]} userId - User UUID(s)
 * @param {number} tenantId - Tenant ID
 * @param {number} page - Page number (1-based)
 * @param {number} limit - Results per page (default 50)
 * @returns {Object} { notifications, total, page, limit, totalPages }
 */
async function getNotifications(userId, tenantId, page = 1, limit = 50) {
  const pool = getNotificationPool();

  const offset = (page - 1) * limit;

  // Support querying by multiple user UUIDs
  const userIds = Array.isArray(userId) ? userId : [userId];
  const uniqueIds = [...new Set(userIds.filter(Boolean))];

  let countWhere = 'WHERE user_id = ANY($1)';
  const countParams = [uniqueIds];
  if (tenantId) {
    countParams.push(tenantId);
    countWhere += ` AND tenant_id = $${countParams.length}`;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) AS total FROM notification_queue ${countWhere}`,
    countParams
  );
  const total = parseInt(countResult.rows[0]?.total || '0', 10);

  const dataParams = [...countParams, limit, offset];
  const { rows } = await pool.query(
    `SELECT * FROM notification_queue ${countWhere}
     ORDER BY created_at DESC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );

  return {
    notifications: rows || [],
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
}

/**
 * Get the authenticated user's recent notifications (across the tenant), paginated.
 * Filters by user_id only (the central JWT id, which is how notification_queue.user_id
 * is keyed) -- used by the mobile Notifications screen (GET /api/notifications/recent).
 * @param {string} userId - User UUID (central auth id)
 * @param {number} page
 * @param {number} limit
 */
async function getRecentNotifications(userId, page = 1, limit = 20) {
  const pool = getNotificationPool();

  const offset = (page - 1) * limit;

  // Get total count
  const countResult = await pool.query(
    'SELECT COUNT(*) AS total FROM notification_queue WHERE user_id = $1',
    [userId]
  );
  const total = parseInt(countResult.rows[0].total, 10);

  // Get paginated data
  const { rows } = await pool.query(
    `SELECT * FROM notification_queue
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  return {
    notifications: rows || [],
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
}

/**
 * Mark a single notification as read by queue_uuid
 */
async function markAsRead(queueUuid, userId) {
  const pool = getNotificationPool();
  const now = new Date().toISOString();
  const { rows } = await pool.query(
    `UPDATE notification_queue
     SET status = 'delivered', delivered_at = $1, updated_at = $1
     WHERE queue_uuid = $2 AND user_id = $3
     RETURNING *`,
    [now, queueUuid, userId]
  );

  if (!rows || rows.length === 0) {
    throw new Error('Notification not found');
  }
  return rows[0];
}

/**
 * Mark all notifications as read for a user in a tenant
 */
async function markAllAsRead(userId, tenantId) {
  const pool = getNotificationPool();
  const now = new Date().toISOString();
  const { rows } = await pool.query(
    `UPDATE notification_queue
     SET status = 'delivered', delivered_at = $1, updated_at = $1
     WHERE user_id = $2 AND tenant_id = $3 AND status = 'pending'
     RETURNING id`,
    [now, userId, tenantId]
  );

  return { updated: rows?.length || 0 };
}

module.exports = {
  getNotifications,
  getRecentNotifications,
  markAsRead,
  markAllAsRead
};
