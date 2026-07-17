#!/usr/bin/env node
// Manual trigger for run() — bypasses cron and health server.
// Usage: node scripts/manual-run.js [--case3]
const config    = require('../src/config');
const manyfood  = require('../src/manyfood');
const hana      = require('../src/hana');
const email     = require('../src/email');
const db        = require('../src/db');
const { storeToWhsCode, minDate, maxDate } = require('../src/utils');

hana.init(config.hana);
email.init(config.graph, config.graph.fromEmail);

const runCase3 = process.argv.includes('--case3');

async function run() {
  console.log(`[manual-run] starting check at ${new Date().toISOString()}`);

  try {
    await manyfood.login(config.manyfood.user, config.manyfood.password);
  } catch (err) {
    console.error('[runner] login failed:', err.message);
    return;
  }

  const dateOffset = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const dateEnd   = dateOffset(0);
  const dateStart = dateOffset(-(config.lookbackDays || 90));

  const filiais = config.filiais || [];
  const errorMap = new Map();

  for (const filial of filiais) {
    try { await manyfood.switchFilial(filial.id); } catch (e) { console.error(`switchFilial ${filial.id}:`, e.message); continue; }

    let rawErrors;
    try { rawErrors = await manyfood.getErrorsForPeriod(dateStart, dateEnd); } catch (e) { console.error(`getErrors ${filial.id}:`, e.message); continue; }

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
  if (errorMap.size === 0) { console.log('[runner] no zero-cost errors. done.'); return; }

  const hanaCache = {};
  for (const [key, group] of errorMap) {
    const { itemCode, store } = group;
    const whsCode = storeToWhsCode(store);
    let costInfo;
    try {
      costInfo = await hana.checkItemCost(itemCode, whsCode, config.hana.database);
    } catch (e) {
      console.error(`[hana] checkItemCost ${itemCode}@${whsCode}:`, e.message);
      hanaCache[key] = null;
      continue;
    }
    let bomRows = [];
    if (costInfo.hasCost) {
      try { bomRows = await hana.checkBomContribution(itemCode, whsCode, config.hana.database); } catch (e) { console.error(`[hana] checkBomContribution ${itemCode}:`, e.message); }
    }
    hanaCache[key] = { costInfo, bomRows };
  }

  const case1 = [], case2Alert = [], case2Action = [];

  for (const [key, group] of errorMap) {
    const { itemCode, store } = group;
    const whsCode = storeToWhsCode(store);
    const cached = hanaCache[key];
    if (cached === null) continue;
    const { costInfo, bomRows } = cached;

    if (!costInfo.hasCost) {
      if (db.wasProcessedThisWeek(itemCode, store, 1)) { console.log(`[dedup] case1 skip ${itemCode}@${store}`); continue; }
      case1.push(group);
    } else if (bomRows.length > 0) {
      if (config.phase >= 2) {
        const results = [];
        for (const bom of bomRows) {
          try { await hana.removeFromBom(itemCode, bom.bomParent, config.hana.database); results.push({ ...group, bomParent: bom.bomParent, success: true }); }
          catch (e) { results.push({ ...group, bomParent: bom.bomParent, success: false, error: e.message }); }
        }
        case2Action.push(...results);
      } else {
        if (db.wasProcessedThisWeek(itemCode, store, 2)) { console.log(`[dedup] case2 skip ${itemCode}@${store}`); continue; }
        case2Alert.push({ ...group, bomRows });
      }
    } else {
      let fallbackRows = [];
      try {
        const allPaths = await hana.findBomPathsFallback(itemCode, whsCode, config.hana.database);
        const best = allPaths[0];
        fallbackRows = best ? [best] : [];
      } catch (e) { console.error(`[hana] findBomPathsFallback ${itemCode}:`, e.message); }
      if (db.wasProcessedThisWeek(itemCode, store, 2)) { console.log(`[dedup] case2-fallback skip ${itemCode}@${store}`); continue; }
      case2Alert.push({ ...group, bomRows: fallbackRows });
    }
  }

  if (case1.length > 0) {
    try {
      await email.send(config.email.recipients_case1, `[Portal MM] Caso 1 — ${case1.length} item(s) sem custo — sem histórico de entrada`, email.buildCase1Email(case1));
      for (const item of case1) db.markProcessed(item.itemCode, item.store, 1, 'alert');
    } catch (e) { console.error('[email] case1:', e.message); }
  }

  if (case2Alert.length > 0) {
    try {
      const uniqueProducts = new Set(case2Alert.map(e => e.itemCode)).size;
      await email.send(config.email.recipients_case2_alert, `[Portal MM] Caso 2 — ${uniqueProducts} produto(s) sem custo — contribuição ínfima em ficha técnica`, email.buildCase2AlertEmail(case2Alert));
      for (const item of case2Alert) db.markProcessed(item.itemCode, item.store, 2, 'alert');
    } catch (e) { console.error('[email] case2:', e.message); }
  }

  if (case2Action.length > 0) {
    try {
      await email.send(config.email.recipients_case2_action, `[Portal MM] Relatório de remoção automática — ${case2Action.filter(r => r.success).length} entrada(s) removida(s)`, email.buildCase2ActionEmail(case2Action));
    } catch (e) { console.error('[email] case2action:', e.message); }
  }

  console.log(`[manual-run] done. case1=${case1.length} case2alert=${case2Alert.length} case2action=${case2Action.length}`);
}

async function runCase3Manual() {
  console.log('[manual-run] starting case3 at', new Date().toISOString());
  const whsCodes = (config.filiais || []).map(f => storeToWhsCode(f.nome)).filter(Boolean);
  if (whsCodes.length === 0) { console.error('[case3] no valid whsCodes'); return; }
  let rows = [];
  try {
    rows = await hana.sweepBomByMinCost(whsCodes, config.hana.database);
    console.log(`[case3] sweep: ${rows.length} path(s) < R$0.01`);
  } catch (e) { console.error('[case3] HANA sweep failed:', e.message); return; }

  if (rows.length === 0) {
    try { await email.send(config.email.recipients_case3 || config.email.recipients_case2_alert, `[Portal MM] Caso 3 — Nenhuma ficha técnica com risco de custo ínfimo`, email.buildCase3AllClearEmail()); }
    catch (e) { console.error('[case3] all-clear email:', e.message); }
    return;
  }

  if (config.phase >= 2) {
    const pathsMap = new Map();
    for (const r of rows) {
      const father = r.via || r.bomParent;
      const key = `${r.itemCode}|${father}`;
      if (!pathsMap.has(key)) pathsMap.set(key, { itemCode: r.itemCode, itemName: r.itemName || '', father, bomParent: r.bomParent, level: r.level, via: r.via || null, minPrice: Number(r.minPrice)||0, qty1: Number(r.qty1)||0, qty2: r.qty2!=null?Number(r.qty2):null, contribution: Number(r.contribution)||0 });
    }
    const results = [];
    for (const p of pathsMap.values()) {
      try { await hana.removeFromBom(p.itemCode, p.father, config.hana.database); results.push({...p, success:true}); console.log(`[case3] removed ${p.itemCode} from ${p.father}`); }
      catch (e) { results.push({...p, success:false, error:e.message}); }
    }
    const removed = results.filter(r=>r.success).length;
    try { await email.send(config.email.recipients_case3||config.email.recipients_case2_alert, `[Portal MM] Caso 3 — ${removed} entrada(s) removida(s)`, email.buildCase3ActionEmail(results)); }
    catch (e) { console.error('[case3] email:', e.message); }
  } else {
    try {
      const uniqueItems = new Set(rows.map(r=>r.itemCode)).size;
      await email.send(config.email.recipients_case3||config.email.recipients_case2_alert, `[Portal MM] Caso 3 — ${uniqueItems} produto(s) com risco`, email.buildCase3Email(rows));
    } catch (e) { console.error('[case3] email:', e.message); }
  }
  console.log('[manual-run] case3 done');
}

(runCase3 ? runCase3Manual() : run()).catch(e => { console.error('[fatal]', e.message); process.exit(1); });
