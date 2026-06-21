/**
 * Local test: ManyFood login + error fetch + zero-cost parsing
 * Does NOT require VPN or HANA — only portal access.
 *
 * Usage: node scripts/test-manyfood.js
 */
const manyfood = require('../src/manyfood');
const config = require('../src/config');

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log('=== Portal MM Solutions — ManyFood Test ===\n');

  // 1. Login
  console.log('Step 1: Login...');
  try {
    await manyfood.login(config.manyfood.user, config.manyfood.password);
    console.log('  ✓ Login OK\n');
  } catch (err) {
    console.error('  ✗ Login FAILED:', err.message);
    process.exit(1);
  }

  // 2. Fetch errors for last 7 days
  const dateEnd = dateOffset(0);
  const dateStart = dateOffset(-7);
  console.log(`Step 2: Fetch errors from ${dateStart} to ${dateEnd}...`);

  let rawErrors;
  try {
    rawErrors = await manyfood.getErrorsForPeriod(dateStart, dateEnd);
    console.log(`  ✓ ${rawErrors.length} total errors returned\n`);
  } catch (err) {
    console.error('  ✗ Fetch FAILED:', err.message);
    process.exit(1);
  }

  // 3. Parse zero-cost errors
  console.log('Step 3: Parse zero-cost errors...');
  const zeroCost = manyfood.parseZeroCostErrors(rawErrors);
  console.log(`  ✓ ${zeroCost.length} zero-cost error(s) found\n`);

  if (zeroCost.length === 0) {
    console.log('No zero-cost errors in the last 7 days. Try extending the date range.');
    return;
  }

  // Print unique items (deduplicated by itemCode)
  const unique = Object.values(
    zeroCost.reduce((acc, e) => { acc[e.itemCode] = e; return acc; }, {})
  );

  console.log(`Unique items affected (${unique.length}):`);
  console.log('─'.repeat(70));
  unique.forEach(e => {
    console.log(`  Code: ${e.itemCode.padEnd(10)} Name: ${e.itemName}`);
    console.log(`  Store: ${e.store}  Date: ${e.date}\n`);
  });

  console.log('─'.repeat(70));
  console.log(`\nTotal occurrences : ${zeroCost.length}`);
  console.log(`Unique items      : ${unique.length}`);
  console.log('\n✓ Test complete. Login and error parsing are working.');
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
