/**
 * Chat realtime listener
 *
 * Uses PostgreSQL LISTEN/NOTIFY on `chat_messages_insert` and
 * `order_entity_messages_insert` channels for every distinct tenant database,
 * then fans out FCM push notifications via chatService.
 *
 * Tenants are configured by env in TENANT_DATABASES (JSON array).
 * The DATABASE_URL env var is auto-included as a fallback so single-database
 * deployments work with no extra config.
 *
 * Example TENANT_DATABASES value:
 *   [
 *     {"label":"shared","database_url":"postgres://...","subdomains":["dolese","hercules"]},
 *     {"label":"concretesupply","database_url":"postgres://...","subdomains":["concretesupply"]}
 *   ]
 */

const pg = require('pg');
const chatService = require('./chatService');

/** @type {pg.Client[]} */
const listenClients = [];

/** @type {pg.Pool[]} */
const queryPools = [];

/** @type {Map<string, pg.Pool>} label -> Pool for query usage */
const poolByLabel = new Map();

/** Track reconnect timers so they can be cleared on stop */
const reconnectTimers = [];

/** Whether the listener has been explicitly stopped */
let stopped = false;

const RECONNECT_DELAY_MS = 5000;

/* ------------------------------------------------------------------ */
/*  Tenant config loading                                              */
/* ------------------------------------------------------------------ */

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

  // Auto-include the primary database if not already present.
  // LISTEN/NOTIFY requires a direct PostgreSQL connection — PgBouncer in
  // transaction-pooling mode silently drops notifications.  Prefer
  // DATABASE_DIRECT_URL or DB_POOL_URL (which, despite the name, is the
  // non-pooled connection in this stack) over DATABASE_URL.
  const directUrl =
    process.env.DATABASE_DIRECT_URL ||
    process.env.DB_POOL_URL ||
    process.env.DATABASE_URL;

  if (directUrl) {
    const exists = configs.find((c) => c.database_url === directUrl);
    if (!exists) {
      configs.push({
        label: 'primary',
        database_url: directUrl,
        subdomains: [],
      });
    }
  }

  return configs;
}

/* ------------------------------------------------------------------ */
/*  SSL helper                                                         */
/* ------------------------------------------------------------------ */

function sslConfig(dbUrl) {
  // Disable SSL for localhost / local dev databases
  if (dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1')) {
    return false;
  }
  return { rejectUnauthorized: false };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function buildPreview(text, attachments) {
  if (text && text.trim().length > 0) {
    return text.length > 120 ? `${text.substring(0, 119)}\u2026` : text;
  }
  if (Array.isArray(attachments) && attachments.length > 0) {
    return 'Sent an attachment';
  }
  return '';
}

/* ------------------------------------------------------------------ */
/*  Database query helpers (use Pool per tenant)                       */
/* ------------------------------------------------------------------ */

async function fetchActiveRecipients(pool, senderId) {
  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE active = true',
      [],
    );
    return (rows || [])
      .map((u) => u.id)
      .filter((id) => id && id !== senderId);
  } catch (err) {
    console.error('[ChatRealtime] failed to load recipients:', err.message);
    return [];
  }
}

async function fetchOrderMeta(pool, orderId) {
  try {
    const { rows } = await pool.query(
      'SELECT order_id, order_code, order_date, customer_name FROM orders WHERE order_id = $1',
      [orderId],
    );
    return rows && rows.length > 0 ? rows[0] : null;
  } catch (err) {
    console.error('[ChatRealtime] failed to load order meta:', err.message);
    return null;
  }
}

