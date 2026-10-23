// ZS6-T2 V3 证据截图：主壳（Help 菜单展开）+ 关于窗 → docs/screenshots/zs6/
// 用法: node scripts/zs6/t2-capture.cjs ；exit 0=成功（PNG 数>0）
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('D:/AI_Projects/harness2/node_modules/.pnpm/ws@8.21.3/node_modules/ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OUT = 'D:/AI_Projects/harness2/docs/screenshots/zs6';

function getJson(p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 9229, path: p, timeout: 5000 }, (res) => {
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

function connect(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    let id = 0;
    const pend = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pend.has(m.id)) {
        pend.get(m.id)(m);
        pend.delete(m.id);
      }
    });
    const send = (method, params) =>
      new Promise((res) => {
        const i = ++id;
        pend.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    const ev = async (e) => {
      const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    ws.on('open', () =>
      resolve({
        ws,
        send,
        ev,
        shot: async (file) => {
          await send('Page.enable', {});
          const r = await send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(OUT, file), Buffer.from(r.result.data, 'base64'));
          console.log('SAVED ' + file);
        },
      }),
    );
    ws.on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const list = await getJson('/json/list');
  const page = list.find((t) => t.type === 'page' && /harness2-zs1-build/.test(t.url) && !/dist\/renderer/.test(t.url));
  if (!page) {
    console.error('NO PAGE TARGET');
    process.exit(3);
  }
  const c = await connect(page);

  // 收起欢迎层
  for (let i = 0; i < 20; i++) {
    const v = await c.ev(
      "(() => { const dlg=document.querySelector('[role=\"dialog\"]'); if(!dlg) return 'none'; const b=Array.from(dlg.querySelectorAll('button')).find(x=>/Start ZCode|开始使用/i.test(x.innerText||'')); if(b){b.click();return 'clicked'} return 'dlg'; })()",
    );
    if (v === 'none') break;
    await sleep(500);
  }

  // 主壳基线一张
  await c.shot('zs6-t2-main.png');

  // 开 Help 菜单（真实鼠标事件）
  let pos = null;
  for (let i = 0; i < 10 && !pos; i++) {
    pos = JSON.parse(
      String(
        (await c.ev(
          "(() => { const b=document.querySelector('[data-testid=\"workspace-help-menu-trigger\"]'); if(!b) return 'null'; const r=b.getBoundingClientRect(); if(r.width===0) return 'null'; return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}); })()",
        )) || 'null',
      ),
    );
    if (!pos) await sleep(800);
  }
  if (!pos) {
    console.error('NO HELP TRIGGER');
    process.exit(1);
  }
  let menu = [];
  for (let attempt = 0; attempt < 4 && menu.length === 0; attempt++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
    await c.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: pos.x,
      y: pos.y,
      button: 'left',
      clickCount: 1,
    });
    await c.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: pos.x,
      y: pos.y,
      button: 'left',
      clickCount: 1,
    });
    await sleep(1000);
    menu = JSON.parse(
      (await c.ev(
        "JSON.stringify(Array.from(document.querySelectorAll('[role=\"menuitem\"]')).map(x=>(x.textContent||'').trim()))",
      )) || '[]',
    );
  }
  console.log('HELP_ITEMS=' + JSON.stringify(menu));
  await c.shot('zs6-t2-help-menu.png');

  // 点「关于 Harness2 Desktop」→ 关于窗
  const ap = JSON.parse(
    String(
      (await c.ev(
        "(() => { const mi=Array.from(document.querySelectorAll('[role=\"menuitem\"]')).find(x=>(x.textContent||'').includes('关于 Harness2 Desktop')); if(!mi) return 'null'; const r=mi.getBoundingClientRect(); if(r.width===0) return 'null'; return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}); })()",
      )) || 'null',
    ),
  );
  if (!ap) {
    console.error('NO ABOUT ITEM');
    process.exit(1);
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ap.x, y: ap.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ap.x, y: ap.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ap.x, y: ap.y, button: 'left', clickCount: 1 });

  let done = false;
  for (let i = 0; i < 15 && !done; i++) {
    await sleep(800);
    const list2 = await getJson('/json/list');
    const about = list2.find(
      (t) =>
        t.type === 'page' && t.url.startsWith('data:text/html') && decodeURIComponent(t.url).includes('about-title'),
    );
    if (!about) continue;
    const a = await connect(about);
    await a.shot('zs6-t2-about.png');
    const txt = String((await a.ev("document.body.innerText.replace(/\\s+/g,' ')")) || '');
    console.log('ABOUT=' + txt.slice(0, 160));
    a.ws.close();
    done = true;
  }
  c.ws.close();
  console.log(done ? 'CAPTURE OK' : 'CAPTURE MISSING ABOUT');
  process.exit(done ? 0 : 1);
})().catch((e) => {
  console.error('CAPTURE ERROR:', e);
  process.exit(1);
});
