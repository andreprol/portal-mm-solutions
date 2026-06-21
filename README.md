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

```bash
# 1. Install OpenVPN with split tunnel
apt install openvpn -y
# Edit .ovpn file:
#   route-nopull
#   route 10.0.0.0 255.0.0.0
systemctl enable openvpn@yourprofile
systemctl start openvpn@yourprofile

# 2. Install Node.js + PM2
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm install -g pm2

# 3. Clone and configure
git clone https://github.com/andreprol/portal-mm-solutions.git
cd portal-mm-solutions
npm install
cp config.example.json config.json
# edit config.json

# 4. Start
pm2 start src/index.js --name portal-mm-solutions
pm2 save
pm2 startup
```
