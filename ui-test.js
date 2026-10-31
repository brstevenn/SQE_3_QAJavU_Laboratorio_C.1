// SQA3 - Pull Requests Lab
// Crea un PR desde la interfaz web de GitHub y captura la petición POST que lo crea.
// Uso: node ui-test.js   (el login lo hace la persona manualmente en la ventana)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OWNER = 'brstevenn';
const REPO = 'SQE_3_QAJavU_Laboratorio_C.1';
const COMPARE_URL = `https://github.com/${OWNER}/${REPO}/compare/main...test-pr-ui`;
const PR_TITLE = 'SQA3 - Pull request creation test';
const PR_BODY = 'PR creado desde la interfaz web de GitHub (exploratory testing con Playwright).';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const OUT = (f) => path.join(__dirname, f);
const log = (msg) => console.log(`[ui-test ${new Date().toLocaleTimeString()}] ${msg}`);

// Cabeceras con secretos que no deben quedar en los archivos de evidencia
const SECRET_HEADERS = ['cookie', 'set-cookie', 'x-csrf-token', 'scoped-csrf-token', 'x-fetch-nonce'];

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SECRET_HEADERS.includes(k.toLowerCase()) ? '***' : v;
  }
  return out;
}

// Devuelve { format, fields, raw } con authenticity_token reemplazado por ***
function parsePayload(postData, contentType = '') {
  if (postData == null) return { format: 'none', fields: {}, raw: null };
  if (contentType.includes('application/json')) {
    try {
      const json = JSON.parse(postData);
      const walk = (o) => {
        if (o && typeof o === 'object') {
          for (const k of Object.keys(o)) {
            if (/authenticity_token|csrf/i.test(k)) o[k] = '***';
            else walk(o[k]);
          }
        }
      };
      walk(json);
      return { format: 'application/json', fields: json, raw: JSON.stringify(json) };
    } catch { /* cae al caso de texto */ }
  }
  if (contentType.includes('multipart/form-data')) {
    const fields = {};
    const re = /name="([^"]+)"\r?\n\r?\n([\s\S]*?)\r?\n--/g;
    let m;
    while ((m = re.exec(postData))) {
      fields[m[1]] = /authenticity_token/i.test(m[1]) ? '***' : m[2];
    }
    const raw = postData.replace(/(name="[^"]*authenticity_token[^"]*"\r?\n\r?\n)[^\r\n]*/gi, '$1***');
    return { format: 'multipart/form-data', fields, raw };
  }
  // application/x-www-form-urlencoded (formulario clásico de GitHub)
  const params = new URLSearchParams(postData);
  const fields = {};
  for (const [k, v] of params) {
    const val = /authenticity_token/i.test(k) ? '***' : v;
    if (k in fields) fields[k] = [].concat(fields[k], val);
    else fields[k] = val;
  }
  for (const k of [...params.keys()]) if (/authenticity_token/i.test(k)) params.set(k, '***');
  return { format: 'application/x-www-form-urlencoded', fields, raw: params.toString() };
}

async function isLoggedIn(page) {
  try {
    return await page.evaluate(() => {
      const meta = document.querySelector('meta[name="user-login"]');
      if (meta && meta.content) return meta.content;
      const avatar = document.querySelector('header img.avatar, [data-login] img.avatar, img.avatar-user');
      return avatar ? 'unknown' : null;
    });
  } catch {
    return null; // la página está navegando
  }
}

// La cookie logged_in=yes no depende de qué pestaña esté abierta (el login puede abrir/cerrar pestañas)
async function loginFromCookies(context) {
  const cookies = await context.cookies('https://github.com').catch(() => []);
  if (!cookies.some((c) => c.name === 'logged_in' && c.value === 'yes')) return null;
  return cookies.find((c) => c.name === 'dotcom_user')?.value || 'unknown';
}

async function waitForLogin(context) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const user = await loginFromCookies(context);
    if (user) return user;
    for (const p of context.pages()) {
      const u = await isLoggedIn(p);
      if (u) return u;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('No se detectó inicio de sesión en 5 minutos.');
}

// GitHub deja algunas peticiones abiertas (telemetría, long-poll): nunca esperar sin límite
const withTimeout = (promise, ms, fallback = null) =>
  Promise.race([promise.catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);

async function firstVisible(page, locators, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const loc of locators) {
      const l = loc.first();
      if (await l.isVisible().catch(() => false)) return l;
    }
    await page.waitForTimeout(300);
  }
  return null;
}

