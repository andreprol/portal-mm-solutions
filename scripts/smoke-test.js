#!/usr/bin/env node
'use strict';

const http = require('http');

const host    = process.env.HEALTH_HOST    || 'localhost';
const port    = parseInt(process.env.HEALTH_PORT    || '3849', 10);
const timeout = parseInt(process.env.HEALTH_TIMEOUT || '5000', 10);

const req = http.request({ host, port, path: '/health', method: 'GET' }, (res) => {
  let body = '';
  res.on('data', chunk => { body += chunk; });
  res.on('end', () => {
    try {
      const data = JSON.parse(body);

      if (data.status !== 'ok') {
        console.error(`[smoke] FAIL: status=${JSON.stringify(data.status)}`);
        process.exit(1);
      }

      if (!data.hanaDriver) {
        console.error('[smoke] FAIL: hanaDriver is null — HANA driver did not load');
        process.exit(1);
      }

      console.log(`[smoke] OK  status=${data.status}  driver=${data.hanaDriver}  started=${data.startedAt}`);
      process.exit(0);
    } catch (e) {
      console.error('[smoke] FAIL: could not parse /health response:', body.slice(0, 200));
      process.exit(1);
    }
  });
});

req.setTimeout(timeout, () => {
  console.error(`[smoke] FAIL: /health timeout after ${timeout}ms`);
  req.destroy();
  process.exit(1);
});

req.on('error', (err) => {
  console.error('[smoke] FAIL: connection error:', err.message);
  process.exit(1);
});

req.end();
