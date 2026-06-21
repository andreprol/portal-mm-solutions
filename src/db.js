const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new Database(path.join(dataDir, 'state.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS processed_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_code TEXT NOT NULL,
    filial TEXT NOT NULL,
    date TEXT NOT NULL,
    case_type INTEGER NOT NULL,
    action TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_error_day
    ON processed_errors(item_code, filial, date, case_type);
`);

function wasProcessedToday(itemCode, filial, date, caseType) {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    `SELECT id FROM processed_errors
     WHERE item_code = ? AND filial = ? AND date = ? AND case_type = ?
       AND processed_at >= ?`
  ).get(itemCode, filial, date, caseType, today + ' 00:00:00');
  return !!row;
}

function markProcessed(itemCode, filial, date, caseType, action) {
  db.prepare(
    `INSERT OR IGNORE INTO processed_errors(item_code, filial, date, case_type, action)
     VALUES(?, ?, ?, ?, ?)`
  ).run(itemCode, filial, date, caseType, action);
}

module.exports = { wasProcessedToday, markProcessed };
