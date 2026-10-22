// ZS5 soak: 30min resource sampling + 3 mid-flight dialog rounds + ratio-based verdict.
// Usage: node scripts/zs5/soak.cjs   (expects CDP on 127.0.0.1:9229, fake-home env set by run-soak.ps1)
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('D:/AI_Projects/harness2/node_modules/.pnpm/ws@8.21.3/node_modules/ws');

const TOTAL_MS = 30 * 60 * 1000;
const SAMPLE_INTERVAL_MS = 10 * 1000;
const ROUND_TIMES_MS = [2 * 60 * 1000, 12 * 60 * 1000, 22 * 60 * 1000];

const CSV_PATH = 'D:/AI_Projects/harness2/docs/screenshots/zs5/soak.csv';
const REPORT_PATH = 'D:/AI_Projects/harness2/docs/screenshots/zs5/soak-report.md';

const PS_CMD =
  "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -like 'D:\\AI_Projects\\harness2-zs1-build*' } | Select-Object ProcessId,Name,WorkingSetSize | ConvertTo-Csv -NoTypeInformation";

const crashDir = path.join(process.env.HARNESS2_HOME || 'C:/Users/ASUS', '.harness2', 'crash');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

// ---------- CDP plumbing ----------
let ws = null;
let pending = new Map();
let msgId = 0;

function connectCdp() {
  return new Promise(async (resolve, reject) => {
    try {
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
      const socket = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
      pending = new Map();
      msgId = 0;
      socket.on('error', (e) => {
        console.error('WS ERR', e && e.message);
      });
      socket.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      });
      socket.on('open', () => {
        ws = socket;
        resolve(socket);
      });
      socket.on('close', () => {
        if (ws === socket) ws = null;
      });
    } catch (e) {
      reject(e);
    }
  });
}

function ensureWs() {
  if (ws && ws.readyState === 1) return Promise.resolve(ws);
  console.log('CDP_RECONNECTING');
  return connectCdp();
}

function send(method, params) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== 1) {
      resolve({ error: 'ws-not-open' });
      return;
    }
    const mid = ++msgId;
    pending.set(mid, resolve);
    try {
      ws.send(JSON.stringify({ id: mid, method, params }));
    } catch (e) {
      pending.delete(mid);
      resolve({ error: String(e) });
    }
    // safety timeout
    setTimeout(() => {
      if (pending.has(mid)) {
        pending.delete(mid);
        resolve({ error: 'timeout' });
      }
    }, 30000);
  });
}

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r && r.result && r.result.result ? r.result.result.value : undefined;
}

async function dismissWelcome() {
  const r = await send('Runtime.evaluate', {
    expression:
      "(() => { const dlg = document.querySelector('[role=\"dialog\"]'); if (!dlg) return 'no-dialog'; const hit = (t) => /Start ZCode|开始使用/i.test(t||''); const b = Array.from(dlg.querySelectorAll('button')).find(x => hit(x.innerText) || hit(x.getAttribute('aria-label'))); if (b) { b.click(); return 'clicked'; } return 'dialog-present-no-start-button'; })()",
  });
  return String((r && r.result && r.result.result && r.result.result.value) || 'none');
}

async function pressEscape() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

// ---------- sampling ----------
const allRows = []; // {ts, elapsedMs, pid, name, ws}
const sampleCounts = []; // {ts, elapsedMs, count}

function spawnPwshSample() {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', PS_CMD], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, 25000);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: String(e) });
    });
  });
}

function parseCsvLine(line) {
  return line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
}

async function sampleOnce(startTs) {
  const now = Date.now();
  const ts = new Date().toISOString();
  const elapsedMs = now - startTs;
  const { stdout } = await spawnPwshSample();
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let dataLines = lines;
  if (lines.length && /ProcessId/i.test(lines[0])) dataLines = lines.slice(1);

  const seenPids = new Set();
  for (const line of dataLines) {
    const cols = parseCsvLine(line);
    if (cols.length < 3) continue;
    const pid = cols[0];
    const name = cols[1];
    const wsBytes = cols[2];
    if (!pid) continue;
    seenPids.add(pid);
    allRows.push({ ts, elapsedMs, pid, name, ws: Number(wsBytes) || 0 });
    fs.appendFileSync(CSV_PATH, `${ts},${pid},${name},${wsBytes}\n`);
  }
  sampleCounts.push({ ts, elapsedMs, count: seenPids.size });
  // keepalive
  try {
    await ev('1');
  } catch {}
  console.log(`SAMPLE elapsed=${Math.round(elapsedMs / 1000)}s pids=${seenPids.size}`);
}

