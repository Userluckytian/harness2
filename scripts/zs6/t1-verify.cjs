// ZS6-T1 隐藏运行态验证门（红线⑩回归：假入口消失 / 真实能力保留）
// 用法: node scripts/zs6/t1-verify.cjs ；exit 0=PASS / 3=连不上壳 / 1=FAIL
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

  // 1. 进设置（重试至 section-nav 出现）
  let navs = [];
  for (let i = 0; i < 30; i++) {
    await ev(
      '(() => { const b=document.querySelector(\'button[data-testid="task-settings-button"]\'); if(b){b.click();return 1} return 0; })()',
    );
    await sleep(900);
    navs = JSON.parse(
      (await ev(
        "JSON.stringify(Array.from(document.querySelectorAll('[data-testid^=\"settings-section-nav-\"]')).map(e=>e.getAttribute('data-testid')))",
      )) || '[]',
    );
    if (navs.length > 0) break;
  }
  const usageHidden = !navs.includes('settings-section-nav-usage');
  const remoteHidden = !navs.includes('settings-section-nav-remoteDevices');
  console.log('SECTIONS=' + navs.length + ' usage_hidden=' + usageHidden + ' remote_hidden=' + remoteHidden);

  // 2. modelProvider 区文本：Z.ai/Start Plan/预设标题消失，添加供应商保留
  await ev(
    '(() => { const b=document.querySelector(\'[data-testid="settings-section-nav-modelProvider"]\'); if(b) b.click(); return 1; })()',
  );
  await sleep(1800);
  const mp = String(
    (await ev(
      "(() => { const t=document.querySelector('[data-testid=\"settings-page\"]'); return t? t.innerText.replace(/\\s+/g,' ').slice(0,4000):'NO'; })()",
    )) || '',
  );
  const zaiGone = !/Z\.ai|连接 Z/.test(mp);
  const startPlanGone = !mp.includes('Start Plan');
  const presetTitleGone = !/预设/.test(mp);
  const addProviderKept = mp.includes('添加供应商');
  console.log(
    'zai_gone=' +
      zaiGone +
      ' startplan_gone=' +
      startPlanGone +
      ' preset_title_gone=' +
      presetTitleGone +
      ' add_provider=' +
      addProviderKept,
  );

  // 3. 回主壳开 Help（真实鼠标事件）
  await ev(
    '(() => { const b=document.querySelector(\'[data-testid="settings-back-button"]\'); if(b) b.click(); return 1; })()',
  );
  await sleep(1200);
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
    console.log('HELP_TRIGGER_MISSING');
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
  const keepReal = menu.some((x) => x.includes('资源管理器')) && menu.some((x) => x.includes('导出日志'));
  const vendorGone = !menu.some((x) => /文档|社群|上报|漏洞|需求|检查更新/.test(x));
  console.log('help_keep=' + keepReal + ' help_vendor_gone=' + vendorGone);

  const pass =
    navs.length > 0 &&
    usageHidden &&
    remoteHidden &&
    zaiGone &&
    startPlanGone &&
    presetTitleGone &&
    addProviderKept &&
    keepReal &&
    vendorGone;
  console.log('GATE=' + (pass ? 'PASS' : 'FAIL'));
  ws.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error('ERR', e && e.message);
  process.exit(1);
});
