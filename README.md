# Portal MM Solutions

Node.js service that monitors the [ManyFood](https://manyfood.manyminds.com.br) portal for **zero-cost item errors** that block the daily Aloha POS → SAP B1 reconciliation at Delírio Tropical restaurants.

Runs 24/7 on Azure VM via PM2. Every 4 hours it checks all monitored stores, classifies each error against SAP HANA, and sends a Portuguese-language email report to the operations team.

## Production Status

> **Phase 1 live since 2026-06-21. Case 1 ✅ and Case 2 ✅ validated.**  
> Covers 8 stores, 90-day lookback, no dedup on Case 2 (reports every cycle while error persists).  
> Case 3 pending definition. Phase 2 (auto-remove from BOM) pending endpoint mapping.

---

## The Problem

Every day the ManyFood portal conciliates Aloha POS sales into SAP B1. When an item has no cost in SAP, the entire day's reconciliation fails — the day shows **RED** in the monitoring grid for that store.

---

## Case 1 — No Receiving History at This Store

`OITW.AvgPrice = 0` at the specific warehouse for the store where the error occurred. The item has never received a purchase invoice (NF de entrada) at that location.

**Action:** Alert email — manual review required in SAP B1.  
**Dedup:** 7-day rolling window (slow-moving issue — NF de entrada takes time).

---

## Case 2 — Negligible BOM Contribution (Ficha Técnica)

The item has cost in OITW at the store's depot, but its effective contribution to a recipe falls below R$0.01 — SAP treats the cost as zero.

**Action:** Alert email listing fichas to fix (Section 1) + dates to reprocess in ManyFood (Section 2).  
**Dedup:** None — reports every cycle while the error exists in ManyFood.

### Cost Formula (validated manually against SAP B1 — 2026-06-21)

> **Do NOT use `ITT1.Price`** — it is a frozen value from BOM creation time and is irrelevant.  
> **Use `ITT1.Quantity × OITW.AvgPrice`** — current moving-average cost at the store's depot.

| Level | Formula | Threshold |
|-------|---------|-----------|
| L1 — direct | `Qty_item × OITW.AvgPrice` | < R$0.01 |
| L2 — nested via sub-recipe | `Qty_subRecipe_in_parent × Qty_item_in_subRecipe × OITW.AvgPrice` | < R$0.01 |

**L2 example:** sub-recipe B contains Alho (0.01 kg × R$20 = R$0.20 — OK standalone). But ficha A uses B with qty 0.02 → effective contribution = 0.02 × 0.01 × R$20 = **R$0.004 < R$0.01 → Case 2**.

Delírio Tropical BOMs are **at most 2 levels deep** (confirmed).

### Fallback — Historical Price Dip

When the strict check returns 0 (today's price recovered, but the error occurred on a past date):

- ManyFood reprocesses using the **historical SAP cost** → the same error would recur without fixing the ficha
- `findBomPathsFallback` queries all BOM paths without the `< R$0.01` filter, sorted by contribution ASC
- Reports the **single lowest-contribution path** (the "next lowest" candidate) — no threshold filter
- Email shows orange note: *"contrib. atual R$X.XXXX — custo variou"*
- **Iterative:** if fixing that path doesn't resolve the error, the next cycle will surface the next candidate

### HANA Note — Computed Columns Return as Strings

Expressions like `T0."Quantity" * T1."AvgPrice"` in SELECT return **string**, not number. Always use `Number()` before comparisons or `.toFixed()`.

### Email Format (Case 2)

**Section 1 — Ficha Técnica Fixes (deduplicated across stores):**
- L1: *"Remover item da ficha X"*
- L2: *"Remover item da sub-receita X (Afeta fichas: Y1, Y2...)"* — remove the **item** from the sub-recipe, not the sub-recipe from the parent
- Fallback items: same action + orange *(contrib. atual R$X.XXXX — custo variou)* note

**Section 2 — Dates to Reprocess in ManyFood:**  
Table of store × error dates → click "Reenviar Conciliação" for each after fixing fichas.

**Subject:** `[Portal MM] N produto(s) sem custo` — N = unique product codes (not item+store pairs).

---

## Key Design Decisions

### Warehouse-Specific OITW Cost Check

The cost check maps the ManyFood store name to the exact SAP depot (`OITW.WhsCode`) before querying HANA:

```javascript
function storeToWhsCode(storeName) {
  // "6 - Cittá Delirio Restaurante" → "06"
  // "14 - Delirio Tropical Niteroi Plaza" → "14"
  const match = storeName.match(/^(\d+)\s*-/);
  return String(parseInt(match[1], 10)).padStart(2, '0');
}
```

Checking any warehouse (not store-specific) produced 136 false positives in initial deployment.

### No Dedup on Case 2

Case 2 errors require a manual ficha fix. A 7-day dedup would suppress the alert even when the problem is unfixed. Case 2 reports on every cycle until the error disappears from ManyFood logs.

### 2-Level BOM Check (UNION ALL)

```sql
-- L1: item directly in a ficha with Qty × OITW.AvgPrice < R$0.01
SELECT 'L1', T0."Father" AS bomParent, NULL AS via,
       T0."Quantity" * T1."AvgPrice" AS contribution
FROM ITT1 T0
INNER JOIN OITW T1 ON T1."ItemCode"=T0."Code" AND T1."WhsCode"=?
WHERE T0."Code"=? AND T1."AvgPrice">0 AND T0."Quantity"*T1."AvgPrice" < 0.01

UNION ALL

-- L2: item in sub-recipe (via), sub-recipe in ficha — effective contribution < 0.01
SELECT 'L2', T2."Father" AS bomParent, T0."Father" AS via,
       T2."Quantity" * T0."Quantity" * T1."AvgPrice" AS contribution
FROM ITT1 T0
INNER JOIN OITW T1 ON T1."ItemCode"=T0."Code" AND T1."WhsCode"=?
INNER JOIN ITT1 T2 ON T2."Code"=T0."Father"
WHERE T0."Code"=? AND T1."AvgPrice">0
  AND T2."Quantity"*T0."Quantity"*T1."AvgPrice" < 0.01
```

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

> **Finding a store's filial ID:** Switch to the store in the portal and read `data-filial_on` from the Principal page HTML. The store selector is loaded via client-side JS and is not present in static HTML.

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
| `node-cron` | Schedule (`0 */4 * * *`) |
| `axios` + `tough-cookie` + `axios-cookiejar-support` | ManyFood session (CodeIgniter 3 CSRF) |
| `hdb` | SAP HANA driver |
| `better-sqlite3` | Dedup state (Case 1 only — 7-day window) |
| `axios` (MS Graph) | Email via `client_credentials` flow |

---

## Project Structure

```
src/
├── index.js        — orchestrator: store loop, grouping, HANA classification, email dispatch
├── manyfood.js     — portal client: login, store switch, error fetch + parse
├── hana.js         — HANA queries: OITW cost check, ITT1 BOM (strict + fallback), Phase 2 delete
├── email.js        — MS Graph sender + HTML email templates (Portuguese)
├── db.js           — SQLite dedup: wasProcessedThisWeek / markProcessed (Case 1 only)
└── config.js       — config.json loader

data/
└── state.db        — SQLite dedup database (gitignored)

config.json         — credentials (gitignored)
config.example.json — safe template (committed)
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure

```bash
cp config.example.json config.json
# Edit config.json with your credentials
```

### 3. Run

```bash
# Production (PM2)
pm2 start src/index.js --name portal-mm-solutions
pm2 save
```

> ⚠️ Never run `node src/index.js` via `az vm run-command` — it blocks for 10+ minutes. Always use `pm2 restart`.

---

## HANA Queries Reference

```sql
-- Case 1: fetch all warehouse costs (filter by whsCode in JS)
SELECT T0."ItemCode", T0."WhsCode", T0."AvgPrice", T0."OnHand"
FROM "DATABASE"."OITW" T0 WHERE T0."ItemCode" = ?

-- Case 2 L1 + L2: see "2-Level BOM Check" section above

-- Fallback (no threshold — all BOM paths sorted ASC by contribution)
-- Same UNION ALL query but without the < 0.01 WHERE clause

-- Phase 2: remove item from ficha (L1) or sub-recipe from parent (L2)
DELETE FROM "DATABASE"."ITT1" WHERE "Father" = ? AND "Code" = ?
```

### Key SAP B1 Schema Notes

| Table | Column | Notes |
|-------|--------|-------|
| `OITW` | `WhsCode` | Depot code — must match store number (`"06"` for store 6) |
| `OITW` | `AvgPrice` | Current moving average cost — `0` means no receiving history at that depot |
| `ITT1` | `Code` | Component item code — **not** `ItemCode` |
| `ITT1` | `Father` | Parent BOM/recipe code |
| `ITT1` | `Price` | Component unit price at BOM creation time — **do not use** |

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

# Search logs for a specific item
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts 'pm2 logs portal-mm-solutions --lines 500 --nostream 2>/dev/null | grep 500302'

# VM restart (clears stuck run-command lock — takes ~2 min, PM2 auto-restarts)
az vm restart --resource-group rg-dt-manager --name vm-dt-manager
```

---

## Roadmap

### Case 3 (to be defined)
- Scenario where the error persists in ManyFood but does not fit Case 1 or Case 2
- To be specified with André in the next session

### Phase 2 — BOM Auto-Fix
- [ ] Map the ManyFood "Reenviar Conciliação" endpoint (capture via DevTools)
- [ ] Implement `removeFromBom()` against test database (`SBO_DATABASE_TST`) before enabling in production
- [ ] Set `"phase": 2` in config.json

### Backlog
- [ ] Find ManyFood filial ID for Delirio Galeão S/A (Tijuca — closed after fire in early 2025)
