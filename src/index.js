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
const { getDriverName } = hana;
const email  = require('./email');
const { run, runCase3, getLastRunAt, getLastCase3At } = require('./runner');

hana.init(config.hana);
email.init(config.graph, config.graph.fromEmail);

const healthPort     = config.healthPort || 3849;
const schedule_case3 = config.schedule_case3 || '0 13 * * *';
const startedAt      = new Date().toISOString();
const ADMIN_TOKEN    = config.adminToken || '';

function checkAuth(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!ADMIN_TOKEN || auth !== `Bearer ${ADMIN_TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  return true;
}

http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:      'ok',
      startedAt,
      hanaDriver:  getDriverName(),
      lastRunAt:   getLastRunAt(),
      lastCase3At: getLastCase3At(),
      schedule:    config.schedule,
      schedule_case3,
    }));
    return;
  }

  if (req.url === '/admin/run' && req.method === 'POST') {
    if (!checkAuth(req, res)) return;
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'run triggered' }));
    run().catch(err => console.error('[admin/run] error:', err));
    return;
  }

  if (req.url === '/admin/run-case3' && req.method === 'POST') {
    if (!checkAuth(req, res)) return;
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'case3 run triggered' }));
    runCase3().catch(err => console.error('[admin/run-case3] error:', err));
    return;
  }

  res.writeHead(404); res.end();
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
