// ZS6-T0 C 类假入口运行态审计探针（只读遍历：浏览点击，零写操作）
// 用法: node scripts/zs6/audit-sweep.cjs  → stdout 打 JSON（同时写 docs/ai-framework/plans/zs6-audit-dump.json）
// 退出码: 0=采集完成（判定另写审计表）/ 3=连不上壳 / 1=异常
// 纪律: 只连 127.0.0.1:9229 的 page target；只点 section 导航/菜单展开（Escape 收），
// 禁点删除/保存/发送等写操作按钮。
const http = require('http');
const fs = require('fs');
const WebSocket = require('D:/AI_Projects/harness2/node_modules/.pnpm/ws@8.21.3/node_modules/ws');

const OUT = 'D:/AI_Projects/harness2/docs/ai-framework/plans/zs6-audit-dump.json';

function getJson(p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 9229, path: p, timeout: 4000 }, (res) => {
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
      .on('error', reject)
      .on('timeout', function () {
        this.destroy(new Error('timeout'));
      });
  });
}

(async () => {
  let targets;
  try {
    targets = await getJson('/json/list');
  } catch (e) {
    console.error('CANNOT REACH CDP:', e.message);
    process.exit(3);
  }
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
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  ws.on('error', (e) => console.error('WS ERR', e && e.message));

  const results = { ts: new Date().toISOString(), url: page.url, areas: {} };

  ws.on('open', async () => {
    try {
      async function ev(expr) {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
        return r.result?.result?.value;
      }
      // 当前可见 DOM 的入口枚举：testid 元素 + 按钮（文案截断）；scope=选择器前缀或 body
      function dumpExpr(scopeSelector) {
        return `(() => {
          const root = ${JSON.stringify(scopeSelector)} ? document.querySelector(${JSON.stringify(scopeSelector)}) : document;
          if (!root) return JSON.stringify({ error: 'scope-not-found' });
          const out = [];
          const els = root.querySelectorAll('[data-testid], button, [role="button"]');
          const seen = new Set();
          for (const el of els) {
            const tid = el.getAttribute('data-testid') || '';
            const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
            const key = tid || text;
            if (seen.has(key)) continue;
            seen.add(key);
            const r = el.getBoundingClientRect();
            out.push({ testid: tid, text, visible: r.width > 0 && r.height > 0, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' });
          }
          return JSON.stringify(out.filter(x => x.visible));
        })()`;
      }
      async function clickTestId(testid) {
        return ev(
          `(() => { const b = document.querySelector('[data-testid="${testid}"]'); if (!b) return 'missing'; b.click(); return 'clicked'; })()`,
        );
      }
      // Radix 下拉要真实鼠标事件（zs4 探针实证）：按 testid 坐标派发
      async function realClickTestId(testid) {
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
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      // 0. Welcome 弹层若在则收起
      await ev(
        "(() => { const dlg = document.querySelector('[role=\"dialog\"]'); if (!dlg) return 'none'; const b = Array.from(dlg.querySelectorAll('button')).find(x => /Start ZCode|开始使用/i.test(x.innerText||'')); if (b) b.click(); return 'dismissed'; })()",
      );
      await sleep(800);

      // 1. 主壳区域（设置未开时）：侧栏底部/导航轨/composer
      results.areas.main_sidebar = JSON.parse((await ev(dumpExpr('[data-testid^="sidebar"]'))) || '[]');
      // 宽域兜底：直接 body dump 的 testid 清单（截样）
      results.areas.main_body_testids = await ev(
        "JSON.stringify(Array.from(new Set(Array.from(document.querySelectorAll('[data-testid]')).map(e=>e.getAttribute('data-testid')))).sort())",
      ).then((s) => JSON.parse(s || '[]'));

      // 2. 打开设置 → 逐分区枚举 section-nav 后进入 dump
      await clickTestId('task-settings-button');
      await sleep(1200);
      const navs = await ev(
        "JSON.stringify(Array.from(document.querySelectorAll('[data-testid^=\"settings-section-nav-\"]')).map(e=>e.getAttribute('data-testid')))",
      );
      const navList = JSON.parse(navs || '[]');
      results.settings_navs = navList;
      results.areas.settings = {};
      for (const nav of navList) {
        await clickTestId(nav);
        await sleep(900);
        const dump = await ev(dumpExpr('[data-testid="settings-page"]'));
        try {
          results.areas.settings[nav] = JSON.parse(dump || '[]');
        } catch {
          results.areas.settings[nav] = { raw: String(dump).slice(0, 400) };
        }
      }
      // 3. 回主壳开 Help 菜单（Radix=真实鼠标）：reload 归零到初始态最稳
      await send('Page.reload', {});
      await sleep(5000);
      await ev(
        "(() => { const dlg = document.querySelector('[role=\"dialog\"]'); if (!dlg) return 'none'; const b = Array.from(dlg.querySelectorAll('button')).find(x => /Start ZCode|开始使用/i.test(x.innerText||'')); if (b) b.click(); return 'dismissed'; })()",
      );
      await sleep(800);
      const helpCandidates = ['workspace-help-menu-trigger', 'workspace-help-menu-button'];
      for (const hc of helpCandidates) {
        const r = await realClickTestId(hc);
        if (r === 'clicked' && hc !== 'task-settings-button') {
          await sleep(600);
          const menu = await ev(
            "JSON.stringify(Array.from(document.querySelectorAll('[role=\"menuitem\"]')).map(x=>({text:(x.textContent||'').trim().slice(0,50), testid:x.getAttribute('data-testid')||''})))",
          );
          results.areas.help_menu = { trigger: hc, items: JSON.parse(menu || '[]') };
          break;
        }
      }
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await sleep(400);

      // 4. 账号区存在性专项（login trigger / 升级 / 奖励类关键字）
      results.account_probe = await ev(
        `(() => {
          const t = document.body.innerText;
          const hits = {};
          for (const kw of ['登录','账号','升级','Upgrade','Sign in','Login','Pro','奖励','Redeem','兑换']) hits[kw] = t.includes(kw);
          const testids = Array.from(document.querySelectorAll('[data-testid]')).map(e=>e.getAttribute('data-testid')).filter(x=>/login|account|upgrade|billing|reward|plan|subscription/i.test(x));
          return JSON.stringify({ hits, testids });
        })()`,
      ).then((s) => JSON.parse(s || '{}'));

      fs.writeFileSync(OUT, JSON.stringify(results, null, 1), 'utf8');
      const nSections = Object.keys(results.areas.settings || {}).length;
      console.log(
        'DUMP_WRITTEN=' +
          OUT +
          ' sections=' +
          nSections +
          ' body_testids=' +
          (results.areas.main_body_testids || []).length,
      );
      ws.close();
      process.exit(0);
    } catch (e) {
      console.error('ERR', e);
      try {
        fs.writeFileSync(OUT, JSON.stringify(results, null, 1), 'utf8');
      } catch {}
      process.exit(1);
    }
  });
})();
