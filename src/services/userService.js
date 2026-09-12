const { getPool } = require('../config/database');
const { uploadAvatarToStorage, deleteAvatarFromStorage, AVATARS_BUCKET } = require('./database/storageClient');

// In-memory user profile cache (2-minute TTL)
// getUserProfile is called on every authenticated request via dashboard/controllers
const _userProfileCache = new Map();
const USER_PROFILE_CACHE_TTL_MS = 2 * 60 * 1000;

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _userProfileCache) {
    if (now - entry.timestamp > USER_PROFILE_CACHE_TTL_MS) {
      _userProfileCache.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

function _invalidateProfileCache(userId) {
  _userProfileCache.delete(userId);
}

/**
 * Get user email from auth database (fallback if not in JWT)
 * @param {string} userId - User ID (UUID)
 * @returns {string|null} User email
 */
async function getUserEmailFromAuth(userId) {
  try {
    // The email should come from JWT token in most cases.
    // With central auth, there's no admin API to call.
    return null;
  } catch (error) {
    console.warn('Could not fetch user email from auth:', error.message);
    return null;
  }
}

/**
 * Create user profile in public.users table if it doesn't exist
 * @param {string} userId - User ID (UUID)
 * @param {string} email - User email
 * @returns {Object} Created or existing user profile data
 */
async function createUserProfile(userId, email) {
  try {
    const pool = getPool();

    // First, check if user already exists (race condition protection)
    const { rows: existingRows } = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );

    // If user already exists, return it
    if (existingRows.length > 0) {
      return existingRows[0];
    }

    const now = new Date().toISOString();

    try {
      const { rows } = await pool.query(
        `INSERT INTO users (id, email, full_name, active, created_at, updated_at,
          invitation_status, invitation_sent_at, invitation_token, last_login_at,
          password_reset_at, title, phone_number, phone_country_code)
         VALUES ($1, $2, NULL, false, $3, $3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
         RETURNING *`,
        [userId, email || null, now]
      );

      return rows[0];
    } catch (insertError) {
      // If duplicate key error, user was created between check and insert - fetch it
      if (insertError.code === '23505' || (insertError.message && (insertError.message.includes('duplicate key') || insertError.message.includes('unique constraint')))) {
        // Try by ID first, then by email (email unique constraint means another ID has this email)
        const { rows: existingById } = await pool.query(
          'SELECT * FROM users WHERE id = $1',
          [userId]
        );

        if (existingById.length > 0) {
          return existingById[0];
        }

        if (email) {
          const { rows: existingByEmail } = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
          );

          if (existingByEmail.length > 0) {
            return existingByEmail[0];
          }
        }
      }
      throw new Error(insertError.message || 'Failed to create user profile');
    }
  } catch (error) {
    throw error;
  }
}

/**
 * Get user's company from user_customers table joined with customers
 * @param {string} userId - User ID (UUID)
 * @returns {string|null} Company name or null if not found
 */
async function getUserCompany(userId) {
  try {
    const pool = getPool();

    const { rows } = await pool.query(
      `SELECT c.name FROM user_customers uc
       INNER JOIN customers c ON c.id = uc.customer_id
       WHERE uc.user_id = $1 LIMIT 1`,
      [userId]
    );

    if (rows.length === 0) return null;
    return rows[0].name || null;
  } catch (error) {
    console.warn('Could not fetch user company:', error.message);
    return null;
  }
}

/**
 * Get user profile from public.users table, creating it if it doesn't exist
 * @param {string} userId - User ID (UUID)
 * @param {string} userEmail - User email (optional, will be fetched if not provided)
 * @returns {Object} User profile data
 */
async function getUserProfile(userId, userEmail = null) {
  try {
    // Check cache first (avoids 2 DB queries on every authenticated request)
    const cached = _userProfileCache.get(userId);
    if (cached && (Date.now() - cached.timestamp) < USER_PROFILE_CACHE_TTL_MS) {
      return cached.data;
    }

    const pool = getPool();

    const { rows } = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );

    const data = rows[0] || null;

    if (!data) {
      // User not found by ID - check if they exist by email (ID may have changed via central auth migration)
      console.log(`User profile not found for ${userId}, checking by email...`);

      let email = userEmail;
      if (!email) {
        email = await getUserEmailFromAuth(userId);
      }

      if (email) {
        const { rows: emailRows } = await pool.query(
          'SELECT * FROM users WHERE email = $1',
          [email]
        );
        const existingByEmail = emailRows[0] || null;

        if (existingByEmail) {
          // User exists with a different ID (old auth vs new central auth)
          // Return existing profile as-is — cannot update users.id due to FK constraints from user_roles/user_customers
          console.log(`User found by email ${email} with old ID ${existingByEmail.id} (new auth ID: ${userId})`);
          const company = await getUserCompany(existingByEmail.id);
          const profile = formatUserProfile(existingByEmail, company);
          _userProfileCache.set(userId, { data: profile, timestamp: Date.now() });
          return profile;
        }
      }

      // Truly new user — create profile
      console.log(`No existing user found, creating new profile for ${userId}`);
      const newUserData = await createUserProfile(userId, email);
      const company = await getUserCompany(userId);
      const profile = formatUserProfile(newUserData, company);
      _userProfileCache.set(userId, { data: profile, timestamp: Date.now() });
      return profile;
    }

    // Get company from user_customers
    const company = await getUserCompany(userId);

    const profile = formatUserProfile(data, company);
    _userProfileCache.set(userId, { data: profile, timestamp: Date.now() });
    return profile;
  } catch (error) {
    throw error;
  }
}

