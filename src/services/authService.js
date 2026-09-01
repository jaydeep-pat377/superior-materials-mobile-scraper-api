const { getPool } = require('../config/database');
const { getAuthPool } = require('../config/authDatabase');
const { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken } = require('../utils/jwtUtils');
const deviceService = require('./deviceService');
const { loadUserAccessData } = require('../middleware/auth');
const bcrypt = require('bcryptjs');

/**
 * Login with email and password using direct PostgreSQL queries
 * @param {string} email - User email
 * @param {string} password - User password
 * @param {Object} deviceInfo - Optional device information
 * @returns {Object} User data and tokens
 */
async function loginWithEmail(email, password, deviceInfo = null) {
  try {
    const pool = getPool();
    const authPool = getAuthPool();
    const normalizedEmail = email.toLowerCase().trim();

    // ---------------------------------------------------------------
    // Pre-auth checks: block users with incomplete signup or pending approval
    // ---------------------------------------------------------------

    // Check if user is still in signup_pending (incomplete signup)
    const { rows: pendingSignup } = await pool.query(
      'SELECT email_verified, phone_number, phone_country_code FROM signup_pending WHERE email = $1 LIMIT 1',
      [normalizedEmail]
    );

    if (pendingSignup && pendingSignup.length > 0) {
      const pending = pendingSignup[0];
      if (!pending.email_verified) {
        throw new Error('Email not verified. Please complete email verification first.');
      }
      if (!pending.phone_number || !pending.phone_country_code) {
        throw new Error('Phone number not verified. Please complete phone verification first.');
      }
      // If pending record exists with email verified but still in table -> phone not verified
      throw new Error('Phone number not verified. Please complete phone verification first.');
    }

    // Check if user exists in database
    const { rows: userProfile } = await pool.query(
      'SELECT active, user_type FROM users WHERE email = $1 LIMIT 1',
      [normalizedEmail]
    );

    if (!userProfile || userProfile.length === 0) {
      throw new Error('User not found');
    }

    // Check admin approval -- ONLY for QR signup users
    const profile = userProfile[0];
    if (profile.user_type === 'QR' && !profile.active) {
      throw new Error('Your account is pending admin approval. You will be notified via email or phone once approved.');
    }

    // ---------------------------------------------------------------
    // Authenticate against auth_tenant.users with bcrypt
    // ---------------------------------------------------------------
    const { rows: authRows } = await authPool.query(
      'SELECT * FROM auth_tenant.users WHERE email = $1 LIMIT 1',
      [normalizedEmail]
    );

    if (!authRows || authRows.length === 0) {
      throw new Error('Invalid email or password');
    }

    const authUser = authRows[0];
    const valid = await bcrypt.compare(password, authUser.password_hash);
    if (!valid) {
      throw new Error('Invalid email or password');
    }

    // Load user access data to determine userType (admin, producer, contractor, none)
    const accessData = await loadUserAccessData(authUser.uuid || authUser.id);

    // Get user metadata
    const user = {
      id: authUser.uuid || authUser.id,
      email: authUser.email,
      phone: authUser.phone_number ? `${authUser.phone_country_code || ''}${authUser.phone_number}` : null,
      role: authUser.user_role || 'user',
      userType: accessData.userType || 'none',
      userRole: accessData.userRole || null,
      metadata: {
        full_name: authUser.full_name,
        phone_number: authUser.phone_number,
        phone_country_code: authUser.phone_country_code
      }
    };

    // Register/update device if device info is provided
    if (deviceInfo) {
      try {
        await deviceService.registerOrUpdateDevice(user.id, deviceInfo);
      } catch (deviceError) {
        // Log device registration error but don't fail login
        console.error('Device registration failed:', deviceError.message);
      }
    }

    // Generate JWT tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    return {
      user,
      accessToken,
      refreshToken
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Login with phone and password using direct PostgreSQL queries
 * @param {string} phone - User phone number
 * @param {string} password - User password
 * @param {Object} deviceInfo - Optional device information
 * @returns {Object} User data and tokens
 */
async function loginWithPhone(phone, password, deviceInfo = null) {
  try {
    const pool = getPool();
    const authPool = getAuthPool();

    // ---------------------------------------------------------------
    // Authenticate against auth_tenant.users by phone with bcrypt
    // ---------------------------------------------------------------
    const fullPhone = phone.replace(/[\s\-+]/g, '');
    const { rows: authRows } = await authPool.query(
      `SELECT * FROM auth_tenant.users
       WHERE REPLACE(REPLACE(REPLACE(COALESCE(phone_country_code, '') || COALESCE(phone_number, ''), '+', ''), '-', ''), ' ', '') = $1
       AND deleted_at IS NULL
       LIMIT 1`,
      [fullPhone]
    );

    if (!authRows || authRows.length === 0) {
      throw new Error('Invalid phone number or password');
    }

    const authUser = authRows[0];
    const valid = await bcrypt.compare(password, authUser.password_hash);
    if (!valid) {
      throw new Error('Invalid phone number or password');
    }

    // ---------------------------------------------------------------
    // Pre-auth check: block users pending admin approval
    // ---------------------------------------------------------------
    if (authUser.email) {
      const { rows: userProfile } = await pool.query(
        'SELECT active FROM users WHERE email = $1 LIMIT 1',
        [authUser.email.toLowerCase()]
      );

      if (userProfile && userProfile.length > 0 && !userProfile[0].active) {
        throw new Error('Your account is pending admin approval. You will be notified via email or phone once approved.');
      }
    }

    // Load user access data to determine userType (admin, producer, contractor, none)
    const accessData = await loadUserAccessData(authUser.uuid || authUser.id);

    // Get user metadata
    const user = {
      id: authUser.uuid || authUser.id,
      email: authUser.email,
      phone: authUser.phone_number ? `${authUser.phone_country_code || ''}${authUser.phone_number}` : null,
      role: authUser.user_role || 'user',
      userType: accessData.userType || 'none',
      userRole: accessData.userRole || null,
      metadata: {
        full_name: authUser.full_name,
        phone_number: authUser.phone_number,
        phone_country_code: authUser.phone_country_code
      }
    };

    // Register/update device if device info is provided
    if (deviceInfo) {
      try {
        await deviceService.registerOrUpdateDevice(user.id, deviceInfo);
      } catch (deviceError) {
        console.error('Device registration failed:', deviceError.message);
      }
    }

    // Generate JWT tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    return {
      user,
      accessToken,
      refreshToken
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Logout user - invalidate session and deactivate device token
 * @param {string} userId - User ID
 * @param {string} accessToken - Access token to invalidate
 * @param {string} deviceToken - Optional device token to deactivate
 * @returns {boolean} Success status
 */
async function logout(userId, accessToken, deviceToken = null) {
  try {
    // Deactivate device token if provided
    if (deviceToken) {
      try {
        await deviceService.deactivateDeviceToken(deviceToken);
      } catch (deviceError) {
        // Log device deactivation error but don't fail logout
        console.error('Device token deactivation failed during logout:', deviceError.message);
      }
    }

    // No-op for JWT-based auth (no server-side sessions to invalidate)
    // In a production system, you might want to:
    // 1. Store blacklisted tokens in Redis/database
    // 2. Invalidate refresh tokens
    // For now, we'll rely on token expiration

    return true;
  } catch (error) {
    throw error;
  }
}

/**
 * Refresh access token using refresh token
 * @param {string} refreshToken - Refresh token
 * @returns {Object} New access token and optionally new refresh token
 */
async function refreshToken(refreshToken) {
  try {
    // Verify refresh token
    const decoded = verifyRefreshToken(refreshToken);

    if (decoded.type !== 'refresh') {
      throw new Error('Invalid token type');
    }

    // Use user data from refresh token (includes id, email, phone, role)
    // The refresh token now contains user information for token refresh
    const userData = {
      id: decoded.id,
      email: decoded.email || null,
      phone: decoded.phone || null,
      role: decoded.role || 'user'
    };
    const newAccessToken = generateAccessToken(userData);

    // Optionally generate new refresh token (token rotation)
    // const newRefreshToken = generateRefreshToken(userData);

    return {
      accessToken: newAccessToken
      // refreshToken: newRefreshToken // Uncomment for token rotation
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Get current user from auth_tenant database by ID
 * @param {string} userId - User ID to look up
 * @returns {Object} User data
 */
async function getCurrentUser(userId) {
  try {
    if (!userId) {
      throw new Error('User not found or session expired');
    }

    const authPool = getAuthPool();
    const { rows } = await authPool.query(
      'SELECT * FROM auth_tenant.users WHERE (uuid = $1 OR id::text = $1) AND deleted_at IS NULL LIMIT 1',
      [userId]
    );

    if (!rows || rows.length === 0) {
      throw new Error('User not found or session expired');
    }

    const user = rows[0];
    return {
      id: user.uuid || user.id,
      email: user.email,
      phone: user.phone_number ? `${user.phone_country_code || ''}${user.phone_number}` : null,
      role: user.user_role || 'user',
      metadata: {
        full_name: user.full_name,
        phone_number: user.phone_number,
        phone_country_code: user.phone_country_code
      },
      createdAt: user.created_at
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Verify JWT token
 * @param {string} token - JWT token
 * @returns {Object} Decoded token data
 */
function verifyToken(token) {
  return verifyAccessToken(token);
}

/**
 * Change user password
 * @param {string} userId - User ID
 * @param {string} userEmail - User email
 * @param {string} currentPassword - Current password
 * @param {string} newPassword - New password
 * @param {string} confirmPassword - Confirm new password
 * @returns {Object} Result object
 */
async function changePassword(userId, userEmail, currentPassword, newPassword, confirmPassword) {
  try {
    // Validate new password and confirm password match
    if (newPassword !== confirmPassword) {
      return {
        success: false,
        error: 'New password and confirm password do not match',
        code: 'PASSWORD_MISMATCH'
      };
    }

    // Validate new password length
    if (!newPassword || newPassword.length < 6) {
      return {
        success: false,
        error: 'New password must be at least 6 characters long',
        code: 'PASSWORD_TOO_SHORT'
      };
    }

    // Validate new password is different from current
    if (currentPassword === newPassword) {
      return {
        success: false,
        error: 'New password must be different from current password',
        code: 'SAME_PASSWORD'
      };
    }

    // Step 1: Verify current password against auth_tenant.users
    const authPool = getAuthPool();
    const { rows: authRows } = await authPool.query(
      'SELECT id, password_hash FROM auth_tenant.users WHERE email = $1 LIMIT 1',
      [userEmail.toLowerCase().trim()]
    );

    if (!authRows || authRows.length === 0) {
      return {
        success: false,
        error: 'Current password is incorrect',
        code: 'INVALID_CURRENT_PASSWORD'
      };
    }

    const validCurrent = await bcrypt.compare(currentPassword, authRows[0].password_hash);
    if (!validCurrent) {
      return {
        success: false,
        error: 'Current password is incorrect',
        code: 'INVALID_CURRENT_PASSWORD'
      };
    }

    // Step 2: Update password in auth_tenant.users
    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    const now = new Date().toISOString();

    await authPool.query(
      'UPDATE auth_tenant.users SET password_hash = $1, updated_at = $2 WHERE id = $3',
      [newPasswordHash, now, authRows[0].id]
    );

    return {
      success: true,
      message: 'Password changed successfully'
    };
  } catch (error) {
    console.error('Error in changePassword:', error.message);
    return {
      success: false,
      error: error.message || 'An unexpected error occurred',
      code: 'UNEXPECTED_ERROR'
    };
  }
}

module.exports = {
  loginWithEmail,
  loginWithPhone,
  logout,
  refreshToken,
  getCurrentUser,
  verifyToken,
  changePassword
};
