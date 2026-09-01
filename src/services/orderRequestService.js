const { getPool } = require('../config/database');

// Fallback timezone when no tenant/user timezone is available
const FALLBACK_TZ = 'America/Chicago';

/**
 * Format an ISO timestamp to the user's timezone.
 * e.g. "2026-02-18T18:40:00Z" → "02/18/2026, 12:40 PM"
 */
function formatDateTimeTo12h(dateTimeStr, tz) {
  if (!dateTimeStr) return null;
  const date = new Date(dateTimeStr);
  if (isNaN(date.getTime())) return dateTimeStr;
  const timeZone = tz?.iana || FALLBACK_TZ;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

/**
 * Convert on_job_time (plain time like "12:40") from the tenant's stored timezone
 * to the user's selected timezone.
 * Combines on_job_date + on_job_time → creates datetime in tenant tz → converts to user tz.
 * Returns "HH:MM AM/PM" e.g. "01:40 PM"
 *
 * @param {string} onJobDate - date string like "2026-05-18"
 * @param {string} onJobTime - time string like "12:40" or "6:29 PM"
 * @param {Object} tz - user's timezone { iana: "America/New_York" }
 * @param {Object} tenantTz - tenant's timezone { iana: "America/Chicago" } (storage tz)
 */
function convertOnJobTime(onJobDate, onJobTime, tz, tenantTz) {
  if (!onJobTime) return null;
  const userTimeZone = tz?.iana || FALLBACK_TZ;

  // NEW FORMAT: UTC ISO string (e.g., "2026-05-18T19:30:00.000Z")
  // Stored as UTC — just format directly in user's timezone (always correct)
  if (isUtcIso(onJobTime)) {
    const date = new Date(onJobTime);
    if (isNaN(date.getTime())) return onJobTime;
    return new Intl.DateTimeFormat('en-US', {
      timeZone: userTimeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).format(date);
  }

  // LEGACY FORMAT: plain time string (e.g., "14:30", "2:30 PM")
  // Assumed to be in tenant's timezone — convert to user's timezone
  const storedTimeZone = tenantTz?.iana || FALLBACK_TZ;

  // If user tz and stored tz are the same, no conversion needed — just format
  if (userTimeZone === storedTimeZone) {
    return formatPlainTime(onJobTime);
  }

  const str = String(onJobTime).trim();
  let hours, minutes;

  const match12h = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (match12h) {
    let h = parseInt(match12h[1], 10);
    minutes = parseInt(match12h[2], 10);
    const period = match12h[3].toUpperCase();
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    hours = h;
  } else {
    const match24h = str.match(/^(\d{1,2}):(\d{2})/);
    if (!match24h) return onJobTime;
    hours = parseInt(match24h[1], 10);
    minutes = parseInt(match24h[2], 10);
  }

  const dateStr = onJobDate || new Date().toISOString().slice(0, 10);
  const [y, m, d] = dateStr.split('-').map(Number);
  const naiveUtc = new Date(Date.UTC(y, m - 1, d, hours, minutes, 0));
  if (isNaN(naiveUtc.getTime())) return onJobTime;

  const storedOffset = getUtcOffsetMs(storedTimeZone, naiveUtc);
  const realUtc = new Date(naiveUtc.getTime() - storedOffset);

  return new Intl.DateTimeFormat('en-US', {
    timeZone: userTimeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(realUtc);
}

/**
 * Format a plain time string to 12h format without timezone conversion.
 */
function formatPlainTime(timeStr) {
  if (!timeStr) return null;
  const str = String(timeStr).trim();
  const match12h = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (match12h) return str; // already 12h format

  const match24h = str.match(/^(\d{1,2}):(\d{2})/);
  if (!match24h) return timeStr;
  const h = parseInt(match24h[1], 10);
  const m = match24h[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${String(h12).padStart(2, '0')}:${m} ${ampm}`;
}

/**
 * Get UTC offset in milliseconds for a timezone on a given date.
 */
function getUtcOffsetMs(timeZone, date) {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = date.toLocaleString('en-US', { timeZone });
  return new Date(tzStr) - new Date(utcStr);
}

/**
 * Check if a string is a UTC ISO timestamp (e.g., "2026-05-18T19:30:00.000Z").
 */
function isUtcIso(str) {
  return typeof str === 'string' && str.includes('T');
}

/**
 * Convert on_job_date + on_job_time (plain time) + tenantTz → UTC ISO string.
 * Used at storage time so the exact moment is preserved regardless of future tz changes.
 */
function convertTimeToUtc(onJobDate, onJobTime, tenantTz) {
  if (!onJobTime || !onJobDate) return onJobTime;
  // If already UTC ISO, return as-is
  if (isUtcIso(onJobTime)) return onJobTime;

  const storedTimeZone = tenantTz?.iana || FALLBACK_TZ;
  const str = String(onJobTime).trim();
  let hours, minutes;

  const match12h = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (match12h) {
    let h = parseInt(match12h[1], 10);
    minutes = parseInt(match12h[2], 10);
    const period = match12h[3].toUpperCase();
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    hours = h;
  } else {
    const match24h = str.match(/^(\d{1,2}):(\d{2})/);
    if (!match24h) return onJobTime;
    hours = parseInt(match24h[1], 10);
    minutes = parseInt(match24h[2], 10);
  }

  const [y, m, d] = onJobDate.split('-').map(Number);
  const naiveUtc = new Date(Date.UTC(y, m - 1, d, hours, minutes, 0));
  if (isNaN(naiveUtc.getTime())) return onJobTime;

  const storedOffset = getUtcOffsetMs(storedTimeZone, naiveUtc);
  const realUtc = new Date(naiveUtc.getTime() - storedOffset);
  return realUtc.toISOString();
}

/**
 * Convert a UTC ISO on_job_time back to a plain HH:MM time string in a target timezone.
 * Used for edit forms — the frontend needs a simple time for the time picker.
 */
function convertUtcToPlainTime(utcIso, tenantTz) {
  if (!utcIso) return null;
  if (!isUtcIso(utcIso)) return formatPlainTime(utcIso); // legacy plain time, format to 12h
  const date = new Date(utcIso);
  if (isNaN(date.getTime())) return utcIso;
  const timeZone = tenantTz?.iana || FALLBACK_TZ;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/**
 * Format time fields on an order request row.
 * - on_job_time: converted from tenant's stored timezone to user's timezone
 * - created_at/updated_at: converted to user's timezone (real UTC timestamps)
 *
 * @param {Object} row - order request row from DB
 * @param {Object} tz - user's timezone { iana: "America/New_York" }
 * @param {Object} tenantTz - tenant's timezone { iana: "America/Chicago" } (storage tz)
 */
function formatOrderRow(row, tz, tenantTz) {
  if (!row) return row;
  return {
    ...row,
    on_job_time: convertOnJobTime(row.on_job_date, row.on_job_time, tz, tenantTz),
    on_job_time_raw: convertUtcToPlainTime(row.on_job_time, tenantTz),
    created_at: formatDateTimeTo12h(row.created_at, tz),
    updated_at: formatDateTimeTo12h(row.updated_at, tz),
  };
}

// Get order requests with pagination, filtering, and search
async function getOrderRequests({ userId, userIds, isAdmin, userType, page = 1, limit = 15, status, search, tz, tenantTz } = {}) {
  const pool = getPool();

  // For contractor filtering, use userIds array (handles UUID migration)
  // Falls back to [userId] if userIds not provided (backward compatibility)
  const contractorIds = userIds && userIds.length > 0 ? userIds : (userId ? [userId] : []);

  // --- Build WHERE clause parts shared by counts and data queries ---
  const needsUserFilter = !isAdmin && userType !== 'producer' && contractorIds.length > 0;

  // --- DB-level counts in parallel ---
  const buildCountSQL = (extraConditions = []) => {
    const conditions = [...extraConditions];
    const params = [];
    let paramIdx = 1;

    if (needsUserFilter) {
      conditions.push(`user_id = ANY($${paramIdx})`);
      params.push(contractorIds);
      paramIdx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { sql: `SELECT COUNT(*) AS cnt FROM order_entities ${where}`, params };
  };

  const totalQ = buildCountSQL();
  const pendingQ = buildCountSQL(['status = \'pending\'']);
  const submittedQ = buildCountSQL(['status = \'submitted\'']);
  const approvedQ = buildCountSQL(['status = \'approved\'']);
  const rejectedQ = buildCountSQL(['status = ANY($' + (needsUserFilter ? '2' : '1') + ')']);
  rejectedQ.params.push(['rejected', 'canceled']);

  const [totalRes, pendingRes, submittedRes, approvedRes, rejectedRes] = await Promise.all([
    pool.query(totalQ.sql, totalQ.params),
    pool.query(pendingQ.sql, pendingQ.params),
    pool.query(submittedQ.sql, submittedQ.params),
    pool.query(approvedQ.sql, approvedQ.params),
    pool.query(rejectedQ.sql, rejectedQ.params),
  ]);

  const counts = {
    total: parseInt(totalRes.rows[0].cnt, 10) || 0,
    pending: parseInt(pendingRes.rows[0].cnt, 10) || 0,
    submitted: parseInt(submittedRes.rows[0].cnt, 10) || 0,
    approved: parseInt(approvedRes.rows[0].cnt, 10) || 0,
    rejected: parseInt(rejectedRes.rows[0].cnt, 10) || 0,
  };

  // --- Build paginated data query ---
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  // Scope by user if not admin/producer (contractor sees only their own)
  if (needsUserFilter) {
    conditions.push(`user_id = ANY($${paramIdx})`);
    params.push(contractorIds);
    paramIdx++;
  }

  // Status filter
  if (status && status !== 'all') {
    if (status === 'rejected') {
      conditions.push(`status = ANY($${paramIdx})`);
      params.push(['rejected', 'canceled']);
      paramIdx++;
    } else {
      conditions.push(`status = $${paramIdx}`);
      params.push(status);
      paramIdx++;
    }
  }

  // Search filter
  if (search && search.trim()) {
    const q = `%${search.trim()}%`;
    conditions.push(`(job_name ILIKE $${paramIdx} OR company_name ILIKE $${paramIdx} OR job_address ILIKE $${paramIdx} OR job_city ILIKE $${paramIdx} OR concrete_product_name ILIKE $${paramIdx} OR po_number ILIKE $${paramIdx})`);
    params.push(q);
    paramIdx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  // Get total count for pagination
  const countResult = await pool.query(`SELECT COUNT(*) AS cnt FROM order_entities ${where}`, params);
  const total = parseInt(countResult.rows[0].cnt, 10) || 0;
  const totalPages = Math.ceil(total / limit);

  // Get paginated data
  const dataResult = await pool.query(
    `SELECT * FROM order_entities ${where} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, limit, offset]
  );

  return {
    orders: (dataResult.rows || []).map(row => formatOrderRow(row, tz, tenantTz)),
    counts,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      has_next: page < totalPages,
    },
  };
}

// Get single order request by ID
async function getOrderRequestById(id, tz = null, tenantTz = null) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM order_entities WHERE id = $1 LIMIT 1',
    [id]
  );

  if (!rows[0]) throw new Error(`Order request not found: id=${id}`);
  const data = rows[0];
  return tz ? formatOrderRow(data, tz, tenantTz) : data;
}

