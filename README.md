# Portal MM Solutions

Node.js service that monitors the [ManyFood](https://manyfood.manyminds.com.br) portal for **zero-cost item errors** that block the daily Aloha POS → SAP B1 reconciliation at Delírio Tropical restaurants.

Runs 24/7 on Azure VM via PM2. Three detection cases, no dedup on any case — every email reflects the current state.

## Production Status

> **All three cases live since 2026-06-21. Cases 1 ✅, 2 ✅ and 3 ✅ validated.**  
> Phase 2 (auto-remove from BOM + reconciliation resend) pending endpoint mapping.

---

## The Problem

Every day the ManyFood portal conciliates Aloha POS sales into SAP B1. When an item has no cost in SAP, the entire day's reconciliation fails — the day shows **RED** in the monitoring grid for that store.

---

## Case 1 — No Receiving History at This Store

`OITW.AvgPrice = 0` at the specific warehouse for the store where the error occurred.

**Action:** Alert email — manual review required in SAP B1.  
**Schedule:** Every 4 hours (`0 */4 * * *`).  
**Subject:** `[Portal MM] Caso 1 — N item(s) sem custo — sem histórico de entrada`

---

## Case 2 — Negligible BOM Contribution (Ficha Técnica)

The item has cost in OITW at the store's depot, but its effective contribution to a recipe falls below R$0.01 — SAP treats the cost as zero.

**Action:** Alert email listing fichas to fix (Section 1) + dates to reprocess in ManyFood (Section 2).  
**Schedule:** Every 4 hours (`0 */4 * * *`).  
**Subject:** `[Portal MM] Caso 2 — N produto(s) sem custo — contribuição ínfima em ficha técnica`

### Cost Formula (validated manually against SAP B1)

> **Do NOT use `ITT1.Price`** — frozen snapshot from BOM creation, irrelevant.  
> **Use `ITT1.Quantity × OITW.AvgPrice`** — current moving-average cost at the store's depot.

| Level | Formula | Threshold |
|-------|---------|-----------|
| L1 — direct | `Qty_item × OITW.AvgPrice` | < R$0.01 |
| L2 — nested via sub-recipe | `Qty_subRecipe_in_parent × Qty_item_in_subRecipe × OITW.AvgPrice` | < R$0.01 |

Delírio Tropical BOMs are **at most 2 levels deep** (confirmed).

### Fallback — Historical Price Dip

When the strict check returns 0 (today's price recovered, but the error occurred on a past date):
- ManyFood reprocesses using **historical SAP cost** → same error would recur without a ficha fix
- Reports the **single lowest-contribution path** (`allPaths[0]`) — no threshold filter
- Email shows orange note: *"contrib. atual R$X.XXXX — custo variou"*
- **Iterative:** next cycle surfaces the next candidate if needed

### Email Format (Case 2)

**Section 1 — Ficha Técnica Fixes:**
- L1: *"Remover item da ficha X"*
- L2: *"Remover item da sub-receita X (Afeta fichas: Y1, Y2...)"*

**Section 2 — Dates to Reprocess in ManyFood** (one row per store with error dates)

---

## Case 3 — Proactive Daily BOM Sweep

Scans **all BOM structures** before ManyFood flags an error. Finds items whose minimum price across monitored stores would cause a contribution < R$0.01.

**Action:** Alert email — preventive ficha review.  
**Schedule:** Once daily at 06:00 (`0 6 * * *`, configurable via `schedule_case3`).  
**Subject:** `[Portal MM] Caso 3 — N produto(s) com risco de custo ínfimo em ficha técnica`

### Logic

1. Items in range `300001–699999` (ingredients/components)
2. Only items with `OITW.AvgPrice > 0` in at least one monitored store (has receiving history)
3. Take `MIN(AvgPrice)` across all monitored store warehouses → worst case across filiais
4. `MIN(AvgPrice) × ITT1.Quantity < R$0.01` → alert (L1 direct or L2 nested)
5. Single HANA query with `GROUP BY + HAVING` — no per-store loop needed (fichas are shared across stores)

### Email Format (Case 3)

Blue "preemptive" template with columns: Item Code | Description | Min Price (across stores) | Contribution | Action (L1/L2).  
Note: *"Estes itens ainda não geraram erro no ManyFood, mas poderão bloquear conciliações futuras."*

---

## Key Design Decisions

### No Dedup on Any Case

Every cycle reports all current issues. The latest email always reflects the current state. If an issue is fixed, it disappears from the next email automatically.

### Warehouse-Specific OITW Cost Check (Cases 1 & 2)

```javascript
function storeToWhsCode(storeName) {
  // "6 - Cittá Delirio Restaurante" → "06"
  // "14 - Delirio Tropical Niteroi Plaza" → "14"
  const match = storeName.match(/^(\d+)\s*-/);
  return String(parseInt(match[1], 10)).padStart(2, '0');
}
```

Checking any warehouse (not store-specific) produced 136 false positives in initial deployment.

### HANA — Computed Columns Return as Strings

Expressions like `T0."Quantity" * T1."AvgPrice"` in SELECT return **string**, not number. Always use `Number()` before comparisons or `.toFixed()`.

---

## Monitored Stores

| ManyFood Filial ID | Store Name | SAP WhsCode |
|--------------------|-----------|-------------|
| 470 | 6 - Cittá Delirio Restaurante | 06 |
| 472 | 5 - Delirio Gávea Restaurante | 05 |
| 473 | 9 - Delirio Metropolitano | 09 |
| 474 | 8 - Delirio Rio Sul Restaurante | 08 |
| 476 | 1 - Delirio Tropical S/A. | 01 |
| 477 | 7 - Delitrop Restaurante | 07 |
| 478 | 4 - Garcia Trop Restaurante | 04 |
| 2668 | 14 - Delirio Tropical Niteroi Plaza | 14 |

---

## Architecture

```
Azure VM vm-dt-manager (Ubuntu 22.04, Standard_B1ms, brazilsouth)
├── PM2: portal-mm-solutions  ← this service
├── PM2: dt-manager           ← Delirio Manager (unrelated)
└── OpenVPN split tunnel: 10.123.0.0/16 → SAP HANA 10.123.35.82:30015
```

### Stack

| Package | Purpose |
|---------|---------|
| `node-cron` | Two schedules: Cases 1+2 every 4h, Case 3 daily at 6h |
| `axios` + `tough-cookie` | ManyFood session (CodeIgniter 3 CSRF) |
| `hdb` | SAP HANA driver |
| `axios` (MS Graph) | Email via `client_credentials` flow |

### Project Structure

```
src/
├── index.js        — orchestrator: Cases 1+2 (run), Case 3 (runCase3), two crons
├── manyfood.js     — portal client: login, store switch, error fetch + parse
├── hana.js         — HANA queries: checkItemCost, checkBomContribution,
│                     findBomPathsFallback, removeFromBom, sweepBomByMinCost
├── email.js        — MS Graph sender + templates: Case1, Case2Alert, Case2Action, Case3
└── config.js       — config.json loader
```

---

## Azure VM Operations

```bash
# Deploy + force immediate cycle
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts 'cd /opt/portal-mm-solutions && git pull && rm -f data/state.db && pm2 restart portal-mm-solutions && echo PRONTO'

# View logs
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts 'pm2 logs portal-mm-solutions --lines 50 --nostream'

# Search logs for specific item
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts 'pm2 logs portal-mm-solutions --lines 500 --nostream 2>/dev/null | grep 500302'

# VM restart (clears stuck run-command — PM2 auto-restarts, takes ~2 min)
az vm restart --resource-group rg-dt-manager --name vm-dt-manager
```

> ⚠️ Never run `node src/index.js` via `az vm run-command` — it blocks for 10+ minutes. Always use `pm2 restart`.

---

## Roadmap

### Phase 2 — BOM Auto-Fix (pending)
- [ ] Map the ManyFood "Reenviar Conciliação" endpoint (capture via DevTools)
- [ ] Implement `removeFromBom()` against test database (`SBO_DATABASE_TST`) before production
- [ ] Set `"phase": 2` in config.json

### Backlog
- [ ] Find ManyFood filial ID for Delirio Galeão S/A (Tijuca — closed after fire in early 2025)
