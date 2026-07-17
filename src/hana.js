// Supports both @sap/hana-client (createConnection) and hdb (createClient)
let driver = null;
let driverName = null;

try {
  driver = require('@sap/hana-client');
  driverName = 'hana-client';
} catch {
  try {
    driver = require('hdb');
    driverName = 'hdb';
  } catch {
    driver = null;
  }
}

let conn = null;
let config = null;

function init(cfg) {
  config = cfg;
}

const CONNECT_TIMEOUT_MS = 15000;

async function connect() {
  if (!driver) throw new Error('No HANA driver found. Run: npm install hdb');

  if (conn) {
    try { conn.disconnect(); } catch {}
    conn = null;
  }

  const params = { host: config.host, port: config.port, user: config.user, password: config.password };
  let newConn = null;

  await Promise.race([
    new Promise((resolve, reject) => {
      if (driverName === 'hana-client') {
        newConn = driver.createConnection();
        newConn.connect(params, err => err ? reject(err) : resolve());
      } else {
        newConn = driver.createClient(params);
        newConn.connect(err => err ? reject(err) : resolve());
      }
    }),
    new Promise((_, reject) => setTimeout(() => {
      try { if (newConn) newConn.disconnect(); } catch {}
      reject(new Error(`HANA connect timeout after ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS)),
  ]);

  conn = newConn;

  // hdb emits async 'error' events on TCP drop (VPN flapping).
  // Without a listener, Node throws uncaughtException and crashes.
  // Setting conn = null lets the lazy-connect in query() reconnect on next call.
  conn.on('error', (err) => {
    console.error('[hana] connection error (async):', err.message);
    conn = null;
  });
}

async function query(sql, params = []) {
  if (!conn) await connect();

  // hdb requires prepare+exec for parameterized queries;
  // @sap/hana-client supports conn.exec(sql, params, cb) directly.
  if (params.length === 0 || driverName === 'hana-client') {
    return new Promise((resolve, reject) => {
      conn.exec(sql, params, (err, rows) => {
        if (err) { conn = null; reject(err); }
        else resolve(rows);
      });
    });
  }

  return new Promise((resolve, reject) => {
    conn.prepare(sql, (err, stmt) => {
      if (err) { conn = null; reject(err); return; }
      stmt.exec(params, (err2, rows) => {
        if (err2) { conn = null; reject(err2); }
        else resolve(rows);
      });
    });
  });
}

// Case 1: check whether the item has cost (AvgPrice > 0) in a specific warehouse.
// whsCode must match the SAP OITW.WhsCode for the store where the error occurred
// (e.g. store "6 - Cittá" → whsCode "06").
// Returns: { hasCost: bool, whsAvgPrice: number, warehouses: [...] }
async function checkItemCost(itemCode, whsCode, database) {
  const sql = `
    SELECT T0."ItemCode", T0."WhsCode", T0."AvgPrice", T0."OnHand"
    FROM "${database}"."OITW" T0
    WHERE T0."ItemCode" = ?
  `;
  const rows = await query(sql, [itemCode]);

  const whsRow = rows.find(r => r.WhsCode === whsCode || r['WhsCode'] === whsCode);
  const whsAvgPrice = whsRow ? (whsRow.AvgPrice || whsRow['AvgPrice'] || 0) : 0;
  const hasCost = whsAvgPrice > 0;
  return { hasCost, whsAvgPrice, warehouses: rows };
}

// Case 2: item appears in a BOM (ITT1) with negligible cost contribution.
//
// Contribution uses OITW.AvgPrice (current real cost at the store depot), NOT ITT1.Price.
// Delírio Tropical BOMs have at most 2 levels: item → sub-recipe (250xxx) → final product.
//
// Level 1 — item directly in a ficha técnica:
//   contribution = ITT1.Quantity × OITW.AvgPrice
//
// Level 2 — item in sub-recipe, sub-recipe in another ficha:
//   effective contribution = Qty_subRecipe_in_parent × Qty_item_in_subRecipe × OITW.AvgPrice
//   (e.g. 0.02 × 0.01 × R$20 = R$0.004 < R$0.01 even though item alone gives R$0.20)
//
// Returns: [{ level, bomParent, via, qty1, qty2, currentPrice, contribution }]
//   level:     'L1' (direct) | 'L2' (nested via sub-recipe)
//   bomParent: the ficha técnica that needs the fix
//   via:       sub-recipe code (L2 only) — the intermediate BOM containing the item
async function checkBomContribution(itemCode, whsCode, database) {
  const sql = `
    SELECT
      'L1'                               AS "level",
      T0."Father"                        AS "bomParent",
      NULL                               AS "via",
      T0."Quantity"                      AS "qty1",
      NULL                               AS "qty2",
      T1."AvgPrice"                      AS "currentPrice",
      T0."Quantity" * T1."AvgPrice"      AS "contribution"
    FROM "${database}"."ITT1" T0
    INNER JOIN "${database}"."OITW" T1
      ON T1."ItemCode" = T0."Code"
     AND T1."WhsCode" = ?
    WHERE T0."Code" = ?
      AND T1."AvgPrice" > 0
      AND T0."Quantity" * T1."AvgPrice" < 0.01

    UNION ALL

    SELECT
      'L2'                                          AS "level",
      T2."Father"                                   AS "bomParent",
      T0."Father"                                   AS "via",
      T0."Quantity"                                 AS "qty1",
      T2."Quantity"                                 AS "qty2",
      T1."AvgPrice"                                 AS "currentPrice",
      T2."Quantity" * T0."Quantity" * T1."AvgPrice" AS "contribution"
    FROM "${database}"."ITT1" T0
    INNER JOIN "${database}"."OITW" T1
      ON T1."ItemCode" = T0."Code"
     AND T1."WhsCode" = ?
    INNER JOIN "${database}"."ITT1" T2
      ON T2."Code" = T0."Father"
    WHERE T0."Code" = ?
      AND T1."AvgPrice" > 0
      AND T2."Quantity" * T0."Quantity" * T1."AvgPrice" < 0.01
  `;
  return await query(sql, [whsCode, itemCode, whsCode, itemCode]);
}

// Phase 2: remove an entry from ITT1.
// For L1: remove item from its direct ficha técnica (bomParent).
// For L2: remove the sub-recipe (via) from the grandparent ficha (bomParent).
async function removeFromBom(itemCode, bomParent, database) {
  const sql = `DELETE FROM "${database}"."ITT1" WHERE "Father" = ? AND "Code" = ?`;
  await query(sql, [bomParent, itemCode]);
}

// Fallback for Case 2 when checkBomContribution returns 0 rows.
// The ManyFood log is authoritative — if the error exists and the item has OITW cost,
// there IS a ficha that caused it (possibly at a lower historical AvgPrice).
// This query removes the < 0.01 threshold and returns ALL BOM paths sorted by
// contribution ascending, so the user can identify and fix the likely culprit(s).
async function findBomPathsFallback(itemCode, whsCode, database) {
  const sql = `
    SELECT
      'L1'                               AS "level",
      T0."Father"                        AS "bomParent",
      NULL                               AS "via",
      T0."Quantity"                      AS "qty1",
      NULL                               AS "qty2",
      T1."AvgPrice"                      AS "currentPrice",
      T0."Quantity" * T1."AvgPrice"      AS "contribution"
    FROM "${database}"."ITT1" T0
    INNER JOIN "${database}"."OITW" T1
      ON T1."ItemCode" = T0."Code"
     AND T1."WhsCode" = ?
    WHERE T0."Code" = ?
      AND T1."AvgPrice" > 0

    UNION ALL

    SELECT
      'L2'                                          AS "level",
      T2."Father"                                   AS "bomParent",
      T0."Father"                                   AS "via",
      T0."Quantity"                                 AS "qty1",
      T2."Quantity"                                 AS "qty2",
      T1."AvgPrice"                                 AS "currentPrice",
      T2."Quantity" * T0."Quantity" * T1."AvgPrice" AS "contribution"
    FROM "${database}"."ITT1" T0
    INNER JOIN "${database}"."OITW" T1
      ON T1."ItemCode" = T0."Code"
     AND T1."WhsCode" = ?
    INNER JOIN "${database}"."ITT1" T2
      ON T2."Code" = T0."Father"
    WHERE T0."Code" = ?
      AND T1."AvgPrice" > 0

    ORDER BY "contribution" ASC
  `;
  return await query(sql, [whsCode, itemCode, whsCode, itemCode]);
}

// Case 3: proactive sweep — find all BOM paths where the item's MIN price across
// monitored stores yields a contribution < R$0.01.
// Items range 300001–699999 (ingredients/components). Only items with AvgPrice > 0
// in at least one monitored store (has receiving history — not a Case 1 issue).
// Single query — runs once daily, independent of ManyFood errors.
// whsCodes: array of SAP warehouse codes for the monitored stores (e.g. ['01','04',...])
async function sweepBomByMinCost(whsCodes, database) {
  const ph = whsCodes.map(() => '?').join(', ');
  const sql = `
    SELECT
      'L1'                                          AS "level",
      T0."Code"                                     AS "itemCode",
      T2."ItemName"                                 AS "itemName",
      T0."Father"                                   AS "bomParent",
      NULL                                          AS "via",
      T0."Quantity"                                 AS "qty1",
      NULL                                          AS "qty2",
      MIN(T1."AvgPrice")                            AS "minPrice",
      T0."Quantity" * MIN(T1."AvgPrice")            AS "contribution"
    FROM "${database}"."ITT1" T0
    INNER JOIN "${database}"."OITW" T1
      ON T1."ItemCode" = T0."Code"
     AND T1."WhsCode" IN (${ph})
    INNER JOIN "${database}"."OITM" T2
      ON T2."ItemCode" = T0."Code"
    WHERE T0."Code" >= '300001'
      AND T0."Code" <= '699999'
      AND T1."AvgPrice" > 0
    GROUP BY T0."Code", T2."ItemName", T0."Father", T0."Quantity"
    HAVING T0."Quantity" * MIN(T1."AvgPrice") < 0.01

    UNION ALL

    SELECT
      'L2'                                               AS "level",
      T0."Code"                                          AS "itemCode",
      T2."ItemName"                                      AS "itemName",
      T3."Father"                                        AS "bomParent",
      T0."Father"                                        AS "via",
      T0."Quantity"                                      AS "qty1",
      T3."Quantity"                                      AS "qty2",
      MIN(T1."AvgPrice")                                 AS "minPrice",
      T3."Quantity" * T0."Quantity" * MIN(T1."AvgPrice") AS "contribution"
    FROM "${database}"."ITT1" T0
    INNER JOIN "${database}"."OITW" T1
      ON T1."ItemCode" = T0."Code"
     AND T1."WhsCode" IN (${ph})
    INNER JOIN "${database}"."OITM" T2
      ON T2."ItemCode" = T0."Code"
    INNER JOIN "${database}"."ITT1" T3
      ON T3."Code" = T0."Father"
    WHERE T0."Code" >= '300001'
      AND T0."Code" <= '699999'
      AND T1."AvgPrice" > 0
    GROUP BY T0."Code", T2."ItemName", T0."Father", T0."Quantity", T3."Father", T3."Quantity"
    HAVING T3."Quantity" * T0."Quantity" * MIN(T1."AvgPrice") < 0.01
  `;
  // params: whsCodes twice (once for each SELECT in the UNION ALL)
  return await query(sql, [...whsCodes, ...whsCodes]);
}

module.exports = { init, connect, checkItemCost, checkBomContribution, findBomPathsFallback, removeFromBom, sweepBomByMinCost };
