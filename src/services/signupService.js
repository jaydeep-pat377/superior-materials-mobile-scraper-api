const { getPool } = require('../config/database');
const { getAuthPool } = require('../config/authDatabase');
const { requestEmailOtp, requestPhoneOtp, verifyOtp, isVerified } = require('./otpService');
const { hashPassword } = require('../utils/encryptionUtils');
const crypto = require('crypto');

/**
 * Normalize phone number for comparison -- strips +, spaces, dashes
 */
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/[\s\-+]/g, '');
}

/** Check if two phone numbers are the same (format-agnostic) */
function phonesMatch(a, b) {
  return normalizePhone(a) === normalizePhone(b);
}

/**
 * Step 1: Initial signup - collect basic info and send email OTP
 *
 * Creates a pending signup record in signup_pending table and sends
 * an email OTP. The user is NOT created until both email and phone
 * are verified.
 *
 * Password is NOT required at signup. Users set their own password
 * in Step 5 after email and phone verification.
 *
 * @param {Object} params
 * @param {string} params.email
 * @param {string} params.full_name
 * @returns {Object} { success, message, error, code }
 */
async function signup({ email, full_name }) {
  const pool = getPool();
  const authPool = getAuthPool();
  const normalizedEmail = email.toLowerCase().trim();

  console.log('[Signup] Checking email:', normalizedEmail);

  // Check if email already exists as a fully registered user in public.users
  const { rows: existingUser } = await pool.query(
    'SELECT id, active FROM users WHERE email = $1 LIMIT 1',
    [normalizedEmail]
  );

  console.log('[Signup] public.users query result:', { found: existingUser?.length || 0 });

  if (existingUser && existingUser.length > 0) {
    if (existingUser[0].active) {
      return { success: false, error: 'A user with this email already exists', code: 'EMAIL_EXISTS' };
    }
    // Inactive user -- allow re-signup to update phone/password
    console.log('[Signup] Inactive user found, allowing re-signup for:', normalizedEmail);
  }

  // Check auth_tenant.users for existing user with this email (skip if inactive user found -- they'll be in auth already)
  if (!existingUser || existingUser.length === 0) {
    try {
      const { rows: authMatch } = await authPool.query(
        'SELECT id FROM auth_tenant.users WHERE email = $1 AND deleted_at IS NULL LIMIT 1',
        [normalizedEmail]
      );

      console.log('[Signup] auth_tenant.users check: match:', authMatch && authMatch.length > 0);
      if (authMatch && authMatch.length > 0) {
        return { success: false, error: 'A user with this email already exists', code: 'EMAIL_EXISTS' };
      }
    } catch (authCheckErr) {
      // Non-fatal: Step 5 will catch duplicates
      console.log('[Signup] auth_tenant.users check skipped:', authCheckErr.message);
    }
  }

  // Check if there's already a pending signup with verified steps
  // This applies to ALL users (new, inactive, or re-signup) so they can resume where they left off
  const { rows: existingPending } = await pool.query(
    'SELECT email_verified, phone_verified FROM signup_pending WHERE email = $1 LIMIT 1',
    [normalizedEmail]
  );

  if (existingPending && existingPending.length > 0 && existingPending[0].email_verified) {
    // Update name in case it changed (don't reset verification flags)
    await pool.query(
      'UPDATE signup_pending SET full_name = $1, updated_at = $2 WHERE email = $3',
      [full_name, new Date().toISOString(), normalizedEmail]
    );

    if (existingPending[0].phone_verified) {
      // Both verified -- redirect to set password
      return { success: false, error: 'Email and phone are already verified. Please set your password to complete signup.', code: 'VERIFICATION_COMPLETE' };
    }
    // Email verified but phone not -- redirect to phone verification
    return { success: false, error: 'Email is already verified. Please proceed to phone verification.', code: 'EMAIL_ALREADY_VERIFIED' };
  }

  // No verified steps -- upsert a fresh pending record
  const { rowCount, ...upsertResult } = await pool.query(
    `INSERT INTO signup_pending (email, full_name, password_hash, phone_number, phone_country_code, title, email_verified, phone_verified, updated_at)
     VALUES ($1, $2, '', '', '', '', false, false, $3)
     ON CONFLICT (email) DO UPDATE SET
       full_name = EXCLUDED.full_name,
       password_hash = EXCLUDED.password_hash,
       phone_number = EXCLUDED.phone_number,
       phone_country_code = EXCLUDED.phone_country_code,
       title = EXCLUDED.title,
       email_verified = EXCLUDED.email_verified,
       phone_verified = EXCLUDED.phone_verified,
       updated_at = EXCLUDED.updated_at`,
    [normalizedEmail, full_name, new Date().toISOString()]
  );

  // Send email OTP
  const otpResult = await requestEmailOtp(normalizedEmail);
  if (!otpResult.success) {
    return { success: false, error: otpResult.error, code: otpResult.code || 'OTP_SEND_FAILED' };
  }

  return {
    success: true,
    message: 'Signup initiated. Please verify your email with the OTP sent to your inbox.'
  };
}

