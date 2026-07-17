'use strict';

const config   = require('./config');
const manyfood = require('./manyfood');
const hana     = require('./hana');
const email    = require('./email');
const db       = require('./db');
const { storeToWhsCode, minDate, maxDate } = require('./utils');

let lastRunAt        = null;
let lastCase3At      = null;
let lastOpsAlertAt   = null; // rate-limit to once per hour

function getLastRunAt()   { return lastRunAt; }
function getLastCase3At() { return lastCase3At; }

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Sends an ops alert email. Rate-limited to once per hour to avoid flooding
// on persistent failures (e.g. HANA down for multiple consecutive runs).
async function sendOpsAlert(subject, detail) {
  const now = Date.now();
  if (lastOpsAlertAt && now - lastOpsAlertAt < 60 * 60 * 1000) {
    console.warn(`[ops-alert] suppressed (${Math.round((now - lastOpsAlertAt) / 60000)}min since last): ${subject}`);
    return;
  }
  lastOpsAlertAt = now;

  const recipients = (config.email || {}).recipients_ops
    || (config.email || {}).recipients_case1
    || [];
  if (recipients.length === 0) {
    console.error('[ops-alert] no recipients — add email.recipients_ops to config.json');
    return;
  }

  const html = `
    <html><body style="font-family:Arial,sans-serif;font-size:14px;color:#333">
    <h2 style="color:#c0392b">&#9888;&#65039; Portal MM Solutions — Falha Operacional</h2>
    <p><strong>${subject}</strong></p>
    <pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap">${detail}</pre>
    <p style="font-size:11px;color:#999">
      Verificar: VM vm-dt-manager &middot; PM2 status &middot; VPN OpenVPN &middot;
      HANA 10.123.35.82:30015 &middot; <code>GET http://localhost:3849/health</code>
    </p>
    <p style="font-size:11px;color:#999">
      Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
    </p>
    </body></html>
  `;

  try {
    await email.send(recipients, `[Portal MM] &#9888; FALHA: ${subject}`, html);
    console.log(`[ops-alert] sent: ${subject}`);
  } catch (e) {
    console.error('[ops-alert] failed to send alert:', e.message);
  }
}

