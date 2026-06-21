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
        conn = null; // force reconnect next time
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// Caso 1: check if item has any cost (AvgPrice > 0) in any warehouse for that store
// Returns: { hasCost: bool, avgPrice: number, warehouses: [...] }
async function checkItemCost(itemCode, database) {
  const sql = `
    SELECT T0."ItemCode", T0."WhsCode", T0."AvgPrice", T0."OnHand"
    FROM "${database}"."OITW" T0
    WHERE T0."ItemCode" = ?
  `;
  const rows = await query(sql, [itemCode]);

  const hasCost = rows.some(r => (r.AvgPrice || r['AvgPrice'] || 0) > 0);
  return {
    hasCost,
    warehouses: rows,
  };
}

// Caso 2: check if item is a BOM component with negligible cost contribution (< 0.01)
// Returns: [{ fichaTecnica, quantity, price, contribution }]
async function checkBomContribution(itemCode, database) {
  const sql = `
    SELECT
      T0."Father"    AS "fichaTecnica",
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

// Phase 2: remove item from BOM (ITT1) — used only when phase >= 2
async function removeFromBom(itemCode, fichaTecnica, database) {
  const sql = `
    DELETE FROM "${database}"."ITT1"
    WHERE "Father" = ? AND "ItemCode" = ?
  `;
  await query(sql, [fichaTecnica, itemCode]);
}

module.exports = { init, connect, checkItemCost, checkBomContribution, removeFromBom };
