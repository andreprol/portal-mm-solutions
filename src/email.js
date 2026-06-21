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
  // L1: key = (itemCode, bomParent) — one row per direct ficha
  // L2: key = (itemCode, via/sub-receita) — one row per sub-receita, listing all affected fichas
  const fichasMap = new Map();
  for (const e of errors) {
    for (const b of e.bomRows) {
      if (b.level === 'L1') {
        const key = `L1|${e.itemCode}|${b.bomParent}`;
        if (!fichasMap.has(key)) {
          fichasMap.set(key, {
            level: 'L1', itemCode: e.itemCode, itemName: e.itemName,
            target: b.bomParent, affectedFichas: null,
            contribution: b.contribution,
          });
        }
      } else {
        // L2: remove the item from the sub-recipe (via); list grandparent fichas as context
        const key = `L2|${e.itemCode}|${b.via}`;
        if (!fichasMap.has(key)) {
          fichasMap.set(key, {
            level: 'L2', itemCode: e.itemCode, itemName: e.itemName,
            target: b.via, affectedFichas: new Set([b.bomParent]),
            contribution: b.contribution,
          });
        } else {
          const entry = fichasMap.get(key);
          entry.affectedFichas.add(b.bomParent);
          // Keep the minimum contribution (worst-case path)
          if ((b.contribution || 0) < (entry.contribution || Infinity)) {
            entry.contribution = b.contribution;
          }
        }
      }
    }
  }

  const fichaRows = [...fichasMap.values()].map(f => {
    let acao;
    // Show current contribution only when it's >= 0.01 (fallback/momentary case)
    // so the user knows the price recovered but the ficha still needs fixing
    const contrib = f.contribution >= 0.01
      ? ` <span style="font-size:11px;color:#e67e22">(contrib. atual R$${Number(f.contribution).toFixed(4)} — custo variou)</span>`
      : '';
    if (f.level === 'L1') {
      acao = `Remover item da ficha <strong>${f.target}</strong>${contrib}`;
    } else {
      const fichas = [...f.affectedFichas].sort().join(', ');
      acao = `Remover item da sub-receita <strong>${f.target}</strong>${contrib}`
           + `<div class="nested">Afeta fichas: ${fichas}</div>`;
    }
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
    <p>Remova os itens indicados das fichas técnicas abaixo. Itens marcados com <em>custo variou</em>
    foram detectados via preço histórico — remova da ficha para garantir o reprocessamento.</p>
    <table>
      <thead><tr><th>Código</th><th>Descrição</th><th>Ação</th></tr></thead>
      <tbody>${fichaRows}</tbody>
    </table>

    <h3 style="color:#2c3e50;margin-top:28px">2. Dias/Lojas para Reprocessar no ManyFood</h3>
    <p>Após corrigir as fichas acima, reprocesse os dias abaixo (botão <em>Reenviar Conciliação</em>):</p>
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

function buildCase3Email(rows) {
  // Deduplicate: one row per (level, itemCode, bomParent, via), keep min contribution
  const fichasMap = new Map();
  for (const r of rows) {
    const via = r.via || 'null';
    const key = `${r.level}|${r.itemCode}|${r.bomParent}|${via}`;
    const contrib = Number(r.contribution) || 0;
    const minPrice = Number(r.minPrice) || 0;
    if (!fichasMap.has(key)) {
      fichasMap.set(key, { ...r, contribution: contrib, minPrice });
    } else {
      const entry = fichasMap.get(key);
      if (contrib < entry.contribution) {
        entry.contribution = contrib;
        entry.minPrice = minPrice;
      }
    }
  }

  const fichaRows = [...fichasMap.values()].map(f => {
    let acao;
    if (f.level === 'L1') {
      acao = `Remover item da ficha <strong>${f.bomParent}</strong>`;
    } else {
      acao = `Remover item da sub-receita <strong>${f.via}</strong>`
           + `<div class="nested">Afeta ficha: ${f.bomParent}</div>`;
    }
    return `<tr>
      <td>${f.itemCode}</td>
      <td>${f.itemName || ''}</td>
      <td style="text-align:right;font-family:monospace">R$${f.minPrice.toFixed(4)}</td>
      <td style="text-align:right;font-family:monospace">R$${f.contribution.toFixed(6)}</td>
      <td>${acao}</td>
    </tr>`;
  }).join('');

  const uniqueItems = new Set([...fichasMap.values()].map(f => f.itemCode)).size;

  return `
    <html><head><style>${STYLE}
      h2 { color: #1a6a9a; border-bottom: 2px solid #1a6a9a; }
    </style></head><body>
    <h2>Portal MM Solutions — Caso 3: Alerta Preemptivo de Ficha Técnica</h2>
    <p>Os <strong>${uniqueItems} produto(s)</strong> abaixo possuem contribuição < R$0,01 em pelo menos
    uma ficha técnica, considerando o <strong>menor preço entre todas as lojas monitoradas</strong>.<br>
    Eles <em>ainda não geraram erro no ManyFood</em>, mas poderão bloquear conciliações futuras
    se o preço do produto cair até esse nível em qualquer loja.</p>
    <table>
      <thead>
        <tr>
          <th>Código</th><th>Descrição</th>
          <th>Menor Preço (lojas)</th><th>Contribuição</th><th>Ação</th>
        </tr>
      </thead>
      <tbody>${fichaRows}</tbody>
    </table>
    <div class="note">
      ℹ️ <strong>Alerta preventivo.</strong> Nenhum erro ativo no ManyFood para estes itens.
      Avalie se a quantidade na ficha técnica faz sentido ou se o item deve ser removido.
    </div>
    <p class="footer">Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (horário de Brasília)</p>
    </body></html>
  `;
}

module.exports = { init, send, buildCase1Email, buildCase2AlertEmail, buildCase2ActionEmail, buildCase3Email };
