#!/usr/bin/env node
// Watchdog independente do PM2 — roda a cada 5min via cron do sistema.
// Detecta: processo morto, health timeout, cron travado, lastRunAt/lastCase3At velho.
// Envia email via MS Graph. Rate-limited a 1 alerta/hora (arquivo /tmp).
'use strict';

const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const CONFIG_PATH        = path.join(__dirname, '../config.json');
const ALERT_STATE_FILE   = '/tmp/portal-mm-watchdog-last-alert';
const ALERT_COOLDOWN_MS  = 60 * 60 * 1000;  // 1 hora
const HEALTH_TIMEOUT_MS  = 8000;
const MAX_RUN_AGE_H      = 5;   // alerta se lastRunAt > 5h atrás
const MAX_CASE3_AGE_H    = 26;  // alerta se lastCase3At > 26h atrás (pode perder 1 dia)
const HEALTH_URL         = 'http://localhost:3849/health';

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: HEALTH_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: true, data: JSON.parse(data) });
        } catch {
          resolve({ ok: false, reason: `health endpoint retornou JSON inválido: ${data.slice(0, 100)}` });
        }
      });
    });
    req.on('error', e => resolve({ ok: false, reason: `health endpoint inacessível: ${e.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: `health endpoint timeout (${HEALTH_TIMEOUT_MS}ms)` }); });
  });
}

function isAlertSuppressed() {
  try {
    const last = parseInt(fs.readFileSync(ALERT_STATE_FILE, 'utf8').trim(), 10);
    const age  = Date.now() - last;
    if (age < ALERT_COOLDOWN_MS) {
      console.log(`[watchdog] alerta suprimido (${Math.round(age / 60000)}min desde último)`);
      return true;
    }
  } catch {}
  return false;
}

async function getGraphToken(cfg) {
  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     cfg.clientId,
        client_secret: cfg.clientSecret,
        scope:         'https://graph.microsoft.com/.default',
      }),
    }
  );
  const json = await res.json();
  if (!json.access_token) throw new Error(`Graph token failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function sendAlert(subject, bodyText, config) {
  if (isAlertSuppressed()) return;

  const recipients = (config.email?.recipients_ops || config.email?.recipients_case1 || [])
    .map(addr => ({ emailAddress: { address: addr } }));

  if (recipients.length === 0) {
    console.error('[watchdog] sem destinatários — adicionar email.recipients_ops ao config.json');
    return;
  }

  const token = await getGraphToken(config.graph);
  const html  = `
    <html><body style="font-family:Arial,sans-serif;font-size:14px;color:#333">
    <h2 style="color:#c0392b">&#9888; Watchdog — Portal MM Solutions</h2>
    <p><strong>${subject}</strong></p>
    <pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap">${bodyText}</pre>
    <p style="font-size:11px;color:#999">
      Verificar: VM vm-dt-manager &middot; <code>/usr/bin/pm2 list</code> &middot;
      <code>curl http://localhost:3849/health</code>
    </p>
    <p style="font-size:11px;color:#999">
      Detectado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
    </p>
    </body></html>
  `;

  await fetch(
    `https://graph.microsoft.com/v1.0/users/${config.graph.fromEmail}/sendMail`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: `[Watchdog] ⚠️ ${subject}`,
          body: { contentType: 'HTML', content: html },
          toRecipients: recipients,
        },
      }),
    }
  );

  fs.writeFileSync(ALERT_STATE_FILE, String(Date.now()));
  console.log(`[watchdog] alerta enviado: ${subject}`);
}

async function main() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('[watchdog] config.json ilegível:', e.message);
    process.exit(1);
  }

  const health = await checkHealth();

  if (!health.ok) {
    console.error('[watchdog] FAIL —', health.reason);
    await sendAlert('Processo morto ou sem resposta', health.reason, config);
    return;
  }

  const issues = [];
  const now    = Date.now();

  const uptimeH = health.data.startedAt
    ? (now - new Date(health.data.startedAt).getTime()) / 3600000
    : MAX_RUN_AGE_H + 1; // se não tem startedAt (versão antiga), assume tempo suficiente

  if (health.data.lastRunAt) {
    const ageH = (now - new Date(health.data.lastRunAt).getTime()) / 3600000;
    if (ageH > MAX_RUN_AGE_H) {
      issues.push(`lastRunAt: ${health.data.lastRunAt} — ${ageH.toFixed(1)}h atrás (máx ${MAX_RUN_AGE_H}h)`);
    }
  } else if (uptimeH > MAX_RUN_AGE_H) {
    // Só alerta se o processo está no ar há mais de MAX_RUN_AGE_H sem rodar nenhum ciclo.
    // Nas primeiras horas após startup é normal — cron ainda não disparou.
    issues.push(`lastRunAt: null — run() nunca completou (processo no ar há ${uptimeH.toFixed(1)}h)`);
  }

  if (health.data.lastCase3At) {
    const ageH = (now - new Date(health.data.lastCase3At).getTime()) / 3600000;
    if (ageH > MAX_CASE3_AGE_H) {
      issues.push(`lastCase3At: ${health.data.lastCase3At} — ${ageH.toFixed(1)}h atrás (máx ${MAX_CASE3_AGE_H}h)`);
    }
  }

  if (issues.length > 0) {
    const detail = issues.join('\n') + '\n\nHealth response:\n' + JSON.stringify(health.data, null, 2);
    console.error('[watchdog] STALE —', issues.join(' | '));
    await sendAlert('Execução atrasada — cron pode estar travado', detail, config);
  } else {
    console.log(`[watchdog] OK — lastRunAt: ${health.data.lastRunAt}`);
  }
}

main().catch(e => {
  console.error('[watchdog] erro fatal:', e.message);
  process.exit(1);
});