// --- HAR propio: recordHar de Playwright solo escribe el archivo al cerrar el contexto,
// y aquí el navegador debe quedar abierto, así que armamos el HAR con los eventos de red.
function createHarRecorder(context) {
  const entries = [];
  const pending = new Map();
  const onRequest = (req) => pending.set(req, { started: new Date(), req });
  const onFinished = async (req) => {
    const p = pending.get(req);
    if (!p) return;
    pending.delete(req);
    const res = await withTimeout(req.response(), 5000);
    let bodyText;
    const reqHeaders = (await withTimeout(req.allHeaders(), 5000)) || {};
    const resHeaders = res ? (await withTimeout(res.allHeaders(), 5000)) || {} : {};
    if (res) {
      const ct = resHeaders['content-type'] || '';
      if (/json|text|html|javascript/.test(ct) && !(res.status() >= 300 && res.status() < 400)) {
        bodyText = (await withTimeout(res.text(), 5000)) || undefined;
        if (bodyText && bodyText.length > 200000) bodyText = bodyText.slice(0, 200000) + '\n...[truncado]';
      }
    }
    const toList = (h) => Object.entries(redactHeaders(h)).map(([name, value]) => ({ name, value }));
    const url = new URL(req.url());
    const payload = req.postData() != null ? parsePayload(req.postData(), reqHeaders['content-type']) : null;
    entries.push({
      startedDateTime: p.started.toISOString(),
      time: Date.now() - p.started.getTime(),
      request: {
        method: req.method(),
        url: req.url(),
        httpVersion: 'HTTP/2.0',
        headers: toList(reqHeaders),
        queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
        cookies: [],
        headersSize: -1,
        bodySize: payload ? payload.raw.length : 0,
        ...(payload && { postData: { mimeType: reqHeaders['content-type'] || '', text: payload.raw } }),
      },
      response: {
        status: res ? res.status() : 0,
        statusText: res ? res.statusText() : (req.failure()?.errorText || ''),
        httpVersion: 'HTTP/2.0',
        headers: toList(resHeaders),
        cookies: [],
        content: { size: bodyText ? bodyText.length : 0, mimeType: resHeaders['content-type'] || '', ...(bodyText && { text: bodyText }) },
        redirectURL: resHeaders['location'] || '',
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: 0, wait: Date.now() - p.started.getTime(), receive: 0 },
    });
  };
  context.on('request', onRequest);
  context.on('requestfinished', onFinished);
  context.on('requestfailed', onFinished);
  return {
    async save(file) {
      await new Promise((r) => setTimeout(r, 1500)); // deja terminar las últimas peticiones
      context.off('request', onRequest);
      context.off('requestfinished', onFinished);
      context.off('requestfailed', onFinished);
      entries.sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime));
      const har = { log: { version: '1.2', creator: { name: 'ui-test.js (Playwright)', version: '1.0' }, pages: [], entries } };
      fs.writeFileSync(file, JSON.stringify(har, null, 2));
      return entries.length;
    },
  };
}

