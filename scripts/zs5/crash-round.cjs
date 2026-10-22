// ZS5 e2e crash round.
// Exit codes: 0 pass / 3 wrong instance / 4 no crash report within timeout /
//             5 secret leaked in report / 6 shell not alive after crash / 1 other

const http = require('http');
const WebSocket = require('D:/AI_Projects/harness2/node_modules/.pnpm/ws@8.21.3/node_modules/ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SHOT = 'D:/AI_Projects/harness2/docs/screenshots/zs5/zs5-crash-round.png';
const HOME = process.env.HARNESS2_HOME || os.homedir();
const CRASH_DIR = path.join(HOME, '.harness2', 'crash');
const SECRET_RE = /sk-[A-Za-z0-9-]{6,}/;

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCrashReport() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(CRASH_DIR)) {
        const files = fs.readdirSync(CRASH_DIR).filter((f) => f.endsWith('.log'));
        for (const f of files) {
          const full = path.join(CRASH_DIR, f);
          const content = fs.readFileSync(full, 'utf8');
          if (content.includes('zs5-e2e-crash-probe')) {
            return { file: f, content };
          }
        }
      }
    } catch (e) {
      // ignore transient fs errors
    }
    await sleep(1000);
  }
  return null;
}

(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await getJson('/json/list');
      break;
    } catch {
      await sleep(1000);
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

  const found = await waitForCrashReport();
  if (!found) {
    console.error('NO CRASH REPORT WITHIN 30s');
    process.exit(4);
  }
  console.log('CRASH_REPORT=' + path.join(CRASH_DIR, found.file));
  console.log('CRASH_REPORT_HEAD=' + found.content.split('\n').slice(0, 8).join(' | '));

  if (SECRET_RE.test(found.content)) {
    console.error('SECRET LEAKED IN CRASH REPORT');
    process.exit(5);
  }
  console.log('SECRET_CHECK=clean');

  // 壳不连坐：等待 >=10s 后 CDP 确认页面仍在
  await sleep(10000);

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

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const evalRes = await send('Runtime.evaluate', {
    expression: '1+1',
    returnByValue: true,
  });
  const value = evalRes && evalRes.result && evalRes.result.result ? evalRes.result.result.value : undefined;
  console.log('SHELL_ALIVE_CHECK=' + value);
  if (value !== 2) {
    console.error('SHELL NOT ALIVE AFTER CRASH');
    ws.close();
    process.exit(6);
  }

  fs.mkdirSync('D:/AI_Projects/harness2/docs/screenshots/zs5', { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(shot.result.data, 'base64');
  fs.writeFileSync(SHOT, buf);
  console.log('SCREENSHOT=' + SHOT + ' bytes=' + buf.length);

  ws.close();
  console.log('RESULT=' + JSON.stringify({ status: 'pass', report: found.file }));
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