// Create order request
async function createOrderRequest(input, tenantTz = null) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO order_entities (
      user_id, order_type, project_code, project_name, company_id, company_name,
      referenced_order, region_code, region_name, customer_job_number,
      usage_code, usage_name, pour_method_code, pour_method_name, po_number,
      order_status, on_job_date, on_job_time, job_name, plant_code, plant_name,
      job_address, job_city, job_state, job_zip_code, job_contact_name,
      job_contact_phone, driver_instructions, know_mix_code,
      concrete_product_code, concrete_product_name, concrete_product_text,
      psi, rock_size, air_non_air, fly_ash, quantity, truck_spacing,
      spacing_type, slump, concrete_notes, call_back_load, pumped, pump_type,
      admixture_product_code, admixture_product_name, admixture_notes,
      other_product_code, other_product_name, other_notes
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
      $31, $32, $33, $34, $35, $36, $37, $38, $39, $40,
      $41, $42, $43, $44, $45, $46, $47, $48, $49, $50
    ) RETURNING id`,
    [
      input.user_id,
      input.order_type || 'without_project',
      input.project_code || null,
      input.project_name || null,
      input.company_id,
      input.company_name || null,
      input.referenced_order || null,
      input.region_code || null,
      input.region_name || null,
      input.customer_job_number || null,
      input.usage_code || null,
      input.usage_name || null,
      input.pour_method_code || null,
      input.pour_method_name || null,
      input.po_number || null,
      input.order_status ?? 0,
      input.on_job_date,
      convertTimeToUtc(input.on_job_date, input.on_job_time, tenantTz),
      input.job_name || null,
      input.plant_code || null,
      input.plant_name || null,
      input.job_address,
      input.job_city,
      input.job_state || null,
      input.job_zip_code || null,
      input.job_contact_name,
      input.job_contact_phone,
      input.driver_instructions || null,
      input.know_mix_code ?? false,
      input.concrete_product_code || null,
      input.concrete_product_name || null,
      input.concrete_product_text || null,
      input.psi || null,
      input.rock_size || null,
      input.air_non_air || null,
      input.fly_ash || null,
      input.quantity || null,
      input.truck_spacing || null,
      input.spacing_type || 'minutes',
      input.slump || null,
      input.concrete_notes || null,
      input.call_back_load || null,
      input.pumped ?? false,
      input.pumped ? (input.pump_type || null) : null,
      input.admixture_product_code || null,
      input.admixture_product_name || null,
      input.admixture_notes || null,
      input.other_product_code || null,
      input.other_product_name || null,
      input.other_notes || null,
    ]
  );

  return rows[0];
}

// Update order request
async function updateOrderRequest(id, input, tenantTz = null) {
  const pool = getPool();
  await pool.query(
    `UPDATE order_entities SET
      order_type = $1, project_code = $2, project_name = $3, company_id = $4,
      company_name = $5, referenced_order = $6, region_code = $7, region_name = $8,
      customer_job_number = $9, usage_code = $10, usage_name = $11,
      pour_method_code = $12, pour_method_name = $13, po_number = $14,
      order_status = $15, on_job_date = $16, on_job_time = $17, job_name = $18,
      plant_code = $19, plant_name = $20, job_address = $21, job_city = $22,
      job_state = $23, job_zip_code = $24, job_contact_name = $25,
      job_contact_phone = $26, driver_instructions = $27, know_mix_code = $28,
      concrete_product_code = $29, concrete_product_name = $30,
      concrete_product_text = $31, psi = $32, rock_size = $33, air_non_air = $34,
      fly_ash = $35, quantity = $36, truck_spacing = $37, spacing_type = $38,
      slump = $39, concrete_notes = $40, call_back_load = $41, pumped = $42,
      pump_type = $43, admixture_product_code = $44, admixture_product_name = $45,
      admixture_notes = $46, other_product_code = $47, other_product_name = $48,
      other_notes = $49, updated_at = $50
    WHERE id = $51`,
    [
      input.order_type || 'without_project',
      input.project_code || null,
      input.project_name || null,
      input.company_id,
      input.company_name || null,
      input.referenced_order || null,
      input.region_code || null,
      input.region_name || null,
      input.customer_job_number || null,
      input.usage_code || null,
      input.usage_name || null,
      input.pour_method_code || null,
      input.pour_method_name || null,
      input.po_number || null,
      input.order_status ?? 0,
      input.on_job_date,
      convertTimeToUtc(input.on_job_date, input.on_job_time, tenantTz),
      input.job_name || null,
      input.plant_code || null,
      input.plant_name || null,
      input.job_address,
      input.job_city,
      input.job_state || null,
      input.job_zip_code || null,
      input.job_contact_name,
      input.job_contact_phone,
      input.driver_instructions || null,
      input.know_mix_code ?? false,
      input.concrete_product_code || null,
      input.concrete_product_name || null,
      input.concrete_product_text || null,
      input.psi || null,
      input.rock_size || null,
      input.air_non_air || null,
      input.fly_ash || null,
      input.quantity || null,
      input.truck_spacing || null,
      input.spacing_type || 'minutes',
      input.slump || null,
      input.concrete_notes || null,
      input.call_back_load || null,
      input.pumped ?? false,
      input.pumped ? (input.pump_type || null) : null,
      input.admixture_product_code || null,
      input.admixture_product_name || null,
      input.admixture_notes || null,
      input.other_product_code || null,
      input.other_product_name || null,
      input.other_notes || null,
      new Date().toISOString(),
      id,
    ]
  );

  return { id };
}

// Update status
async function updateOrderRequestStatus(id, status) {
  const validStatuses = ['pending', 'submitted', 'approved', 'rejected', 'canceled'];
  if (!validStatuses.includes(status)) {
    throw new Error('Invalid status');
  }

  const pool = getPool();
  await pool.query(
    'UPDATE order_entities SET status = $1, updated_at = $2 WHERE id = $3',
    [status, new Date().toISOString(), id]
  );

  return { id, status };
}

// Update verification fields
async function updateOrderVerification(id, data, tenantTz = null) {
  const pool = getPool();

  const setClauses = ['updated_at = $1'];
  const values = [new Date().toISOString()];
  let paramIdx = 2;

  if (data.order_number !== undefined) {
    setClauses.push(`order_number = $${paramIdx}`);
    values.push(data.order_number || null);
    paramIdx++;
  }
  if (data.order_status !== undefined) {
    setClauses.push(`order_status = $${paramIdx}`);
    values.push(data.order_status);
    paramIdx++;
  }
  if (data.on_job_date !== undefined) {
    setClauses.push(`on_job_date = $${paramIdx}`);
    values.push(data.on_job_date);
    paramIdx++;
  }
  if (data.on_job_time !== undefined) {
    const dateForConversion = data.on_job_date || data.on_job_date;
    setClauses.push(`on_job_time = $${paramIdx}`);
    values.push(convertTimeToUtc(dateForConversion, data.on_job_time, tenantTz));
    paramIdx++;
  }

  values.push(id);
  await pool.query(
    `UPDATE order_entities SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
    values
  );

  return { id };
}

