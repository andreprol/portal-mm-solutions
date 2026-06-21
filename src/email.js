const axios = require('axios');

let graphConfig = null;
let fromEmail = null;
let tokenCache = { token: null, expiresAt: 0 };

function init(cfg, from) {
  graphConfig = cfg;
  fromEmail = from;
}

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.token;
  }

  const resp = await axios.post(
    `https://login.microsoftonline.com/${graphConfig.tenantId}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: graphConfig.clientId,
      client_secret: graphConfig.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  tokenCache = {
    token: resp.data.access_token,
    expiresAt: Date.now() + resp.data.expires_in * 1000,
  };

  return tokenCache.token;
}

async function send(recipients, subject, htmlBody) {
  const token = await getToken();

  const message = {
    subject,
    body: { contentType: 'HTML', content: htmlBody },
    toRecipients: recipients.map(r => ({ emailAddress: { address: r } })),
  };

  await axios.post(
    `https://graph.microsoft.com/v1.0/users/${fromEmail}/sendMail`,
    { message, saveToSentItems: true },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  console.log(`[email] sent "${subject}" to ${recipients.join(', ')}`);
}

function buildCase1Email(errors) {
  const rows = errors.map(e =>
    `<tr>
      <td>${e.itemCode}</td>
      <td>${e.itemName}</td>
      <td>${e.store}</td>
      <td>${e.date}</td>
    </tr>`
  ).join('');

  return `
    <h2>Portal MM Solutions — Item Without Cost Alert (Case 1)</h2>
    <p>The following items have <strong>no purchase history</strong> at the indicated store.
    No automatic fix is possible — manual review required.</p>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead>
        <tr><th>Item Code</th><th>Item Name</th><th>Store</th><th>Date</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p><small>Detected at ${new Date().toISOString()}</small></p>
  `;
}

function buildCase2AlertEmail(errors) {
  const rows = errors.map(e =>
    `<tr>
      <td>${e.itemCode}</td>
      <td>${e.itemName}</td>
      <td>${e.store}</td>
      <td>${e.date}</td>
      <td>${e.bomRows.map(b => `${b.bomParent} (qty ${b.quantity} × R$${b.price} = R$${b.contribution})`).join('<br>')}</td>
    </tr>`
  ).join('');

  return `
    <h2>Portal MM Solutions — Item Without Cost Alert (Case 2)</h2>
    <p>The following items appear in a <strong>Bill of Materials with negligible cost contribution</strong>
    (&lt; R$0.01). They need to be removed from the BOM to fix reconciliation.</p>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead>
        <tr><th>Item Code</th><th>Item Name</th><th>Store</th><th>Date</th><th>BOM</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p><em>Phase 1 only: no automatic action taken. Upgrade to phase 2 to enable auto-removal.</em></p>
    <p><small>Detected at ${new Date().toISOString()}</small></p>
  `;
}

function buildCase2ActionEmail(results) {
  const rows = results.map(r =>
    `<tr>
      <td>${r.itemCode}</td>
      <td>${r.itemName}</td>
      <td>${r.bomParent}</td>
      <td>${r.success ? '✅ Removed' : '❌ Failed: ' + r.error}</td>
    </tr>`
  ).join('');

  return `
    <h2>Portal MM Solutions — BOM Auto-Removal Report (Case 2)</h2>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead>
        <tr><th>Item Code</th><th>Item Name</th><th>BOM</th><th>Result</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p><small>Executed at ${new Date().toISOString()}</small></p>
  `;
}

module.exports = { init, send, buildCase1Email, buildCase2AlertEmail, buildCase2ActionEmail };
