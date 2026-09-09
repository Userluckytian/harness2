// 浏览器工具测试（阶段 7 Task 2）：
// 本地 stub HTTP 页面 + 真实 headless chromium 全链（navigate→snapshot→click→type→snapshot、
// 截图落盘）、资源管控（并发排队/空闲销毁/close 清理/LRU 腾位）、未安装分支（loader 注入失败）。
// chromium 未安装时真实浏览器用例整体跳过（CI 由 chromium 安装步骤保证运行）。
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserNotInstalledError,
  BrowserPool,
  createBrowserTools,
  chromiumAvailable,
} from '../src/tools/predefined/browser.js';
import type { ToolDefinition } from '../src/tools/types.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-browser-'));
  dirs.push(d);
  return d;
}

const pools: BrowserPool[] = [];
function smallPool(
  opts: { idleDestroyMs?: number; maxConcurrent?: number; loader?: () => Promise<unknown> } = {},
): BrowserPool {
  const pool = new BrowserPool({
    ...(opts.idleDestroyMs !== undefined ? { idleDestroyMs: opts.idleDestroyMs } : {}),
    ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
    ...(opts.loader !== undefined ? { loader: opts.loader as never } : {}),
  });
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  for (const p of pools.splice(0)) await p.closeAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  servers.splice(0).forEach((s) => s.close());
});
const servers: Server[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 本地 stub 页面：按钮（点击写 #out）、输入框、文本；/empty 路径返回无交互元素页面（ref 失配场景） */
function startStubServer(): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/empty')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><p>空白页（无交互元素）</p></body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>stub 页面</title></head><body>
<h1>harness2 浏览器测试页</h1>
<button onclick="document.getElementById('out').textContent='clicked-ok'">点我</button>
<input id="txt" placeholder="input here" />
<p id="out">(empty)</p>
</body></html>`);
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve(`http://127.0.0.1:${port}/`);
    });
  });
}

/** 从 aria 快照 YAML 提取包含指定文本的元素的 ref */
function refOf(snapshot: string, text: string): string {
  const line = snapshot.split('\n').find((l) => l.includes(text));
  if (!line) throw new Error(`snapshot 中找不到 "${text}"：\n${snapshot}`);
  const m = /\[ref=([^\]]+)\]/.exec(line);
  if (!m) throw new Error(`"${text}" 无 ref：${line}`);
  return m[1]!;
}

function toolByName(defs: ToolDefinition[], name: string): ToolDefinition {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  return def;
}

async function runTool(def: ToolDefinition, args: unknown): Promise<{ ok: boolean; text: string }> {
  const out = await def.execute(args, { signal: new AbortController().signal, cwd: process.cwd() });
  return { ok: out.error === undefined, text: out.output ?? out.error ?? '' };
}

const hasChromium = await chromiumAvailable();

