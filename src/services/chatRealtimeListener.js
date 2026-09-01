/**
 * Chat realtime listener
 *
 * Subscribes to PostgreSQL LISTEN/NOTIFY channels (`new_chat_message` and
 * `new_order_entity_message`) on every distinct tenant database, then fans
 * out FCM via chatService.notifyChatMessage / notifyOrderEntityMessage.
 *
 * Tenants are configured by env in TENANT_DATABASES (JSON array). The shared
 * DATABASE_URL is auto-included as a fallback so single-project deployments
 * work with no extra config.
 *
 * Example TENANT_DATABASES value:
 *   [
 *     {"label":"shared","database_url":"postgres://...","subdomains":["dolese","hercules","preferredmaterials","sws"]},
 *     {"label":"concretesupply","database_url":"postgres://...","subdomains":["concretesupply"]},
 *     {"label":"delta","database_url":"postgres://...","subdomains":["delta"]},
 *     {"label":"sunrise","database_url":"postgres://...","subdomains":["sunrise"]}
 *   ]
 *
 * The "subdomains" field is informational only -- the listener does not need
 * to resolve a per-message subdomain since the mobile tenant-switch is opt-in.
 */

const pg = require('pg');
const { getPool } = require('../config/database');
const chatService = require('./chatService');

const clients = [];

function loadTenantConfigs() {
  const configs = [];

  if (process.env.TENANT_DATABASES) {
    try {
      const parsed = JSON.parse(process.env.TENANT_DATABASES);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && entry.database_url) {
            configs.push({
              label: entry.label || 'tenant',
              database_url: entry.database_url,
              subdomains: Array.isArray(entry.subdomains) ? entry.subdomains : [],
            });
          }
        }
      }
    } catch (err) {
      console.error('[ChatRealtime] TENANT_DATABASES parse error:', err.message);
    }
  }

  // Auto-include the primary DATABASE_URL if not already present
  if (process.env.DATABASE_URL) {
    const exists = configs.find((c) => c.database_url === process.env.DATABASE_URL);
    if (!exists) {
      configs.push({
        label: 'primary',
        database_url: process.env.DATABASE_URL,
        subdomains: [],
      });
    }
  }

  return configs;
}

function buildPreview(text, attachments) {
  if (text && text.trim().length > 0) {
    return text.length > 120 ? `${text.substring(0, 119)}…` : text;
  }
  if (Array.isArray(attachments) && attachments.length > 0) {
    return 'Sent an attachment';
  }
  return '';
}

async function fetchActiveRecipients(pool, senderId) {
  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE active = true AND id != $1',
      [senderId]
    );
    return rows.map((u) => u.id);
  } catch (err) {
    console.error(
      '[ChatRealtime] failed to load recipients:',
      err.message,
    );
    return [];
  }
}