// Get messages for an order request
async function getMessages(orderEntityId, tz = null) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM order_entity_messages WHERE order_entity_id = $1 ORDER BY created_at ASC',
    [orderEntityId]
  );

  const messages = rows || [];
  if (tz) {
    return messages.map(msg => ({
      ...msg,
      created_at: formatDateTimeTo12h(msg.created_at, tz),
    }));
  }
  return messages;
}

// Send a message
async function sendMessage(orderEntityId, senderId, messageText, senderRole, tz = null) {
  const pool = getPool();

  // Fetch sender name server-side
  const { rows: userRows } = await pool.query(
    'SELECT full_name, email FROM users WHERE id = $1 LIMIT 1',
    [senderId]
  );

  const userProfile = userRows[0] || null;
  const senderName = userProfile?.full_name || userProfile?.email || 'Unknown User';

  const { rows } = await pool.query(
    `INSERT INTO order_entity_messages (order_entity_id, sender_id, sender_name, sender_role, message_text)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [orderEntityId, senderId, senderName, senderRole, messageText.trim()]
  );

  const data = rows[0];
  if (tz) {
    return { ...data, created_at: formatDateTimeTo12h(data.created_at, tz) };
  }
  return data;
}

// Simple in-memory cache for form data (refreshes every 5 minutes)
let formDataCache = null;
let formDataCacheTime = 0;
const FORM_DATA_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Batch-fetch helper for large tables
async function fetchAllBatched(pool, table, selectFields, whereClause, whereParams, orderField, batchSize = 1000) {
  let all = [];
  let offset = 0;
  let hasMore = true;
  const nextParamIdx = whereParams.length + 1;

  while (hasMore) {
    const sql = `SELECT ${selectFields} FROM ${table}${whereClause ? ' WHERE ' + whereClause : ''} ORDER BY ${orderField} ASC LIMIT $${nextParamIdx} OFFSET $${nextParamIdx + 1}`;
    const { rows } = await pool.query(sql, [...whereParams, batchSize, offset]);
    if (rows && rows.length > 0) {
      all = all.concat(rows);
      offset += batchSize;
      hasMore = rows.length === batchSize;
    } else {
      hasMore = false;
    }
  }
  return all;
}

// Get form data (regions, customers, projects, admixture & other products)
async function getFormData() {
  // Return cached data if still fresh
  if (formDataCache && (Date.now() - formDataCacheTime) < FORM_DATA_CACHE_TTL) {
    return formDataCache;
  }

  const pool = getPool();

  // Run ALL 5 fetches in parallel
  const [regions, customers, projects, admixtureRaw, otherRaw] = await Promise.all([
    // 1. Regions (small table - single query)
    pool.query('SELECT code, description FROM regions ORDER BY description ASC')
      .then(({ rows }) => rows || []),

    // 2. Customers (large table - batched)
    fetchAllBatched(pool, 'customers', 'code, name',
      '(inactive IS NULL OR inactive = false)', [], 'name'),

    // 3. Projects (large table - batched)
    fetchAllBatched(pool, 'projects',
      'id, code, name, customer_code, customer_name, delivery_addr1, delivery_addr2, delivery_addr3, contact, phone',
      null, [], 'name'),

    // 4. Admixture products (matches web query exactly)
    pool.query(
      `SELECT item_code, description FROM order_products
       WHERE is_mix = false AND item_code IS NOT NULL
       AND (description ILIKE '%admix%' OR description ILIKE '%retard%' OR description ILIKE '%mrwra%' OR description ILIKE '%calcium%' OR description ILIKE '%accelerat%')
       LIMIT 2000`
    ).then(({ rows }) => rows || []),

    // 5. Other products (matches web query exactly)
    pool.query(
      `SELECT item_code, description FROM order_products
       WHERE is_mix = false AND item_code IS NOT NULL
       LIMIT 2000`
    ).then(({ rows }) => rows || []),
  ]);

  // Deduplicate admixture products by item_code
  // Label format matches web: description only (or code if no description)
  const admixturesSeen = new Map();
  for (const row of admixtureRaw) {
    if (!row.item_code) continue;
    if (!admixturesSeen.has(row.item_code)) {
      const desc = row.description || '';
      admixturesSeen.set(row.item_code, { value: row.item_code, label: desc || row.item_code });
    }
  }

  // Deduplicate other products by item_code
  const otherSeen = new Map();
  for (const row of otherRaw) {
    if (!row.item_code) continue;
    if (!otherSeen.has(row.item_code)) {
      const desc = row.description || '';
      otherSeen.set(row.item_code, { value: row.item_code, label: desc || row.item_code });
    }
  }

  const result = {
    regions,
    customers,
    projects,
    admixtureProducts: Array.from(admixturesSeen.values()).sort((a, b) => a.value.localeCompare(b.value)),
    otherProducts: Array.from(otherSeen.values()).sort((a, b) => a.value.localeCompare(b.value)),
  };

  // Cache the result
  formDataCache = result;
  formDataCacheTime = Date.now();

  return result;
}

// Get orders by project code (for auto-filling referenced order when project is selected)
async function getOrdersByProjectCode(projectCode) {
  if (!projectCode || !projectCode.trim()) {
    return [];
  }

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT order_id, order_code, customer_code, customer_name, order_date, project_name,
            delivery_addr1, delivery_addr2, delivery_addr3, ordered_by_name, ordered_by_phone,
            pricing_plant_code, zone_name
     FROM orders
     WHERE project_code = $1
     ORDER BY order_date DESC
     LIMIT 50`,
    [projectCode.trim()]
  );

  return rows || [];
}