(async () => {
  const context = await chromium.launchPersistentContext(OUT('.pw-profile'), {
    // Google Chrome instalado (motor Chromium); PW_CHANNEL= vacío usa el Chromium de Playwright
    channel: process.env.PW_CHANNEL ?? 'chrome',
    headless: false,
    devtools: true,
    viewport: null,
    args: ['--start-maximized'],
  });
  context.on('close', () => { log('El navegador se cerró.'); process.exit(0); });
  const loginPage = context.pages()[0] || (await context.newPage());

  // 1) Login manual
  log('Abriendo https://github.com/login ...');
  await loginPage.goto('https://github.com/login');
  let user = (await loginFromCookies(context)) || (await isLoggedIn(loginPage));
  if (!user) {
    log('>>> Inicia sesión MANUALMENTE en la ventana del navegador (tienes hasta 5 minutos). <<<');
    user = await waitForLogin(context);
  }
  log(`Sesión detectada (usuario: ${user}).`);
  const page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());
  await page.bringToFront();

  // 2) Página compare (el HAR empieza a grabar desde aquí)
  const har = createHarRecorder(context);
  log(`Abriendo ${COMPARE_URL}`);
  await page.goto(COMPARE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  const titleCandidates = [
    page.locator('input[name="pull_request[title]"]'),
    page.locator('#pull_request_title'),
    page.getByRole('textbox', { name: /title/i }),
  ];
  let titleInput = await firstVisible(page, titleCandidates, 2000);
  if (!titleInput) {
    // El formulario está colapsado: botón "Create pull request" que lo despliega
    const openBtn = await firstVisible(page, [
      page.locator('button.js-details-target:has-text("Create pull request")'),
      page.getByRole('button', { name: /create pull request/i }),
    ], 10000);
    if (openBtn) {
      log('Abriendo el formulario de PR...');
      await openBtn.click();
    }
    titleInput = await firstVisible(page, titleCandidates, 15000);
  }
  if (!titleInput) throw new Error('No se encontró el campo de título del PR. ¿Ya existe un PR abierto para test-pr-ui?');

  // 3) Llenar formulario
  await titleInput.fill(PR_TITLE);
  const bodyInput = await firstVisible(page, [
    page.locator('textarea[name="pull_request[body]"]'),
    page.locator('#pull_request_body'),
    page.getByRole('textbox', { name: /description|body|comment/i }),
  ], 5000);
  if (bodyInput) await bodyInput.fill(PR_BODY);
  else log('Aviso: no se encontró el campo de descripción.');

  await page.screenshot({ path: OUT('ui-before.png'), fullPage: true });
  log('Screenshot ui-before.png guardado.');

  // 4) Escuchar la red ANTES del clic y capturar los POST
  const posts = [];
  const onReq = (req) => { if (req.method() === 'POST') posts.push(req); };
  context.on('request', onReq);

  const submit = await firstVisible(page, [
    page.locator('form#new_pull_request button[type="submit"]:has-text("Create pull request")'),
    page.locator('button[type="submit"]:has-text("Create pull request")'),
    page.getByRole('button', { name: /^create pull request$/i }),
  ], 5000);
  if (!submit) throw new Error('No se encontró el botón "Create pull request" del formulario.');

  log('Haciendo clic en "Create pull request"...');
  await submit.click();
  await page.waitForURL(/\/pull\/\d+/, { timeout: 30000 }).catch(() => log('Aviso: la URL no cambió a /pull/N en 30s.'));
  await page.waitForLoadState('networkidle').catch(() => {});
  context.off('request', onReq);

  // 5) Elegir la petición que creó el PR
  const described = [];
  for (const req of posts) {
    const res = await withTimeout(req.response(), 5000);
    const resHeaders = res ? await withTimeout(res.allHeaders(), 5000, {}) : {};
    described.push({ req, res, resHeaders });
  }
  const isCreate = (d) =>
    /\/pull\/\d+/.test(d.resHeaders.location || '') ||
    /\/pull\/create|\/pulls$|\/compare\//.test(d.req.url());
  const chosen = described.find((d) => /\/pull\/\d+/.test(d.resHeaders.location || '')) || described.find(isCreate) || described[0];
  if (!chosen) throw new Error('No se capturó ninguna petición POST.');

  const { req, res, resHeaders } = chosen;
  const reqHeaders = (await withTimeout(req.allHeaders(), 5000)) || req.headers();
  const payload = parsePayload(req.postData(), reqHeaders['content-type'] || '');
  let responseBody = null;
  if (res && !(res.status() >= 300 && res.status() < 400)) {
    responseBody = await withTimeout(res.text(), 5000);
    if (responseBody && responseBody.length > 5000) responseBody = responseBody.slice(0, 5000) + '\n...[truncado]';
  }

  const result = {
    capturedAt: new Date().toISOString(),
    pageUrlAfter: page.url(),
    request: {
      method: req.method(),
      url: req.url(),
      headers: redactHeaders(reqHeaders),
      payloadFormat: payload.format,
      payloadFieldNames: Object.keys(payload.fields),
      payload: payload.fields,
      payloadRaw: payload.raw,
    },
    response: {
      status: res ? res.status() : null,
      statusText: res ? res.statusText() : null,
      location: resHeaders.location || null,
      headers: redactHeaders(resHeaders),
      body: responseBody || (res && res.status() >= 300 && res.status() < 400 ? '(redirección: sin body)' : null),
    },
    otherPostRequests: described.filter((d) => d !== chosen).map((d) => ({
      method: d.req.method(), url: d.req.url(), status: d.res ? d.res.status() : null,
    })),
  };
  fs.writeFileSync(OUT('ui-request.json'), JSON.stringify(result, null, 2));
  log(`ui-request.json guardado: ${result.request.method} ${result.request.url} -> ${result.response.status} (Location: ${result.response.location})`);

  await page.screenshot({ path: OUT('ui-after.png'), fullPage: true });
  log('Screenshot ui-after.png guardado.');

  const n = await har.save(OUT('ui-test.har'));
  log(`HAR guardado en ui-test.har (${n} peticiones).`);

  log('=== TERMINADO. El navegador queda ABIERTO para tus capturas de DevTools. Ciérralo cuando acabes. ===');
  await new Promise(() => {}); // mantener vivo el proceso (y el navegador)
})().catch((err) => {
  log(`ERROR: ${err.message}`);
  log('El navegador queda abierto para revisar. Ciérralo para terminar.');
});
