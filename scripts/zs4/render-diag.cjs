// 诊断：attach renderer，监听 console/log 事件，发一条消息，抓取所有错误输出。
'use strict';
const http = require('node:http');
const TEXT = '渲染诊断请回复OK';

(async () => {
  const list = await new Promise((res, rej) => {
    http
      .get('http://127.0.0.1:9229/json/list', (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => res(JSON.parse(b)));
      })
      .on('error', rej);
  });
  const page = list.find((t) => t.type === 'page' && (t.url || '').includes('harness2-zs1-build'));
  if (!page) {
    console.error('NO_PAGE');
    process.exit(2);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map((a) => String(a.value ?? a.description ?? a.type)).join(' ');
      if (m.params.type === 'error' || m.params.type === 'warning') errors.push(`CONSOLE[${m.params.type}]: ${args.slice(0, 300)}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.level === 'warning') errors.push(`LOG[${e.level}]: ${(e.text || '').slice(0, 300)}`);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const call = (method, params = {}) =>
    new Promise((r) => {
      const mid = ++id;
      pend.set(mid, r);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const ev = async (x) => {
    const r = await call('Runtime.evaluate', { expression: x, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : r;
  };
  await call('Runtime.enable');
  await call('Log.enable');

  // 先关弹窗
  for (let i = 0; i < 3; i++) {
    await ev(`(() => { const d=document.querySelector('[role="dialog"]'); if(d){const b=Array.from(d.querySelectorAll('button')).find(x=>/开始使用|Start ZCode/i.test(x.innerText||'')); if(b)b.click();} return 1; })()`);
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await new Promise((r) => setTimeout(r, 300));
  }
  await ev(`document.querySelector('[contenteditable=true]')?.focus()`);
  await new Promise((r) => setTimeout(r, 300));
  await call('Input.insertText', { text: TEXT });
  await new Promise((r) => setTimeout(r, 400));
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 8000));
  console.log('ROWS=' + (await ev(`document.querySelectorAll('[data-testid^="v4-row-"]').length`)));
  console.log('HAS_TEXT=' + (await ev(`(document.body.innerText||'').includes(${JSON.stringify(TEXT)})`)));
  console.log('WHERE=' + (await ev(`(() => {
    const walk=(el,acc)=>{for(const c of el.children){const hit=(c.innerText||'').includes(${JSON.stringify(TEXT)});if(hit&&c.children.length===0)acc.push(c.tagName+'/'+(c.getAttribute('data-testid')||c.className.toString().slice(0,40)));walk(c,acc)}return acc};
    return JSON.stringify(walk(document.body,[]).slice(0,6));
  })()`)));
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  require('node:fs').writeFileSync('D:/AI_Projects/harness2-zs1-build/after-send.png', Buffer.from(shot.result.data, 'base64'));
  console.log('SHOT=d:/AI_Projects/harness2-zs1-build/after-send.png');
  console.log('ERRORS=' + JSON.stringify(errors.slice(0, 15), null, 1));
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('ERR=' + e.message);
  process.exit(1);
});
