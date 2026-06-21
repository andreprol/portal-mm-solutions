const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new Database(path.join(dataDir, 'state.db'));

// Schema v2: dedup per (item_code, store, case_type) with a weekly window.
// The `date` column was removed from the unique key — we group all occurrences
// of the same item+store+case and alert once per week, not once per error date.
db.exec(`
  CREATE TABLE IF NOT EXISTS processed_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_code TEXT NOT NULL,
    store TEXT NOT NULL,
    case_type INTEGER NOT NULL,
    action TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_error_item_store_case
    ON processed_errors(item_code, store, case_type);
`);

// Returns true if this (item, store, case) was already alerted within the last 7 days.
function wasProcessedThisWeek(itemCode, store, caseType) {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
  const row = db.prepare(
    `SELECT id FROM processed_errors
     WHERE item_code = ? AND store = ? AND case_type = ? AND processed_at >= ?`
  ).get(itemCode, store, caseType, cutoff);
  return !!row;
}

// INSERT OR REPLACE so the timestamp is refreshed each time we alert.
function markProcessed(itemCode, store, caseType, action) {
  db.prepare(
    `INSERT OR REPLACE INTO processed_errors(item_code, store, case_type, action, processed_at)
     VALUES(?, ?, ?, ?, datetime('now'))`
  ).run(itemCode, store, caseType, action);
}

module.exports = { wasProcessedThisWeek, markProcessed };
