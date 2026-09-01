const { getPool } = require('../config/database');

/**
 * Get plant_ids for a user based on their roles
 * Flow: user_id -> user_roles -> role_plants -> plant_ids
 * @param {string} userId - User UUID
 * @returns {Array<number>} Array of plant_ids the user has access to
 */
async function getUserPlantIds(userId) {
  const pool = getPool();

  // Get role_ids for the user from user_roles table
  const { rows: userRoles } = await pool.query(
    'SELECT role_id FROM user_roles WHERE user_id = $1',
    [userId]
  );

  if (!userRoles || userRoles.length === 0) {
    return [];
  }

  const roleIds = userRoles.map(ur => ur.role_id);

  // Get plant_ids for those roles from role_plants table
  const { rows: rolePlants } = await pool.query(
    'SELECT plant_id FROM role_plants WHERE role_id = ANY($1)',
    [roleIds]
  );

  if (!rolePlants || rolePlants.length === 0) {
    return [];
  }

  // Return unique plant_ids
  const plantIds = [...new Set(rolePlants.map(rp => rp.plant_id))];
  return plantIds;
}

/**
 * Get announcements for a specific user based on their plant access
 * Filters by: published=true, plant_ids overlap, and optionally active dates
 * @param {string} userId - User UUID
 * @param {Object} filters - Filter options
 * @param {boolean} filters.active - If true, only active announcements (current date within start/end date)
 * @param {number} page - Page number (1-based)
 * @param {number} limit - Results per page (default 50)
 * @returns {Object} { announcements, total, page, limit, totalPages, userPlantIds }
 */
async function getAnnouncementsForUser(userId, filters = {}, page = 1, limit = 50) {
  const pool = getPool();

  // Get user's plant_ids
  const userPlantIds = await getUserPlantIds(userId);

  if (userPlantIds.length === 0) {
    return {
      announcements: [],
      total: 0,
      page,
      limit,
      totalPages: 0,
      userPlantIds: []
    };
  }

  const offset = (page - 1) * limit;
  const now = new Date().toISOString();

  // Build query for published announcements
  // that have at least one plant_id matching user's plant_ids
  let conditions = 'WHERE published = true AND plant_ids && $1';
  const params = [userPlantIds];
  let paramIdx = 2;

  // Filter by active status (current date within start_date and end_date)
  if (filters.active === true) {
    // Active: start_date <= now AND end_date >= now (or null)
    conditions += ` AND (start_date IS NULL OR start_date <= $${paramIdx})`;
    params.push(now);
    paramIdx++;
    conditions += ` AND (end_date IS NULL OR end_date >= $${paramIdx})`;
    params.push(now);
    paramIdx++;
  } else if (filters.active === false) {
    // Inactive: start_date > now OR end_date < now
    conditions += ` AND (start_date > $${paramIdx} OR end_date < $${paramIdx})`;
    params.push(now);
    paramIdx++;
  }
  // If filters.active is undefined, return all (no date filter)

  // Get total count
  const countResult = await pool.query(
    `SELECT COUNT(*) AS total FROM announcements ${conditions}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  // Get paginated data
  const dataParams = [...params, limit, offset];
  const { rows } = await pool.query(
    `SELECT * FROM announcements ${conditions} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    dataParams
  );

  return {
    announcements: rows || [],
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    userPlantIds
  };
}

/**
 * Get all announcements with optional filters and pagination
 * @param {Object} filters - Filter options
 * @param {boolean} filters.published - Filter by published status
 * @param {number} filters.plant_id - Filter by plant_id (checks if plant_id is in plant_ids array)
 * @param {boolean} filters.active - Filter by active announcements (current date between start_date and end_date)
 * @param {number} page - Page number (1-based)
 * @param {number} limit - Results per page (default 50)
 * @returns {Object} { announcements, total, page, limit, totalPages }
 */
async function getAnnouncements(filters = {}, page = 1, limit = 50) {
  const pool = getPool();

  const offset = (page - 1) * limit;

  let conditions = 'WHERE 1=1';
  const params = [];
  let paramIdx = 1;

  // Filter by published status
  if (filters.published !== undefined) {
    conditions += ` AND published = $${paramIdx}`;
    params.push(filters.published);
    paramIdx++;
  }

  // Filter by plant_id (check if plant_id is in plant_ids array)
  if (filters.plant_id) {
    conditions += ` AND plant_ids @> $${paramIdx}`;
    params.push([parseInt(filters.plant_id, 10)]);
    paramIdx++;
  }

  // Filter by active announcements (current date between start_date and end_date)
  if (filters.active) {
    const now = new Date().toISOString();
    conditions += ` AND (start_date IS NULL OR start_date <= $${paramIdx})`;
    params.push(now);
    paramIdx++;
    conditions += ` AND (end_date IS NULL OR end_date >= $${paramIdx})`;
    params.push(now);
    paramIdx++;
  }

  // Get total count
  const countResult = await pool.query(
    `SELECT COUNT(*) AS total FROM announcements ${conditions}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  // Get paginated data
  const dataParams = [...params, limit, offset];
  const { rows } = await pool.query(
    `SELECT * FROM announcements ${conditions} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    dataParams
  );

  return {
    announcements: rows || [],
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
}

/**
 * Get a single announcement by ID
 * @param {number} id - Announcement ID
 * @returns {Object} Announcement object
 */
async function getAnnouncementById(id) {
  const pool = getPool();

  const { rows } = await pool.query(
    'SELECT * FROM announcements WHERE id = $1 LIMIT 1',
    [id]
  );

  return rows[0] || null;
}

/**
 * Create a new announcement
 * @param {Object} announcementData - Announcement data
 * @returns {Object} Created announcement
 */
async function createAnnouncement(announcementData) {
  const pool = getPool();

  const keys = Object.keys(announcementData);
  const values = Object.values(announcementData);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const columns = keys.join(', ');

  const { rows } = await pool.query(
    `INSERT INTO announcements (${columns}) VALUES (${placeholders}) RETURNING *`,
    values
  );

  return rows[0];
}

/**
 * Update an existing announcement
 * @param {number} id - Announcement ID
 * @param {Object} announcementData - Updated announcement data
 * @returns {Object} Updated announcement
 */
async function updateAnnouncement(id, announcementData) {
  const pool = getPool();

  const keys = Object.keys(announcementData);
  const values = Object.values(announcementData);
  const setClauses = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');

  const { rows } = await pool.query(
    `UPDATE announcements SET ${setClauses} WHERE id = $${keys.length + 1} RETURNING *`,
    [...values, id]
  );

  return rows[0] || null;
}

/**
 * Delete an announcement
 * @param {number} id - Announcement ID
 * @returns {boolean} True if deleted successfully
 */
async function deleteAnnouncement(id) {
  const pool = getPool();

  await pool.query(
    'DELETE FROM announcements WHERE id = $1',
    [id]
  );

  return true;
}

module.exports = {
  getAnnouncements,
  getAnnouncementById,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  getUserPlantIds,
  getAnnouncementsForUser
};
