// ZS4-T6 e2e：侧栏删除轮（归档 → 归档视图恢复 → 再归档 → 删除 + 磁盘消失）。
// 选择器全部对齐 **scratch ZCode 构建（packages/ui，2026-10-21 运行时实测）**，
// 证据：hover 行内按钮 testid="task-archive-<id前22字符>"（task-item testid 同样截断，
// 匹配一律用前缀）；归档视图在 设置页→archives 分区（data-settings-section-nav="archives"，
// ArchiveManagement testid="archive-management"，行="archive-task"[data-task-id 全 id]，
// 单条恢复="archive-unarchive"，单条删除="archive-delete"，组内展开="archive-group-toggle"）。
// Exit codes: 0 pass / 3 wrong instance / 4 前置失败（建会话/行未出现）/
//             5 归档未生效 / 6 恢复未生效 / 7 删除未生效（视图或磁盘）/ 8 确认弹窗缺失 / 1 其他
'use strict';
const http = require('http');
const WebSocket = require('D:/AI_Projects/harness2/node_modules/.pnpm/ws@8.21.3/node_modules/ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SHOT = 'D:/AI_Projects/harness2/docs/screenshots/zs4/sidebar-delete-round.png';
const HOME = process.env.HARNESS2_HOME || os.homedir();
const MARK_A = `zs4删除轮甲-${Date.now()}`;
const MARK_B = `zs4删除轮乙-${Date.now()}`;

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

/** 前缀匹配磁盘会话目录（侧栏 testid 截断，全 id 可能比目录名短/长——两头前缀都试） */
function findSessionDir(idPrefix) {
  const root = path.join(HOME, '.harness2', 'sessions');
  if (!fs.existsSync(root) || !idPrefix) return null;
  for (const g of fs.readdirSync(root, { withFileTypes: true })) {
    if (!g.isDirectory()) continue;
    for (const s of fs.readdirSync(path.join(root, g.name), { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      if (s.name.startsWith(idPrefix) || idPrefix.startsWith(s.name)) return path.join(root, g.name, s.name);
    }
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
      t.type === 'page' && /harness2-zs1-build/.test(t.url || '') && !/packages\/desktop\/dist\/renderer/.test(t.url),
  );
  if (!page) {
    console.error('WRONG INSTANCE/NOT UP');
    process.exit(3);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  ws.onmessage = (raw) => {
    const m = JSON.parse(raw.data.toString());
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function dismissDialogs() {
    for (let i = 0; i < 10; i++) {
      const r = await ev(
        `(() => { const d=document.querySelector('[role="dialog"]'); if(!d) return 'no'; const b=Array.from(d.querySelectorAll('button')).find(x=>/开始使用|Start ZCode/i.test(x.innerText||'')); if(b){b.click();return 'clicked';} return 'other:'+((d.innerText||'').slice(0,10)); })()`,
      );
      if (r === 'clicked' || r === 'no') return;
      await sleep(500);
    }
  }

  /** composer 发送一条消息；返回后等侧栏出现含 MARK 的行。
   *  提交走三重兜底（每重后轮询 8s）：Enter 键（e2e-round 同款序列，冷启动实证可用）→
   *  点 v4-composer-send → rawKeyDown 重清空+重输入再 Enter。
   *  2026-10-22 实测：脏草稿环境 keyDown 清空无效需 rawKeyDown；Enter 在部分状态不提交。 */
  async function sendAndAwaitRow(mark) {
    await ev(
      `(() => { const b=document.querySelector('[data-testid="task-new-button"]'); if(b){b.click();return 1;} return 0; })()`,
    );
    await sleep(1200);
    await dismissDialogs();
    const clearComposer = async () => {
      const ok = await ev(
        `(() => { const c=document.querySelector('[contenteditable=true]'); if(c) c.focus(); return !!c; })()`,
      );
      if (!ok) console.log('WARN_NO_COMPOSER=1');
      await sleep(150);
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
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
        type: 'rawKeyDown',
        key: 'Delete',
        code: 'Delete',
        windowsVirtualKeyCode: 46,
      });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await sleep(200);
    };
    const waitRow = async (seconds) => {
      for (let i = 0; i < seconds * 2; i++) {
        await sleep(500);
        const seen = await ev(
          `(() => { const el=Array.from(document.querySelectorAll('[data-testid^="task-item-"]')).find(i=>(i.innerText||'').includes(${JSON.stringify(mark)})); return el? el.getAttribute('data-testid') : null; })()`,
        );
        if (seen) return String(seen).replace(/^task-item-/, '');
      }
      return null;
    };
    await clearComposer();
    await send('Input.insertText', { text: mark });
    await sleep(400);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    let id = await waitRow(8);
    if (!id) {
      console.log('RETRY_VIA_SEND_BUTTON=1');
      await ev(
        `(() => { const b=document.querySelector('[data-testid="v4-composer-send"]'); if(b){b.click();return 1;} return 0; })()`,
      );
      id = await waitRow(8);
    }
    if (!id) {
      console.log('RETRY_FULL_RETYPE=1');
      const dump = await ev(
        `(() => { const c=document.querySelector('[contenteditable=true]'); return c? JSON.stringify((c.innerText||'').slice(0,40)) : 'no-composer'; })()`,
      );
      console.log('COMPOSER_STUCK=' + dump);
      // 冷启动 landing 竞态（sb10 实证：首条 Enter/send 均不提交，第二条正常）——
      // 先点新建任务强制切 draft 会话视图，再 clear+type+send
      await ev(
        `(() => { const b=document.querySelector('[data-testid="task-new-button"]'); if(b){b.click();return 1;} return 0; })()`,
      );
      await sleep(1200);
      await dismissDialogs();
      await clearComposer();
      await send('Input.insertText', { text: mark });
      await sleep(400);
      await ev(
        `(() => { const b=document.querySelector('[data-testid="v4-composer-send"]'); if(b){b.click();return 1;} return 0; })()`,
      );
      id = await waitRow(20);
    }
    return id;
  }

  /** 侧车落盘真值（T2 session-meta.json）：证明 UI 动作确实打到了 adapter 写面 */
  function diskArchived(idPrefix) {
    const dir = findSessionDir(idPrefix);
    if (!dir) return 'dir-missing';
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'session-meta.json'), 'utf8'));
      return meta.archived === true;
    } catch {
      return false;
    }
  }

  /** 归档：主路径=右键菜单「归档任务」（dump#1 实证菜单含该项，直发 archive mutation，
   *  无二段确认）；兜底=hover 二段确认（TaskListItem.tsx:331-346/140-162）。
   *  判据：侧车落盘（写面真值）必须达成；行从主列表消失（硬刷新后）= 'ok'，
   *  落盘达成但 UI 未刷新 = 'ui-stale'（登记刷新缺口，不假绿不假红）。
   *  返回 'ok' | 'ui-stale' | 'row-missing' | 'failed:<原因>'。 */
  async function hoverArchive(mark, idPrefix) {
    // 路径 A：右键菜单
    for (let attempt = 0; attempt < 3; attempt++) {
      const rect = await ev(
        `(() => { const el=Array.from(document.querySelectorAll('[data-testid^="task-item-"]')).find(i=>(i.innerText||'').includes(${JSON.stringify(mark)})); if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}); })()`,
      );
      if (!rect) return 'row-missing';
      const { x, y } = JSON.parse(rect);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
      let menuClicked = 'no-menu';
      for (let i = 0; i < 10; i++) {
        await sleep(300);
        menuClicked = await ev(
          `(() => { const items=Array.from(document.querySelectorAll('[role="menuitem"]')); const b=items.find(i=>/^归档任务/.test((i.innerText||'').trim())); if(!b) return 'no-item'; b.click(); return 'ok'; })()`,
        );
        if (menuClicked === 'ok') break;
      }
      if (menuClicked === 'ok') {
        // 权威判据 1：侧车落盘（写面真值，UI 刷新时机不敏感）
        let diskOk = false;
        for (let i = 0; i < 10; i++) {
          await sleep(400);
          if (diskArchived(idPrefix) === true) {
            diskOk = true;
            break;
          }
        }
        // 权威判据 2：强制 tab 刷新后行消失（UI 判据）
        if (diskOk && !(await rowPresent(mark, { hard: true }))) return 'ok';
        return diskOk ? 'ui-stale' : 'failed:menu-noop-disk';
      }
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(400);
    }
    // 路径 B：hover 二段确认（兜底）
    for (let round = 0; round < 4; round++) {
      const rect = await ev(
        `(() => { const el=Array.from(document.querySelectorAll('[data-testid^="task-item-"]')).find(i=>(i.innerText||'').includes(${JSON.stringify(mark)})); if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}); })()`,
      );
      if (!rect) return 'row-missing';
      const { x, y } = JSON.parse(rect);
      for (let i = 0; i < 8; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.max(2, x - 80 + i * 10), y: y + (i % 2) });
        await sleep(150);
      }
      await sleep(400);
      const first = await ev(
        `(() => { const el=Array.from(document.querySelectorAll('[data-testid^="task-item-"]')).find(i=>(i.innerText||'').includes(${JSON.stringify(mark)})); const b=el&&el.querySelector('[data-testid^="task-archive-"]'); if(!b) return 'absent'; b.click(); return 'first'; })()`,
      );
      if (first !== 'first') {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
        await sleep(500);
        continue;
      }
      // 等 confirming 态出现（destructive「确认」按钮替换原按钮）
      let confirmed = 'timeout';
      for (let i = 0; i < 8; i++) {
        await sleep(350);
        confirmed = await ev(
          `(() => { const el=Array.from(document.querySelectorAll('[data-testid^="task-item-"]')).find(i=>(i.innerText||'').includes(${JSON.stringify(mark)})); if(!el) return 'row-gone?'; const bs=Array.from(el.querySelectorAll('button')); const c=bs.find(b=>/确认|Confirm/i.test((b.innerText||'').trim())); if(!c) return 'waiting'; c.click(); return 'ok'; })()`,
        );
        if (confirmed === 'row-gone?') return 'ok'; // 行已消失 = 已归档（二段确认不存在时）
        if (confirmed === 'ok' || confirmed.startsWith('row-gone')) break;
      }
      if (confirmed === 'ok') {
        let diskOk = false;
        for (let i = 0; i < 10; i++) {
          await sleep(400);
          if (diskArchived(idPrefix) === true) {
            diskOk = true;
            break;
          }
        }
        if (diskOk && !(await rowPresent(mark, { hard: true }))) return 'ok';
        return diskOk ? 'ui-stale' : 'failed:hover-noop-disk';
      }
    }
    return 'failed:archive-btn-absent';
  }

  /** 退出设置页焦点：点一个任务行激活会话 tab（sb11 实证设置页开着时侧栏右键失灵；
   *  点行=切 tab 回会话视图，侧栏恢复交互，快照路径此前已验证）。 */
  async function closeSettings() {
    await ev(
      `(() => { const el=Array.from(document.querySelectorAll('[data-testid^="task-item-"]')).find(i=>(i.innerText||'').includes(${JSON.stringify(MARK_B)}))||Array.from(document.querySelectorAll('[data-testid^="task-item-"]')).find(i=>(i.innerText||'').includes(${JSON.stringify(MARK_A)}))||document.querySelector('[data-testid^="task-item-"]'); if(el){const b=el.querySelector('button')||el; b.click(); return 1;} return 0; })()`,
    );
    await sleep(1500);
    const r = await ev(
      `(() => { const el=Array.from(document.querySelectorAll('[data-testid^="task-item-"]'))[0]; if(!el) return 0; el.scrollIntoView({block:'center'}); const s=getComputedStyle(el); return el.getBoundingClientRect().width>0?1:0; })()`,
    );
    return r;
  }

  /** 强制列表刷新：切换任务/项目 tab 再切回（用户级动作，触发 UI refetch readTree）。
   *  背景：adapter 不广播 controller 帧，mutation 后主列表行消失依赖刷新时机（sb12/sb13
   *  对照实证 flaky）——权威判据=归档视图/磁盘（写面），UI 消失用刷新兜底后二次判。 */
  async function forceListRefresh() {
    await ev(
      `(() => { const secs=Array.from(document.querySelectorAll('[data-testid="task-item-"]')).length; const proj=document.querySelector('button[aria-label="项目"]'); if(proj){proj.click();return 'proj';} return 'none'; })()`,
    );
    await sleep(1200);
    await ev(
      `(() => { const task=document.querySelector('button[aria-label="任务"]'); if(task){task.click();return 'task';} return 'none'; })()`,
    );
    await sleep(1500);
  }

  /** 主列表可见性（先探，未命中点显示更多；带 tab 切换强制刷新的二次判） */
  async function rowPresent(mark, opts = {}) {
    const probe = async () =>
      ev(
        `!!Array.from(document.querySelectorAll('[data-testid^="task-item-"]')).find(i=>(i.innerText||'').includes(${JSON.stringify(mark)}))`,
      );
    if (await probe()) return true;
    if (opts.hard) {
      await forceListRefresh();
      if (await probe()) return true;
    }
    await ev(
      `(() => { const b=Array.from(document.querySelectorAll('button,[role="button"]')).find(x=>/显示更多/.test((x.innerText||'').trim())); if(b){b.click();return 1;} return 0; })()`,
    );
    for (let i = 0; i < 12; i++) {
      if (await probe()) return true;
      await sleep(500);
    }
    return false;
  }

  /** 打开 设置→归档管理；展开组；返回 archive-task 行列表 [{id,title}] */
  async function openArchives() {
    await ev(
      `(() => { const b=document.querySelector('[data-testid="task-settings-button"]'); if(b)b.click(); return !!b; })()`,
    );
    await sleep(1800);
    await ev(
      `(() => { const b=document.querySelector('[data-settings-section-nav="archives"]'); if(b)b.click(); return !!b; })()`,
    );
    await sleep(1500);
    const ok = await ev(`!!document.querySelector('[data-testid="archive-management"]')`);
    if (!ok) return false;
    await ev(
      `(() => { const t=document.querySelectorAll('[data-testid="archive-group-toggle"]'); t.forEach(x=>x.click()); return t.length; })()`,
    );
    await sleep(800);
    return true;
  }

  function archiveRowsDump() {
    return ev(
      `JSON.stringify(Array.from(document.querySelectorAll('[data-testid="archive-task"]')).map(el=>({id:el.getAttribute('data-task-id'),t:(el.innerText||'').replace(/\\s+/g,' ').slice(0,40)})))`,
    );
  }

  async function actOnArchiveTask(idPrefix, which) {
    return ev(
      `(() => { const row=Array.from(document.querySelectorAll('[data-testid="archive-task"]')).find(el=>(el.getAttribute('data-task-id')||'').startsWith(${JSON.stringify(idPrefix.slice(0, 22))})||${JSON.stringify(idPrefix)}.startsWith(el.getAttribute('data-task-id')||'')); if(!row) return 'no-row'; const b=row.querySelector('[data-testid="${which}"]'); if(!b) return 'no-btn'; b.click(); return 'ok'; })()`,
    );
  }

  /** 点 destructive 确认按钮：dump dialog 按钮文本，点「删除」 */
  async function confirmDialog() {
    let last = '';
    for (let i = 0; i < 10; i++) {
      const r = await ev(
        `(() => { const dlg=document.querySelector('[role="alertdialog"],[role="dialog"]'); if(!dlg) return 'no-dialog'; const bs=Array.from(dlg.querySelectorAll('button')); const del=bs.find(b=>/^删除|Delete$/i.test((b.innerText||'').trim())); if(del){del.click();return 'clicked';} return 'buttons:'+JSON.stringify(bs.map(b=>(b.innerText||'').trim()).slice(0,6)); })()`,
      );
      if (r === 'clicked') return true;
      last = r;
      await sleep(400);
    }
    console.error('CONFIRM DIALOG FAIL: ' + last);
    return false;
  }

  try {
    await dismissDialogs();
    // 等 composer 挂载（冷启动欢迎层关闭后才有）
    let cap = 'no-composer';
    for (let i = 0; i < 30; i++) {
      cap = await ev(`document.querySelector('[contenteditable=true]') ? 'input-capable' : 'no-composer'`);
      if (cap === 'input-capable') break;
      await dismissDialogs();
      await sleep(500);
    }
    console.log('COMPOSER=' + cap);
    if (cap !== 'input-capable') {
      console.error('PRECONDITION: composer never mounted');
      process.exit(4);
    }
    await sleep(800);

    // ── 前置：建两个会话 ──
    const idA = await sendAndAwaitRow(MARK_A);
    const idB = await sendAndAwaitRow(MARK_B);
    console.log('SESSIONS=' + JSON.stringify({ idA, idB }));
    if (!idA || !idB) {
      console.error('PRECONDITION: session rows not created');
      process.exit(4);
    }
    if (!findSessionDir(idA)) {
      console.error('PRECONDITION: disk dir for A not found (prefix ' + idA + ')');
      process.exit(4);
    }

    // ── 1. 归档 A → 侧车落盘 + 主列表消失（硬刷新判据） ──
    const arch = await hoverArchive(MARK_A, idA);
    console.log('ARCHIVE_CLICK=' + arch);
    if (arch !== 'ok' && arch !== 'ui-stale') process.exit(5);
    if (arch === 'ui-stale') console.log('OBSERVE_UI_STALE=1'); // 写面已生效、UI 刷新滞后——登记缺口不假绿
    if (diskArchived(idA) !== true) {
      console.error('AFTER ARCHIVE sidecar not archived');
      process.exit(5);
    }
    console.log('ARCHIVED_DISK=ok');

    // ── 2. 归档视图恢复 A → 主列表回来 ──
    if (!(await openArchives())) {
      console.error('archive-management section not found');
      process.exit(6);
    }
    console.log('ARCHIVE_ROWS=' + (await archiveRowsDump()));
    const inArchiveView = await ev(
      `(() => { const row=Array.from(document.querySelectorAll('[data-testid="archive-task"]')).find(el=>(el.getAttribute('data-task-id')||'').startsWith(${JSON.stringify(idA.slice(0, 22))})); return !!row; })()`,
    );
    console.log('A_IN_ARCHIVE_VIEW=' + inArchiveView);
    if (!inArchiveView) process.exit(6);
    const un = await actOnArchiveTask(idA, 'archive-unarchive');
    console.log('UNARCHIVE=' + un);
    if (un !== 'ok') process.exit(6);
    for (let i = 0; i < 10; i++) {
      await sleep(400);
      if (diskArchived(idA) !== true) break;
    }
    if (diskArchived(idA) === true) {
      console.error('AFTER UNARCHIVE sidecar still archived');
      process.exit(6);
    }
    console.log('RESTORED_DISK=ok');
    console.log('SETTINGS_CLOSE_BUTTONS=' + (await closeSettings()));
    if (!(await rowPresent(MARK_A, { hard: true }))) {
      console.error('AFTER UNARCHIVE not back in main list (post-close)');
      process.exit(6);
    }
    console.log('RESTORED_TO_MAIN=ok');

    // ── 3. 再归档 A → 归档视图删除 → 确认 → 磁盘消失 ──
    const arch2 = await hoverArchive(MARK_A, idA);
    if (arch2 !== 'ok' && arch2 !== 'ui-stale') {
      console.error('re-archive failed: ' + arch2);
      process.exit(5);
    }
    if (diskArchived(idA) !== true) {
      console.error('re-archive disk not effective: ' + arch2);
      process.exit(5);
    }
    console.log('REARCHIVE_DISK=ok (' + arch2 + ')');
    if (!(await openArchives())) process.exit(7);
    const del = await actOnArchiveTask(idA, 'archive-delete');
    console.log('DELETE_CLICK=' + del);
    if (del !== 'ok') process.exit(7);
    const confirmed = await confirmDialog();
    if (!confirmed) process.exit(8);
    await sleep(2000);

    const dirA = findSessionDir(idA);
    const diskGone = !dirA;
    const stillInArchive = await ev(
      `(() => { const row=Array.from(document.querySelectorAll('[data-testid="archive-task"]')).find(el=>(el.getAttribute('data-task-id')||'').startsWith(${JSON.stringify(idA.slice(0, 22))})); return !!row; })()`,
    );
    console.log('DISK_GONE=' + diskGone + ' IN_ARCHIVE_VIEW=' + stillInArchive);
    if (!diskGone || stillInArchive) process.exit(7);

    // B 必须健在（误删保护）
    if (!(await rowPresent(MARK_B))) {
      console.error('REGRESSION: session B disappeared');
      process.exit(7);
    }

    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
    console.log(
      'RESULT=' +
        JSON.stringify({ status: 'pass', sessionA: idA, diskGone: true, restoredThenDeleted: true, screenshot: SHOT }),
    );
    ws.close();
    process.exit(0);
  } catch (e) {
    console.error('UNEXPECTED=' + (e && e.message ? e.message : String(e)));
    try {
      ws.close();
    } catch {}
    process.exit(1);
  }
})();
