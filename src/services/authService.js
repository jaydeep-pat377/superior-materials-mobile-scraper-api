const { getPool } = require('../config/database');
const { getAuthPool } = require('../config/authDatabase');
const { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken } = require('../utils/jwtUtils');
const { verifyPassword, hashPassword } = require('../utils/encryptionUtils');
const deviceService = require('./deviceService');
const { loadUserAccessData } = require('../middleware/auth');

/**
 * Login with email and password using bcrypt verification against auth_tenant.users
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
    // Authenticate with bcrypt against auth_tenant.users
    // ---------------------------------------------------------------
    const { rows: authUsers } = await authPool.query(
      `SELECT id, uuid, email, phone_number, password_hash, full_name, active
       FROM auth_tenant.users
       WHERE email = $1 AND deleted_at IS NULL
       LIMIT 1`,
      [normalizedEmail]
    );

    if (!authUsers || authUsers.length === 0) {
      throw new Error('Invalid email or password');
    }

    const authUser = authUsers[0];

    const passwordValid = await verifyPassword(password, authUser.password_hash);
    if (!passwordValid) {
      throw new Error('Invalid email or password');
    }

    // Use the user's UUID as the ID (consistent with existing login behavior)
    const userId = authUser.uuid;

    // Load user access data to determine userType (admin, producer, contractor, none)
    const accessData = await loadUserAccessData(userId);

    // Get user metadata
    const user = {
      id: userId,
      email: authUser.email,
      phone: authUser.phone_number || '',
      role: 'authenticated',
      userType: accessData.userType || 'none',
      userRole: accessData.userRole || null,
      metadata: {
        full_name: authUser.full_name
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
 * Login with phone and password using bcrypt verification against auth_tenant.users
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
    // Authenticate with bcrypt against auth_tenant.users by phone
    // ---------------------------------------------------------------
    const { rows: authUsers } = await authPool.query(
      `SELECT id, uuid, email, phone_number, phone_country_code, password_hash, full_name, active
       FROM auth_tenant.users
       WHERE phone_number = $1 AND deleted_at IS NULL
       LIMIT 1`,
      [phone]
    );

    // If not found by phone_number alone, try matching with country code prefix
    let authUser = authUsers && authUsers.length > 0 ? authUsers[0] : null;

    if (!authUser) {
      // Try matching phone with country code concatenation
      const { rows: authUsers2 } = await authPool.query(
        `SELECT id, uuid, email, phone_number, phone_country_code, password_hash, full_name, active
         FROM auth_tenant.users
         WHERE CONCAT(phone_country_code, phone_number) = $1 AND deleted_at IS NULL
         LIMIT 1`,
        [phone]
      );
      authUser = authUsers2 && authUsers2.length > 0 ? authUsers2[0] : null;
    }

    if (!authUser) {
      throw new Error('Invalid phone number or password');
    }

    const passwordValid = await verifyPassword(password, authUser.password_hash);
    if (!passwordValid) {
      throw new Error('Invalid phone number or password');
    }

    // Pre-auth check: block users pending admin approval
    if (authUser.email) {
      const { rows: userProfile } = await pool.query(
        'SELECT active FROM users WHERE email = $1 LIMIT 1',
        [authUser.email.toLowerCase()]
      );

      if (userProfile && userProfile.length > 0 && !userProfile[0].active) {
        throw new Error('Your account is pending admin approval. You will be notified via email or phone once approved.');
      }
    }

    const userId = authUser.uuid;

    // Load user access data to determine userType (admin, producer, contractor, none)
    const accessData = await loadUserAccessData(userId);

    // Get user metadata
    const user = {
      id: userId,
      email: authUser.email,
      phone: authUser.phone_number || '',
      role: 'authenticated',
      userType: accessData.userType || 'none',
      userRole: accessData.userRole || null,
      metadata: {
        full_name: authUser.full_name
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
 * Logout user - deactivate device token
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
        console.error('Device token deactivation failed during logout:', deviceError.message);
      }
    }

    // In a production system, you might want to:
    // 1. Store blacklisted tokens in Redis/database
    // 2. Invalidate refresh tokens
    // For now, we rely on token expiration

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
 * Get current user from auth_tenant.users by UUID
 * @param {string} userId - User UUID
 * @returns {Object} User data
 */
async function getCurrentUser(userId) {
  try {
    if (!userId) {
      throw new Error('User not found or session expired');
    }

    const authPool = getAuthPool();
    const { rows } = await authPool.query(
      `SELECT id, uuid, email, phone_number, full_name, user_role, created_at
       FROM auth_tenant.users
       WHERE uuid = $1 AND deleted_at IS NULL
       LIMIT 1`,
      [userId]
    );

    if (!rows || rows.length === 0) {
      throw new Error('User not found or session expired');
    }

    const user = rows[0];
    return {
      id: user.uuid,
      email: user.email,
      phone: user.phone_number || '',
      role: user.user_role || 'user',
      metadata: {
        full_name: user.full_name
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
 * @param {string} userId - User UUID
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
    const normalizedEmail = userEmail.toLowerCase().trim();

    const { rows } = await authPool.query(
      `SELECT id, uuid, password_hash FROM auth_tenant.users
       WHERE email = $1 AND deleted_at IS NULL
       LIMIT 1`,
      [normalizedEmail]
    );

    if (!rows || rows.length === 0) {
      return {
        success: false,
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      };
    }

    const authUser = rows[0];
    const passwordValid = await verifyPassword(currentPassword, authUser.password_hash);

    if (!passwordValid) {
      return {
        success: false,
        error: 'Current password is incorrect',
        code: 'INVALID_CURRENT_PASSWORD'
      };
    }

    // Step 2: Update password in auth_tenant.users
    const newHash = await hashPassword(newPassword);
    const { rowCount } = await authPool.query(
      `UPDATE auth_tenant.users
       SET password_hash = $1, updated_at = $2
       WHERE id = $3`,
      [newHash, new Date().toISOString(), authUser.id]
    );

    if (rowCount === 0) {
      console.error('Error updating password: no rows updated');
      return {
        success: false,
        error: 'Failed to update password. Please try again.',
        code: 'UPDATE_FAILED'
      };
    }

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
