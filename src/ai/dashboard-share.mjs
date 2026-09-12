/** Dashboard sharing: per-user grants + public links (ported from /api/ai/dashboards/[id]/share + public/[token]). */
import { randomBytes } from 'node:crypto';
import pool from './_db.mjs';

async function ownsDashboard(userId, id) {
  const { rows } = await pool.query(
    'SELECT id FROM ai_dashboards WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return rows.length > 0;
}

export async function getShareInfo(userId, id) {
  if (!(await ownsDashboard(userId, id))) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }
  const [sharesRes, dashRes] = await Promise.all([
    pool.query(
      'SELECT id, shared_with_user_id, permission, created_at FROM ai_dashboard_shares WHERE dashboard_id = $1',
      [id],
    ),
    pool.query(
      'SELECT share_token, is_public FROM ai_dashboards WHERE id = $1',
      [id],
    ),
  ]);
  const dash = dashRes.rows[0];
  return {
    shares: sharesRes.rows,
    publicToken: dash?.share_token ?? null,
    isPublic: dash?.is_public ?? false,
  };
}

export async function applyShare(userId, id, body = {}) {
  if (!(await ownsDashboard(userId, id))) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }
  if (body.action === 'invite') {
    if (!body.email || !body.email.includes('@')) {
      throw Object.assign(new Error('valid email required'), { status: 400 });
    }
    const { rows: users } = await pool.query(
      'SELECT id, email FROM auth.users',
    );
    const found = users.find((u) => u.email?.toLowerCase() === body.email.toLowerCase());
    if (!found) throw Object.assign(new Error('user not found'), { status: 404 });
    try {
      await pool.query(
        'INSERT INTO ai_dashboard_shares (dashboard_id, shared_with_user_id, created_by) VALUES ($1, $2, $3)',
        [id, found.id, userId],
      );
    } catch (err) {
      if (!/duplicate/i.test(err.message)) {
        throw Object.assign(new Error(err.message), { status: 500 });
      }
    }
    return { ok: true, sharedWithUserId: found.id };
  }
  if (body.action === 'generateLink') {
    const token = randomBytes(24).toString('base64url');
    await pool.query(
      'UPDATE ai_dashboards SET share_token = $1, is_public = true WHERE id = $2',
      [token, id],
    );
    return { token, isPublic: true };
  }
  if (body.action === 'revokeLink') {
    await pool.query(
      'UPDATE ai_dashboards SET share_token = NULL, is_public = false WHERE id = $1',
      [id],
    );
    return { ok: true };
  }
  throw Object.assign(new Error('unknown action'), { status: 400 });
}

export async function revokeUserShare(userId, id, sharedWithUserId) {
  if (!(await ownsDashboard(userId, id))) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }
  if (!sharedWithUserId) {
    throw Object.assign(new Error('sharedWithUserId required'), { status: 400 });
  }
  await pool.query(
    'DELETE FROM ai_dashboard_shares WHERE dashboard_id = $1 AND shared_with_user_id = $2',
    [id, sharedWithUserId],
  );
  return { ok: true };
}

export async function getPublicDashboard(token) {
  if (!token) throw Object.assign(new Error('Not found'), { status: 404 });
  const { rows } = await pool.query(
    `SELECT id, title, layout, widgets, updated_at
     FROM ai_dashboards
     WHERE share_token = $1 AND is_public = true`,
    [token],
  );
  if (rows.length === 0) throw Object.assign(new Error('Not found'), { status: 404 });
  return { dashboard: rows[0] };
}
