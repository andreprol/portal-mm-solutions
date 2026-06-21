const cron = require('node-cron');
const config = require('./config');
const manyfood = require('./manyfood');
const hana = require('./hana');
const email = require('./email');
const db = require('./db');

hana.init(config.hana);
email.init(config.graph, config.graph.fromEmail);

// Returns date string 'YYYY-MM-DD' offset by N days from today
function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Convert portal date 'DD/MM/YYYY' → 'YYYY-MM-DD'
function portalDateToIso(s) {
  const [d, m, y] = s.split('/');
  return `${y}-${m}-${d}`;
}

async function run() {
  console.log(`[runner] starting check at ${new Date().toISOString()}`);

  try {
    await manyfood.login(config.manyfood.user, config.manyfood.password);
  } catch (err) {
    console.error('[runner] login failed:', err.message);
    return;
  }

  const dateEnd = dateOffset(0);
  const dateStart = dateOffset(-(config.lookbackDays || 7));

  let rawErrors;
  try {
    rawErrors = await manyfood.getErrorsForPeriod(dateStart, dateEnd);
  } catch (err) {
    console.error('[runner] failed to fetch errors:', err.message);
    return;
  }

  const semCusto = manyfood.parseSemCustoErrors(rawErrors);
  console.log(`[runner] ${rawErrors.length} total errors, ${semCusto.length} "sem custo"`);

  if (semCusto.length === 0) {
    console.log('[runner] no "sem custo" errors. Done.');
    return;
  }

  const case1 = [];
  const case2Alert = [];
  const case2Action = [];

  for (const err of semCusto) {
    const isoDate = portalDateToIso(err.date);
    const dedup1 = db.wasProcessedToday(err.itemCode, err.filial, isoDate, 1);
    const dedup2 = db.wasProcessedToday(err.itemCode, err.filial, isoDate, 2);

    let costInfo;
    try {
      costInfo = await hana.checkItemCost(err.itemCode, config.hana.database);
    } catch (e) {
      console.error(`[hana] checkItemCost ${err.itemCode} failed:`, e.message);
      continue;
    }

    if (!costInfo.hasCost) {
      // Caso 1 — no purchase history at all
      if (!dedup1) {
        case1.push(err);
        db.markProcessed(err.itemCode, err.filial, isoDate, 1, 'alert');
      }
    } else {
      // Has cost globally — check if it's in a BOM with negligible contribution
      let bomRows;
      try {
        bomRows = await hana.checkBomContribution(err.itemCode, config.hana.database);
      } catch (e) {
        console.error(`[hana] checkBomContribution ${err.itemCode} failed:`, e.message);
        continue;
      }

      if (bomRows.length > 0) {
        // Caso 2
        if (config.phase >= 2) {
          if (!dedup2) {
            // Auto-remove from BOM + mark for resend
            const results = [];
            for (const bom of bomRows) {
              try {
                await hana.removeFromBom(err.itemCode, bom.fichaTecnica, config.hana.database);
                results.push({ ...err, fichaTecnica: bom.fichaTecnica, success: true });
              } catch (e) {
                results.push({ ...err, fichaTecnica: bom.fichaTecnica, success: false, error: e.message });
              }
            }
            case2Action.push(...results);
            db.markProcessed(err.itemCode, err.filial, isoDate, 2, 'auto-removed');
          }
        } else {
          // Phase 1 — alert only
          if (!dedup2) {
            case2Alert.push({ ...err, bomRows });
            db.markProcessed(err.itemCode, err.filial, isoDate, 2, 'alerted');
          }
        }
      } else {
        // BOM contribution check passed (>= 0.01) but still "sem custo"
        // Treat as Case 1 (unknown cause)
        if (!dedup1) {
          case1.push(err);
          db.markProcessed(err.itemCode, err.filial, isoDate, 1, 'alert-unknown');
        }
      }
    }
  }

  // Send emails
  if (case1.length > 0) {
    try {
      await email.send(
        config.email.recipients_case1,
        `[Portal MM] ${case1.length} item(s) without cost — no purchase history`,
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
        `[Portal MM] ${case2Alert.length} item(s) without cost — negligible BOM contribution`,
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
        `[Portal MM] Auto-removal report — ${case2Action.filter(r => r.success).length} BOM entries removed`,
        email.buildCase2ActionEmail(case2Action)
      );
    } catch (e) {
      console.error('[email] case2 action send failed:', e.message);
    }
  }

  console.log(`[runner] done. case1=${case1.length} case2alert=${case2Alert.length} case2action=${case2Action.length}`);
}

// Run immediately on start, then on schedule
run().catch(err => console.error('[runner] unhandled error:', err));

cron.schedule(config.schedule, () => {
  run().catch(err => console.error('[runner] unhandled error:', err));
});

console.log(`[portal-mm-solutions] scheduled: ${config.schedule}`);