async function fetchOrderMeta(pool, orderId) {
  try {
    const { rows } = await pool.query(
      'SELECT order_id, order_code, order_date, customer_name FROM orders WHERE order_id = $1 LIMIT 1',
      [orderId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error(
      '[ChatRealtime] failed to load order meta:',
      err.message,
    );
    return null;
  }
}

async function handleInsert(config, payload) {
  const row = payload?.new;
  if (!row) return;
  if (row.is_deleted === true) return;
  if (!row.sender_id || !row.order_id) return;

  try {
    const pool = getPool();

    const [recipients, orderMeta] = await Promise.all([
      fetchActiveRecipients(pool, row.sender_id),
      fetchOrderMeta(pool, row.order_id),
    ]);

    if (recipients.length === 0) {
      console.log(
        `[ChatRealtime][${config.label}] order=${row.order_id} sender=${row.sender_id} -> no recipients`,
      );
      return;
    }

    const orderCode = orderMeta?.order_code || String(row.order_id);

    const result = await chatService.notifyChatMessage({
      order_id: row.order_id,
      order_code: orderCode,
      chat_id: row.chat_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name || '',
      message_preview: buildPreview(row.message_text, row.attachments),
      tenant_subdomain:
        config.subdomains && config.subdomains.length === 1
          ? config.subdomains[0]
          : '',
      recipient_user_ids: recipients,
      order_date: orderMeta?.order_date || '',
      customer_name: orderMeta?.customer_name || '',
    });

    console.log(
      `[ChatRealtime][${config.label}] order=${orderCode} (id=${row.order_id}) -> ${result.successCount}/${result.tokenCount || 0} pushed (failures: ${result.failureCount}, recipients: ${result.recipientCount}, skipped: ${result.skipped || 'no'})`,
    );
  } catch (err) {
    console.error(
      `[ChatRealtime][${config.label}] handler error:`,
      err.message,
    );
  }
}

async function fetchOrderEntityMeta(pool, orderEntityId) {
  try {
    const { rows } = await pool.query(
      'SELECT id, job_name, company_name, on_job_date FROM order_entities WHERE id = $1 LIMIT 1',
      [orderEntityId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error(
      '[ChatRealtime] failed to load order_entity meta:',
      err.message,
    );
    return null;
  }
}

async function handleOrderEntityInsert(config, payload) {
  const row = payload?.new;
  if (!row) return;
  if (!row.sender_id || !row.order_entity_id) return;

  try {
    const pool = getPool();

    const [recipients, meta] = await Promise.all([
      fetchActiveRecipients(pool, row.sender_id),
      fetchOrderEntityMeta(pool, row.order_entity_id),
    ]);

    if (recipients.length === 0) {
      console.log(
        `[ChatRealtime][${config.label}] order_entity=${row.order_entity_id} sender=${row.sender_id} -> no recipients`,
      );
      return;
    }

    const result = await chatService.notifyOrderEntityMessage({
      order_entity_id: row.order_entity_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name || '',
      message_preview: buildPreview(row.message_text, null),
      tenant_subdomain:
        config.subdomains && config.subdomains.length === 1
          ? config.subdomains[0]
          : '',
      recipient_user_ids: recipients,
      job_name: meta?.job_name || '',
      company_name: meta?.company_name || '',
      on_job_date: meta?.on_job_date || '',
    });

    console.log(
      `[ChatRealtime][${config.label}] order_request=${row.order_entity_id} -> ${result.successCount}/${result.tokenCount || 0} pushed (failures: ${result.failureCount}, recipients: ${result.recipientCount}, skipped: ${result.skipped || 'no'})`,
    );
  } catch (err) {
    console.error(
      `[ChatRealtime][${config.label}] order entity handler error:`,
      err.message,
    );
  }
}

function subscribeOne(config) {
  const client = new pg.Client({
    connectionString: config.database_url,
    ssl: { rejectUnauthorized: false },
  });

  client.connect().then(() => {
    client.query('LISTEN new_chat_message');
    client.query('LISTEN new_order_entity_message');

    client.on('notification', async (msg) => {
      try {
        const payload = JSON.parse(msg.payload);
        if (msg.channel === 'new_chat_message') {
          await handleInsert(config, { new: payload });
        } else if (msg.channel === 'new_order_entity_message') {
          await handleOrderEntityInsert(config, { new: payload });
        }
      } catch (err) {
        console.error(
          `[ChatRealtime][${config.label}] notification parse error:`,
          err.message,
        );
      }
    });

    console.log(
      `[ChatRealtime][${config.label}] listening on PostgreSQL channels`,
    );
  }).catch((err) => {
    console.error(
      `[ChatRealtime][${config.label}] connection error:`,
      err.message,
    );
  });

  clients.push(client);
}

function startChatRealtimeListener() {
  // Kill switch -- set CHAT_REALTIME_DISABLED=true on whichever backend you
  // don't want firing FCM (e.g. disable on production while testing locally,
  // or vice versa) to avoid double-pushes when prod + local share a database.
  if (
    process.env.CHAT_REALTIME_DISABLED === 'true' ||
    process.env.CHAT_REALTIME_DISABLED === '1'
  ) {
    console.log(
      '[ChatRealtime] CHAT_REALTIME_DISABLED is set -- listener will not start',
    );
    return;
  }

  let configs = loadTenantConfigs();
  if (configs.length === 0) {
    console.warn(
      '[ChatRealtime] no database configs found -- listener disabled',
    );
    return;
  }

  // Per-project disable -- comma-separated list of labels (e.g. "primary,sunrise")
  // matching the `label` field in TENANT_DATABASES (auto-included primary uses
  // label "primary"). Use this when one tenant's prod backend already fires FCM
  // (so local should skip it) but other tenants' prod is down (local must fire).
  const disabledRaw = process.env.CHAT_REALTIME_DISABLED_PROJECTS;
  if (disabledRaw) {
    const disabledLabels = new Set(
      disabledRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const before = configs.length;
    configs = configs.filter((c) => !disabledLabels.has(c.label));
    const skipped = before - configs.length;
    if (skipped > 0) {
      console.log(
        `[ChatRealtime] CHAT_REALTIME_DISABLED_PROJECTS skipped ${skipped} project(s): ${[...disabledLabels].join(', ')}`,
      );
    }
  }

  if (configs.length === 0) {
    console.warn(
      '[ChatRealtime] all configured projects are disabled -- listener will not start',
    );
    return;
  }

  console.log(
    `[ChatRealtime] starting listener for ${configs.length} tenant database(s)`,
  );
  for (const cfg of configs) {
    subscribeOne(cfg);
  }
}

async function stopChatRealtimeListener() {
  console.log('[ChatRealtime] stopping listener...');
  await Promise.allSettled(
    clients.map((c) =>
      c.end().catch((err) =>
        console.error('[ChatRealtime] client close error:', err.message),
      ),
    ),
  );
  clients.length = 0;
}

module.exports = {
  startChatRealtimeListener,
  stopChatRealtimeListener,
};
