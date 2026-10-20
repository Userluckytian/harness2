// ZS2 e2e round: CDP-driven single conversation round.
// Usage: node scripts/zs2/e2e-round.cjs [--text "..."] [--screenshot path]
const http = require('http');
const WebSocket = require('D:/AI_Projects/harness2-zs1-build/ZCode/node_modules/ws');
const fs = require('fs');

const TEXT = (process.argv.includes('--text')
  ? process.argv[process.argv.indexOf('--text') + 1]
  : '请用三句话介绍你自己');

const SHOT = process.argv.includes('--screenshot')
  ? process.argv[process.argv.indexOf('--screenshot') + 1]
  : 'D:/AI_Projects/harness2/docs/screenshots/zs2/e2e-round.png';

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9229, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const ROW_SEL = '[data-testid^="v4-row-"]';

(async () => {
  for (let i = 0; i < 60; i++) {
    try { await getJson('/json/list'); break; } catch (e) { await new Promise(r => setTimeout(r, 1000)); }
  }
const targets = await getJson('/json/list');
const page = targets.find((t) => t.type === 'page' && /localhost:5174|127\.0\.0\.1:5174|harness2-zs1-build/.test(t.url) && !/packages\/desktop\/dist\/renderer/.test(t.url));
if (!page) { console.error('WRONG INSTANCE/NOT UP'); process.exit(3); }
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  ws.on('open', async () => {
    try {
      // dump message container DOM structure (evidence for stable selector)
      const dump = await send('Runtime.evaluate', { expression: `(() => { const rows = document.querySelectorAll('${ROW_SEL}'); return JSON.stringify({selector:'${ROW_SEL}', count: rows.length, sample: rows.length? rows[0].outerHTML.slice(0,400): ''}); })()` });
      console.log('DOM_DUMP=' + (dump.result?.result?.value || ''));

      // create a new session first
      await send('Runtime.evaluate', { expression: `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.getAttribute('aria-label')||'').includes('新建会话')); if (b) b.click(); return !!b; })()` });
      await new Promise(r => setTimeout(r, 1000));

      // bypass first-run onboarding if present
      await send('Runtime.evaluate', { expression: `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText||'').includes('Start ZCode')); if (b) { b.click(); return 'clicked'; } return 'none'; })()` });
      await new Promise(r => setTimeout(r, 2000));

      // create a new session/task if button present
      const nb = await send('Runtime.evaluate', { expression: `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.getAttribute('aria-label')||x.innerText||'').includes('新建会话') || (x.getAttribute('aria-label')||x.innerText||'').includes('New task')); if (b) { b.click(); return 'clicked'; } return 'none'; })()` });
      await new Promise(r => setTimeout(r, 1500));

      await send('Runtime.evaluate', { expression: `document.querySelector('[contenteditable=true]') && document.querySelector('[contenteditable=true]').focus()` });
      await send('Input.insertText', { text: TEXT });
      await new Promise(r => setTimeout(r, 300));
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      console.log('INPUT_SENT');

      let lastRowCount = 0;
      let lastRowTextLen = 0;
      let growthCount = 0;
      let lastReply = '';
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 500));
        const r = await send('Runtime.evaluate', { expression: `(() => { const rows = Array.from(document.querySelectorAll('${ROW_SEL}')); const arows = rows.filter(r => !r.querySelector('[data-v4-user-input-bubble]')); const texts = arows.map(x => (x.innerText||'').trim()); const replyText = texts.join(' ').trim().replace(/\\s*Copy\\s*/g,'').trim(); return JSON.stringify({ rowCount: rows.length, rowTextLen: texts.join('\\n').length, replyText }); })()` });
        const v = JSON.parse(r.result?.result?.value || '{}');
        if (v.rowCount > lastRowCount || v.rowTextLen > lastRowTextLen) { growthCount++; lastRowCount = v.rowCount; lastRowTextLen = v.rowTextLen; }
        if (v.replyText) lastReply = v.replyText;
      }
      const replyOk = lastReply.length > 0 && lastReply !== TEXT;
      console.log('POLL_DONE growthEvents=' + growthCount + ' finalReplyLen=' + lastReply.length + ' replyOk=' + replyOk);
      console.log('FINAL_REPLY=' + lastReply.slice(0, 80));

      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(shot.result.data, 'base64');
      fs.writeFileSync(SHOT, buf);
      console.log('SCREENSHOT=' + SHOT + ' bytes=' + buf.length);

      ws.close();
      if (growthCount >= 1 && replyOk) process.exit(0); else process.exit(1);
    } catch (e) {
      console.error('ERR', e);
      process.exit(1);
    }
  });
})();