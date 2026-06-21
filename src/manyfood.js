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

  // Load login page to get CSRF cookie
  await client.get('/Login');
  const csrfToken = await getCsrfToken();

  const resp = await client.post('/Login/check', qs.stringify({
    ci_csrf_token: csrfToken,
    usuario: user,
    senha: password,
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 5,
  });

  // Verify login succeeded by checking we're not back on login page
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

  // If redirected to login page, session expired — re-throw
  if (String(resp.data).includes('id="usuario"')) {
    throw new Error('ManyFood session expired');
  }

  const data = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
  return data;
}

// Returns errors for a date range
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

// Filters only "item sem custo" errors and extracts structured info
// Returns: [{ itemCode, itemName, filial, date }]
function parseSemCustoErrors(erros) {
  const PATTERN = /O item '(\d+)':'([^']+)' está sem custo/;
  const results = [];

  for (const e of erros) {
    const match = (e.erro || '').match(PATTERN);
    if (!match) continue;

    results.push({
      itemCode: match[1],
      itemName: match[2],
      filial: e.filiais || '',
      date: e.data || '',           // format: DD/MM/YYYY
      empresaGestora: e.empresaGestora || '',
    });
  }

  return results;
}

// Sends "Reenviar Conciliação" for a specific day and filial
// date format: 'YYYY-MM-DD', filialId: numeric string from portal
async function reenviarConciliacao(date, filialId) {
  const data = await post('/Conciliacao/getInformacoesDiaMonitoramento', {
    dataMonitoramento: date,
    idFilialMonitoramento: filialId,
  });
  return data;
}

module.exports = { login, getErrorsForPeriod, parseSemCustoErrors, reenviarConciliacao };
