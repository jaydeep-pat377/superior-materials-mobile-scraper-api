import pool from "./_db.mjs";
import { BLOCKED_TABLES } from "./sql-safety.mjs";
import { getAiRequestContext } from "./audit-log.mjs";

/**
 * Tables that carry a `customer_id` and can therefore be safely scoped to a
 * contractor's own customers. Every other AI-queryable table (master tables,
 * product/schedule child tables, daily_intelligence) has no customer_id, so a
 * contractor query against them is denied rather than returning everyone's data.
 */
const CONTRACTOR_SCOPED_TABLES = new Set([
  "orders",
  "tickets",
  "v_late_tickets",
  "v_tickets_with_cy",
  "v_pour_rate_per_order",
]);

/**
 * Row-level security for contractor users. Producers/admins are unaffected.
 * For a contractor, force a `customer_id IN (their customers)` filter onto every
 * query — regardless of what the model asked — and deny tables that can't be
 * scoped. Fail-closed: a contractor with no customers matches nothing.
 *
 * The scope is read from the per-request AsyncLocalStorage context set in
 * dashboard-chat.mjs, so the model can never bypass it.
 */
function applyContractorScope(params) {
  const scope = getAiRequestContext().customerScope;
  if (!scope || scope.userType !== "contractor") return params;

  if (!CONTRACTOR_SCOPED_TABLES.has(params.table)) {
    throw new Error(
      `Access to '${params.table}' is not available for your account.`,
    );
  }

  const ids = Array.isArray(scope.customerIds)
    ? scope.customerIds.filter((v) => v !== null && v !== undefined && `${v}`.length > 0)
    : [];
  // Fail-closed: no assigned customers -> a value that matches no real id.
  const value = ids.length > 0 ? ids.join(",") : "-1";

  const scopeFilter = { column: "customer_id", operator: "in", value };
  return { ...params, filters: [...(params.filters ?? []), scopeFilter] };
}

/**
 * Stage 3: Structured error thrown when a column reference is rejected by
 * the server-side _ai_validate_columns helper. tools.ts catches this and
 * surfaces it to the AI for self-correction on retry.
 */
export class UnknownColumnError extends Error {
  code = "unknown_column";
  constructor(message) {
    super(message);
    this.name = "UnknownColumnError";
  }
}

/**
 * Stage 3: Pre-flight column validation. Calls the _ai_validate_columns RPC
 * (added in migration 20260501000002) before any aggregate / select_rows /
 * count query. If the RPC isn't yet deployed (PGRST202 "function not found"),
 * skips validation gracefully so the codebase works against pre-migration
 * environments too.
 */
async function validateColumns(table, columns) {
  const cleaned = columns.filter((c) => typeof c === "string" && c.trim().length > 0);
  if (cleaned.length === 0) return;

  try {
    await pool.query(
      "SELECT * FROM _ai_validate_columns($1, $2)",
      [table, cleaned],
    );
  } catch (err) {
    // Migration not yet applied — RPC missing. Skip validation silently.
    if (err.code === "42883" || /function .* does not exist/i.test(err.message)) {
      return;
    }

    // Real validation failure — surface as structured error
    if (err.code === "22023" || /unknown_column/.test(err.message)) {
      throw new UnknownColumnError(err.message);
    }

    // Any other error: rethrow as-is (network failure etc.)
    throw new Error(`column validation: ${err.message}`);
  }
}

/**
 * Extracts every distinct column name referenced by a filter array.
 * Includes column-compare values (which are themselves column names).
 */
function collectFilterColumns(filters) {
  const out = new Set();
  for (const f of filters ?? []) {
    if (f.column) out.add(f.column);
    if (f.operator.endsWith("_col") && typeof f.value === "string" && f.value.length > 0) {
      out.add(f.value);
    }
  }
  return Array.from(out);
}

const COLUMN_COMPARE_OPS = new Set([
  "eq_col", "neq_col", "gt_col", "gte_col", "lt_col", "lte_col",
]);

function hasColumnCompareFilter(filters) {
  return (filters ?? []).some((f) => COLUMN_COMPARE_OPS.has(f.operator));
}

