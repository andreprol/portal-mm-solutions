const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const qs = require('qs');

const BASE = 'https://manyfood.manyminds.com.br';

// Persistent session across calls within the same process
let client = null;
let jar = null;

function buildClient() {
  jar = new CookieJar();
  client = wrapper(axios.create({
    baseURL: BASE,
    jar,
    withCredentials: true,
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (portal-mm-solutions)',
    },
    timeout: 30000,
  }));
}

async function getCsrfToken() {
  const cookies = await jar.getCookies(BASE);
  const csrf = cookies.find(c => c.key === 'ci_csrf_token');
  return csrf ? csrf.value : '';
}

async function login(user, password) {
  if (!client) buildClient();

  // Load login page to receive the CodeIgniter CSRF cookie
  await client.get('/Login');
  const csrfToken = await getCsrfToken();

  const resp = await client.post('/Login/requisicaoLogin', qs.stringify({
    ci_csrf_token: csrfToken,
    usuario: user,
    senha: password,
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 5,
  });

  // Verify login succeeded — must not be redirected back to login form
  const isLoggedIn = !resp.request.path.includes('/Login') &&
    !String(resp.data).includes('id="usuario"');

  if (!isLoggedIn) {
    throw new Error('ManyFood login failed — check credentials');
  }

  console.log('[manyfood] session established');
}

async function post(path, params) {
  const csrfToken = await getCsrfToken();
  const resp = await client.post(path, qs.stringify({ ...params, ci_csrf_token: csrfToken }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  // Session expired if response redirects back to login form
  if (String(resp.data).includes('id="usuario"')) {
    throw new Error('ManyFood session expired');
  }

  const data = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
  return data;
}

// Returns all errors for a date range from the portal.
// dateStart / dateEnd format: 'YYYY-MM-DD'
async function getErrorsForPeriod(dateStart, dateEnd) {
  const data = await post('/Conciliacao/getErrosNoPeriodoAjax', {
    dataInicial: dateStart,
    dataFinal: dateEnd,
  });

  if (!data.success) {
    throw new Error('getErrosNoPeriodoAjax returned success=false: ' + JSON.stringify(data));
  }

  return data.erros || [];
}

// Filters only "zero cost" errors from the portal error list and returns structured objects.
// The portal error message is in Portuguese: "O item 'CODE':'NAME' está sem custo"
// Returns: [{ itemCode, itemName, store, date, managingCompany }]
function parseZeroCostErrors(errors) {
  // Matches the Portuguese error string emitted by the portal
  const PATTERN = /O item '(\d+)':'([^']+)' está sem custo/;
  const results = [];

  for (const e of errors) {
    const match = (e.erro || '').match(PATTERN);
    if (!match) continue;

    results.push({
      itemCode: match[1],
      itemName: match[2],
      store: e.filiais || '',
      date: e.data || '',             // format: DD/MM/YYYY
      managingCompany: e.empresaGestora || '',
    });
  }

  return results;
}

// Switches the active store context for this session.
// Must be called before getErrorsForPeriod to scope results to the desired store.
// filialId: numeric ManyFood store ID (see config.filiais)
async function switchFilial(filialId) {
  if (!client) buildClient();
  const csrfToken = await getCsrfToken();
  await client.post(`/Principal/requisicaoMudaEmpresa/${filialId}`, qs.stringify({
    ci_csrf_token: csrfToken,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
}

// Fetches the day detail from the monitoring grid.
// Used in Phase 2 to trigger reconciliation resend after a BOM fix.
// date format: 'YYYY-MM-DD', storeId: numeric string from portal
async function getDayDetail(date, storeId) {
  const data = await post('/Conciliacao/getInformacoesDiaMonitoramento', {
    dataMonitoramento: date,
    idFilialMonitoramento: storeId,
  });
  return data;
}

module.exports = { login, switchFilial, getErrorsForPeriod, parseZeroCostErrors, getDayDetail };
