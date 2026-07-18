'use strict';

const { createDb } = require('../src/db');

describe('db — dedup logic', () => {
  let db;
  beforeEach(() => { db = createDb(':memory:'); });
  afterEach(() => { db.close(); });

  test('wasProcessedThisWeek returns false for unknown item', () => {
    expect(db.wasProcessedThisWeek('CODE1', 'Loja A', 1)).toBe(false);
  });

  test('wasProcessedThisWeek returns true after markProcessed', () => {
    db.markProcessed('CODE1', 'Loja A', 1, 'alert');
    expect(db.wasProcessedThisWeek('CODE1', 'Loja A', 1)).toBe(true);
  });

  test('different store is independent key', () => {
    db.markProcessed('CODE1', 'Loja A', 1, 'alert');
    expect(db.wasProcessedThisWeek('CODE1', 'Loja B', 1)).toBe(false);
  });

  test('different caseType is independent key', () => {
    db.markProcessed('CODE1', 'Loja A', 1, 'alert');
    expect(db.wasProcessedThisWeek('CODE1', 'Loja A', 2)).toBe(false);
  });

  test('duplicate markProcessed does not throw — INSERT OR REPLACE refreshes', () => {
    db.markProcessed('CODE1', 'Loja A', 1, 'alert');
    expect(() => db.markProcessed('CODE1', 'Loja A', 1, 'alert')).not.toThrow();
    expect(db.wasProcessedThisWeek('CODE1', 'Loja A', 1)).toBe(true);
  });

  test('record older than 7 days is not counted as processed this week', () => {
    db._db.prepare(
      `INSERT INTO processed_errors(item_code, store, case_type, action, processed_at)
       VALUES(?, ?, ?, ?, datetime('now', '-8 days'))`
    ).run('CODE1', 'Loja A', 1, 'alert');
    expect(db.wasProcessedThisWeek('CODE1', 'Loja A', 1)).toBe(false);
  });

  test('record 6 days old is still within window', () => {
    db._db.prepare(
      `INSERT INTO processed_errors(item_code, store, case_type, action, processed_at)
       VALUES(?, ?, ?, ?, datetime('now', '-6 days'))`
    ).run('CODE1', 'Loja A', 1, 'alert');
    expect(db.wasProcessedThisWeek('CODE1', 'Loja A', 1)).toBe(true);
  });

  test('record at exactly 7 days boundary is included (>= comparison)', () => {
    db._db.prepare(
      `INSERT INTO processed_errors(item_code, store, case_type, action, processed_at)
       VALUES(?, ?, ?, ?, datetime('now', '-7 days'))`
    ).run('CODE1', 'Loja A', 1, 'alert');
    expect(db.wasProcessedThisWeek('CODE1', 'Loja A', 1)).toBe(true);
  });

  test('multiple distinct keys coexist without interference', () => {
    db.markProcessed('CODE1', 'Loja A', 1, 'alert');
    db.markProcessed('CODE2', 'Loja A', 1, 'alert');
    db.markProcessed('CODE1', 'Loja B', 1, 'alert');
    db.markProcessed('CODE1', 'Loja A', 2, 'action');

    expect(db.wasProcessedThisWeek('CODE1', 'Loja A', 1)).toBe(true);
    expect(db.wasProcessedThisWeek('CODE2', 'Loja A', 1)).toBe(true);
    expect(db.wasProcessedThisWeek('CODE1', 'Loja B', 1)).toBe(true);
    expect(db.wasProcessedThisWeek('CODE1', 'Loja A', 2)).toBe(true);
    expect(db.wasProcessedThisWeek('CODE3', 'Loja A', 1)).toBe(false);
  });
});
