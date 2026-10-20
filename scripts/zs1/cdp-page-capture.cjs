// CDP 截图（正确版）：连应用自带的 9229 调试服务，找 page 目标，Page.captureScreenshot 拿渲染真实像素
const WebSocket = require('D:/AI_Projects/harness2/packages/gateway/node_modules/ws');
const http = require('node:http');
const fs = require('node:fs');

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 9229, path }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(new Error('bad json: ' + d.slice(0, 200)));
          }
        });
      })
      .on('error', reject);
  });
}

(async () => {
  const targets = await getJson('/json/list');
  console.log(
    'targets:',
    JSON.stringify(targets.map((t) => ({ type: t.type, title: t.title, url: String(t.url).slice(0, 60) }))),
  );
  const page = targets.find((t) => t.type === 'page' && String(t.url).startsWith('file://') && t.webSocketDebuggerUrl);
  if (!page) {
    console.error('NO PAGE TARGET');
    process.exit(1);
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
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  ws.on('open', async () => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.error) {
      console.error('CDP ERR ' + JSON.stringify(shot.error).slice(0, 300));
      process.exit(1);
    }
    const buf = Buffer.from(shot.result.data, 'base64');
    const out = 'D:/AI_Projects/harness2/docs/screenshots/zs1/t3-cdp-page.png';
    fs.writeFileSync(out, buf);
    console.log('SAVED ' + out + ' ' + buf.length + ' bytes');
    // 顺带取 DOM 摘要：body 下第一层结构 + 可见文字前 300 字
    const dom = await send('Runtime.evaluate', {
      expression:
        "(() => { const b = document.body; const kids = Array.from(b.children).map(e => e.tagName + '#' + (e.id || '') + '.' + (e.className || '').toString().slice(0, 40)).join(' | '); const text = (b.innerText || '').replace(/\\s+/g, ' ').slice(0, 300); return 'KIDS: ' + kids + ' || TEXT: ' + text; })()",
      returnByValue: true,
    });
    if (dom.result && dom.result.result && dom.result.result.value) {
      console.log('DOM: ' + dom.result.result.value);
    }
    ws.close();
    process.exit(0);
  });
  ws.on('error', (e) => {
    console.error('WS ERR ' + e.message);
    process.exit(1);
  });
  setTimeout(() => {
    console.error('TIMEOUT');
    process.exit(1);
  }, 30000);
})().catch((e) => {
  console.error('FATAL ' + e.message);
  process.exit(1);
});
