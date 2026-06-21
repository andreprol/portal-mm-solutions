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

const STYLE = `
  body { font-family: Arial, sans-serif; font-size: 14px; color: #333; }
  h2 { color: #c0392b; border-bottom: 2px solid #c0392b; padding-bottom: 6px; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  th { background: #2c3e50; color: #fff; padding: 8px 10px; text-align: left; }
  td { padding: 7px 10px; border-bottom: 1px solid #ddd; }
  tr:nth-child(even) td { background: #f9f9f9; }
  .note { margin-top: 16px; padding: 10px 14px; background: #fef9e7; border-left: 4px solid #f39c12; font-size: 13px; }
  .footer { margin-top: 20px; font-size: 11px; color: #999; }
  .nested { font-size: 12px; color: #555; margin-top: 3px; }
`;

function buildCase1Email(errors) {
  const rows = errors.map(e =>
    `<tr>
      <td>${e.itemCode}</td>
      <td>${e.itemName}</td>
      <td>${e.store}</td>
      <td>${e.firstDate}</td>
      <td>${e.lastDate}</td>
      <td style="text-align:center">${e.occurrences}</td>
    </tr>`
  ).join('');

  return `
    <html><head><style>${STYLE}</style></head><body>
    <h2>Portal MM Solutions — Item Sem Custo (Caso 1: Sem Histórico de Entrada)</h2>
    <p>Os itens abaixo <strong>não possuem histórico de nota fiscal de entrada</strong> na loja indicada.
    Não há correção automática possível — é necessária revisão manual no SAP.</p>
    <table>
      <thead>
        <tr><th>Código</th><th>Descrição</th><th>Loja</th><th>Primeira Ocorrência</th><th>Última Ocorrência</th><th>Dias c/ Erro</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="note">
      ℹ️ <strong>Ação necessária:</strong> verificar se o item precisa de uma NF de entrada na loja indicada,
      ou se deve ser removido da ficha técnica de venda.
    </div>
    <p class="footer">Detectado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (horário de Brasília)</p>
    </body></html>
  `;
}

function buildCase2AlertEmail(errors) {
  // --- Section 1: deduplicated ficha fixes across all stores ---
  const fichasMap = new Map();
  for (const e of errors) {
    for (const b of e.bomRows) {
      const key = `${e.itemCode}|${b.level}|${b.bomParent}|${b.via || ''}`;
      if (!fichasMap.has(key)) {
        fichasMap.set(key, {
          itemCode:  e.itemCode,
          itemName:  e.itemName,
          level:     b.level,
          bomParent: b.bomParent,
          via:       b.via || null,
        });
      }
    }
  }

  const fichaRows = [...fichasMap.values()].map(f => {
    const acao = f.level === 'L2'
      ? `Remover sub-receita <strong>${f.via}</strong> da ficha <strong>${f.bomParent}</strong>`
      : `Remover item da ficha <strong>${f.bomParent}</strong>`;
    return `<tr>
      <td>${f.itemCode}</td>
      <td>${f.itemName}</td>
      <td>${acao}</td>
    </tr>`;
  }).join('');

  // --- Section 2: stores × dates to reprocess ---
  const storesDates = new Map();
  for (const e of errors) {
    if (!storesDates.has(e.store)) storesDates.set(e.store, new Set());
    for (const d of (e.errorDates || [e.firstDate])) storesDates.get(e.store).add(d);
  }

  const storeRows = [...storesDates.entries()].map(([store, dates]) => {
    const sorted = [...dates].sort((a, b) => portalDateToIso(a).localeCompare(portalDateToIso(b)));
    return `<tr>
      <td>${store}</td>
      <td>${sorted.join(' · ')}</td>
    </tr>`;
  }).join('');

  return `
    <html><head><style>${STYLE}</style></head><body>
    <h2>Portal MM Solutions — Caso 2: Contribuição Ínfima em Ficha Técnica</h2>

    <h3 style="color:#2c3e50;margin-top:20px">1. Correções nas Fichas Técnicas (SAP B1)</h3>
    <p>Remova os itens indicados das fichas técnicas abaixo para eliminar a contribuição de custo &lt; R$0,01:</p>
    <table>
      <thead>
        <tr><th>Código</th><th>Descrição</th><th>Ação</th></tr>
      </thead>
      <tbody>${fichaRows}</tbody>
    </table>

    <h3 style="color:#2c3e50;margin-top:28px">2. Dias/Lojas para Reprocessar no ManyFood</h3>
    <p>Após corrigir as fichas, reprocesse os dias abaixo (botão <em>Reenviar Conciliação</em>):</p>
    <table>
      <thead>
        <tr><th>Loja</th><th>Datas com erro</th></tr>
      </thead>
      <tbody>${storeRows}</tbody>
    </table>

    <div class="note">
      ℹ️ <strong>Fase 1 — somente alerta.</strong> Nenhuma ação automática foi realizada.
      Ative a <em>fase 2</em> no config para habilitar remoção automática.
    </div>
    <p class="footer">Detectado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (horário de Brasília)</p>
    </body></html>
  `;
}

function portalDateToIso(s) {
  const [d, m, y] = (s || '').split('/');
  return y ? `${y}-${m}-${d}` : s;
}

function buildCase2ActionEmail(results) {
  const rows = results.map(r =>
    `<tr>
      <td>${r.itemCode}</td>
      <td>${r.itemName}</td>
      <td>${r.bomParent}</td>
      <td>${r.success ? '✅ Removido' : '❌ Falha: ' + r.error}</td>
    </tr>`
  ).join('');

  const removed = results.filter(r => r.success).length;
  const failed = results.length - removed;

  return `
    <html><head><style>${STYLE}</style></head><body>
    <h2>Portal MM Solutions — Relatório de Remoção Automática (Caso 2)</h2>
    <p><strong>${removed}</strong> entrada(s) removida(s) com sucesso.
    ${failed > 0 ? `<strong style="color:#c0392b">${failed} falha(s)</strong>.` : ''}</p>
    <table>
      <thead>
        <tr><th>Código</th><th>Descrição</th><th>Ficha Técnica</th><th>Resultado</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="footer">Executado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (horário de Brasília)</p>
    </body></html>
  `;
}

module.exports = { init, send, buildCase1Email, buildCase2AlertEmail, buildCase2ActionEmail };
