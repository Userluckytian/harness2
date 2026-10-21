// ZS4 e2e settings provider round.
// Exit codes: 0 pass / 3 wrong instance / 4 settings not opened / 5 provider not created /
//             6 save not persisted / 7 connectivity failure not shown / 8 delete not effective /
//             9 secret leaked / 1 other
'use strict';
const http = require('http');
const WebSocket = require('D:/AI_Projects/harness2/node_modules/.pnpm/ws@8.21.3/node_modules/ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SHOT = 'D:/AI_Projects/harness2/docs/screenshots/zs4/settings-provider-round.png';
const HOME = process.env.HARNESS2_HOME || os.homedir();
const SECRET = 'sk-probe-secret-123';
const BASE_URL = 'http://127.0.0.1:9/v1';
const CONFIG_PATH = path.join(HOME, '.harness2', 'config.json');
const AUTH_PATH = path.join(HOME, '.harness2', 'auth.json');

function getJson(p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 9229, path: p }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function findProviderIdByBaseUrl(cfg) {
  if (!cfg || !cfg.providers) return null;
  for (const [id, entry] of Object.entries(cfg.providers)) {
    if (entry && typeof entry === 'object' && entry.baseUrl === BASE_URL) return id;
  }
  return null;
}

(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await getJson('/json/list');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const targets = await getJson('/json/list');
  const page = targets.find(
    (t) =>
      t.type === 'page' &&
      /localhost:5174|127\.0\.0\.1:5174|harness2-zs1-build/.test(t.url) &&
      !/packages\/desktop\/dist\/renderer/.test(t.url),
  );
  if (!page) {
    console.error('WRONG INSTANCE/NOT UP');
    process.exit(3);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  ws.on('error', (e) => {
    console.error('WS ERR', e && e.message);
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  ws.on('open', async () => {
    try {
      async function ev(expr) {
        const r = await send('Runtime.evaluate', { expression: expr });
        return r.result?.result?.value;
      }
      async function dismissWelcome() {
        const r = await send('Runtime.evaluate', {
          expression:
            "(() => { const dlg = document.querySelector('[role=\"dialog\"]'); if (!dlg) return 'no-dialog'; const hit = (t) => /Start ZCode|开始使用/i.test(t||''); const b = Array.from(dlg.querySelectorAll('button')).find(x => hit(x.innerText) || hit(x.getAttribute('aria-label'))); if (b) { b.click(); return 'clicked'; } return 'dialog-present-no-start-button'; })()",
        });
        return String(r.result?.result?.value || 'none');
      }
      for (let i = 0; i < 20; i++) {
        if ((await dismissWelcome()) === 'clicked') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      await new Promise((r) => setTimeout(r, 1500));

      // open settings
      let settingsOpened = false;
      for (let i = 0; i < 20; i++) {
        const v = await ev("(() => { const b = document.querySelector('button[data-testid=\"task-settings-button\"]'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()");
        if (v === 'clicked') {
          settingsOpened = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!settingsOpened) {
        console.error('SETTINGS BUTTON MISSING');
        process.exit(4);
      }
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev("!!document.querySelector('[data-testid=\"settings-page\"]')");
        if (v === true) break;
      }

      // navigate to model provider section
      await ev("(() => { const b = document.querySelector('button[data-testid=\"settings-section-nav-modelProvider\"]'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()");
      let sectionOpened = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev("!!document.querySelector('[data-testid=\"model-provider-add-provider-button\"]')");
        if (v === true) {
          sectionOpened = true;
          break;
        }
      }
      if (!sectionOpened) {
        console.error('MODEL PROVIDER SECTION NOT OPENED');
        process.exit(4);
      }

      // add provider
      await ev("(() => { const b = document.querySelector('[data-testid=\"model-provider-add-provider-button\"]'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()");
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev("!!document.querySelector('[data-testid=\"model-provider-template-picker\"]')");
        if (v === true) break;
      }
      await ev("(() => { const b = document.querySelector('[data-testid=\"model-provider-template-item-custom\"]'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()");

      let formOpened = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev("!!document.querySelector('[data-testid=\"model-provider-base-url-input\"]')");
        if (v === true) {
          formOpened = true;
          break;
        }
      }
      if (!formOpened) {
        console.error('PROVIDER FORM NOT OPENED');
        process.exit(5);
      }

      // fill baseUrl
      await ev(`(() => {
        const el = document.querySelector('[data-testid="model-provider-base-url-input"]');
        if (!el) return 'missing';
        el.value = ${JSON.stringify(BASE_URL)};
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
        el.blur();
        return 'done';
      })()`);
      // fill apiKey
      await ev(`(() => {
        const el = document.querySelector('[data-testid="model-provider-api-key-input"]');
        if (!el) return 'missing';
        el.value = ${JSON.stringify(SECRET)};
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
        el.blur();
        return 'done';
      })()`);

      // wait save persisted
      let providerId = null;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const cfg = readJsonSafe(CONFIG_PATH);
        providerId = findProviderIdByBaseUrl(cfg);
        if (providerId) break;
      }
      console.log('PROVIDER_ID=' + String(providerId));
      if (!providerId) {
        console.error('SAVE NOT PERSISTED');
        process.exit(6);
      }

      // secret leakage check in config
      const cfgText = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : '';
      if (cfgText.includes(SECRET)) {
        console.error('SECRET LEAKED IN CONFIG');
        process.exit(9);
      }
      const authText = fs.existsSync(AUTH_PATH) ? fs.readFileSync(AUTH_PATH, 'utf8') : '';
      const authHas = authText.includes(SECRET);
      console.log('AUTH_HAS_SECRET=' + authHas);
      if (!authHas) {
        console.error('AUTH MISSING SECRET');
        process.exit(6);
      }

      // add a model
      await ev("(() => { const b = document.querySelector('[data-testid=\"model-provider-add-model-button\"]'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()");
      // fill model id in dialog: first text input in dialog
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev("!!document.querySelector('div[role=\"dialog\"] input')");
        if (v === true) break;
      }
      await ev(`(() => {
        const dlg = document.querySelector('div[role="dialog"]');
        const inp = dlg ? dlg.querySelector('input') : null;
        if (!inp) return 'missing';
        inp.value = 'probe-model';
        inp.dispatchEvent(new Event('input', {bubbles:true}));
        inp.dispatchEvent(new Event('change', {bubbles:true}));
        return 'done';
      })()`);
      // click save button in dialog
      await ev("(() => { const dlg = document.querySelector('div[role=\"dialog\"]'); const btns = dlg ? Array.from(dlg.querySelectorAll('button')) : []; const b = btns.find(x => /保存|Save/i.test(x.textContent||'')); if (b) { b.click(); return 'clicked'; } return 'missing'; })()");
      // wait model row appears
      let modelRow = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev("!!document.querySelector('[data-testid^=\"model-provider-model-input-\"]')");
        if (v === true) {
          modelRow = true;
          break;
        }
      }
      console.log('MODEL_ROW=' + modelRow);

      // test connectivity
      let testClicked = false;
      for (let i = 0; i < 20; i++) {
        const v = await ev("(() => { const btns = Array.from(document.querySelectorAll('button')); const b = btns.find(x => /测试|Test/i.test(x.getAttribute('title')||'') || /测试|Test/i.test(x.textContent||'')); if (b) { b.click(); return 'clicked'; } return 'missing'; })()");
        if (v === 'clicked') {
          testClicked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      console.log('TEST_CLICKED=' + testClicked);

      // wait for failure text
      let failureShown = false;
      let pageText = '';
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev("document.body.innerText.replace(/\\s+/g,' ').slice(0,4000)");
        pageText = v || '';
        if (/失败|failed|Connection failed|request-failed|provider-unavailable| refused|ECONNREFUSED|9\/v1/i.test(pageText)) {
          failureShown = true;
          break;
        }
      }
      console.log('FAILURE_SHOWN=' + failureShown);
      if (!failureShown) {
        console.error('CONNECTIVITY FAILURE NOT SHOWN');
        process.exit(7);
      }
      // secret not in page text
      if (pageText.includes(SECRET)) {
        console.error('SECRET LEAKED IN UI');
        process.exit(9);
      }

      // delete provider via actions menu
      await ev("(() => { const b = document.querySelector('[data-testid=\"model-provider-actions-button\"]'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()");
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const v = await ev("(() => { const items = Array.from(document.querySelectorAll('[role=\"menuitem\"]')); const b = items.find(x => /删除|Delete/i.test(x.textContent||'')); if (b) { b.click(); return 'clicked'; } return 'missing'; })()");
        if (v === 'clicked') break;
      }
      // confirm dialog if present
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const v = await ev("!!document.querySelector('[data-testid=\"confirm-dialog-confirm\"]')");
        if (v === true) {
          await ev("(() => { const b = document.querySelector('[data-testid=\"confirm-dialog-confirm\"]'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()");
          break;
        }
      }

      // wait provider removed from config
      let removed = false;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const cfg = readJsonSafe(CONFIG_PATH);
        if (!findProviderIdByBaseUrl(cfg)) {
          removed = true;
          break;
        }
      }
      console.log('PROVIDER_REMOVED=' + removed);
      if (!removed) {
        console.error('DELETE NOT EFFECTIVE');
        process.exit(8);
      }

      fs.mkdirSync('D:/AI_Projects/harness2/docs/screenshots/zs4', { recursive: true });
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(shot.result.data, 'base64');
      fs.writeFileSync(SHOT, buf);
      console.log('SCREENSHOT=' + SHOT + ' bytes=' + buf.length);

      ws.close();
      const result = {
        status: 'pass',
        providerId: providerId,
        authHasSecret: authHas,
        configLeakedSecret: false,
        connectivityFailureShown: failureShown,
        deleted: removed,
      };
      console.log('RESULT=' + JSON.stringify(result));
      process.exit(0);
    } catch (e) {
      console.error('ERR', e);
      process.exit(1);
    }
  });
})();