// ---------- dialog round ----------
async function sendRound(text, roundIdx) {
  await ensureWs();
  console.log(`ROUND_${roundIdx}_START text=${JSON.stringify(text)}`);
  // dismiss welcome
  for (let i = 0; i < 20; i++) {
    const r = await dismissWelcome();
    if (r === 'clicked' || r === 'no-dialog') break;
    if (r === 'dialog-present-no-start-button') {
      await pressEscape();
      await sleep(300);
      continue;
    }
    await sleep(500);
  }
  await sleep(1500);

  // wait composer
  let cap = 'no-composer';
  for (let i = 0; i < 20; i++) {
    cap =
      (await ev("document.querySelector('[contenteditable=true]') ? 'input-capable' : 'no-composer'")) || 'no-composer';
    if (cap === 'input-capable') break;
    await sleep(500);
  }
  console.log(`ROUND_${roundIdx}_CAP=${cap}`);
  if (cap !== 'input-capable') {
    console.log(`ROUND_${roundIdx}_NO_COMPOSER_SKIP`);
    return;
  }

  await ev("document.querySelector('[contenteditable=true]').focus()");
  // clear
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
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
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await sleep(300);
  await send('Input.insertText', { text });
  await sleep(500);

  let composed = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    composed =
      (await ev(
        "(() => { const ce = document.querySelector('[contenteditable=true]'); return ce ? (ce.innerText||'').trim() : ''; })()",
      )) || '';
    if (composed === text.trim()) break;
    await dismissWelcome();
    await ev("document.querySelector('[contenteditable=true]').focus()");
    await send('Input.insertText', { text });
    await sleep(500);
  }
  console.log(`ROUND_${roundIdx}_COMPOSED=${JSON.stringify(composed)}`);
  if (composed !== text.trim()) {
    console.log(`ROUND_${roundIdx}_COMPOSE_FAIL`);
    return;
  }

  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  console.log(`ROUND_${roundIdx}_SENT`);

  // wait user row
  let userRowSeen = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const r = await ev(
      "(() => { const rows = Array.from(document.querySelectorAll('[data-testid^=\"v4-row-\"]')); return rows.some(r => (r.innerText||'').includes('" +
        text.replace(/"/g, '\\"') +
        "')); })()",
    );
    if (r === true) {
      userRowSeen = true;
      break;
    }
  }
  console.log(`ROUND_${roundIdx}_USER_ROW=${userRowSeen}`);
}

