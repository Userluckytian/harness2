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
        const v = await ev(
          "(() => { const b = document.querySelector('button[data-testid=\"task-settings-button\"]'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()",
        );
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
        const v = await ev('!!document.querySelector(\'[data-testid="settings-page"]\')');
        if (v === true) break;
      }

      // navigate to model provider section
      await ev(
        "(() => { const b = document.querySelector('button[data-testid=\"settings-section-nav-modelProvider\"]'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()",
      );
      let sectionOpened = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev('!!document.querySelector(\'[data-testid="model-provider-add-provider-button"]\')');
        if (v === true) {
          sectionOpened = true;
          break;
        }
      }
      if (!sectionOpened) {
        console.error('MODEL PROVIDER SECTION NOT OPENED');
        process.exit(4);
      }

      // add provider：模板卡=立即 createPersonalProvider（草稿态）；随后必须点导航项
      // 才进详情表单（2026-10-22 dump 实证：create 后表单不自动打开）
      await ev(
        "(() => { const b = document.querySelector('[data-testid=\"model-provider-add-provider-button\"]'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()",
      );
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev('!!document.querySelector(\'[data-testid="model-provider-template-picker"]\')');
        if (v === true) break;
      }
      const navBefore = await ev(
        'JSON.stringify(Array.from(document.querySelectorAll(\'[data-testid^="model-provider-nav-item-custom"]\')).map(e=>e.getAttribute("data-testid")))',
      );
      const preSet = new Set(JSON.parse(navBefore || '[]'));
      await ev(
        "(() => { const b = document.querySelector('[data-testid=\"model-provider-template-item-custom\"]'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()",
      );
      await new Promise((r) => setTimeout(r, 3500));
      // 点新出现的 custom 导航项
      const newNav = await ev(
        `(() => { const items=Array.from(document.querySelectorAll('[data-testid^="model-provider-nav-item-custom"]')); const n=items.find(e=>!${JSON.stringify([...preSet])}.includes(e.getAttribute('data-testid'))); if(n){n.click();return n.getAttribute('data-testid');} return 'none-new'; })()`,
      );
      console.log('NEW_NAV=' + newNav);

      let formOpened = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev('!!document.querySelector(\'[data-testid="model-provider-base-url-input"]\')');
        if (v === true) {
          formOpened = true;
          break;
        }
      }
      if (!formOpened) {
        console.error('PROVIDER FORM NOT OPENED');
        process.exit(5);
      }

      // React 受控 input：直接 el.value= 被 value-tracker 吞掉（2026-10-22 实证空 baseUrl 落盘）
      // ——必须走 HTMLInputElement.prototype 原生 value setter 再 dispatch input。
      async function fillReactInput(testid, value) {
        return ev(`(() => {
          const el = document.querySelector('[data-testid="${testid}"]');
          if (!el) return 'missing';
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('blur', {bubbles:true}));
          return 'done';
        })()`);
      }
      // fill baseUrl
      await fillReactInput('model-provider-base-url-input', BASE_URL);
      // fill apiKey
      await fillReactInput('model-provider-api-key-input', SECRET);

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

      // add a model（ProviderModelMetadataDialog：modelId Input 是 React 受控 → 必须原生 setter）
      await ev(
        "(() => { const b = document.querySelector('[data-testid=\"model-provider-add-model-button\"]'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()",
      );
      // wait dialog with inputs
      let dialogReady = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev('!!document.querySelector(\'div[role="dialog"] input\')');
        if (v === true) {
          dialogReady = true;
          break;
        }
      }
      if (!dialogReady) {
        console.error('ADD-MODEL DIALOG NOT OPENED');
        process.exit(6);
      }
      // 第一个 input = 模型 ID（DOM 顺序：ProviderModelMetadataDialog.tsx:181）
      const filled = await ev(`(() => {
        const inp = document.querySelector('div[role="dialog"] input');
        if (!inp) return 'missing';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, 'probe-model');
        inp.dispatchEvent(new Event('input', {bubbles:true}));
        inp.dispatchEvent(new Event('blur', {bubbles:true}));
        return 'done';
      })()`);
      console.log('DIALOG_FILL=' + filled);
      await new Promise((r) => setTimeout(r, 600));
      const backfill = await ev(
        `document.querySelector('div[role="dialog"] input') ? document.querySelector('div[role="dialog"] input').value : 'no-input'`,
      );
      console.log('DIALOG_VALUE=' + backfill);
      // ZS4.5d 验收（用户要求）：只填模型 ID，**不碰任何其他字段**，直接点保存——
      // 验证宿主基线（DEFAULT_CONTEXT_WINDOW + disabled 档位占位）贯通表单校验。
      // 先等异步 resolveModelConfig 回填基线，dump 表单自动带出的值作证据。
      await new Promise((r) => setTimeout(r, 1500));
      const formDump = await ev(`(() => {
        const dlg = document.querySelector('div[role="dialog"]');
        if (!dlg) return 'no-dialog';
        const inputs = Array.from(dlg.querySelectorAll('input')).map(i => ({ v: i.value, ph: i.placeholder || '' }));
        const chips = Array.from(dlg.querySelectorAll('[data-model-reasoning-chip]')).map(c => (c.innerText||'').trim());
        const ta = document.querySelector('[data-model-reasoning-level-map-editor="true"] textarea');
        return JSON.stringify({ inputs: inputs.slice(0,4), chips, mapPlaceholder: ta ? ta.placeholder : null, mapValue: ta ? ta.value : null });
      })()`);
      console.log('FORM_BASELINE=' + formDump);
      // click save button in dialog（variant=default 的「保存」，zh common.save）
      const saved = await ev(
        "(() => { const dlg = document.querySelector('div[role=\"dialog\"]'); const btns = dlg ? Array.from(dlg.querySelectorAll('button')) : []; const b = btns.find(x => /^\\s*(保存|Save)\\s*$/.test(x.textContent||'')); if (b) { b.click(); return 'clicked'; } return 'missing'; })()",
      );
      console.log('DIALOG_SAVE=' + saved);
      // wait model row appears（行 testid 在 span 上：model-provider-model-input-<index>）
      let modelRow = false;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev('!!document.querySelector(\'[data-testid^="model-provider-model-input-"]\')');
        if (v === true) {
          modelRow = true;
          break;
        }
      }
      console.log('MODEL_ROW=' + modelRow);
      if (!modelRow) {
        const dlgText = await ev(
          "(() => { const d = document.querySelector('div[role=\"dialog\"]'); return d ? d.innerText.replace(/\\s+/g,' ').slice(0,600) : 'no-dialog'; })()",
        );
        console.error('MODEL ADD FAILED, dialog text: ' + dlgText);
        process.exit(6);
      }

      // test connectivity
      let testClicked = false;
      for (let i = 0; i < 20; i++) {
        const v = await ev(
          "(() => { const btns = Array.from(document.querySelectorAll('button')); const b = btns.find(x => /测试|Test/i.test(x.getAttribute('title')||'') || /测试|Test/i.test(x.textContent||'')); if (b) { b.click(); return 'clicked'; } return 'missing'; })()",
        );
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
        if (
          /失败|failed|Connection failed|request-failed|provider-unavailable| refused|ECONNREFUSED|9\/v1/i.test(
            pageText,
          )
        ) {
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

      // delete provider via actions menu —— Radix DropdownMenu 不认 el.click()（无真实
      // pointerdown），必须 CDP 鼠标事件打按钮坐标（与 sidebar 探针右键菜单同一实证）
      async function clickByTestId(testid) {
        const pos = await ev(
          `(() => { const b = document.querySelector('[data-testid="${testid}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}); })()`,
        );
        if (!pos) return 'missing';
        const { x, y } = JSON.parse(pos);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        return 'clicked';
      }
      const acts = await clickByTestId('model-provider-actions-button');
      console.log('DELETE_ACTS_BTN=' + acts);
      await new Promise((r) => setTimeout(r, 600));
      const menuDump = await ev(
        "JSON.stringify(Array.from(document.querySelectorAll('[role=\"menuitem\"]')).map(x=>(x.textContent||'').trim()).slice(0,20))",
      );
      console.log('DELETE_MENU_ITEMS=' + menuDump);
      let menuClicked = 'no';
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const v = await ev(
          "(() => { const items = Array.from(document.querySelectorAll('[role=\"menuitem\"]')); const b = items.find(x => /删除|Delete/i.test(x.textContent||'')); if (b) { b.click(); return 'clicked'; } return 'missing'; })()",
        );
        if (v === 'clicked') {
          menuClicked = 'yes';
          break;
        }
      }
      console.log('DELETE_MENU_CLICKED=' + menuClicked);
      await new Promise((r) => setTimeout(r, 500));
      const dlgDump = await ev(
        "(() => { const d = document.querySelector('div[role=\"dialog\"]'); return d ? d.innerText.replace(/\\s+/g,' ').slice(0,300) : 'no-dialog'; })()",
      );
      console.log('DELETE_CONFIRM_DIALOG=' + dlgDump);
      // confirm dialog if present
      let confirmClicked = 'no';
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const v = await ev('!!document.querySelector(\'[data-testid="confirm-dialog-confirm"]\')');
        if (v === true) {
          confirmClicked = await ev(
            "(() => { const b = document.querySelector('[data-testid=\"confirm-dialog-confirm\"]'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()",
          );
          break;
        }
      }
      console.log('DELETE_CONFIRM=' + confirmClicked);

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