export async function executeTableQuery(
  params
) {
  if (BLOCKED_TABLES.includes(params.table)) {
    throw new Error(`Access to table '${params.table}' is not allowed`);
  }
  params = applyContractorScope(params);

  // Stage 3: pre-validate column references on tables and select expressions.
  const selectCols = params.select && params.select !== "*"
    ? params.select.split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))
    : [];
  await validateColumns(params.table, [
    ...selectCols,
    params.order?.column,
    params.groupBy,
    ...collectFilterColumns(params.filters),
  ]);

  // When any filter uses a column-compare operator, route through the
  // ai_select_rows RPC which builds the SQL server-side with %I/%I.
  if (hasColumnCompareFilter(params.filters)) {
    return executeRowsViaRpc(params);
  }

  const selectExpr = params.select || "*";
  const conditions = [];
  const queryParams = [];
  let paramIdx = 1;

  if (params.filters) {
    for (const f of params.filters) {
      switch (f.operator) {
        case "eq":
          conditions.push(`"${f.column}" = $${paramIdx++}`);
          queryParams.push(f.value);
          break;
        case "neq":
          conditions.push(`"${f.column}" != $${paramIdx++}`);
          queryParams.push(f.value);
          break;
        case "gt":
          conditions.push(`"${f.column}" > $${paramIdx++}`);
          queryParams.push(f.value);
          break;
        case "gte":
          conditions.push(`"${f.column}" >= $${paramIdx++}`);
          queryParams.push(f.value);
          break;
        case "lt":
          conditions.push(`"${f.column}" < $${paramIdx++}`);
          queryParams.push(f.value);
          break;
        case "lte":
          conditions.push(`"${f.column}" <= $${paramIdx++}`);
          queryParams.push(f.value);
          break;
        case "like":
          conditions.push(`"${f.column}" LIKE $${paramIdx++}`);
          queryParams.push(String(f.value));
          break;
        case "ilike":
          conditions.push(`"${f.column}" ILIKE $${paramIdx++}`);
          queryParams.push(String(f.value));
          break;
        case "is":
          if (f.value === null || f.value === undefined || f.value === "null") {
            conditions.push(`"${f.column}" IS NULL`);
          } else if (typeof f.value === "boolean") {
            conditions.push(`"${f.column}" IS $${paramIdx++}`);
            queryParams.push(f.value);
          } else {
            conditions.push(`"${f.column}" = $${paramIdx++}`);
            queryParams.push(f.value);
          }
          break;
        case "is_null":
          conditions.push(`"${f.column}" IS NULL`);
          break;
        case "is_not_null":
          conditions.push(`"${f.column}" IS NOT NULL`);
          break;
        case "in":
          conditions.push(`"${f.column}" = ANY($${paramIdx++})`);
          queryParams.push(String(f.value).split(","));
          break;
        default:
          if (f.value !== undefined) {
            conditions.push(`"${f.column}" = $${paramIdx++}`);
            queryParams.push(f.value);
          }
      }
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderClause = params.order
    ? `ORDER BY "${params.order.column}" ${params.order.ascending !== false ? "ASC" : "DESC"}`
    : "";
  const limitVal = params.limit || 10;

  const sql = `SELECT ${selectExpr} FROM "${params.table}" ${whereClause} ${orderClause} LIMIT ${limitVal}`;
  const { rows } = await pool.query(sql, queryParams);

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

function filtersToJsonb(filters) {
  if (!filters || filters.length === 0) return [];
  return filters.map((f) => ({
    column: f.column,
    operator: f.operator,
    value: f.value === undefined ? null : f.value,
  }));
}

/**
 * Routes executeTableQuery through the ai_select_rows RPC when filters
 * include column-compare operators (eq_col, gt_col, etc.). PostgREST has
 * no native syntax for column-vs-column predicates, so we let Postgres
 * build the WHERE clause via the RPC's safe identifier-only path.
 */
async function executeRowsViaRpc(
  params,
) {
  const { rows: data } = await pool.query(
    `SELECT * FROM ai_select_rows($1, $2, $3, $4, $5, $6)`,
    [
      params.table,
      JSON.stringify(filtersToJsonb(params.filters)),
      params.select ?? "*",
      params.order?.column ?? null,
      params.order?.ascending ?? false,
      params.limit ?? 10,
    ],
  );

  // ai_select_rows returns SETOF JSONB — each row is already a json object.
  const rows = data ?? [];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

export async function executeAggregate(
  params
) {
  if (BLOCKED_TABLES.includes(params.table)) {
    throw new Error(`Access to table '${params.table}' is not allowed`);
  }
  params = applyContractorScope(params);

  // Stage 3: pre-validate every column reference. Throws UnknownColumnError
  // with structured "available columns" hint if any column is invalid.
  await validateColumns(params.table, [
    params.valueColumn,
    params.groupBy,
    ...collectFilterColumns(params.filters),
  ]);

  const { rows: data } = await pool.query(
    `SELECT * FROM ai_aggregate($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      params.table,
      JSON.stringify(filtersToJsonb(params.filters)),
      params.groupBy ?? null,
      params.method,
      params.valueColumn ?? null,
      params.dateFormat ?? null,
      params.sort ?? null,
      params.limit ?? 500,
      params.topN ?? null,
      params.outerMethod ?? null,
    ],
  );

  const rows = (data ?? []).map(
    (r) => ({ key: r.key, value: Number(r.value) })
  );
  return { rows };
}

export async function executeCount(params) {
  if (BLOCKED_TABLES.includes(params.table)) {
    throw new Error(`Access to table '${params.table}' is not allowed`);
  }
  params = applyContractorScope(params);

  // Stage 3: pre-validate filter column references.
  await validateColumns(params.table, collectFilterColumns(params.filters));

  const { rows } = await pool.query(
    `SELECT * FROM ai_count($1, $2)`,
    [params.table, JSON.stringify(filtersToJsonb(params.filters))],
  );

  return Number(rows[0]?.ai_count ?? 0);
}
