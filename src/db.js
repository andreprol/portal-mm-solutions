const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
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
`;

// Factory — allows tests to pass ':memory:' for isolation.
function createDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const instance = new Database(dbPath);
  instance.pragma('busy_timeout = 10000');
  instance.exec(SCHEMA);

  const stmtWasProcessed = instance.prepare(
    `SELECT id FROM processed_errors
     WHERE item_code = ? AND store = ? AND case_type = ? AND processed_at >= ?`
  );

  const stmtMark = instance.prepare(
    `INSERT OR REPLACE INTO processed_errors(item_code, store, case_type, action, processed_at)
     VALUES(?, ?, ?, ?, datetime('now'))`
  );

  function wasProcessedThisWeek(itemCode, store, caseType) {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    return !!stmtWasProcessed.get(itemCode, store, caseType, cutoff);
  }

  function markProcessed(itemCode, store, caseType, action) {
    stmtMark.run(itemCode, store, caseType, action);
  }

  function close() { instance.close(); }

  return { wasProcessedThisWeek, markProcessed, close, _db: instance };
}

const defaultDb = createDb(path.join(__dirname, '..', 'data', 'state.db'));

module.exports = {
  wasProcessedThisWeek: defaultDb.wasProcessedThisWeek,
  markProcessed:        defaultDb.markProcessed,
  close:                defaultDb.close,
  createDb,
};