// Search orders by code (for referenced order dropdown)
async function searchOrders(searchTerm) {
  if (!searchTerm || searchTerm.trim().length < 2) {
    return [];
  }

  const pool = getPool();
  const term = searchTerm.trim();

  // Use prefix match for order_code (index-friendly) and contains for customer_name
  const { rows } = await pool.query(
    `SELECT order_id, order_code, customer_code, customer_name, order_date, project_name,
            delivery_addr1, delivery_addr2, delivery_addr3, ordered_by_name, ordered_by_phone,
            pricing_plant_code, zone_name
     FROM orders
     WHERE order_code ILIKE $1 OR customer_name ILIKE $2
     LIMIT 50`,
    [`${term}%`, `%${term}%`]
  );

  // Deduplicate by order_code
  const seen = new Map();
  (rows || []).forEach((o) => {
    if (o.order_code && !seen.has(o.order_code)) {
      seen.set(o.order_code, o);
    }
  });

  return Array.from(seen.values());
}

// Search mix products
async function searchProducts(search = '', uniqueOffset = 0, limit = 50) {
  const pool = getPool();
  const BATCH_SIZE = 1000;
  const needed = uniqueOffset + limit + 1;
  const seen = new Map();
  let dbOffset = 0;
  let exhausted = false;

  // Build search conditions
  const searchConditions = [];
  const searchParams = [];
  let paramIdx = 1;

  if (search.trim()) {
    const words = search.trim().split(/\s+/)
      .map((w) => w.replace(/^[^a-zA-Z0-9]+$/, ''))
      .filter((w) => w.length > 0);
    for (const w of words) {
      searchConditions.push(`(item_code ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`);
      searchParams.push(`%${w}%`);
      paramIdx++;
    }
  }

  const searchWhere = searchConditions.length > 0
    ? ' AND ' + searchConditions.join(' AND ')
    : '';

  while (seen.size < needed && !exhausted) {
    const sql = `SELECT item_code, description, slump FROM order_products
      WHERE is_mix = true AND item_code IS NOT NULL${searchWhere}
      ORDER BY item_code
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;

    let rows;
    try {
      const result = await pool.query(sql, [...searchParams, BATCH_SIZE, dbOffset]);
      rows = result.rows;
    } catch {
      break;
    }

    if (!rows || rows.length === 0) { exhausted = true; break; }

    for (const row of rows) {
      if (!row.item_code) continue;
      const desc = row.description || '';
      const label = desc ? `${row.item_code} - ${desc}` : row.item_code;
      const key = `${row.item_code}|${label.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.set(key, { value: row.item_code, label, slump: row.slump });
      }
    }

    if (rows.length < BATCH_SIZE) { exhausted = true; break; }
    dbOffset += BATCH_SIZE;
  }

  const all = Array.from(seen.values());
  const products = all.slice(uniqueOffset, uniqueOffset + limit);
  const hasMore = all.length > uniqueOffset + limit;

  return { products, hasMore };
}

// Get recent order entities for referenced order dropdown
async function getRecentOrderEntities(userId) {
  if (!userId) return [];

  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id, job_name, on_job_date, company_name, company_id FROM order_entities WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
    [userId]
  );

  return (rows || []).map((o) => ({
    id: o.id,
    display: `OE-${o.id.slice(0, 6).toUpperCase()} — ${o.job_name || o.company_name || o.on_job_date}`,
    company_id: o.company_id,
  }));
}

module.exports = {
  getOrderRequests,
  getOrderRequestById,
  createOrderRequest,
  updateOrderRequest,
  updateOrderRequestStatus,
  updateOrderVerification,
  getMessages,
  sendMessage,
  getFormData,
  getOrdersByProjectCode,
  searchOrders,
  searchProducts,
  getRecentOrderEntities,
};