/**
 * Format user profile data for API response
 * @param {Object} data - Raw user data from database
 * @param {string|null} company - Company name from user_customers
 * @returns {Object} Formatted user profile
 */
function formatUserProfile(data, company = null) {
  // Parse full_name into first_name and last_name
  let firstName = '';
  let lastName = '';
  if (data.full_name) {
    const nameParts = data.full_name.trim().split(/\s+/);
    firstName = nameParts[0] || '';
    lastName = nameParts.slice(1).join(' ') || '';
  }

  // Format phone number with country code
  let phone = '';
  if (data.phone_number) {
    phone = data.phone_country_code
      ? `${data.phone_country_code}${data.phone_number}`
      : data.phone_number;
  }

  return {
    id: data.id,
    email: data.email,
    firstName,
    lastName,
    fullName: data.full_name || '',
    phone,
    phoneNumber: data.phone_number || '',
    phoneCountryCode: data.phone_country_code || '',
    title: data.title || '',
    company: company || null,
    active: data.active || false,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    avatarUrl: data.avatar_url || null,
    // Tenant volume unit (m³ for CBM, CY for US). Shared mobile app renders this.
    volumeUnit: process.env.VOLUME_UNIT || 'CY'
  };
}

/**
 * Update user profile in public.users table
 * @param {string} userId - User ID (UUID)
 * @param {Object} profileData - Profile data to update
 * @returns {Object} Updated user profile data
 */
async function updateUserProfile(userId, profileData, userEmail = null) {
  try {
    const pool = getPool();

    // Ensure user profile exists before updating
    let currentProfile;
    try {
      currentProfile = await getUserProfile(userId, userEmail);
    } catch (error) {
      // If profile doesn't exist, create it first
      if (error.message === 'User profile not found') {
        let email = userEmail;
        if (!email) {
          email = await getUserEmailFromAuth(userId);
        }
        await createUserProfile(userId, email);
        currentProfile = await getUserProfile(userId, email);
      } else {
        throw error;
      }
    }

    // Build update object
    const updateData = {};

    // Handle name - combine first_name and last_name into full_name
    if (profileData.firstName !== undefined || profileData.lastName !== undefined) {
      const firstName = profileData.firstName !== undefined ? profileData.firstName : currentProfile.firstName;
      const lastName = profileData.lastName !== undefined ? profileData.lastName : currentProfile.lastName;

      if (firstName || lastName) {
        updateData.full_name = `${firstName || ''} ${lastName || ''}`.trim();
      } else {
        updateData.full_name = null;
      }
    } else if (profileData.fullName !== undefined) {
      updateData.full_name = profileData.fullName || null;
    }

    // Handle phone - split phone into phone_number and phone_country_code
    if (profileData.phone !== undefined) {
      if (profileData.phone) {
        // Try to extract country code (common formats: +1, +44, etc.)
        const phoneMatch = profileData.phone.match(/^(\+\d{1,4})?(.+)$/);
        if (phoneMatch && phoneMatch[1]) {
          updateData.phone_country_code = phoneMatch[1];
          updateData.phone_number = phoneMatch[2].replace(/\D/g, ''); // Remove non-digits
        } else {
          updateData.phone_country_code = null;
          updateData.phone_number = profileData.phone.replace(/\D/g, ''); // Remove non-digits
        }
      } else {
        updateData.phone_number = null;
        updateData.phone_country_code = null;
      }
    } else {
      // Handle separate phone_number and phone_country_code
      if (profileData.phoneNumber !== undefined) {
        updateData.phone_number = profileData.phoneNumber ? profileData.phoneNumber.replace(/\D/g, '') : null;
      }
      if (profileData.phoneCountryCode !== undefined) {
        updateData.phone_country_code = profileData.phoneCountryCode || null;
      }
    }

    // Handle title
    if (profileData.title !== undefined) {
      updateData.title = profileData.title || null;
    }

    // Note: company is read-only, managed via user_customers table

    // Handle avatar URL (if column exists in schema)
    if (profileData.avatarUrl !== undefined) {
      updateData.avatar_url = profileData.avatarUrl || null;
    }

    // Check if there's anything to update
    if (Object.keys(updateData).length === 0) {
      // No fields to update, return current profile
      return currentProfile;
    }

    // Update updated_at will be handled by trigger, but we can set it explicitly if needed
    updateData.updated_at = new Date().toISOString();

    // Perform update.
    // Use the RESOLVED public.users id (currentProfile.id), not the raw central-auth
    // userId. Users created via central auth carry a different public.users id and are
    // matched by email in getUserProfile(); updating by the central userId matches 0 rows.
    const targetUserId = currentProfile?.id || userId;

    // Build dynamic SET clause
    const keys = Object.keys(updateData);
    const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
    const values = keys.map(key => updateData[key]);
    values.push(targetUserId);

    const { rows } = await pool.query(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );

    if (rows.length === 0) {
      console.error('Update returned no data for user:', userId);
      throw new Error('User profile not found or update failed');
    }

    _invalidateProfileCache(userId);
    return formatUserProfile(rows[0]);
  } catch (error) {
    console.error('Error in updateUserProfile:', error);
    throw error;
  }
}

