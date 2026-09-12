const { getNotificationPool } = require('../config/notificationDatabase');

/**
 * Get notifications for a user filtered by tenant with pagination
 * @param {string} userId - User UUID
 * @param {number} tenantId - Tenant ID
 * @param {number} page - Page number (1-based)
 * @param {number} limit - Results per page (default 50)
 * @returns {Object} { notifications, total, page, limit, totalPages }
 */
async function getNotifications(userId, tenantId, page = 1, limit = 50) {
  const pool = getNotificationPool();

  const offset = (page - 1) * limit;

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      'SELECT * FROM notification_queue WHERE user_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4',
      [userId, tenantId, limit, offset]
    ),
    pool.query(
      'SELECT COUNT(*) FROM notification_queue WHERE user_id = $1 AND tenant_id = $2',
      [userId, tenantId]
    )
  ]);

  const total = parseInt(countResult.rows[0].count, 10) || 0;

  return {
    notifications: dataResult.rows || [],
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
}

/**
 * Get the authenticated user's recent notifications (across the tenant), paginated.
 * Filters by user_id only (the central JWT id, which is how notification_queue.user_id
 * is keyed) — used by the mobile Notifications screen (GET /api/notifications/recent).
 * @param {string} userId - User UUID (central auth id)
 * @param {number} page
 * @param {number} limit
 */
async function getRecentNotifications(userId, page = 1, limit = 20) {
  const pool = getNotificationPool();

  const offset = (page - 1) * limit;

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      'SELECT * FROM notification_queue WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [userId, limit, offset]
    ),
    pool.query(
      'SELECT COUNT(*) FROM notification_queue WHERE user_id = $1',
      [userId]
    )
  ]);

  const total = parseInt(countResult.rows[0].count, 10) || 0;

  return {
    notifications: dataResult.rows || [],
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