/**
 * Step 2: Verify email OTP
 *
 * @param {string} email
 * @param {string} otp
 * @returns {Object} { success, message, error, code }
 */
async function verifyEmailOtp(email, otp) {
  const normalizedEmail = email.toLowerCase().trim();
  const pool = getPool();

  // Ensure there's a pending signup for this email
  const { rows: pending } = await pool.query(
    'SELECT * FROM signup_pending WHERE email = $1 LIMIT 1',
    [normalizedEmail]
  );

  if (!pending || pending.length === 0) {
    return { success: false, error: 'No pending signup found for this email. Please sign up first.', code: 'NO_PENDING_SIGNUP' };
  }

  // Reject if email is already verified -- prevent re-verification
  if (pending[0].email_verified) {
    return { success: false, error: 'Email is already verified. Please proceed to phone verification.', code: 'ALREADY_VERIFIED' };
  }

  const result = await verifyOtp(normalizedEmail, 'email', otp);
  if (!result.success) {
    return result;
  }

  // Mark email as verified in pending record
  await pool.query(
    'UPDATE signup_pending SET email_verified = true, updated_at = $1 WHERE email = $2',
    [new Date().toISOString(), normalizedEmail]
  );

  return {
    success: true,
    message: 'Email verified successfully. Please proceed to verify your phone number.'
  };
}

/**
 * Step 3: Send phone OTP (only after email is verified)
 *
 * @param {string} email
 * @param {string} phone_country_code
 * @param {string} phone_number
 * @returns {Object} { success, message, error, code }
 */
async function sendPhoneOtpForSignup(email, phone_country_code, phone_number) {
  const normalizedEmail = email.toLowerCase().trim();
  const pool = getPool();

  // Check pending signup exists and email is verified
  const { rows: pending } = await pool.query(
    'SELECT * FROM signup_pending WHERE email = $1 LIMIT 1',
    [normalizedEmail]
  );

  if (!pending || pending.length === 0) {
    return { success: false, error: 'No pending signup found. Please sign up first.', code: 'NO_PENDING_SIGNUP' };
  }

  if (!pending[0].email_verified) {
    return { success: false, error: 'Please verify your email first.', code: 'EMAIL_NOT_VERIFIED' };
  }

  // Compose full phone number
  const fullPhone = `${phone_country_code}${phone_number}`.replace(/\s+/g, '');

  // Check if phone number belongs to a different active user
  const { rows: phoneOwners } = await pool.query(
    'SELECT email, active FROM users WHERE phone_number = $1 AND phone_country_code = $2',
    [phone_number, phone_country_code]
  );

  if (phoneOwners && phoneOwners.length > 0) {
    // Allow if the phone belongs to the same user (case-insensitive) or to an inactive user
    const activeConflict = phoneOwners.find(
      p => p.email.toLowerCase().trim() !== normalizedEmail && p.active
    );
    if (activeConflict) {
      return { success: false, error: 'Phone number already exists for another user.', code: 'PHONE_EXISTS' };
    }
  }

  // Update phone in pending record
  await pool.query(
    'UPDATE signup_pending SET phone_number = $1, phone_country_code = $2, updated_at = $3 WHERE email = $4',
    [phone_number, phone_country_code, new Date().toISOString(), normalizedEmail]
  );

  const otpResult = await requestPhoneOtp(fullPhone);
  if (!otpResult.success) {
    return { success: false, error: otpResult.error, code: otpResult.code || 'OTP_SEND_FAILED' };
  }

  return {
    success: true,
    message: 'OTP sent to your phone number.'
  };
}

/**
 * Step 4: Verify phone OTP (does NOT complete registration)
 *
 * Marks phone as verified in pending record. User must still set password in Step 5.
 *
 * @param {string} email
 * @param {string} otp
 * @returns {Object} { success, message, error, code }
 */
async function verifyPhoneOtp(email, otp) {
  const normalizedEmail = email.toLowerCase().trim();
  const pool = getPool();

  const { rows: pending } = await pool.query(
    'SELECT * FROM signup_pending WHERE email = $1 LIMIT 1',
    [normalizedEmail]
  );

  if (!pending || pending.length === 0) {
    return { success: false, error: 'No pending signup found.', code: 'NO_PENDING_SIGNUP' };
  }

  const record = pending[0];

  if (!record.email_verified) {
    return { success: false, error: 'Please verify your email first.', code: 'EMAIL_NOT_VERIFIED' };
  }

  if (!record.phone_number || !record.phone_country_code) {
    return { success: false, error: 'Please submit your phone number first.', code: 'PHONE_NOT_SUBMITTED' };
  }

  const fullPhone = `${record.phone_country_code}${record.phone_number}`.replace(/\s+/g, '');
  const result = await verifyOtp(fullPhone, 'phone', otp);
  if (!result.success) {
    return result;
  }

  // Mark phone as verified -- do NOT create user yet (password step pending)
  await pool.query(
    'UPDATE signup_pending SET phone_verified = true, updated_at = $1 WHERE email = $2',
    [new Date().toISOString(), normalizedEmail]
  );

  return {
    success: true,
    message: 'Phone verified successfully. Please set your password to complete signup.'
  };
}

