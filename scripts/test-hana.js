/**
 * Local/VM test: HANA connectivity + OITW query
 * Requires VPN tunnel to 10.123.0.0/16.
 *
 * Usage: node scripts/test-hana.js [itemCode]
 *   itemCode defaults to 300005 (Sacolas — known zero-cost item)
 */
const hana = require('../src/hana');
const config = require('../src/config');

const itemCode = process.argv[2] || '300005';

async function main() {
  console.log('=== Portal MM Solutions — HANA Test ===\n');
  console.log(`Host    : ${config.hana.host}:${config.hana.port}`);
  console.log(`Database: ${config.hana.database}`);
  console.log(`Item    : ${itemCode}\n`);

  hana.init(config.hana);

  console.log('Step 1: Connect to HANA...');
  try {
    await hana.connect();
    console.log('  ✓ Connected\n');
  } catch (err) {
    console.error('  ✗ Connection FAILED:', err.message);
    process.exit(1);
  }

  console.log('Step 2: Check item cost (OITW)...');
  try {
    const result = await hana.checkItemCost(itemCode, config.hana.database);
    console.log(`  ✓ hasCost: ${result.hasCost}`);
    console.log(`  Warehouses (${result.warehouses.length}):`);
    result.warehouses.forEach(w => {
      console.log(`    ${w.WhsCode || w['WhsCode']} — AvgPrice: ${w.AvgPrice ?? w['AvgPrice']}  OnHand: ${w.OnHand ?? w['OnHand']}`);
    });
  } catch (err) {
    console.error('  ✗ OITW query FAILED:', err.message);
    process.exit(1);
  }

  console.log('\nStep 3: Check BOM contribution (ITT1)...');
  try {
    const boms = await hana.checkBomContribution(itemCode, config.hana.database);
    if (boms.length === 0) {
      console.log('  No BOM rows with contribution < R$0.01 found for this item.');
    } else {
      console.log(`  Found ${boms.length} BOM row(s):`);
      boms.forEach(b => {
        console.log(`    BOM: ${b.bomParent || b['bomParent']}  qty: ${b.quantity || b['quantity']}  price: ${b.price || b['price']}  contrib: ${b.contribution || b['contribution']}`);
      });
    }
  } catch (err) {
    console.error('  ✗ ITT1 query FAILED:', err.message);
    process.exit(1);
  }

  console.log('\n✓ HANA test complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
