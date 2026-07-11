'use strict';

// Converts "DD/MM/YYYY" → "YYYY-MM-DD"
function portalDateToIso(s) {
  const [d, m, y] = s.split('/');
  return `${y}-${m}-${d}`;
}

// "6 - Cittá Delirio Restaurante" → "06"
// "14 - Delirio Tropical Niteroi Plaza" → "14"
// Returns null if storeName does not start with a number.
function storeToWhsCode(storeName) {
  const match = storeName.match(/^(\d+)\s*-/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return String(n).padStart(2, '0');
}

// Compares two DD/MM/YYYY date strings, returning the earlier one.
function minDate(a, b) {
  return portalDateToIso(a) <= portalDateToIso(b) ? a : b;
}

// Compares two DD/MM/YYYY date strings, returning the later one.
function maxDate(a, b) {
  return portalDateToIso(a) >= portalDateToIso(b) ? a : b;
}

module.exports = { portalDateToIso, storeToWhsCode, minDate, maxDate };
