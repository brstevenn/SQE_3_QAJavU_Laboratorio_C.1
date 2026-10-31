// SQA3 - Pull Requests Lab
// Genera páginas HTML de evidencia con los datos reales capturados y les toma screenshots.
// Requiere: ui-request.json, api-response.txt, api-response-error.txt
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUT = (f) => path.join(__dirname, f);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #f4f1ea; color: #222; font: 15px/1.5 "Segoe UI", Arial, sans-serif; }
  h1 { font-size: 22px; margin: 0 0 4px; color: #1d3557; }
  .sub { color: #666; margin: 0 0 20px; font-size: 13px; }
  section { background: #fff; border: 2px solid #1d3557; border-radius: 10px; padding: 18px 20px; margin-bottom: 22px; max-width: 1100px; }
  section h2 { margin: 0 0 12px; font-size: 17px; color: #fff; background: #1d3557; display: inline-block; padding: 3px 12px; border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; font: 13px/1.45 Consolas, "Courier New", monospace; }
  td { border-bottom: 1px solid #e3ded3; padding: 5px 8px; vertical-align: top; word-break: break-all; }
  td.k { width: 30%; font-weight: bold; color: #7a3e00; white-space: nowrap; word-break: normal; }
  tr.hl td { background: #fff3c4; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-weight: bold; color: #fff; }
  .ok { background: #2a9d8f; } .redir { background: #e09f3e; } .err { background: #c1121f; }
  pre { background: #fbfaf7; border: 1px solid #e3ded3; padding: 10px; border-radius: 6px; white-space: pre-wrap; word-break: break-all; font: 12px/1.45 Consolas, monospace; margin: 8px 0 0; }
  .note { font-size: 12px; color: #666; margin-top: 8px; }
`;

const badge = (status) => {
  const cls = status >= 400 ? 'err' : status >= 300 ? 'redir' : 'ok';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
};
const rows = (obj, highlight = []) =>
  Object.entries(obj).map(([k, v]) => {
    let val = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
    if (val.length > 160) val = val.slice(0, 160) + ` … [${val.length} caracteres]`;
    return `<tr class="${highlight.includes(k.toLowerCase()) ? 'hl' : ''}"><td class="k">${esc(k)}</td><td>${esc(val)}</td></tr>`;
  }).join('');
const page = (title, sub, body) =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head>` +
  `<body><h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p>${body}</body></html>`;

// Lee la salida de `gh api -i`: línea de status, headers, línea en blanco, JSON
function parseGhResponse(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
  const [head, ...rest] = text.split('\n\n');
  const [statusLine, ...headerLines] = head.split('\n');
  const headers = {};
  for (const l of headerLines) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i)] = l.slice(i + 1).trim();
  }
  const bodyText = rest.join('\n\n');
  const start = bodyText.indexOf('{');
  let json = null;
  let depth = 0;
  for (let i = start; start >= 0 && i < bodyText.length; i++) {
    if (bodyText[i] === '{') depth++;
    else if (bodyText[i] === '}' && --depth === 0) { json = JSON.parse(bodyText.slice(start, i + 1)); break; }
  }
  const m = statusLine.match(/^(\S+)\s+(\d{3})\s*(.*)$/);
  return { statusLine, httpVersion: m[1], status: Number(m[2]), statusText: m[3], headers, json };
}

function uiHtml(ui) {
  const r = ui.request, s = ui.response;
  const general = {
    'Request Method': r.method,
    'Request URL': r.url,
    'Status Code': `${s.status} ${s.statusText || ''}`,
    'Página después del clic': ui.pageUrlAfter,
    'Capturado': ui.capturedAt,
  };
  return page(
    'Evidencia capturada con Playwright – Creación de Pull Request (UI)',
    'Datos reales de ui-request.json. Cookies y tokens CSRF reemplazados por ***.',
    `<section id="headers"><h2>1 · Headers</h2>
       <table>${rows(general)}</table>
       <p class="note">Status: ${badge(s.status)}</p>
       <h3 style="font-size:14px;margin:14px 0 6px">Request Headers</h3>
       <table>${rows(r.headers, ['content-type', 'origin', 'referer'])}</table>
     </section>
     <section id="payload"><h2>2 · Payload</h2>
       <table>${rows({ 'Formato': r.payloadFormat, 'Campos': r.payloadFieldNames.join(', ') })}</table>
       <h3 style="font-size:14px;margin:14px 0 6px">Form Data</h3>
       <table>${rows(r.payload, ['pull_request[title]', 'pull_request[body]'])}</table>
     </section>
     <section id="response"><h2>3 · Response Headers</h2>
       <table>${rows({ 'Status Code': `${s.status} ${s.statusText || ''}`, 'Location': s.location || '(sin Location)' }, ['location'])}</table>
       <h3 style="font-size:14px;margin:14px 0 6px">Todos los Response Headers</h3>
       <table>${rows(s.headers, ['location', 'content-type'])}</table>
       ${s.body ? `<h3 style="font-size:14px;margin:14px 0 6px">Body</h3><pre>${esc(s.body)}</pre>` : ''}
     </section>`
  );
}

function apiHtml(api, title, sub) {
  const keyHeaders = {};
  for (const k of ['Content-Type', 'Location', 'X-Github-Request-Id', 'X-Ratelimit-Remaining', 'X-Accepted-Oauth-Scopes']) {
    if (api.headers[k]) keyHeaders[k] = api.headers[k];
  }
  const j = api.json || {};
  const body = api.status < 300
    ? `<table>${rows({ number: j.number, state: j.state, title: j.title, html_url: j.html_url, 'head.ref': j.head?.ref, 'base.ref': j.base?.ref, 'user.login': j.user?.login, created_at: j.created_at }, ['number', 'state', 'title', 'html_url', 'head.ref', 'base.ref'])}</table>
       <p class="note">El JSON completo (${Object.keys(j).length} campos de primer nivel) está en api-response.txt.</p>`
    : `<pre>${esc(JSON.stringify(j, null, 2))}</pre>`;
  return page(title, sub,
    `<section id="api"><h2>Respuesta HTTP</h2>
       <table>${rows({ 'Request': 'POST https://api.github.com/repos/brstevenn/SQE_3_QAJavU_Laboratorio_C.1/pulls', 'Status Line': api.statusLine })}</table>
       <p class="note">Status: ${badge(api.status)}</p>
       <h3 style="font-size:14px;margin:14px 0 6px">Response Headers (principales)</h3>
       <table>${rows(keyHeaders, ['location', 'content-type'])}</table>
       <h3 style="font-size:14px;margin:14px 0 6px">${api.status < 300 ? 'Campos del JSON' : 'Body (error)'}</h3>
       ${body}
     </section>`);
}

(async () => {
  const ui = JSON.parse(fs.readFileSync(OUT('ui-request.json'), 'utf8'));
  const api = parseGhResponse(OUT('api-response.txt'));
  const apiErr = parseGhResponse(OUT('api-response-error.txt'));

  const pages = [
    ['ui-evidencia.html', uiHtml(ui), [['#headers', 'ui-evidencia-headers.png'], ['#payload', 'ui-evidencia-payload.png'], ['#response', 'ui-evidencia-response.png']]],
    ['ui-evidencia-api.html', apiHtml(api, 'Evidencia – Creación de Pull Request (API REST)', 'Datos reales de api-response.txt (gh api -i).'), [['#api', 'api-evidencia.png']]],
    ['ui-evidencia-api-error.html', apiHtml(apiErr, 'Evidencia – Prueba negativa (API REST, head inexistente)', 'Datos reales de api-response-error.txt (head="rama-que-no-existe").'), [['#api', 'api-evidencia-error.png']]],
  ];

  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
  const tab = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1.5 });
  for (const [htmlFile, html, shots] of pages) {
    fs.writeFileSync(OUT(htmlFile), html);
    await tab.goto('file:///' + OUT(htmlFile).replace(/\\/g, '/'));
    for (const [sel, png] of shots) {
      await tab.locator(sel).screenshot({ path: OUT(png) });
      console.log(`${png} <- ${htmlFile} ${sel}`);
    }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
