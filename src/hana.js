let hdb;
try {
  hdb = require('@sap/hana-client');
} catch {
  try {
    hdb = require('hdb');
  } catch {
    hdb = null;
  }
}

let conn = null;
let config = null;

function init(cfg) {
  config = cfg;
}

async function connect() {
  if (!hdb) throw new Error('No HANA driver found. Run: npm install @sap/hana-client');

  if (conn) {
    try { conn.disconnect(); } catch {}
    conn = null;
  }

  conn = hdb.createConnection();
  await new Promise((resolve, reject) => {
    conn.connect({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
    }, err => err ? reject(err) : resolve());
  });
}

async function query(sql, params = []) {
  if (!conn) await connect();

  return new Promise((resolve, reject) => {
    conn.exec(sql, params, (err, rows) => {
      if (err) {
        conn = null; // force reconnect on next call
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// Case 1: check whether the item has any cost (AvgPrice > 0) in any warehouse.
// Returns: { hasCost: bool, warehouses: [...] }
async function checkItemCost(itemCode, database) {
  const sql = `
    SELECT T0."ItemCode", T0."WhsCode", T0."AvgPrice", T0."OnHand"
    FROM "${database}"."OITW" T0
    WHERE T0."ItemCode" = ?
  `;
  const rows = await query(sql, [itemCode]);

  const hasCost = rows.some(r => (r.AvgPrice || r['AvgPrice'] || 0) > 0);
  return { hasCost, warehouses: rows };
}

// Case 2: check whether the item appears in any BOM (ITT1) with a negligible
// cost contribution (quantity × price < 0.01), which SAP treats as zero cost.
// Returns: [{ bomParent, component, quantity, price, contribution }]
async function checkBomContribution(itemCode, database) {
  const sql = `
    SELECT
      T0."Father"    AS "bomParent",
      T0."ItemCode"  AS "component",
      T0."Quantity"  AS "quantity",
      T0."Price"     AS "price",
      T0."Quantity" * T0."Price" AS "contribution"
    FROM "${database}"."ITT1" T0
    WHERE T0."ItemCode" = ?
      AND T0."Quantity" * T0."Price" < 0.01
  `;
  return await query(sql, [itemCode]);
}

// Phase 2: remove the item from a BOM (ITT1 row) by parent + component.
async function removeFromBom(itemCode, bomParent, database) {
  const sql = `
    DELETE FROM "${database}"."ITT1"
    WHERE "Father" = ? AND "ItemCode" = ?
  `;
  await query(sql, [bomParent, itemCode]);
}

module.exports = { init, connect, checkItemCost, checkBomContribution, removeFromBom };