/**
 * Check if user exists in public.users table
 * @param {string} userId - User ID (UUID)
 * @returns {boolean} True if user exists
 */
async function userExists(userId) {
  try {
    const pool = getPool();

    const { rows } = await pool.query(
      'SELECT id FROM users WHERE id = $1 LIMIT 1',
      [userId]
    );

    return rows.length > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Upload user avatar image to storage and save URL in database
 * @param {string} userId - User ID (UUID)
 * @param {Buffer} fileBuffer - Raw image buffer
 * @param {string} mimeType - MIME type of the image
 * @param {string} originalName - Original filename
 * @returns {Object} Updated user profile
 */
/**
 * Resolve the actual public.users row id for an authenticated user. Users created
 * via central auth carry a different public.users id (matched by email), so callers
 * must not assume req.user.id === public.users.id. Falls back to userId.
 */
async function resolveUserRowId(pool, userId, userEmail = null) {
  const { rows: byId } = await pool.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [userId]);
  if (byId.length > 0) return byId[0].id;
  if (userEmail) {
    const { rows: byEmail } = await pool.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [userEmail]);
    if (byEmail.length > 0) return byEmail[0].id;
  }
  return userId;
}

async function uploadUserAvatar(userId, fileBuffer, mimeType, originalName, userEmail = null) {
  const pool = getPool();
  const rowId = await resolveUserRowId(pool, userId, userEmail);

  // Get current avatar URL to clean up old file
  const { rows: currentRows } = await pool.query(
    'SELECT avatar_url FROM users WHERE id = $1 LIMIT 1',
    [rowId]
  );
  const currentUser = currentRows[0] || null;

  // Delete old avatar from storage if it exists in our bucket
  if (currentUser && currentUser.avatar_url && currentUser.avatar_url.includes(AVATARS_BUCKET)) {
    try {
      // Extract path from the public URL: everything after /avatars/
      const urlParts = currentUser.avatar_url.split(`/${AVATARS_BUCKET}/`);
      if (urlParts[1]) {
        await deleteAvatarFromStorage(urlParts[1]);
      }
    } catch (err) {
      console.warn('Could not delete old avatar:', err.message);
    }
  }

  // Upload new avatar
  const { publicUrl } = await uploadAvatarToStorage(rowId, fileBuffer, mimeType, originalName);

  // Update avatar_url in the users table
  const { rows } = await pool.query(
    'UPDATE users SET avatar_url = $1, updated_at = $2 WHERE id = $3 RETURNING *',
    [publicUrl, new Date().toISOString(), rowId]
  );

  if (rows.length === 0) {
    throw new Error('Failed to update avatar URL');
  }

  _invalidateProfileCache(userId);
  const company = await getUserCompany(rowId);
  return formatUserProfile(rows[0], company);
}

/**
 * Remove user avatar - delete from storage and clear URL in database
 * @param {string} userId - User ID (UUID)
 * @returns {Object} Updated user profile
 */
async function removeUserAvatar(userId, userEmail = null) {
  const pool = getPool();
  const rowId = await resolveUserRowId(pool, userId, userEmail);

  // Get current avatar URL
  const { rows: currentRows } = await pool.query(
    'SELECT avatar_url FROM users WHERE id = $1 LIMIT 1',
    [rowId]
  );
  const currentUser = currentRows[0] || null;

  // Delete from storage if it exists in our bucket
  if (currentUser && currentUser.avatar_url && currentUser.avatar_url.includes(AVATARS_BUCKET)) {
    try {
      const urlParts = currentUser.avatar_url.split(`/${AVATARS_BUCKET}/`);
      if (urlParts[1]) {
        await deleteAvatarFromStorage(urlParts[1]);
      }
    } catch (err) {
      console.warn('Could not delete avatar from storage:', err.message);
    }
  }

  // Clear avatar_url in database
  const { rows } = await pool.query(
    'UPDATE users SET avatar_url = NULL, updated_at = $1 WHERE id = $2 RETURNING *',
    [new Date().toISOString(), rowId]
  );

  if (rows.length === 0) {
    throw new Error('Failed to remove avatar');
  }

  _invalidateProfileCache(userId);
  const company = await getUserCompany(rowId);
  return formatUserProfile(rows[0], company);
}

module.exports = {
  getUserProfile,
  updateUserProfile,
  uploadUserAvatar,
  removeUserAvatar,
  userExists,
  getUserCompany
};

