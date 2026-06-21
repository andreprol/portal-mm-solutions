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

async function connect() {
  if (!driver) throw new Error('No HANA driver found. Run: npm install hdb');

  if (conn) {
    try { conn.disconnect(); } catch {}
    conn = null;
  }

  const params = { host: config.host, port: config.port, user: config.user, password: config.password };

  await new Promise((resolve, reject) => {
    if (driverName === 'hana-client') {
      conn = driver.createConnection();
      conn.connect(params, err => err ? reject(err) : resolve());
    } else {
      // hdb npm package
      conn = driver.createClient(params);
      conn.connect(err => err ? reject(err) : resolve());
    }
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

// Case 2: item appears in a BOM (ITT1) with a negligible cost contribution.
// Contribution = ITT1.Quantity × OITW.AvgPrice (current real cost at the store's depot).
// ITT1.Price is a frozen value from BOM creation and is NOT used here.
// whsCode must be the depot for the store where the ManyFood error occurred.
// Returns: [{ bomParent, component, quantity, currentPrice, contribution }]
async function checkBomContribution(itemCode, whsCode, database) {
  const sql = `
    SELECT
      T0."Father"                        AS "bomParent",
      T0."Code"                          AS "component",
      T0."Quantity"                      AS "quantity",
      T1."AvgPrice"                      AS "currentPrice",
      T0."Quantity" * T1."AvgPrice"      AS "contribution"
    FROM "${database}"."ITT1" T0
    INNER JOIN "${database}"."OITW" T1
      ON T1."ItemCode" = T0."Code"
     AND T1."WhsCode" = ?
    WHERE T0."Code" = ?
      AND T1."AvgPrice" > 0
      AND T0."Quantity" * T1."AvgPrice" < 0.01
  `;
  return await query(sql, [whsCode, itemCode]);
}

// Nested BOM check: verifies whether a BOM parent (Father) is itself a component
// in another BOM — i.e., the Delirio Tropical multi-level recipe structure.
// Returns: [{ grandParent, quantity, price }]
async function checkNestedBom(bomCode, database) {
  const sql = `
    SELECT
      T0."Father"   AS "grandParent",
      T0."Quantity" AS "quantity",
      T0."Price"    AS "price"
    FROM "${database}"."ITT1" T0
    WHERE T0."Code" = ?
  `;
  return await query(sql, [bomCode]);
}

// Phase 2: remove the item from a BOM (ITT1 row) by parent + component.
async function removeFromBom(itemCode, bomParent, database) {
  const sql = `DELETE FROM "${database}"."ITT1" WHERE "Father" = ? AND "Code" = ?`;
  await query(sql, [bomParent, itemCode]);
}

module.exports = { init, connect, checkItemCost, checkBomContribution, checkNestedBom, removeFromBom };
