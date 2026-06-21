const cron = require('node-cron');
const config = require('./config');
const manyfood = require('./manyfood');
const hana = require('./hana');
const email = require('./email');
const db = require('./db');

hana.init(config.hana);
email.init(config.graph, config.graph.fromEmail);

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function portalDateToIso(s) {
  const [d, m, y] = s.split('/');
  return `${y}-${m}-${d}`;
}

// "6 - Cittá Delirio Restaurante" → "06"
// "14 - Delirio Tropical Niteroi Plaza" → "14"
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
function maxDate(a, b) {
  return portalDateToIso(a) >= portalDateToIso(b) ? a : b;
}

async function run() {
  console.log(`[runner] starting check at ${new Date().toISOString()}`);

  // --- Step 1: login once, then collect errors from every configured store ---
  try {
    await manyfood.login(config.manyfood.user, config.manyfood.password);
  } catch (err) {
    console.error('[runner] login failed:', err.message);
    return;
  }

  const dateEnd   = dateOffset(0);
  const dateStart = dateOffset(-(config.lookbackDays || 90));

  const filiais = config.filiais || [];
  if (filiais.length === 0) {
    console.warn('[runner] config.filiais is empty — add store IDs to config.json');
  }

  // Collect all zero-cost errors across all stores.
  // Key: `${itemCode}|${store}` → grouped error record.
  const errorMap = new Map();

  for (const filial of filiais) {
    try {
      await manyfood.switchFilial(filial.id);
    } catch (err) {
      console.error(`[runner] switchFilial ${filial.id} failed:`, err.message);
      continue;
    }

    let rawErrors;
    try {
      rawErrors = await manyfood.getErrorsForPeriod(dateStart, dateEnd);
    } catch (err) {
      console.error(`[runner] getErrorsForPeriod filial ${filial.id} failed:`, err.message);
      continue;
    }

    const zeroCost = manyfood.parseZeroCostErrors(rawErrors);
    console.log(`[runner] filial ${filial.id} (${filial.nome}): ${rawErrors.length} total, ${zeroCost.length} zero-cost`);

    for (const err of zeroCost) {
      const key = `${err.itemCode}|${err.store}`;
      if (!errorMap.has(key)) {
        errorMap.set(key, { ...err, firstDate: err.date, lastDate: err.date, occurrences: 1, errorDates: new Set([err.date]) });
      } else {
        const g = errorMap.get(key);
        g.firstDate   = minDate(g.firstDate, err.date);
        g.lastDate    = maxDate(g.lastDate, err.date);
        g.occurrences += 1;
        g.errorDates.add(err.date);
      }
    }
  }

  console.log(`[runner] ${errorMap.size} unique item+store pairs with zero-cost errors`);
  if (errorMap.size === 0) {
    console.log('[runner] no zero-cost errors found. Done.');
    return;
  }

  // --- Step 2: classify each unique (itemCode, store) pair via HANA ---
  // HANA check is per-pair because the same item may have cost at one store but not another.
  // WhsCode is derived from the ManyFood store name number prefix (e.g. "6 - Cittá" → "06").
  const hanaCache = {};

  for (const [key, group] of errorMap) {
    const { itemCode, store } = group;
    const whsCode = storeToWhsCode(store);

    let costInfo;
    try {
      costInfo = await hana.checkItemCost(itemCode, whsCode, config.hana.database);
    } catch (e) {
      console.error(`[hana] checkItemCost ${itemCode}@${whsCode} failed:`, e.message);
      // HANA error: skip this pair to avoid false Case 1 alerts
      hanaCache[key] = null;
      continue;
    }

    let bomRows = [];
    if (costInfo.hasCost) {
      try {
        // L1: direct BOM entries with contribution < R$0.01
        // L2: item in sub-recipe, sub-recipe in another ficha — effective contribution < R$0.01
        // Both levels returned in a single query; no separate nested BOM loop needed.
        bomRows = await hana.checkBomContribution(itemCode, whsCode, config.hana.database);
      } catch (e) {
        console.error(`[hana] checkBomContribution ${itemCode} failed:`, e.message);
      }
    }

    hanaCache[key] = { costInfo, bomRows };
  }

  // --- Step 3: route each group to Case 1 or Case 2, applying weekly dedup ---
  const case1       = [];
  const case2Alert  = [];
  const case2Action = [];

  for (const [key, group] of errorMap) {
    const { itemCode, store } = group;
    const whsCode = storeToWhsCode(store);
    const cached = hanaCache[key];

    // HANA query failed for this pair — skip to avoid false positives
    if (cached === null) continue;

    const { costInfo, bomRows } = cached;
    const dedup1 = db.wasProcessedThisWeek(itemCode, store, 1);
    const dedup2 = db.wasProcessedThisWeek(itemCode, store, 2);

    if (!costInfo.hasCost) {
      // Case 1 — OITW.AvgPrice = 0 at the store's warehouse → no receiving history at this location
      if (!dedup1) {
        case1.push(group);
        db.markProcessed(itemCode, store, 1, 'alert');
      }
    } else if (bomRows.length > 0) {
      // Case 2 — has cost at the warehouse but BOM contribution is negligible (Price > 0, qty × price < 0.01)
      if (config.phase >= 2) {
        if (!dedup2) {
          const results = [];
          for (const bom of bomRows) {
            try {
              await hana.removeFromBom(itemCode, bom.bomParent, config.hana.database);
              results.push({ ...group, bomParent: bom.bomParent, success: true });
            } catch (e) {
              results.push({ ...group, bomParent: bom.bomParent, success: false, error: e.message });
            }
          }
          case2Action.push(...results);
          db.markProcessed(itemCode, store, 2, 'auto-removed');
        }
      } else {
        if (!dedup2) {
          case2Alert.push({ ...group, bomRows });
          db.markProcessed(itemCode, store, 2, 'alerted');
        }
      }
    } else {
      // hasCost=true but strict check (Qty × AvgPrice < R$0.01) returned 0 rows.
      // The ManyFood log is authoritative: the error exists and there IS a ficha that caused it.
      // Most likely cause: OITW.AvgPrice was lower on the error date (moving average dipped).
      // When ManyFood reprocesses that date it will use the historical cost → same error recurs.
      // Solution: find the lowest-contribution BOM paths (most likely culprits) and report them.
      let fallbackRows = [];
      try {
        const allPaths = await hana.findBomPathsFallback(itemCode, whsCode, config.hana.database);
        // Take only the single lowest-contribution path (closest to R$0.01).
        // If it doesn't fix the error, the next run will pick the next candidate.
        fallbackRows = allPaths.length > 0 ? [allPaths[0]] : [];
        if (fallbackRows.length > 0) {
          console.log(`[hana] fallback found ${fallbackRows.length} path(s) for ${itemCode}@${whsCode} (contributions: ${fallbackRows.map(r => r.contribution?.toFixed(4)).join(', ')})`);
        }
      } catch (e) {
        console.error(`[hana] findBomPathsFallback ${itemCode} failed:`, e.message);
      }

      if (!dedup2) {
        case2Alert.push({ ...group, bomRows: fallbackRows });
        db.markProcessed(itemCode, store, 2, fallbackRows.length > 0 ? 'momentary' : 'no-bom-found');
      }
    }
  }

  // --- Step 4: send emails ---
  if (case1.length > 0) {
    try {
      await email.send(
        config.email.recipients_case1,
        `[Portal MM] ${case1.length} item(s) sem custo — sem histórico de entrada`,
        email.buildCase1Email(case1)
      );
    } catch (e) {
      console.error('[email] case1 send failed:', e.message);
    }
  }

  if (case2Alert.length > 0) {
    try {
      await email.send(
        config.email.recipients_case2_alert,
        `[Portal MM] ${case2Alert.length} item(s) sem custo — contribuição ínfima em ficha técnica`,
        email.buildCase2AlertEmail(case2Alert)
      );
    } catch (e) {
      console.error('[email] case2 alert send failed:', e.message);
    }
  }

  if (case2Action.length > 0) {
    try {
      await email.send(
        config.email.recipients_case2_action,
        `[Portal MM] Relatório de remoção automática — ${case2Action.filter(r => r.success).length} entrada(s) de ficha técnica removida(s)`,
        email.buildCase2ActionEmail(case2Action)
      );
    } catch (e) {
      console.error('[email] case2 action send failed:', e.message);
    }
  }

  console.log(`[runner] done. case1=${case1.length} case2alert=${case2Alert.length} case2action=${case2Action.length}`);
}

run().catch(err => console.error('[runner] unhandled error:', err));

cron.schedule(config.schedule, () => {
  run().catch(err => console.error('[runner] unhandled error:', err));
});

console.log(`[portal-mm-solutions] scheduled: ${config.schedule}`);