describe('BrowserPool 资源管控（无需 chromium 的部分）', () => {
  it('未安装分支：loader 抛错 → 浏览器工具返回「请先运行 harness2 browser install」', async () => {
    const pool = smallPool({ loader: () => Promise.reject(new Error('Cannot find package playwright')) });
    const [navigate] = createBrowserTools('s-none', pool);
    const r = await runTool(navigate!, { url: 'https://example.com/' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('harness2 browser install');
    expect(r.text).toContain('Cannot find package');
  });

  it('未安装分支：BrowserNotInstalledError 归类（chromium 二进制缺失同口径）', () => {
    const e = new BrowserNotInstalledError('Executable does not exist');
    expect(e.message).toContain('harness2 browser install');
  });

  it('navigate 只接受 http/https URL（file:/ftp: 拒绝，池不启动）', async () => {
    const pool = smallPool({ loader: () => Promise.reject(new Error('should not load')) });
    const [navigate] = createBrowserTools('s-proto', pool);
    const r1 = await runTool(navigate!, { url: 'file:///C:/Windows/win.ini' });
    expect(r1.ok).toBe(false);
    expect(r1.text).toContain('仅支持 http/https');
    const r2 = await runTool(navigate!, { url: 'not-a-url' });
    expect(r2.ok).toBe(false);
    expect(pool.size).toBe(0);
  });

  it('ref 校验：非 ref 字符（selector 注入原语）拒绝', async () => {
    const tools = createBrowserTools('s-ref', smallPool());
    const click = toolByName(tools, 'browser_click');
    const ctx = { signal: new AbortController().signal, cwd: process.cwd() };
    await expect(click.execute({ ref: '../../etc' }, ctx)).rejects.toThrow(/ref 非法/);
    await expect(click.execute({ ref: 'a b' }, ctx)).rejects.toThrow(/ref 非法/);
  });
});

describe.skipIf(!hasChromium)('浏览器全链（真实 headless chromium + 本地 stub 页面）', () => {
  it('navigate→snapshot→click→snapshot：点击生效（stub 页面状态变化）', async () => {
    const url = await startStubServer();
    const pool = smallPool();
    const tools = createBrowserTools('s-e2e', pool);
    const navigate = toolByName(tools, 'browser_navigate');
    const snapshot = toolByName(tools, 'browser_snapshot');
    const click = toolByName(tools, 'browser_click');

    const r1 = await runTool(navigate, { url });
    expect(r1.ok).toBe(true);
    expect(r1.text).toContain('已打开');
    expect(r1.text).toContain('stub 页面');

    const s1 = await runTool(snapshot, {});
    expect(s1.ok).toBe(true);
    const btnRef = refOf(s1.text, '点我');
    expect(pool.size).toBe(1); // 每会话 1 上下文：同一会话复用

    const r2 = await runTool(click, { ref: btnRef });
    expect(r2.ok).toBe(true);

    const s2 = await runTool(snapshot, {});
    expect(s2.text).toContain('clicked-ok'); // 点击生效
    expect(pool.size).toBe(1);
  }, 30_000);

  it('type→snapshot：输入生效；两会话各自上下文（每会话 1 个）', async () => {
    const url = await startStubServer();
    const pool = smallPool();
    const a = createBrowserTools('s-a', pool);
    const b = createBrowserTools('s-b', pool);
    await runTool(toolByName(a, 'browser_navigate'), { url });
    const snapA = await runTool(toolByName(a, 'browser_snapshot'), {});
    const inputRef = refOf(snapA.text, 'input here');
    await runTool(toolByName(a, 'browser_type'), { ref: inputRef, text: 'hello harness2' });
    const snapA2 = await runTool(toolByName(a, 'browser_snapshot'), {});
    expect(snapA2.text).toContain('hello harness2');

    // 第二个会话：独立上下文（池中 2 个），A 的输入不会出现在 B
    await runTool(toolByName(b, 'browser_navigate'), { url });
    expect(pool.size).toBe(2);
    const snapB = await runTool(toolByName(b, 'browser_snapshot'), {});
    expect(snapB.text).not.toContain('hello harness2');
  }, 40_000);

  it('ref 失配提示：页面跳转后用旧 ref → 错误附「browser_snapshot 重新获取引用」提示（审查 P2-4）', async () => {
    const url = await startStubServer();
    const pool = smallPool();
    const tools = createBrowserTools('s-stale', pool);
    const navigate = toolByName(tools, 'browser_navigate');
    const snapshot = toolByName(tools, 'browser_snapshot');
    const click = toolByName(tools, 'browser_click');

    await runTool(navigate, { url });
    const s1 = await runTool(snapshot, {});
    const btnRef = refOf(s1.text, '点我');
    expect(btnRef).toBeTruthy();

    // 导航到无交互元素的页面（DOM 已变更）→ 旧 ref 定位失败，错误必须含再取引用的指引
    const nav2 = await runTool(navigate, { url: `${url}empty` });
    expect(nav2.ok).toBe(true);
    const r = await runTool(click, { ref: btnRef });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('页面可能已变化');
    expect(r.text).toContain('browser_snapshot 重新获取引用');
  }, 40_000);

  it('screenshot：png 落盘（默认临时目录与指定路径）', async () => {
    const url = await startStubServer();
    const pool = smallPool();
    const tools = createBrowserTools('s-shot', pool);
    await runTool(toolByName(tools, 'browser_navigate'), { url });
    const shot = toolByName(tools, 'browser_screenshot');
    const target = join(tmpDir(), 'shot.png');
    const r = await runTool(shot, { path: target });
    expect(r.ok).toBe(true);
    expect(r.text).toContain(target);
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).size).toBeGreaterThan(0);
    // 默认路径：省略 path 参数也能落盘
    const r2 = await runTool(shot, {});
    const defaultPath = /截图已保存: (.+)/.exec(r2.text)?.[1];
    expect(defaultPath).toBeDefined();
    expect(existsSync(defaultPath!)).toBe(true);
  }, 30_000);

  it('browser_close：池清理；再次使用自动重建', async () => {
    const url = await startStubServer();
    const pool = smallPool();
    const tools = createBrowserTools('s-close', pool);
    await runTool(toolByName(tools, 'browser_navigate'), { url });
    expect(pool.size).toBe(1);
    const r = await runTool(toolByName(tools, 'browser_close'), {});
    expect(r.text).toContain('已关闭');
    expect(pool.size).toBe(0);
    // 再次使用：重建 + dispose 说明
    const r2 = await runTool(toolByName(tools, 'browser_navigate'), { url });
    expect(r2.text).toContain('已销毁'); // dispose 说明进输出 → tool/result → 轨迹
    expect(pool.size).toBe(1);
  }, 30_000);

  it('空闲销毁：idleDestroyMs 到期上下文被销毁，下次使用附 dispose 说明', async () => {
    const url = await startStubServer();
    const pool = smallPool({ idleDestroyMs: 150 });
    const tools = createBrowserTools('s-idle', pool);
    await runTool(toolByName(tools, 'browser_navigate'), { url });
    expect(pool.size).toBe(1);
    await sleep(400);
    expect(pool.size).toBe(0); // 空闲自动销毁
    const r = await runTool(toolByName(tools, 'browser_snapshot'), {});
    expect(r.text).toContain('空闲'); // dispose 说明
  }, 30_000);

  it('并发上限：maxConcurrent=2 时三个会话的操作排队（同时在执行 ≤2）', async () => {
    const pool = smallPool({ maxConcurrent: 2 });
    let inFlight = 0;
    let peak = 0;
    const run = (key: string): Promise<void> =>
      pool
        .withPage(key, async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await sleep(120);
          inFlight -= 1;
        })
        .then(() => {});
    await Promise.all([run('c1'), run('c2'), run('c3')]);
    expect(peak).toBe(2); // 第三个排队
    expect(pool.size).toBeLessThanOrEqual(2); // 存活上下文同样受限
  }, 40_000);

  it('LRU 腾位：满载时新建会话驱逐最久未用的空闲上下文', async () => {
    const url = await startStubServer();
    const pool = smallPool({ maxConcurrent: 2 });
    const t1 = createBrowserTools('lru-1', pool);
    const t2 = createBrowserTools('lru-2', pool);
    const t3 = createBrowserTools('lru-3', pool);
    await runTool(toolByName(t1, 'browser_navigate'), { url });
    await sleep(150); // 拉开 lastUsed（远大于计时器粒度，避免 LRU 序抖动）
    await runTool(toolByName(t2, 'browser_navigate'), { url });
    expect(pool.size).toBe(2);
    const r = await runTool(toolByName(t3, 'browser_navigate'), { url }); // 挤掉 lru-1
    expect(pool.size).toBeLessThanOrEqual(2);
    expect(r.text).not.toContain('已销毁'); // 新会话自己的首启无 dispose 说明
    // lru-1 再用：其上下文被驱逐 → dispose 说明 + 重建
    const r2 = await runTool(toolByName(t1, 'browser_snapshot'), {});
    expect(r2.text).toContain('腾位');
  }, 40_000);
});
