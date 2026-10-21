// ZS3 e2e approval round: 在真实壳里触发一次 permission 审批并点 deny。
// 依赖启动 env ZS3_E2E_APPROVAL=1（run-e2e.ps1 -Approval 设置）：
// adapter 使用脚本化 MockProvider 调 write 工具，审批弹窗必然出现，不依赖真实模型决策。
// 退出码：0 通过 / 3 实例锁定失败 / 4 输入未落 / 5 用户行未现 / 6 无 composer /
//        7 审批弹窗未出现 / 8 deny 选项缺失 / 9 弹窗未消失 / 10 未观察到拒绝结果 / 1 其他
const http = require('http');
const WebSocket = require('D:/AI_Projects/harness2/node_modules/.pnpm/ws@8.21.3/node_modules/ws');
const fs = require('fs');

const TEXT = '请执行审批测试工具';
const SHOT = 'D:/AI_Projects/harness2/docs/screenshots/zs3/approval-deny.png';
const ROW_SEL = '[data-testid^="v4-row-"]';
const OPTION_SEL = '[data-permission-option-kind]';

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

      let cap = 'no-composer';
      for (let i = 0; i < 20; i++) {
        const c = await send('Runtime.evaluate', {
          expression: "document.querySelector('[contenteditable=true]') ? 'input-capable' : 'no-composer'",
        });
        cap = c.result?.result?.value || 'no-composer';
        if (cap === 'input-capable') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      console.log('INPUT_CAPABILITY=' + cap);
      if (cap !== 'input-capable') {
        const dt = await send('Runtime.evaluate', {
          expression: "document.body.innerText.replace(/\\s+/g,' ').slice(0,500)",
        });
        console.log('PAGE_TEXT=' + (dt.result?.result?.value || ''));
        console.error('NO COMPOSER');
        process.exit(6);
      }

      await send('Runtime.evaluate', {
        expression:
          "(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.getAttribute('aria-label')||x.innerText||'').includes('新建会话') || (x.getAttribute('aria-label')||x.innerText||'').includes('New task')); if (b) b.click(); return !!b; })()",
      });
      await new Promise((r) => setTimeout(r, 1200));
      await dismissWelcome();

      await send('Runtime.evaluate', { expression: "document.querySelector('[contenteditable=true]').focus()" });
      // 清空 composer 既有内容（草稿持久化在 renderer Local Storage，跨重启存活——
      // 不清会拼进本轮文本导致 COMPOSED 不匹配，2026-10-21 草稿污染实证）
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Delete',
        code: 'Delete',
        windowsVirtualKeyCode: 46,
      });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await new Promise((r) => setTimeout(r, 300));
      await send('Input.insertText', { text: TEXT });
      await new Promise((r) => setTimeout(r, 400));
      const composed = await send('Runtime.evaluate', {
        expression:
          "(() => { const ce = document.querySelector('[contenteditable=true]'); return ce ? (ce.innerText||'').trim() : ''; })()",
      });
      const composedText = composed.result?.result?.value || '';
      console.log('COMPOSED_TEXT=' + JSON.stringify(composedText));
      if (composedText !== TEXT) {
        console.error('INPUT NOT COMPOSED');
        process.exit(4);
      }
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      console.log('INPUT_SENT');

      let userRowSeen = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const r = await send('Runtime.evaluate', {
          expression: `document.querySelectorAll('${ROW_SEL}').length > 0`,
        });
        if (r.result?.result?.value === true) {
          userRowSeen = true;
          break;
        }
      }
      if (!userRowSeen) {
        console.error('USER ROW NOT SEEN');
        process.exit(5);
      }
      console.log('USER_ROW_SEEN');

      // 审批弹窗：等待 permission 选项出现
      let optionKinds = [];
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const r = await send('Runtime.evaluate', {
          expression: `JSON.stringify(Array.from(document.querySelectorAll('${OPTION_SEL}')).map(x => x.getAttribute('data-permission-option-kind')))`,
        });
        try {
          optionKinds = JSON.parse(r.result?.result?.value || '[]');
        } catch {
          optionKinds = [];
        }
        if (optionKinds.length > 0) break;
      }
      console.log('PERMISSION_OPTIONS=' + JSON.stringify(optionKinds));
      if (optionKinds.length === 0) {
        const dt = await send('Runtime.evaluate', {
          expression: "document.body.innerText.replace(/\\s+/g,' ').slice(0,800)",
        });
        console.log('PAGE_TEXT=' + (dt.result?.result?.value || ''));
        const dbg = await send('Runtime.evaluate', {
          expression:
            "(() => { const bs = Array.from(document.querySelectorAll('button')); return JSON.stringify({ buttons: bs.slice(0,40).map(b => ({ text: (b.innerText||'').slice(0,40), aria: b.getAttribute('aria-label'), kind: b.getAttribute('data-permission-option-kind'), role: b.getAttribute('role') })), listboxes: document.querySelectorAll('[role=listbox]').length, permissionNodes: document.querySelectorAll('[data-permission-dialog-scroll]').length, htmlSnippet: (document.body.innerHTML.match(/.{0,120}拒绝.{0,120}/)||[''])[0] }); })()",
        });
        console.log('DEBUG_DOM=' + (dbg.result?.result?.value || ''));
        console.error('PERMISSION DIALOG NOT SHOWN');
        process.exit(7);
      }
      const denyKinds = optionKinds.filter((k) => k === 'deny' || (typeof k === 'string' && k.startsWith('reject')));
      if (denyKinds.length === 0) {
        console.error('DENY OPTION MISSING');
        process.exit(8);
      }
      const denyKind = denyKinds[0];

      // 选中 deny，再点确认（确认按钮 aria-label = common.confirm）
      const clicked = await send('Runtime.evaluate', {
        expression: `(() => { const b = document.querySelector('${OPTION_SEL}[data-permission-option-kind="${denyKind}"]'); if (!b) return false; b.click(); return true; })()`,
      });
      if (clicked.result?.result?.value !== true) {
        console.error('DENY OPTION MISSING');
        process.exit(8);
      }
      await new Promise((r) => setTimeout(r, 300));
      const confirmed = await send('Runtime.evaluate', {
        expression:
          "(() => { const bs = Array.from(document.querySelectorAll('button')).filter(b => !b.disabled && /确认|Confirm/i.test(b.getAttribute('aria-label')||b.innerText||'')); const b = bs[0]; if (!b) return false; b.click(); return true; })()",
      });
      console.log('DENY_CONFIRM=' + String(confirmed.result?.result?.value));
      if (confirmed.result?.result?.value !== true) {
        console.error('CONFIRM BUTTON MISSING');
        process.exit(8);
      }

      // 弹窗消失 = resolveInteraction 被接受并清理 pending
      let cleared = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const r = await send('Runtime.evaluate', {
          expression: `document.querySelectorAll('${OPTION_SEL}').length === 0`,
        });
        if (r.result?.result?.value === true) {
          cleared = true;
          break;
        }
      }
      console.log('DIALOG_CLEARED=' + cleared);
      if (!cleared) {
        const dt = await send('Runtime.evaluate', {
          expression: "document.body.innerText.replace(/\\s+/g,' ').slice(0,800)",
        });
        console.log('PAGE_TEXT=' + (dt.result?.result?.value || ''));
        console.error('DIALOG NOT CLEARED');
        process.exit(9);
      }

      // 行转 error/cancelled：页面文本应出现拒绝/错误标记
      let deniedSeen = false;
      let pageText = '';
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const r = await send('Runtime.evaluate', {
          expression: "document.body.innerText.replace(/\\s+/g,' ').slice(0,2000)",
        });
        pageText = r.result?.result?.value || '';
        if (/denied by approval policy|denied|拒绝|已拒绝|失败|error/i.test(pageText)) {
          deniedSeen = true;
          break;
        }
      }
      console.log('DENIED_MARKER=' + deniedSeen);
      console.log('PAGE_TEXT_TAIL=' + pageText.slice(-300));

      fs.mkdirSync('D:/AI_Projects/harness2/docs/screenshots/zs3', { recursive: true });
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(shot.result.data, 'base64');
      fs.writeFileSync(SHOT, buf);
      console.log('SCREENSHOT=' + SHOT + ' bytes=' + buf.length);

      ws.close();
      process.exit(deniedSeen ? 0 : 10);
    } catch (e) {
      console.error('ERR', e);
      process.exit(1);
    }
  });
})();