async function fetchOrderEntityMeta(pool, orderEntityId) {
  try {
    const { rows } = await pool.query(
      'SELECT id, job_name, company_name, on_job_date FROM order_entities WHERE id = $1',
      [orderEntityId],
    );
    return rows && rows.length > 0 ? rows[0] : null;
  } catch (err) {
    console.error('[ChatRealtime] failed to load order_entity meta:', err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Notification handlers                                              */
/* ------------------------------------------------------------------ */

async function handleInsert(config, payload) {
  const row = payload?.new;
  if (!row) return;
  if (row.is_deleted === true) return;
  if (!row.sender_id || !row.order_id) return;

  try {
    const pool = poolByLabel.get(config.label);
    if (!pool) {
      console.error(`[ChatRealtime][${config.label}] no query pool available`);
      return;
    }

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

async function handleOrderEntityInsert(config, payload) {
  const row = payload?.new;
  if (!row) return;
  if (!row.sender_id || !row.order_entity_id) return;

  try {
    const pool = poolByLabel.get(config.label);
    if (!pool) {
      console.error(`[ChatRealtime][${config.label}] no query pool available`);
      return;
    }

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

/* ------------------------------------------------------------------ */
/*  LISTEN/NOTIFY subscription per tenant                              */
/* ------------------------------------------------------------------ */

async function subscribeOne(config) {
  // Create a Pool for query usage (shared across notification handlers)
  if (!poolByLabel.has(config.label)) {
    const pool = new pg.Pool({
      connectionString: config.database_url,
      ssl: sslConfig(config.database_url),
      max: 3,
    });
    queryPools.push(pool);
    poolByLabel.set(config.label, pool);
  }

  // Create a dedicated Client for LISTEN (persistent connection required)
  const client = new pg.Client({
    connectionString: config.database_url,
    ssl: sslConfig(config.database_url),
  });

  listenClients.push(client);

  try {
    await client.connect();
    await client.query('LISTEN chat_messages_insert');
    await client.query('LISTEN order_entity_messages_insert');

    console.log(
      `[ChatRealtime][${config.label}] listening on chat_messages_insert, order_entity_messages_insert`,
    );

    client.on('notification', async (msg) => {
      try {
        const payload = JSON.parse(msg.payload);
        if (msg.channel === 'chat_messages_insert') {
          await handleInsert(config, { new: payload });
        } else if (msg.channel === 'order_entity_messages_insert') {
          await handleOrderEntityInsert(config, { new: payload });
        }
      } catch (parseErr) {
        console.error(
          `[ChatRealtime][${config.label}] payload parse error:`,
          parseErr.message,
        );
      }
    });

    // Auto-reconnect on unexpected disconnect
    client.on('error', (err) => {
      console.error(
        `[ChatRealtime][${config.label}] client error:`,
        err.message,
      );
      scheduleReconnect(config, client);
    });

    client.on('end', () => {
      if (!stopped) {
        console.warn(
          `[ChatRealtime][${config.label}] connection ended unexpectedly, will reconnect`,
        );
        scheduleReconnect(config, client);
      }
    });
  } catch (err) {
    console.error(
      `[ChatRealtime][${config.label}] failed to connect:`,
      err.message,
    );
    scheduleReconnect(config, client);
  }
}

function scheduleReconnect(config, oldClient) {
  if (stopped) return;

  // Remove old client from tracking array
  const idx = listenClients.indexOf(oldClient);
  if (idx !== -1) listenClients.splice(idx, 1);

  // Attempt to close cleanly (ignore errors)
  try {
    oldClient.end().catch(() => {});
  } catch (_) {
    // already closed
  }

  console.log(
    `[ChatRealtime][${config.label}] reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`,
  );

  const timer = setTimeout(async () => {
    const timerIdx = reconnectTimers.indexOf(timer);
    if (timerIdx !== -1) reconnectTimers.splice(timerIdx, 1);
    if (stopped) return;

    try {
      await subscribeOne(config);
    } catch (err) {
      console.error(
        `[ChatRealtime][${config.label}] reconnect failed:`,
        err.message,
      );
    }
  }, RECONNECT_DELAY_MS);

  reconnectTimers.push(timer);
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

function startChatRealtimeListener() {
  // Kill switch
  if (
    process.env.CHAT_REALTIME_DISABLED === 'true' ||
    process.env.CHAT_REALTIME_DISABLED === '1'
  ) {
    console.log(
      '[ChatRealtime] CHAT_REALTIME_DISABLED is set — listener will not start',
    );
    return;
  }

  stopped = false;
  let configs = loadTenantConfigs();
  if (configs.length === 0) {
    console.warn(
      '[ChatRealtime] no database configs found — listener disabled',
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
      '[ChatRealtime] all configured projects are disabled — listener will not start',
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
  stopped = true;

  // Clear pending reconnect timers
  for (const timer of reconnectTimers) {
    clearTimeout(timer);
  }
  reconnectTimers.length = 0;

  // Close all LISTEN clients
  await Promise.allSettled(
    listenClients.map((client) =>
      client.end().catch((err) =>
        console.error('[ChatRealtime] client close error:', err.message),
      ),
    ),
  );
  listenClients.length = 0;

  // Close all query pools
  await Promise.allSettled(
    queryPools.map((pool) =>
      pool.end().catch((err) =>
        console.error('[ChatRealtime] pool close error:', err.message),
      ),
    ),
  );
  queryPools.length = 0;
  poolByLabel.clear();
}

module.exports = {
  startChatRealtimeListener,
  stopChatRealtimeListener,
};
