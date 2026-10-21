// ZS4 诊断探针：连接已运行的壳（9229），在「发送一条消息」的各环节 dump DOM 状态。
// 用法：node scripts/zs4/palette-probe.cjs  （需先 launch 应用）
// 退出码：0 用户行出现；5 未出现（带 STATE_DUMP）。
'use strict';
const http = require('node:http');

const TEXT = process.env.PROBE_TEXT || '探针测试请回复OK';

function getTargets() {
  return new Promise((resolve, reject) => {
    http
      .get('http://127.0.0.1:9229/json/list', (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function main() {
  const targets = await getTargets();
  const page = targets.find(
    (t) => t.type === 'page' && (t.url || '').includes('harness2-zs1-build') && !(t.url || '').includes('packages/desktop/dist'),
  );
  if (!page) {
    console.error('NO_PAGE');
    process.exit(2);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  await new Promise((r) => (ws.onopen = r));

  const dump = async (label) => {
    const expr = `(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const rows = document.querySelectorAll('[data-testid^="v4-row-"]');
      const ce = document.querySelector('[contenteditable=true]');
      const bodyLen = (document.body.innerText || '').length;
      return JSON.stringify({
        hasDialog: !!dlg,
        dialogText: dlg ? (dlg.innerText || '').replace(/\\s+/g, ' ').slice(0, 80) : null,
        v4RowCount: rows.length,
        composer: !!ce,
        composerText: ce ? (ce.innerText || '').trim().slice(0, 40) : null,
        bodyTextLen: bodyLen,
        bodyHead: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 120),
        focus: document.activeElement ? document.activeElement.tagName + '/' + (document.activeElement.getAttribute('data-testid') || '') : 'none',
      });
    })()`;
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(`STATE[${label}]=` + JSON.stringify(r.result && r.result.result ? r.result.result.value : r));
  };

  await dump('boot');
  // 尝试关 dialog（点开始使用 / Esc）
  await send('Runtime.evaluate', {
    expression: `(() => { const dlg=document.querySelector('[role="dialog"]'); if(!dlg) return 'no'; const b=Array.from(dlg.querySelectorAll('button')).find(x=>/Start ZCode|开始使用/i.test(x.innerText||'')); if(b){b.click();return 'clicked';} return 'present'; })()`,
  });
  for (let i = 0; i < 3; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await new Promise((r) => setTimeout(r, 400));
  }
  await dump('after-dismiss');

  // focus composer, type, send
  await send('Runtime.evaluate', { expression: `document.querySelector('[contenteditable=true]') && document.querySelector('[contenteditable=true]').focus()` });
  await new Promise((r) => setTimeout(r, 300));
  await send('Input.insertText', { text: TEXT });
  await new Promise((r) => setTimeout(r, 400));
  await dump('after-insert');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const r = await send('Runtime.evaluate', {
      expression:
        `(() => { const rows = Array.from(document.querySelectorAll('[data-testid^="v4-row-"]')); return rows.some(x => x.querySelector('[data-v4-user-input-bubble]') || (x.innerText||'').includes(${JSON.stringify(TEXT)})); })()`,
      returnByValue: true,
    });
    if (r.result && r.result.result && r.result.result.value === true) {
      console.log('USER_ROW_SEEN at tick', i);
      await dump('after-user-row');
      ws.close();
      process.exit(0);
    }
  }
  await dump('user-row-missing');
  ws.close();
  process.exit(5);
}

main().catch((e) => {
  console.error('PROBE_ERR=' + e.message);
  process.exit(9);
});