/**
 * Step 5: Set password and complete registration
 *
 * Creates the real user in public.users and auth_tenant.users with the user-chosen password.
 * Only allowed after both email and phone are verified.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Object} { success, message, error, code }
 */
async function setPasswordAndComplete(email, password) {
  const normalizedEmail = email.toLowerCase().trim();
  const pool = getPool();
  const authPool = getAuthPool();

  // Load pending signup
  const { rows: pending } = await pool.query(
    'SELECT * FROM signup_pending WHERE email = $1 LIMIT 1',
    [normalizedEmail]
  );

  if (!pending || pending.length === 0) {
    return { success: false, error: 'No pending signup found.', code: 'NO_PENDING_SIGNUP' };
  }

  const record = pending[0];

  // Strict step validation
  if (!record.email_verified) {
    return { success: false, error: 'Please verify your email first.', code: 'EMAIL_NOT_VERIFIED' };
  }

  if (!record.phone_verified) {
    return { success: false, error: 'Please verify your phone number first.', code: 'PHONE_NOT_VERIFIED' };
  }

  // -- Email uniqueness validation across all user tables --

  // 1. Check public.users (no limit -- need full count for duplicate detection)
  const { rows: publicUsers } = await pool.query(
    'SELECT id, active, phone_number, phone_country_code FROM users WHERE email = $1',
    [normalizedEmail]
  );

  if (publicUsers && publicUsers.length > 1) {
    console.error('[Signup] Duplicate email in public.users:', normalizedEmail, 'count:', publicUsers.length);
    return { success: false, error: 'This email is associated with multiple accounts. Please contact support.', code: 'DUPLICATE_EMAIL' };
  }

  // 2. Check auth_tenant.users
  const { rows: tenantUsers } = await authPool.query(
    'SELECT id FROM auth_tenant.users WHERE email = $1',
    [normalizedEmail]
  );

  if (tenantUsers && tenantUsers.length > 1) {
    console.error('[Signup] Duplicate email in auth_tenant.users:', normalizedEmail, 'count:', tenantUsers.length);
    return { success: false, error: 'This email is associated with multiple accounts. Please contact support.', code: 'DUPLICATE_EMAIL' };
  }

  // 3. Determine user state
  const existingUser = publicUsers && publicUsers.length === 1 ? publicUsers[0] : null;
  const existingAuthTenantUser = tenantUsers && tenantUsers.length === 1 ? tenantUsers[0] : null;

  if (existingUser && existingUser.active) {
    return { success: false, error: 'Account already created. Please login.', code: 'ALREADY_REGISTERED' };
  }

  const fullPhone = `${record.phone_country_code}${record.phone_number}`.replace(/\s+/g, '');
  const now = new Date().toISOString();
  const bcryptHash = await hashPassword(password);

  // --- UPDATE PATH: Inactive user exists -- update phone + password ---
  if (existingUser) {
    console.log('[Signup] Inactive user found, updating:', normalizedEmail);

    // Update phone in public.users if different
    const phoneChanged = existingUser.phone_number !== record.phone_number || existingUser.phone_country_code !== record.phone_country_code;
    if (phoneChanged) {
      console.log('[Signup] Updating phone number for:', normalizedEmail);
      const { rowCount } = await pool.query(
        `UPDATE users SET phone_number = $1, phone_country_code = $2, full_name = $3, updated_at = $4 WHERE id = $5`,
        [record.phone_number, record.phone_country_code, record.full_name, now, existingUser.id]
      );

      if (rowCount === 0) {
        console.error('[Signup] Error updating user phone: no rows updated');
        return { success: false, error: 'Failed to update user. Please try again.', code: 'UPDATE_FAILED' };
      }
    }

    // Update auth_tenant.users
    try {
      await authPool.query(
        `UPDATE auth_tenant.users SET
           password_hash = $1, phone_number = $2, phone_country_code = $3, full_name = $4, updated_at = $5
         WHERE email = $6`,
        [bcryptHash, record.phone_number, record.phone_country_code, record.full_name, now, normalizedEmail]
      );
    } catch (authTenantErr) {
      console.error('[Signup] auth_tenant sync error:', authTenantErr.message);
    }

    // Clean up pending record and OTPs
    await pool.query('DELETE FROM signup_pending WHERE email = $1', [normalizedEmail]);
    await pool.query('DELETE FROM signup_otps WHERE identifier = $1', [normalizedEmail]);
    await pool.query('DELETE FROM signup_otps WHERE identifier = $1', [fullPhone]);

    return {
      success: true,
      message: 'Account updated successfully. Once admin approves your request, you will be notified via email or phone.'
    };
  }

  // --- CREATE PATH: New user ---

  // Check for phone conflicts in auth_tenant.users
  try {
    const { rows: phoneConflict } = await authPool.query(
      `SELECT id, email FROM auth_tenant.users
       WHERE phone_number = $1 AND phone_country_code = $2
         AND email != $3 AND deleted_at IS NULL`,
      [record.phone_number, record.phone_country_code, normalizedEmail]
    );

    if (phoneConflict && phoneConflict.length > 0) {
      // Check if the conflicting user is active in public.users
      const conflictEmail = phoneConflict[0].email;
      const { rows: conflictProfile } = await pool.query(
        'SELECT id, active FROM users WHERE email = $1 LIMIT 1',
        [conflictEmail]
      );

      if (conflictProfile && conflictProfile.length > 0 && conflictProfile[0].active) {
        return { success: false, error: 'Phone number is already in use by another account.', code: 'PHONE_EXISTS' };
      }
    }
  } catch (phoneCheckErr) {
    console.warn('[Signup] Phone conflict check skipped:', phoneCheckErr.message);
  }

  // Generate a UUID for the new user
  const userUuid = crypto.randomUUID();

  // Create or update user profile in public.users
  try {
    await pool.query(
      `INSERT INTO users (id, email, full_name, phone_number, phone_country_code, title, user_type, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'QR', false, $7, $7)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         full_name = EXCLUDED.full_name,
         phone_number = EXCLUDED.phone_number,
         phone_country_code = EXCLUDED.phone_country_code,
         title = EXCLUDED.title,
         user_type = EXCLUDED.user_type,
         active = EXCLUDED.active,
         updated_at = EXCLUDED.updated_at`,
      [userUuid, normalizedEmail, record.full_name, record.phone_number, record.phone_country_code, record.title, now]
    );
  } catch (profileError) {
    console.error('Profile creation error:', profileError.message);
  }

  // Create or update user in auth_tenant database (used by mobile login)
  try {
    // Upsert into auth_tenant.users
    const { rows: authUserRows } = await authPool.query(
      `INSERT INTO auth_tenant.users (uuid, email, password_hash, full_name, phone_number, phone_country_code, title, user_role, active, email_verified_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'user', false, $8, $8, $8)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         full_name = EXCLUDED.full_name,
         phone_number = EXCLUDED.phone_number,
         phone_country_code = EXCLUDED.phone_country_code,
         title = EXCLUDED.title,
         updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [userUuid, normalizedEmail, bcryptHash, record.full_name, record.phone_number, record.phone_country_code, record.title, now]
    );

    if (authUserRows && authUserRows.length > 0) {
      const authUserId = authUserRows[0].id;

      // Link to all QR-enabled tenants
      const { rows: qrTenants } = await authPool.query(
        `SELECT id FROM auth_tenant.tenants
         WHERE qr_enabled = true AND status = 'active' AND deleted_at IS NULL`
      );

      if (qrTenants && qrTenants.length > 0) {
        const values = [];
        const params = [];
        let idx = 1;

        for (const t of qrTenants) {
          values.push(`($${idx++}, $${idx++}, 'member', 'active', $${idx++}, $${idx++})`);
          params.push(t.id, authUserId, now, now);
        }

        try {
          await authPool.query(
            `INSERT INTO auth_tenant.tenant_users (tenant_id, user_id, role, status, created_at, updated_at)
             VALUES ${values.join(', ')}`,
            params
          );
        } catch (tuError) {
          console.error('[Signup] auth_tenant.tenant_users insert error:', tuError.message);
        }
      }
    }
  } catch (authTenantErr) {
    // Non-fatal: user is created in main DB, auth_tenant sync can be retried
    console.error('[Signup] auth_tenant sync error:', authTenantErr.message);
  }

  // Clean up pending record and OTPs
  await pool.query('DELETE FROM signup_pending WHERE email = $1', [normalizedEmail]);
  await pool.query('DELETE FROM signup_otps WHERE identifier = $1', [normalizedEmail]);
  await pool.query('DELETE FROM signup_otps WHERE identifier = $1', [fullPhone]);

  return {
    success: true,
    message: 'Signup completed successfully. Once admin approves your request, you will be notified via email or phone.'
  };
}

module.exports = {
  signup,
  verifyEmailOtp,
  sendPhoneOtpForSignup,
  verifyPhoneOtp,
  setPasswordAndComplete
};
