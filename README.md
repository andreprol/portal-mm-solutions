# Portal MM Solutions

Node.js service that monitors the [ManyFood](https://manyfood.manyminds.com.br) portal for **zero-cost item errors** that block the daily Aloha POS → SAP B1 reconciliation at Delírio Tropical restaurants.

Runs 24/7 on Azure VM via PM2. Every 4 hours it checks all monitored stores, classifies each error against SAP HANA, and sends a Portuguese-language email report to the operations team.

## Production Status

> **Phase 1 live since 2026-06-21.** Covers 8 stores, 90-day lookback.  
> Latest run: 176 unique item+store pairs detected → **40 true Case 1** (warehouse-specific check), 0 Case 2.

Phase 2 (auto-remove from BOM + reconciliation resend) pending endpoint mapping.

---

## The Problem

Every day the ManyFood portal conciliates Aloha POS sales into SAP B1. When an item has no cost in SAP, the entire day's reconciliation fails — the day shows **RED** in the monitoring grid for that store.

### Case 1 — No Receiving History at This Store

`OITW.AvgPrice = 0` at the specific warehouse for the store where the error occurred. The item has never received a purchase invoice (NF de entrada) at that location.

**Action:** Alert email — manual review required in SAP B1.

### Case 2 — Negligible BOM Contribution (Ficha Técnica)

The item has cost in OITW, but appears as a component in a Bill of Materials (ITT1) with such a small quantity that `Qty × Price < R$0.01`. SAP treats the parent recipe as having zero cost.

**Phase 1 action:** Alert email listing the affected BOM parent(s) and any nested BOMs.  
**Phase 2 action (pending):** Auto-remove from ITT1 + trigger reconciliation resend.

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

An item with cost at a _different_ store's warehouse is **not** a Case 1 for this store. Without this check, 136 false positives were generated in initial deployment.

### ITT1 `Price > 0` Filter (Case 2)

The BOM query requires `T0."Price" > 0`:

```sql
WHERE T0."Code" = ?
  AND T0."Price" > 0          -- excludes BOMs created before item had any cost
  AND T0."Quantity" * T0."Price" < 0.01
```

`ITT1.Price = 0` means the BOM was created when the component had no purchase history — that is a Case 1 issue, not Case 2.

### Per-Store Session Switching

ManyFood scopes reconciliation results to the **active store** in the server session. The service switches context before each store's query:

```
POST /Principal/requisicaoMudaEmpresa/{filialId}
```

The response is the full Principal page HTML; `data-filial_on="XXXX"` in that HTML confirms the active store.

### 90-Day Lookback + Grouped Errors

Errors are fetched for the last 90 days, then grouped by `(itemCode, store)`. Each email row shows `firstDate`, `lastDate`, and total `occurrences` instead of one row per day.

### Weekly Dedup

SQLite tracks `(item_code, store, case_type)` with a 7-day rolling window. The same pair will not re-alert for a week, even if it appears on multiple error days within the lookback period.

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

> **Finding a store's filial ID:** ManyFood IDs are not sequential (e.g. Niterói Plaza = 2668, not in the 470–479 cluster). To find an unknown ID: switch to the store in the portal and read `data-filial_on` from the Principal page HTML. The store selector list is loaded via client-side JS and is not present in the static HTML.

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
| `qs` | Form-encoded POST bodies |
| `hdb` | SAP HANA driver |
| `better-sqlite3` | Dedup state |
| `axios` (MS Graph) | Email via `client_credentials` flow |

---

## Project Structure

```
src/
├── index.js        — orchestrator: store loop, grouping, HANA classification, email dispatch
├── manyfood.js     — portal client: login, store switch, error fetch + parse
├── hana.js         — HANA queries: OITW cost check, ITT1 BOM + nested BOM, Phase 2 delete
├── email.js        — MS Graph sender + HTML email templates (Portuguese)
├── db.js           — SQLite dedup: wasProcessedThisWeek / markProcessed
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

See `config.example.json` for all fields. Key settings:

| Field | Description |
|-------|-------------|
| `schedule` | Cron expression (default: every 4h) |
| `lookbackDays` | Days of history to check (default: 90) |
| `filiais` | Array of `{id, nome}` store objects |
| `phase` | `1` = alert only · `2` = auto-fix Case 2 (pending) |

### 3. Run

```bash
# Development (single run)
node src/index.js

# Production (PM2)
pm2 start src/index.js --name portal-mm-solutions
pm2 save
```

---

## HANA Queries Reference

```sql
-- Case 1: fetch all warehouse costs (filter by whsCode in JS)
SELECT T0."ItemCode", T0."WhsCode", T0."AvgPrice", T0."OnHand"
FROM "DATABASE"."OITW" T0 WHERE T0."ItemCode" = ?

-- Case 2: BOM components with negligible cost contribution
-- Price > 0 is mandatory to avoid false positives
SELECT T0."Father" AS "bomParent", T0."Code" AS "component",
       T0."Quantity", T0."Price",
       T0."Quantity" * T0."Price" AS "contribution"
FROM "DATABASE"."ITT1" T0
WHERE T0."Code" = ?
  AND T0."Price" > 0
  AND T0."Quantity" * T0."Price" < 0.01

-- Nested BOM: is the BOM parent itself a component elsewhere?
SELECT T0."Father" AS "grandParent", T0."Quantity", T0."Price"
FROM "DATABASE"."ITT1" T0 WHERE T0."Code" = ?

-- Phase 2: remove component from recipe
DELETE FROM "DATABASE"."ITT1" WHERE "Father" = ? AND "Code" = ?
```

### Key SAP B1 Schema Notes

| Table | Column | Notes |
|-------|--------|-------|
| `OITW` | `WhsCode` | Depot code — must match store number (`"06"` for store 6) |
| `OITW` | `AvgPrice` | Current moving average cost — `0` means no receiving history at that depot |
| `ITT1` | `Code` | Component item code — **not** `ItemCode` |
| `ITT1` | `Father` | Parent BOM/recipe code |
| `ITT1` | `Price` | Component unit price at BOM creation time — can be `0` if item had no cost then |

---

## Azure VM Operations

```bash
# Deploy new version
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts 'cd /opt/portal-mm-solutions && git pull && pm2 restart portal-mm-solutions'

# View logs
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts 'pm2 logs portal-mm-solutions --lines 50 --nostream'

# Force immediate run (clears dedup state)
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts 'cd /opt/portal-mm-solutions && rm -f data/state.db && pm2 restart portal-mm-solutions'
```

---

## OpenVPN Split Tunnel Setup (Ubuntu)

Only HANA traffic goes through the VPN — internet (ManyFood, GitHub, Azure) remains direct:

```
# In your .conf file:
route-nopull
route 10.123.0.0 255.255.0.0
auth-user-pass /etc/openvpn/client/auth.txt
```

```bash
apt install openvpn -y
systemctl enable openvpn-client@yourprofile
systemctl restart openvpn-client@yourprofile
ip route | grep 10.123   # verify route is active
```

---

## Roadmap

### Phase 2 — BOM Auto-Fix

- [ ] Map the ManyFood "Reenviar Conciliação" endpoint
- [ ] Implement reconciliation resend trigger after BOM fix
- [ ] Test `removeFromBom()` against test database (`SBO_DATABASE_TST`) before enabling in production
- [ ] Set `"phase": 2` in config.json

### Backlog

- [ ] Find ManyFood filial ID for Delirio Galeão S/A (Tijuca — closed after fire in early 2025; no recent errors)
- [ ] Case 3: item has warehouse cost today but ManyFood still flags sem custo — timing/reprocessing issue