// ---------- main ----------
(async () => {
  fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
  fs.writeFileSync(CSV_PATH, 'ts,pid,name,ws_bytes\n');

  const baselineCrashFiles = fs.existsSync(crashDir) ? fs.readdirSync(crashDir) : [];
  console.log('CRASH_BASELINE_COUNT=' + baselineCrashFiles.length);
  console.log('START=' + new Date().toISOString());

  await connectCdp();

  const startTs = Date.now();
  let nextRoundIdx = 0;

  while (Date.now() - startTs < TOTAL_MS) {
    const elapsed = Date.now() - startTs;
    // fire round if due
    if (nextRoundIdx < ROUND_TIMES_MS.length && elapsed >= ROUND_TIMES_MS[nextRoundIdx]) {
      const idx = nextRoundIdx + 1;
      try {
        await sendRound(`soak round ${idx} ping`, idx);
      } catch (e) {
        console.error('ROUND_ERROR', e && e.message);
      }
      nextRoundIdx++;
    }
    await sampleOnce(startTs);
    // sleep until next sample boundary (or round)
    const nowElapsed = Date.now() - startTs;
    const nextSample = (Math.floor(nowElapsed / SAMPLE_INTERVAL_MS) + 1) * SAMPLE_INTERVAL_MS;
    let sleepMs = nextSample - nowElapsed;
    // if a round is due before next sample, wake earlier
    if (nextRoundIdx < ROUND_TIMES_MS.length) {
      const untilRound = ROUND_TIMES_MS[nextRoundIdx] - nowElapsed;
      if (untilRound > 0 && untilRound < sleepMs) sleepMs = untilRound;
    }
    const remaining = TOTAL_MS - nowElapsed;
    if (sleepMs > remaining) sleepMs = remaining;
    if (sleepMs < 0) sleepMs = 0;
    if (sleepMs > 0) await sleep(sleepMs);
  }

  // ---------- verdict ----------
  const endTs = Date.now();
  const finalCrashFiles = fs.existsSync(crashDir) ? fs.readdirSync(crashDir) : [];
  const newCrashFiles = finalCrashFiles.filter((f) => !baselineCrashFiles.includes(f));

  // memory means
  const firstWindow = allRows.filter((r) => r.elapsedMs < 10 * 60 * 1000);
  const lastWindow = allRows.filter((r) => r.elapsedMs >= 20 * 60 * 1000);

  function meanByPid(rows) {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.pid)) m.set(r.pid, { name: r.name, vals: [] });
      m.get(r.pid).vals.push(r.ws);
    }
    const out = new Map();
    for (const [pid, v] of m.entries()) {
      const mean = v.vals.reduce((a, b) => a + b, 0) / v.vals.length;
      out.set(pid, { name: v.name, mean, n: v.vals.length });
    }
    return out;
  }
  const firstMean = meanByPid(firstWindow);
  const lastMean = meanByPid(lastWindow);

  let memPass = true;
  const memLines = [];
  for (const [pid, lv] of lastMean.entries()) {
    const fv = firstMean.get(pid);
    if (fv) {
      const ratio = fv.mean > 0 ? lv.mean / fv.mean : Infinity;
      const ok = ratio <= 1.25;
      if (!ok) memPass = false;
      memLines.push(
        `| ${pid} | ${lv.name} | ${(fv.mean / 1024 / 1024).toFixed(1)} | ${(lv.mean / 1024 / 1024).toFixed(1)} | ${ratio.toFixed(3)} | ${ok ? 'PASS' : 'FAIL'} |`,
      );
    } else {
      memLines.push(`| ${pid} | ${lv.name} | (new) | ${(lv.mean / 1024 / 1024).toFixed(1)} | n/a | (new pid) |`);
    }
  }
  if (lastMean.size === 0 || firstMean.size === 0) memPass = false;

  // process count
  const firstCount = sampleCounts.length ? sampleCounts[0].count : 0;
  const lastCount = sampleCounts.length ? sampleCounts[sampleCounts.length - 1].count : 0;
  const maxCount = sampleCounts.reduce((a, s) => Math.max(a, s.count), 0);
  const procPass = lastCount <= firstCount + 1;

  const crashPass = newCrashFiles.length === 0;

  const overallPass = memPass && procPass && crashPass;

  const report = [];
  report.push('# ZS5 soak report');
  report.push('');
  report.push(`- start: ${new Date(startTs).toISOString()}`);
  report.push(`- end: ${new Date(endTs).toISOString()}`);
  report.push(`- duration_s: ${Math.round((endTs - startTs) / 1000)}`);
  report.push(`- samples: ${sampleCounts.length}`);
  report.push(`- csv_rows: ${allRows.length}`);
  report.push('');
  report.push('## Verdict');
  report.push('');
  report.push('| criterion | value | pass |');
  report.push('|---|---|---|');
  report.push(`| memory ratio (last 10min mean <= first 10min mean * 1.25) | see table | ${memPass} |`);
  report.push(
    `| scratch electron process count (last <= first + 1) | first=${firstCount} last=${lastCount} max=${maxCount} | ${procPass} |`,
  );
  report.push(`| crash dir new files | ${newCrashFiles.length} | ${crashPass} |`);
  report.push(`| **OVERALL** | | **${overallPass ? 'PASS' : 'FAIL'}** |`);
  report.push('');
  report.push('## Memory (per pid mean WS)');
  report.push('');
  report.push('| pid | name | first10min MB | last10min MB | ratio | result |');
  report.push('|---|---|---|---|---|---|');
  report.push(memLines.length ? memLines.join('\n') : '| (none) | | | | | |');
  report.push('');
  report.push('## Process count curve (per 10s sample)');
  report.push('');
  report.push('first=' + firstCount + ' last=' + lastCount + ' max=' + maxCount + ' samples=' + sampleCounts.length);
  report.push('');
  report.push('## Crash directory check');
  report.push('');
  report.push('baseline files: ' + baselineCrashFiles.length);
  report.push('final files: ' + finalCrashFiles.length);
  report.push('new files: ' + (newCrashFiles.length ? newCrashFiles.join(', ') : '(none)'));
  report.push('');

  fs.writeFileSync(REPORT_PATH, report.join('\n'));
  console.log('REPORT=' + REPORT_PATH);
  console.log('OVERALL=' + (overallPass ? 'PASS' : 'FAIL'));
  console.log('MEM_PASS=' + memPass + ' PROC_PASS=' + procPass + ' CRASH_PASS=' + crashPass);

  try {
    ws && ws.close();
  } catch {}
  process.exit(overallPass ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
