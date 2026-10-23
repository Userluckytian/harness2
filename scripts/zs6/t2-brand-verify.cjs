// ZS6-T2 品牌运行态验证门（装配面证据：任务栏/标题/关于页/Help 菜单标签）
// 用法: node scripts/zs6/t2-brand-verify.cjs ；exit 0=PASS / 3=连不上壳 / 1=FAIL
const http = require('http');
const WebSocket = require('D:/AI_Projects/harness2/node_modules/.pnpm/ws@8.21.3/node_modules/ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

(async () => {
  let list;
  try {
    list = await getJson('/json/list');
  } catch (e) {
    console.error('CANNOT REACH CDP:', e.message);
    process.exit(3);
  }
  const page = list.find(
    (t) => t.type === 'page' && /localhost:5174|harness2-zs1-build/.test(t.url) && !/dist\/renderer/.test(t.url),
  );
  if (!page) {
    console.error('NO PAGE TARGET');
    process.exit(3);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  let id = 0;
  const pend = new Map();
  const send = (method, params) =>
    new Promise((resolve) => {
      const i = ++id;
      pend.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  });
  await new Promise((r) => ws.on('open', r));
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  // 0. 欢迎层若在场则收起
  for (let i = 0; i < 20; i++) {
    const v = await ev(
      "(() => { const dlg=document.querySelector('[role=\"dialog\"]'); if(!dlg) return 'none'; const b=Array.from(dlg.querySelectorAll('button')).find(x=>/Start ZCode|开始使用/i.test(x.innerText||'')); if(b){b.click();return 'clicked'} return 'dlg'; })()",
    );
    if (v === 'none') break;
    await sleep(500);
  }

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''));
  };

  // 1. P11：壳标题 = Harness2 Desktop（Electron 传播到窗口/任务栏）
  const title = String((await ev('document.title')) || '');
  check('P11_page_title', title === 'Harness2 Desktop', 'document.title=' + JSON.stringify(title));

  // 2. P10：窗内 Help 下拉「关于 Harness2 Desktop」（真实鼠标事件开菜单）
  let pos = null;
  for (let i = 0; i < 10 && !pos; i++) {
    pos = JSON.parse(
      String(
        (await ev(
          "(() => { const b=document.querySelector('[data-testid=\"workspace-help-menu-trigger\"]'); if(!b) return 'null'; const r=b.getBoundingClientRect(); if(r.width===0) return 'null'; return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}); })()",
        )) || 'null',
      ),
    );
    if (!pos) await sleep(800);
  }
  if (!pos) {
    check('P10_help_menu', false, 'HELP_TRIGGER_MISSING');
    console.log('GATE=FAIL');
    process.exit(1);
  }
  let menu = [];
  for (let attempt = 0; attempt < 4 && menu.length === 0; attempt++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: pos.x,
      y: pos.y,
      button: 'left',
      clickCount: 1,
    });
    await sleep(1000);
    menu = JSON.parse(
      (await ev(
        "JSON.stringify(Array.from(document.querySelectorAll('[role=\"menuitem\"]')).map(x=>(x.textContent||'').trim()))",
      )) || '[]',
    );
  }
  console.log('HELP_ITEMS=' + JSON.stringify(menu));
  check(
    'P10_help_about_label',
    menu.some((x) => x.includes('关于 Harness2 Desktop')),
  );
  check('P10_no_old_label', !menu.some((x) => /关于 ZCode(?! )/.test(x) && !x.includes('Harness2')));
  // 旧 ZCode 字样彻底不在可见菜单里（关于项也已是新名）
  check('menu_no_zcode', !menu.some((x) => x.includes('ZCode')));

  // 3. 点「关于 Harness2 Desktop」→ 关于窗（data URL 独立 target）
  const aboutPos = JSON.parse(
    String(
      (await ev(
        "(() => { const mi=Array.from(document.querySelectorAll('[role=\"menuitem\"]')).find(x=>(x.textContent||'').includes('关于 Harness2 Desktop')); if(!mi) return 'null'; const r=mi.getBoundingClientRect(); if(r.width===0) return 'null'; return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}); })()",
      )) || 'null',
    ),
  );
  if (!aboutPos) {
    check('P8_about_window', false, 'ABOUT_ITEM_NO_RECT');
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: aboutPos.x, y: aboutPos.y });
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: aboutPos.x,
      y: aboutPos.y,
      button: 'left',
      clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: aboutPos.x,
      y: aboutPos.y,
      button: 'left',
      clickCount: 1,
    });
    let aboutText = '';
    let aboutTitle = '';
    for (let i = 0; i < 15; i++) {
      await sleep(800);
      const list2 = await getJson('/json/list');
      const about = list2.find(
        (t) =>
          t.type === 'page' && t.url.startsWith('data:text/html') && decodeURIComponent(t.url).includes('about-title'),
      );
      if (!about) continue;
      const ws2 = new WebSocket(about.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
      const pend2 = new Map();
      ws2.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.id && pend2.has(m.id)) {
          pend2.get(m.id)(m);
          pend2.delete(m.id);
        }
      });
      await new Promise((r) => ws2.on('open', r));
      const ev2 = (e) =>
        new Promise((res) => {
          const ii = ++id;
          pend2.set(ii, res);
          ws2.send(
            JSON.stringify({ id: ii, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true } }),
          );
        }).then((r) => (r.result && r.result.result ? r.result.result.value : undefined));
      aboutText = String((await ev2("document.body.innerText.replace(/\\s+/g,' ')")) || '');
      aboutTitle = String((await ev2('document.title')) || '');
      ws2.close();
      if (aboutText.length > 10) break;
    }
    console.log('ABOUT_TEXT=' + aboutText.slice(0, 300));
    check(
      'P8_about_window_brand',
      aboutText.includes('Harness2 Desktop') && aboutText.includes('harness2'),
      'about_title=' + JSON.stringify(aboutTitle),
    );
    check('P8_about_window_no_old', aboutText.length > 0 && !aboutText.includes('ZCode'));
  }

  // 4. /json/version 的 Browser 字段（Electron 运行时身份，仅记录不判定）
  try {
    const v = await getJson('/json/version');
    console.log('CDP_BROWSER=' + v.Browser);
  } catch {}

  const failed = results.filter((r) => !r.ok);
  console.log('CHECKS=' + results.length + ' FAILED=' + failed.length);
  console.log(failed.length === 0 ? 'GATE=PASS' : 'GATE=FAIL');
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('VERIFY ERROR:', e);
  process.exit(1);
});
