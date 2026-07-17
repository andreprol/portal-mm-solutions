'use strict';

process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason);
});

const http   = require('http');
const cron   = require('node-cron');
const config = require('./config');
const hana   = require('./hana');
const email  = require('./email');
const { run, runCase3, getLastRunAt, getLastCase3At } = require('./runner');

hana.init(config.hana);
email.init(config.graph, config.graph.fromEmail);

const healthPort    = config.healthPort || 3849;
const schedule_case3 = config.schedule_case3 || '30 6 * * *';

http.createServer((req, res) => {
  if (req.url !== '/health') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    lastRunAt:   getLastRunAt(),
    lastCase3At: getLastCase3At(),
    schedule:    config.schedule,
    schedule_case3,
  }));
}).listen(healthPort, () => {
  console.log(`[health] listening on :${healthPort}`);
});

cron.schedule(config.schedule, () => {
  run().catch(err => console.error('[runner] unhandled error:', err));
});

cron.schedule(schedule_case3, () => {
  runCase3().catch(err => console.error('[case3] unhandled error:', err));
});

console.log(`[portal-mm-solutions] scheduled: ${config.schedule} | case3: ${schedule_case3} | health: :${healthPort}`);
