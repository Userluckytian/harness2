// ZS4 e2e sidebar delete round: archive -> restore -> delete, disk dir must disappear.
// Exit codes: 0 pass / 3 wrong instance / 4 no session rows / 5 archive not effective /
//             6 restore not effective / 7 delete not effective / 8 confirm missing / 1 other
'use strict';
const http = require('http');
const WebSocket = require('D:/AI_Projects/harness2/node_modules/.pnpm/ws@8.21.3/node_modules/ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SHOT = 'D:/AI_Projects/harness2/docs/screenshots/zs4/sidebar-delete-round.png';
const HOME = process.env.HARNESS2_HOME || os.homedir();

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

function findSessionDir(id) {
  const root = path.join(HOME, '.harness2', 'sessions');
  if (!fs.existsSync(root)) return null;
  let groups = [];
  try {
    groups = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const p = path.join(root, g.name, id);
    if (fs.existsSync(p)) return p;
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

      // create two sessions via new-task button
      for (let n = 0; n < 2; n++) {
        await send('Runtime.evaluate', {
          expression:
            "(() => { const b = document.querySelector('button[data-testid=\"sidebar-tasks-new\"]'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()",
        });
        await new Promise((r) => setTimeout(r, 1200));
        await dismissWelcome();
      }

      // capture session ids
      let ids = [];
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const v = await ev(
          "JSON.stringify(Array.from(document.querySelectorAll('[data-session-id]')).map(x=>x.getAttribute('data-session-id')))",
        );
        try {
          ids = JSON.parse(v || '[]');
        } catch {
          ids = [];
        }
        if (ids.length >= 2) break;
      }
      console.log('SESSION_IDS=' + JSON.stringify(ids));
      if (ids.length < 2) {
        console.error('NO SESSION ROWS');
        process.exit(4);
      }
      const targetId = ids[0];
      const targetDir = findSessionDir(targetId);
      console.log('TARGET_DIR=' + String(targetDir));

      // archive target via context menu
      await ev(
        `(() => { const b = document.querySelector('button[data-session-id="${targetId}"]'); if (!b) return 'missing-row'; b.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true,button:2})); return 'dispatched'; })()`,
      );
      let archiveItem = null;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const v = await ev('!!document.querySelector(\'[data-menu-action="archive"]\')');
        if (v === true) {
          archiveItem = true;
          break;
        }
      }
      if (!archiveItem) {
        console.error('ARCHIVE MENU MISSING');
        process.exit(5);
      }
      await ev(
        '(() => { const b = document.querySelector(\'[data-menu-action="archive"]\'); if (b) { b.click(); return true; } return false; })()',
      );
      // wait row disappears from active list
      let archivedFromActive = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev(`!document.querySelector('button[data-session-id="${targetId}"]')`);
        if (v === true) {
          archivedFromActive = true;
          break;
        }
      }
      console.log('ARCHIVED_FROM_ACTIVE=' + archivedFromActive);
      if (!archivedFromActive) {
        console.error('ARCHIVE NOT EFFECTIVE');
        process.exit(5);
      }

      // open archived view
      await ev(
        '(() => { const b = document.querySelector(\'button[data-testid="sidebar-archived-toggle"]\'); if (b) { b.click(); return true; } return false; })()',
      );
      let inArchivedView = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev(`!!document.querySelector('button[data-session-id="${targetId}"]')`);
        if (v === true) {
          inArchivedView = true;
          break;
        }
      }
      console.log('IN_ARCHIVED_VIEW=' + inArchivedView);
      if (!inArchivedView) {
        console.error('ARCHIVE VIEW NOT SHOWING');
        process.exit(6);
      }

      // restore one (target) back to main list to test restore
      await ev(
        `(() => { const b = document.querySelector('button[data-session-id="${targetId}"]'); if (!b) return 'missing-row'; b.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true,button:2})); return 'dispatched'; })()`,
      );
      let unarchiveItem = null;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const v = await ev('!!document.querySelector(\'[data-menu-action="unarchive"]\')');
        if (v === true) {
          unarchiveItem = true;
          break;
        }
      }
      if (!unarchiveItem) {
        console.error('UNARCHIVE MENU MISSING');
        process.exit(6);
      }
      await ev(
        '(() => { const b = document.querySelector(\'[data-menu-action="unarchive"]\'); if (b) { b.click(); return true; } return false; })()',
      );
      // after unarchive, archived toggle still on; row should disappear from archived view
      let restored = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev(`!document.querySelector('button[data-session-id="${targetId}"]')`);
        if (v === true) {
          restored = true;
          break;
        }
      }
      console.log('RESTORED_FROM_ARCHIVED=' + restored);
      if (!restored) {
        console.error('RESTORE NOT EFFECTIVE');
        process.exit(6);
      }

      // re-archive target so we can test delete in archived view
      // toggle back to active view first
      await ev(
        '(() => { const b = document.querySelector(\'button[data-testid="sidebar-archived-toggle"]\'); if (b) { b.click(); return true; } return false; })()',
      );
      await new Promise((r) => setTimeout(r, 800));
      // find row in active list again
      let activeAgain = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev(`!!document.querySelector('button[data-session-id="${targetId}"]')`);
        if (v === true) {
          activeAgain = true;
          break;
        }
      }
      if (!activeAgain) {
        console.error('RESTORE NOT REFLECTED IN ACTIVE LIST');
        process.exit(6);
      }
      // archive again
      await ev(
        `(() => { const b = document.querySelector('button[data-session-id="${targetId}"]'); if (!b) return 'missing-row'; b.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true,button:2})); return 'dispatched'; })()`,
      );
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const v = await ev('!!document.querySelector(\'[data-menu-action="archive"]\')');
        if (v === true) break;
      }
      await ev(
        '(() => { const b = document.querySelector(\'[data-menu-action="archive"]\'); if (b) { b.click(); return true; } return false; })()',
      );
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev(`!document.querySelector('button[data-session-id="${targetId}"]')`);
        if (v === true) break;
      }
      // open archived view
      await ev(
        '(() => { const b = document.querySelector(\'button[data-testid="sidebar-archived-toggle"]\'); if (b) { b.click(); return true; } return false; })()',
      );
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev(`!!document.querySelector('button[data-session-id="${targetId}"]')`);
        if (v === true) break;
      }

      // delete archived target
      await ev(
        `(() => { const b = document.querySelector('button[data-session-id="${targetId}"]'); if (!b) return 'missing-row'; b.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true,button:2})); return 'dispatched'; })()`,
      );
      let deleteItem = null;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const v = await ev('!!document.querySelector(\'[data-menu-action="delete"]\')');
        if (v === true) {
          deleteItem = true;
          break;
        }
      }
      if (!deleteItem) {
        console.error('DELETE MENU MISSING');
        process.exit(8);
      }
      await ev(
        '(() => { const b = document.querySelector(\'[data-menu-action="delete"]\'); if (b) { b.click(); return true; } return false; })()',
      );
      // confirm dialog
      let confirmShown = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const v = await ev('!!document.querySelector(\'[data-testid="confirm-dialog-confirm"]\')');
        if (v === true) {
          confirmShown = true;
          break;
        }
      }
      if (!confirmShown) {
        console.error('CONFIRM DIALOG MISSING');
        process.exit(8);
      }
      // verify confirm label contains delete
      const label = await ev("document.querySelector('[data-testid=\"confirm-dialog-confirm\"]')?.textContent || ''");
      console.log('CONFIRM_LABEL=' + JSON.stringify(label));
      await ev(
        '(() => { const b = document.querySelector(\'[data-testid="confirm-dialog-confirm"]\'); if (b) { b.click(); return true; } return false; })()',
      );
      // wait row disappears
      let deletedFromView = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const v = await ev(`!document.querySelector('button[data-session-id="${targetId}"]')`);
        if (v === true) {
          deletedFromView = true;
          break;
        }
      }
      console.log('DELETED_FROM_VIEW=' + deletedFromView);
      if (!deletedFromView) {
        console.error('DELETE NOT EFFECTIVE IN VIEW');
        process.exit(7);
      }

      // disk check：轮询等异步落盘删除，超时仍存则 exit 7
      for (let i = 0; i < 20; i++) {
        if (!findSessionDir(targetId)) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const stillExists = !!findSessionDir(targetId);
      console.log('DISK_STILL_EXISTS=' + stillExists);
      if (stillExists) {
        console.error('DISK NOT DELETED');
        process.exit(7);
      }

      fs.mkdirSync('D:/AI_Projects/harness2/docs/screenshots/zs4', { recursive: true });
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(shot.result.data, 'base64');
      fs.writeFileSync(SHOT, buf);
      console.log('SCREENSHOT=' + SHOT + ' bytes=' + buf.length);

      ws.close();
      const result = {
        status: 'pass',
        deletedId: targetId,
        diskGone: !stillExists,
        viewRemoved: deletedFromView,
      };
      console.log('RESULT=' + JSON.stringify(result));
      process.exit(0);
    } catch (e) {
      console.error('ERR', e);
      process.exit(1);
    }
  });
})();
