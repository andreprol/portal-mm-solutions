#!/usr/bin/env node
// Manual trigger — bypasses cron and health server.
// Usage: node scripts/manual-run.js [--case3]
'use strict';

const config = require('../src/config');
const hana   = require('../src/hana');
const email  = require('../src/email');
const { run, runCase3 } = require('../src/runner');

hana.init(config.hana);
email.init(config.graph, config.graph.fromEmail);

const useCase3 = process.argv.includes('--case3');
(useCase3 ? runCase3() : run()).catch(e => { console.error('[fatal]', e.message); process.exit(1); });