async function run() {
  console.log(`[runner] starting check at ${new Date().toISOString()}`);

  try {
    await manyfood.login(config.manyfood.user, config.manyfood.password);
  } catch (err) {
    console.error('[runner] login failed:', err.message);
    await sendOpsAlert('ManyFood login falhou', err.message);
    return;
  }

  const dateEnd   = dateOffset(0);
  const dateStart = dateOffset(-(config.lookbackDays || 90));
  const filiais   = config.filiais || [];

  if (filiais.length === 0) {
    console.warn('[runner] config.filiais is empty — add store IDs to config.json');
  }

  // Step 1: collect zero-cost errors across all stores
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
    lastRunAt = new Date().toISOString();
    return;
  }

  // Step 2: classify each pair via HANA
  const hanaCache   = {};
  let hanaFailCount = 0;

  for (const [key, group] of errorMap) {
    const { itemCode, store } = group;
    const whsCode = storeToWhsCode(store);

    let costInfo;
    try {
      costInfo = await hana.checkItemCost(itemCode, whsCode, config.hana.database);
    } catch (e) {
      console.error(`[hana] checkItemCost ${itemCode}@${whsCode} failed:`, e.message);
      hanaCache[key] = null;
      hanaFailCount++;
      continue;
    }

    let bomRows = [];
    if (costInfo.hasCost) {
      try {
        bomRows = await hana.checkBomContribution(itemCode, whsCode, config.hana.database);
      } catch (e) {
        console.error(`[hana] checkBomContribution ${itemCode} failed:`, e.message);
      }
    }

    hanaCache[key] = { costInfo, bomRows };
  }

  // Alert if HANA was unreachable for every single item in this run
  if (hanaFailCount > 0 && hanaFailCount === errorMap.size) {
    await sendOpsAlert(
      'HANA inacessível — nenhum item classificado',
      `${hanaFailCount} item(s) com zero-cost encontrados no ManyFood, mas TODAS as queries HANA falharam.\n` +
      'Verificar: VPN OpenVPN na VM, conectividade 10.123.35.82:30015, driver hdb instalado.'
    );
  }

  // Step 3: route to Case 1 / Case 2, applying weekly dedup
  const case1       = [];
  const case2Alert  = [];
  const case2Action = [];

  for (const [key, group] of errorMap) {
    const { itemCode, store } = group;
    const whsCode = storeToWhsCode(store);
    const cached  = hanaCache[key];

    if (cached === null) continue;

    const { costInfo, bomRows } = cached;

    if (!costInfo.hasCost) {
      if (db.wasProcessedThisWeek(itemCode, store, 1)) {
        console.log(`[dedup] case1 skip ${itemCode}@${store} (alerted this week)`);
        continue;
      }
      case1.push(group);
    } else if (bomRows.length > 0) {
      if (config.phase >= 2) {
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
      } else {
        if (db.wasProcessedThisWeek(itemCode, store, 2)) {
          console.log(`[dedup] case2 skip ${itemCode}@${store} (alerted this week)`);
          continue;
        }
        case2Alert.push({ ...group, bomRows });
      }
    } else {
      let fallbackRows = [];
      try {
        const allPaths  = await hana.findBomPathsFallback(itemCode, whsCode, config.hana.database);
        const best      = allPaths[0];
        fallbackRows    = best ? [best] : [];
        if (fallbackRows.length > 0) {
          console.log(`[hana] fallback found 1 path for ${itemCode}@${whsCode} (contribution: ${(Number(best.contribution) || 0).toFixed(4)})`);
        }
      } catch (e) {
        console.error(`[hana] findBomPathsFallback ${itemCode} failed:`, e.message);
      }

      if (db.wasProcessedThisWeek(itemCode, store, 2)) {
        console.log(`[dedup] case2-fallback skip ${itemCode}@${store} (alerted this week)`);
        continue;
      }
      case2Alert.push({ ...group, bomRows: fallbackRows });
    }
  }

  // Step 4: send emails, mark processed on success
  if (case1.length > 0) {
    try {
      await email.send(
        config.email.recipients_case1,
        `[Portal MM] Caso 1 — ${case1.length} item(s) sem custo — sem histórico de entrada`,
        email.buildCase1Email(case1)
      );
      for (const item of case1) db.markProcessed(item.itemCode, item.store, 1, 'alert');
    } catch (e) {
      console.error('[email] case1 send failed:', e.message);
    }
  }

  if (case2Alert.length > 0) {
    try {
      const uniqueProducts = new Set(case2Alert.map(e => e.itemCode)).size;
      await email.send(
        config.email.recipients_case2_alert,
        `[Portal MM] Caso 2 — ${uniqueProducts} produto(s) sem custo — contribuição ínfima em ficha técnica`,
        email.buildCase2AlertEmail(case2Alert)
      );
      for (const item of case2Alert) db.markProcessed(item.itemCode, item.store, 2, 'alert');
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
  lastRunAt = new Date().toISOString();
}

async function runCase3() {
  console.log('[case3] starting proactive BOM sweep');

  const whsCodes = (config.filiais || [])
    .map(f => storeToWhsCode(f.nome))
    .filter(Boolean);

  if (whsCodes.length === 0) {
    console.error('[case3] no valid whsCodes from config.filiais — aborting sweep');
    return;
  }

  let rows = [];
  try {
    rows = await hana.sweepBomByMinCost(whsCodes, config.hana.database);
    console.log(`[case3] sweep complete: ${rows.length} path(s) with contribution < R$0.01`);
  } catch (e) {
    console.error('[case3] HANA sweep failed:', e.message);
    await sendOpsAlert('[Case3] HANA sweep falhou', e.message);
    return;
  }

  if (rows.length === 0) {
    console.log('[case3] no issues found — sending all-clear email');
    try {
      await email.send(
        config.email.recipients_case3 || config.email.recipients_case2_alert,
        `[Portal MM] Caso 3 — Nenhuma ficha técnica com risco de custo ínfimo`,
        email.buildCase3AllClearEmail()
      );
    } catch (e) {
      console.error('[case3] all-clear email send failed:', e.message);
    }
    lastCase3At = new Date().toISOString();
    return;
  }

  if (config.phase >= 2) {
    const pathsMap = new Map();
    for (const r of rows) {
      const father = r.via || r.bomParent;
      const key    = `${r.itemCode}|${father}`;
      if (!pathsMap.has(key)) {
        pathsMap.set(key, {
          itemCode:     r.itemCode,
          itemName:     r.itemName || '',
          father,
          bomParent:    r.bomParent,
          level:        r.level,
          via:          r.via || null,
          minPrice:     Number(r.minPrice) || 0,
          qty1:         Number(r.qty1) || 0,
          qty2:         r.qty2 != null ? Number(r.qty2) : null,
          contribution: Number(r.contribution) || 0,
        });
      }
    }

    const results = [];
    for (const p of pathsMap.values()) {
      try {
        await hana.removeFromBom(p.itemCode, p.father, config.hana.database);
        console.log(`[case3] removed ${p.itemCode} from ${p.father}`);
        results.push({ ...p, success: true });
      } catch (e) {
        console.error(`[case3] failed to remove ${p.itemCode} from ${p.father}:`, e.message);
        results.push({ ...p, success: false, error: e.message });
      }
    }

    const removed = results.filter(r => r.success).length;
    const failed  = results.length - removed;
    console.log(`[case3] phase2 done: ${removed} removed, ${failed} failed`);

    try {
      await email.send(
        config.email.recipients_case3 || config.email.recipients_case2_alert,
        `[Portal MM] Caso 3 — ${removed} entrada(s) removida(s) de ficha técnica${failed > 0 ? ` (${failed} falha(s))` : ''}`,
        email.buildCase3ActionEmail(results)
      );
    } catch (e) {
      console.error('[case3] email send failed:', e.message);
    }
  } else {
    try {
      const uniqueItems = new Set(rows.map(r => r.itemCode)).size;
      await email.send(
        config.email.recipients_case3 || config.email.recipients_case2_alert,
        `[Portal MM] Caso 3 — ${uniqueItems} produto(s) com risco de custo ínfimo em ficha técnica`,
        email.buildCase3Email(rows)
      );
    } catch (e) {
      console.error('[case3] email send failed:', e.message);
    }
  }

  lastCase3At = new Date().toISOString();
}

module.exports = { run, runCase3, getLastRunAt, getLastCase3At };
