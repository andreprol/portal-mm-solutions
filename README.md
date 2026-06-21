# Portal MM Solutions

Automated monitor and auto-fixer for **item without cost** errors in the ManyFood B1 Food portal that block Aloha POS → SAP B1 daily reconciliation.

## The Problem

Every day the ManyFood portal conciliates Aloha POS sales into SAP B1. When an item has no cost in SAP, the entire day's reconciliation fails for every affected store — the day shows RED in the monitoring grid.

This app runs 24/7, detects those errors, diagnoses the root cause, and (in Phase 2) fixes them automatically.

## Two root causes

| Case | Cause | Action |
|------|-------|--------|
| **Case 1** | Item has no purchase history at that store (no OITW record) | Alert email only |
| **Case 2** | Item is in a BOM with quantity so small the cost contribution < R$0.01 | Phase 1: alert email · Phase 2: auto-remove from BOM + resend reconciliation |

## Architecture

```
Azure VM (PM2 24/7)
│
├── OpenVPN (split tunnel 10.x.x.0/16) ──► SAP HANA
│
└── portal-mm-solutions (Node.js)
    ├── node-cron          — periodic checks
    ├── Axios + CookieJar  — ManyFood portal session
    ├── HANA client        — diagnose Case 1 vs Case 2
    ├── MS Graph API       — email alerts
    └── SQLite             — dedup (no repeated alerts same day)
```

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

`config.json` fields:

| Field | Description |
|-------|-------------|
| `schedule` | Cron expression (default: every 4h) |
| `lookbackDays` | How many past days to check (default: 7) |
| `manyfood.url` | Portal URL |
| `manyfood.user` | Portal username |
| `manyfood.password` | Portal password |
| `hana.*` | SAP HANA connection |
| `graph.*` | Microsoft Graph API credentials (for email) |
| `email.*` | Alert recipient lists |
| `phase` | `1` = alert only · `2` = auto-fix Case 2 |

### 3. Run

```bash
# Development
npm run dev

# Production (PM2)
pm2 start src/index.js --name portal-mm-solutions
pm2 save
```

## HANA tables used

| Table | Purpose |
|-------|---------|
| `OITW` | Item cost per warehouse — diagnose Case 1 |
| `ITT1` | BOM components — diagnose and fix Case 2 |

## Phase 2 — Auto-fix

Set `"phase": 2` in `config.json` to enable:
1. Detects item in BOM with contribution < R$0.01
2. Removes component from `ITT1` via direct HANA SQL
3. Sends confirmation email

> **Note:** Phase 2 requires VPN access to SAP HANA from the deployment machine.

## Azure VM Deployment

> **Tested on Ubuntu 22.04, Node.js 22, PM2 7.0.1**

### 1. OpenVPN split tunnel

Place your `.ovpn`, `.p12`, and `tls.key` files under `/etc/openvpn/client/`. Add these two lines to the `.conf` to avoid routing all traffic through the VPN:

```
route-nopull
route 10.123.0.0 255.255.0.0   # only SAP HANA subnet goes through VPN
```

Create `/etc/openvpn/client/auth.txt` with username on line 1, password on line 2 (mode 600), then reference it with `auth-user-pass /etc/openvpn/client/auth.txt` in the config.

```bash
apt install openvpn -y
systemctl enable openvpn-client@yourprofile
systemctl restart openvpn-client@yourprofile
ip route show | grep 10.123   # verify route is present
```

### 2. HANA driver

Use the `hdb` npm package — easier to install than `@sap/hana-client`:

```bash
npm install hdb
```

> **Note:** `hdb` uses `createClient()` not `createConnection()`, and requires `prepare()` + `exec()` for parameterized queries. The `src/hana.js` module handles both drivers automatically.

### 3. Install and start

```bash
git clone https://github.com/andreprol/portal-mm-solutions.git /opt/portal-mm-solutions
cd /opt/portal-mm-solutions
npm install
cp config.example.json config.json   # fill in your credentials
pm2 start src/index.js --name portal-mm-solutions
pm2 save
systemctl enable pm2-root
```

### 4. Verify

```bash
pm2 logs portal-mm-solutions --lines 20 --nostream
# Expected:
# [runner] starting check at ...
# [manyfood] session established
# [runner] N total errors, M zero-cost
# [runner] done. case1=N case2alert=N case2action=N
```

### Local test (no VPN needed)

```bash
node scripts/test-manyfood.js   # test portal login and error parsing
node scripts/test-hana.js       # test HANA connectivity (requires VPN)
```

## Known SAP B1 schema details

| Table | Key column | Notes |
|-------|-----------|-------|
| `OITW` | `ItemCode`, `WhsCode` | Average cost per warehouse; `AvgPrice = 0` means no purchase history |
| `ITT1` | `Father` (parent BOM), `Code` (component) | Component column is **`Code`**, not `ItemCode` |
