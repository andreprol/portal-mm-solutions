# Portal MM Solutions

Node.js service that monitors the [ManyFood](https://manyfood.manyminds.com.br) portal for **zero-cost item errors** that block the daily Aloha POS → SAP B1 reconciliation at Delírio Tropical restaurants.

Runs 24/7 on Azure VM via PM2. Three detection cases, no dedup — every email reflects the current state.

## Production Status

| Case | Phase | Action | Schedule |
|------|-------|--------|----------|
| 1 — No receiving history | 1 | Alert email | every 4h |
| 2 — Negligible BOM contribution | 1 | Alert email | every 4h |
| **3 — Proactive BOM sweep** | **2 ✅** | **Auto-remove + report email** | daily 6h |

> `phase=2` active in VM config.json since 2026-06-21.

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

### Fallback — Historical Price Dip

When the strict check returns 0 (today's price recovered), reports the single lowest-contribution path with no threshold filter. Email shows orange note: *"contrib. atual R$X.XXXX — custo variou"*.

### Email Format (Case 2)

**Section 1:** L1: *"Remover item da ficha X"* | L2: *"Remover item da sub-receita X (Afeta fichas: Y1, Y2...)"*  
**Section 2:** Dates to reprocess in ManyFood (one row per store)

---

## Case 3 — Proactive Daily BOM Sweep + Auto-Remove (Phase 2)

Scans all BOM structures before ManyFood flags an error. Finds items whose minimum price across monitored stores would cause a contribution < R$0.01, then **removes them automatically**.

**Schedule:** Once daily at 06:00 (`0 6 * * *`, configurable via `schedule_case3`).  
**Subject (removals):** `[Portal MM] Caso 3 — N entrada(s) removida(s) de ficha técnica`  
**Subject (all-clear):** `[Portal MM] Caso 3 — Nenhuma ficha técnica com risco de custo ínfimo`

### Logic

1. Items in range `300001–699999` (ingredients/components) with `AvgPrice > 0`
2. `MIN(AvgPrice)` across all monitored store warehouses → worst case across filiais
3. `MIN(AvgPrice) × ITT1.Quantity < R$0.01` → flag for removal (L1 or L2)
4. Single HANA query — fichas are shared across stores, no per-store loop needed

### Phase 2 — Auto-Removal

Deduplicate paths by `(itemCode, father)` before removing, then for each unique path:
- **L1**: `removeFromBom(itemCode, bomParent)` — remove from the parent ficha directly
- **L2**: `removeFromBom(itemCode, via)` — remove from the sub-recipe (not from the parent ficha)

Result email (`buildCase3ActionEmail`) shows ✅ / ❌ per removed entry.

> ℹ️ `hdb` driver returns `undefined` for DML — absence of error = success. Validated by test: item 500564 removed from ficha 250087 and confirmed directly in SAP B1.

### Email Format (Case 3 — Phase 2)

- **Removals found:** one row per removal attempt — Item Code | Description | Removed From | Result (✅/❌)
- **Nothing found:** all-clear email (green) — `buildCase3AllClearEmail` — confirms all BOM structures are within the R$0.01 threshold

---

## Key Design Decisions

### No Dedup on Any Case

Every cycle reports all current issues. The latest email always reflects the current state.

### Warehouse-Specific OITW Cost Check (Cases 1 & 2)

```javascript
function storeToWhsCode(storeName) {
  // "6 - Cittá Delirio Restaurante" → "06"
  // "14 - Delirio Tropical Niteroi Plaza" → "14"
  const match = storeName.match(/^(\d+)\s*-/);
  return String(parseInt(match[1], 10)).padStart(2, '0');
}
```

### HANA — Computed Columns Return as Strings

`T0."Quantity" * T1."AvgPrice"` returns **string**, not number. Always use `Number()` before comparisons or `.toFixed()`.

### VM — run-command Locks When Interrupted

If `az vm run-command` is cancelled before completion, the VM extension locks. Fix: `az vm restart`. PM2 restarts automatically in ~2 minutes.

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
├── PM2: portal-mm-solutions  ← this service (phase=2)
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
├── index.js        — orchestrator: run() (Cases 1+2), runCase3() (Phase 2 auto-remove)
├── manyfood.js     — portal client: login, store switch, error fetch + parse
├── hana.js         — HANA queries: checkItemCost, checkBomContribution,
│                     findBomPathsFallback, removeFromBom, sweepBomByMinCost
├── email.js        — MS Graph sender + templates:
│                     buildCase1Email, buildCase2AlertEmail, buildCase2ActionEmail,
│                     buildCase3Email (alert), buildCase3ActionEmail (phase 2)
└── config.js       — config.json loader
```

---

## Azure VM Operations

```bash
# Deploy
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts 'cd /opt/portal-mm-solutions && git pull && pm2 restart portal-mm-solutions && echo PRONTO'

# View logs
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts 'pm2 logs portal-mm-solutions --lines 50 --nostream'

# Set phase=2 in config.json (already done — for reference)
az vm run-command invoke --resource-group rg-dt-manager --name vm-dt-manager \
  --command-id RunShellScript \
  --scripts 'cd /opt/portal-mm-solutions && node -e "const fs=require(\"fs\");const c=JSON.parse(fs.readFileSync(\"config.json\",\"utf8\"));c.phase=2;fs.writeFileSync(\"config.json\",JSON.stringify(c,null,2));console.log(\"phase\",c.phase);"'

# VM restart (clears stuck run-command — PM2 auto-restarts in ~2 min)
az vm restart --resource-group rg-dt-manager --name vm-dt-manager
```

> ⚠️ Never run `node src/index.js` via `az vm run-command` — it blocks for 10+ minutes. Always use `pm2 restart`.

---

## Roadmap

### Case 2 — Phase 2 (pending)
- [ ] Map the ManyFood "Reenviar Conciliação" endpoint (capture via DevTools)
- [ ] Enable `"phase": 2` in config.json — auto-removes Case 2 BOM entries
- [ ] Test `removeFromBom()` on `SBO_DATABASE_TST` first (Case 2 is reactive — higher risk)

### Backlog
- [ ] Find ManyFood filial ID for Delirio Galeão S/A (Tijuca — closed after fire in early 2025)

---

## Incident Log

### 2026-06-22/23 — PM2 Down + DNS Broken

**Root cause:** Disk-full incident (22/06) caused `systemd-resolved` to fail → `/etc/resolv.conf` symlink pointed to empty file → DNS silently broken → MS Graph (email) and ManyFood (DNS) stopped working → PM2 entered restart loop and eventually died.

**Symptoms:**
- Case 3 removed 16 BOM entries but confirmation email was never sent
- `pm2 list` was empty — both `portal-mm-solutions` and `dt-manager` offline
- VPN route to `10.123.0.0/16` was gone

**Fixes applied:**
1. VPN reconnected + `openvpn-client@deliriotropical` enabled in systemd (survives reboots)
2. PM2 restarted for both processes + `pm2 save` + `pm2 startup systemd`
3. Port 3847 zombie (leftover dt-manager) killed via `fuser -k 3847/tcp`
4. `/etc/resolv.conf` permanently fixed:
   ```bash
   rm /etc/resolv.conf   # break the broken symlink
   echo "nameserver 168.63.129.16
   nameserver 8.8.8.8
   nameserver 8.8.4.4" > /etc/resolv.conf
   chattr +i /etc/resolv.conf   # immutable — nothing can overwrite it
   ```
5. Retroactive audit email sent for the 16 silent removals via `audit-resend.js`

**Verify DNS health:**
```bash
lsattr /etc/resolv.conf   # must show 'i' flag
nslookup login.microsoftonline.com
```

**PM2 recovery procedure (if pm2 list is empty):**
```bash
fuser -k 3847/tcp 2>/dev/null   # clear port if dt-manager has a zombie
cd /opt/portal-mm-solutions && pm2 start src/index.js --name portal-mm-solutions
cd /opt/dt-manager && pm2 start ecosystem.config.js
pm2 save
```

---

## Changelog

| Date | Change |
|------|--------|
| 2026-06-23 | `buildCase3ActionEmail` now shows **Custo na Ficha** column (exact contribution, 6 decimal places); `pathsMap` in `index.js` now preserves `minPrice`, `qty1`, `qty2`, `contribution` from HANA sweep |
| 2026-06-23 | VM DNS fixed: `/etc/resolv.conf` made immutable (`chattr +i`) with Azure DNS + Google fallback |
| 2026-06-21 | Case 3 Phase 2 activated — auto-remove enabled (`phase=2` in config.json) |
| 2026-06-21 | Cases 1, 2, 3 deployed and validated in production |
