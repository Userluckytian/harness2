// 浏览器工具（阶段 7 Task 2）：agent 的浏览器自动化（Playwright 子进程，惰性加载）。
// 资源红线（Global Constraints #2 落地）：
//   - 每会话至多 1 个浏览器上下文（池键 = 会话 id；CLI 单会话用 'cli'）；
//   - 全局并发 ≤ maxConcurrent（默认 2）：同时在执行操作的上下文数，超限排队；
//   - 存活上下文数 ≤ maxConcurrent：新建前按 LRU 驱逐空闲（未在执行）上下文；
//   - 空闲 idleDestroyMs（默认 5 分钟）销毁；crash/断开即销毁；
//   - 销毁/崩溃原因暂存为 dispose 说明，附到该会话下一次浏览器工具的输出
//     （经既有 tool/result 事件链自动进轨迹）；
//   - 页面只访问工具参数显式给出的 URL（http/https），无自动爬取。
// 惰性：import('playwright') 动态加载；chromium 未安装 → 报「请先运行 harness2 browser install」；
// 工具注册不依赖 playwright 可解析（本模块顶部不 import playwright 运行时符号）。
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { ToolDefinition, ToolOutput } from '../types.js';
import { expectObject, expectString, optionalString, truncateText } from './common.js';

/** 池默认参数（可被 config.browser 覆盖） */
export const BROWSER_IDLE_DESTROY_MS = 300_000;
export const BROWSER_MAX_CONCURRENT = 2;

/** aria 快照输出的字符上限（防极端页面撑爆模型上下文） */
const SNAPSHOT_MAX_CHARS = 20_000;

/** 摘要 provider 无关；loader 缺省 = 动态 import('playwright')（测试可注入失败桩） */
export type PlaywrightLoader = () => Promise<typeof import('playwright')>;

export interface BrowserPoolOptions {
  /** 空闲销毁 ms（默认 300000） */
  idleDestroyMs?: number;
  /** 全局并发上限（默认 2；同时约束存活上下文数） */
  maxConcurrent?: number;
  /** playwright 模块加载器（测试注入；缺省动态 import） */
  loader?: PlaywrightLoader;
}

/** chromium 未安装（Playwright 在但浏览器二进制缺失） */
export class BrowserNotInstalledError extends Error {
  constructor(detail?: string) {
    super(
      `浏览器未安装：请先运行 harness2 browser install（或 npx playwright install chromium）${detail ? `；原始错误: ${detail}` : ''}`,
    );
    this.name = 'BrowserNotInstalledError';
  }
}

interface PoolEntry {
  browser: Browser;
  context: BrowserContext;
  page: Page | null;
  lastUsed: number;
  inUse: boolean;
  idleTimer: NodeJS.Timeout | null;
}

export interface PoolOutcome<T> {
  result: T;
  /** dispose 说明（本会话上下文在上次使用后被销毁/崩溃的原因等），工具应附到输出 */
  notes: string[];
}

/** 简单计数信号量：acquire 返回 release；超 maxConcurrent 排队 */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }
  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
  get inFlight(): number {
    return this.active;
  }
}

const DEFAULT_LOADER: PlaywrightLoader = () => import('playwright');

/**
 * 浏览器上下文池（进程级；serve/CLI 经 getSharedBrowserPool 复用单例）。
 * 键 = 会话 id。测试可直接 new BrowserPool({ idleDestroyMs: 50, ... }) 注入小超时。
 */
export class BrowserPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly pendingNotes = new Map<string, string[]>();
  private readonly semaphore: Semaphore;
  private readonly idleDestroyMs: number;
  private readonly maxConcurrent: number;
  private readonly loader: PlaywrightLoader;

  constructor(options: BrowserPoolOptions = {}) {
    this.idleDestroyMs = options.idleDestroyMs ?? BROWSER_IDLE_DESTROY_MS;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? BROWSER_MAX_CONCURRENT);
    this.loader = options.loader ?? DEFAULT_LOADER;
    this.semaphore = new Semaphore(this.maxConcurrent);
  }

  get size(): number {
    return this.entries.size;
  }

  /** 在池键的页面上下文中执行 fn（自动建上下文/页面、刷新空闲计时、收集 dispose 说明） */
  async withPage<T>(key: string, fn: (page: Page) => Promise<T>): Promise<PoolOutcome<T>> {
    if (typeof key !== 'string' || key.length === 0) throw new Error('browser pool: 会话键不能为空');
    const release = await this.semaphore.acquire();
    try {
      let entry = this.entries.get(key);
      if (entry === undefined) {
        this.evictIdleForCreate();
        entry = await this.createEntry(key);
      }
      entry.inUse = true;
      this.refreshIdleTimer(key, entry);
      try {
        if (entry.page === null) entry.page = await entry.context.newPage();
        const result = await fn(entry.page);
        return { result, notes: this.takeNotes(key) };
      } catch (e) {
        // 崩溃/断开：销毁并记录 dispose 说明（下次使用时告知模型）
        if (!entry.browser.isConnected()) {
          this.destroyEntry(key, '浏览器进程崩溃/断开');
          this.pushNote(key, '上次使用的浏览器已崩溃断开，本次操作失败；下次调用将重新启动浏览器');
        }
        throw e;
      } finally {
        entry.inUse = false;
        this.refreshIdleTimer(key, entry);
      }
    } finally {
      release();
    }
  }

  /** 显式关闭（browser_close 工具）；返回是否确实销毁了上下文 */
  async closeKey(key: string): Promise<boolean> {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.destroyEntry(key, 'browser_close 显式关闭');
    return true;
  }

  /** 全量关闭（测试/进程收尾用） */
  async closeAll(): Promise<void> {
    for (const key of [...this.entries.keys()]) {
      this.destroyEntry(key, 'closeAll');
    }
  }

  // —— 内部 ——

  private async createEntry(key: string): Promise<PoolEntry> {
    let pw: typeof import('playwright');
    try {
      pw = await this.loader();
    } catch (e) {
      throw new BrowserNotInstalledError((e as Error)?.message);
    }
    let browser: Browser;
    try {
      browser = await pw.chromium.launch({ headless: true });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (/Executable doesn't exist|playwright install|Playwright was just installed/i.test(msg)) {
        throw new BrowserNotInstalledError(msg);
      }
      throw e;
    }
    const context = await browser.newContext();
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(15_000);
    const entry: PoolEntry = {
      browser,
      context,
      page: null,
      lastUsed: Date.now(),
      inUse: false,
      idleTimer: null,
    };
    browser.on('disconnected', () => {
      if (this.entries.get(key) === entry) this.destroyEntry(key, '浏览器进程崩溃/断开');
    });
    this.entries.set(key, entry);
    this.refreshIdleTimer(key, entry);
    return entry;
  }

  /** 新建前腾位：存活上下文达上限时按 LRU 驱逐空闲（未在执行）的条目 */
  private evictIdleForCreate(): void {
    while (this.entries.size >= this.maxConcurrent) {
      const idle = [...this.entries.entries()]
        .filter(([, e]) => !e.inUse)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      const victim = idle[0];
      if (victim === undefined) break; // 全部在用（信号量已限制并发，防御性兜底）
      this.destroyEntry(victim[0], `为其他会话腾位（存活上下文达上限 ${this.maxConcurrent}）`);
    }
  }

  private refreshIdleTimer(key: string, entry: PoolEntry): void {
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    entry.lastUsed = Date.now();
    entry.idleTimer = setTimeout(() => {
      if (this.entries.get(key) === entry && !entry.inUse) {
        this.destroyEntry(key, `空闲超过 ${Math.round(this.idleDestroyMs / 1000)}s`);
        this.pushNote(key, `浏览器上下文已因空闲 ${Math.round(this.idleDestroyMs / 1000)}s 自动销毁；下次调用将重新启动`);
      }
    }, this.idleDestroyMs);
    entry.idleTimer.unref?.(); // 不阻塞进程退出
  }

  private destroyEntry(key: string, reason: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    void entry.context.close().catch(() => {});
    void entry.browser.close().catch(() => {});
    this.pushNote(key, `浏览器上下文已销毁（${reason}）`);
  }

  private pushNote(key: string, note: string): void {
    const list = this.pendingNotes.get(key) ?? [];
    list.push(note);
    this.pendingNotes.set(key, list);
  }

  private takeNotes(key: string): string[] {
    const notes = this.pendingNotes.get(key) ?? [];
    this.pendingNotes.delete(key);
    return notes;
  }
}

// —— 进程级单例（serve 与 CLI 复用；首个调用者的参数生效） ——

let sharedPool: BrowserPool | undefined;

export function getSharedBrowserPool(options: BrowserPoolOptions = {}): BrowserPool {
  if (sharedPool === undefined) sharedPool = new BrowserPool(options);
  return sharedPool;
}

/** 关闭并清空单例（测试隔离用） */
export async function resetSharedBrowserPool(): Promise<void> {
  if (sharedPool !== undefined) {
    await sharedPool.closeAll();
    sharedPool = undefined;
  }
}

// —— 工具组装 ——

/** ref = snapshot 输出的元素引用（aria-ref）；只允许 ref 字符，杜绝拼 selector */
function normalizeRef(tool: string, raw: string): string {
  const ref = raw.trim();
  if (!/^[\w.-]+$/.test(ref)) throw new Error(`${tool}: ref 非法（应来自 browser_snapshot 输出的 [ref=...]）`);
  return ref;
}

function disposeSuffix(notes: string[]): string {
  return notes.length > 0 ? `\n${notes.join('\n')}` : '';
}

/** chromium 可执行文件探测（测试 skipIf 用；不触发 playwright 加载错误） */
export async function chromiumAvailable(): Promise<boolean> {
  try {
    const pw = await DEFAULT_LOADER();
    return existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
}

/**
 * 浏览器工具集（6 个，全部 unsafe = 默认审批 ask）：
 *   browser_navigate {url} / browser_click {ref} / browser_type {ref,text} /
 *   browser_snapshot {} / browser_screenshot {path?} / browser_close {}
 * sessionKey = 会话 id（池键）；pool 由装配层提供（config.browser.enabled 时）。
 */
export function createBrowserTools(sessionKey: string, pool: BrowserPool): ToolDefinition[] {
  const navigate: ToolDefinition = {
    name: 'browser_navigate',
    description:
      'Open a URL in the session browser (headless Chromium). Only http/https URLs are allowed; ' +
      'the URL must be the one explicitly given by the user or derived from this conversation (no crawling). ' +
      'Use browser_snapshot afterwards to get element refs for browser_click/browser_type.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) URL to open' } },
      required: ['url'],
    },
    timeoutMs: 30_000,
    execute: async (rawArgs): Promise<ToolOutput> => {
      const args = expectObject(rawArgs, 'browser_navigate');
      const url = expectString(args, 'url', 'browser_navigate');
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { error: `browser_navigate: 不是合法 URL: ${url}` };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: `browser_navigate: 仅支持 http/https URL，实际为 ${parsed.protocol}` };
      }
      try {
        const { result, notes } = await pool.withPage(sessionKey, async (page) => {
          await page.goto(parsed.href, { waitUntil: 'load' });
          const title = await page.title();
          return `已打开 ${page.url()}${title ? `（title: ${title}）` : ''}`;
        });
        return { output: result + disposeSuffix(notes) };
      } catch (e) {
        return { error: `browser_navigate: ${(e as Error)?.message ?? String(e)}` };
      }
    },
  };

  const click: ToolDefinition = {
    name: 'browser_click',
    description: 'Click an element in the session browser by its snapshot ref (from browser_snapshot output).',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. s1e3' } },
      required: ['ref'],
    },
    timeoutMs: 15_000,
    execute: async (rawArgs): Promise<ToolOutput> => {
      const args = expectObject(rawArgs, 'browser_click');
      const ref = normalizeRef('browser_click', expectString(args, 'ref', 'browser_click'));
      try {
        const { result, notes } = await pool.withPage(sessionKey, async (page) => {
          await page.locator(`aria-ref=${ref}`).click();
          return `已点击元素 ${ref}`;
        });
        return { output: result + disposeSuffix(notes) };
      } catch (e) {
        return { error: `browser_click: ${(e as Error)?.message ?? String(e)}` };
      }
    },
  };

  const type: ToolDefinition = {
    name: 'browser_type',
    description: 'Type text into an editable element (input/textarea/contenteditable) by its snapshot ref.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        text: { type: 'string', description: 'Text to fill in (replaces existing value)' },
      },
      required: ['ref', 'text'],
    },
    timeoutMs: 15_000,
    execute: async (rawArgs): Promise<ToolOutput> => {
      const args = expectObject(rawArgs, 'browser_type');
      const ref = normalizeRef('browser_type', expectString(args, 'ref', 'browser_type'));
      const text = expectString(args, 'text', 'browser_type');
      try {
        const { result, notes } = await pool.withPage(sessionKey, async (page) => {
          await page.locator(`aria-ref=${ref}`).fill(text);
          return `已在 ${ref} 输入 ${text.length} 字符`;
        });
        return { output: result + disposeSuffix(notes) };
      } catch (e) {
        return { error: `browser_type: ${(e as Error)?.message ?? String(e)}` };
      }
    },
  };

  const snapshot: ToolDefinition = {
    name: 'browser_snapshot',
    description:
      'Capture the accessibility snapshot (YAML) of the current page. Interactive elements carry [ref=...] ids; ' +
      'pass a ref to browser_click/browser_type. Prefer this over screenshots for structural understanding.',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 15_000,
    execute: async (): Promise<ToolOutput> => {
      try {
        const { result, notes } = await pool.withPage(sessionKey, async (page) => {
          // mode:'ai' 输出 [ref=...] 元素引用（browser_click/browser_type 的定位凭据）
          const yaml = await page.locator('body').ariaSnapshot({ mode: 'ai' });
          return truncateText(yaml, SNAPSHOT_MAX_CHARS);
        });
        return { output: result + disposeSuffix(notes) };
      } catch (e) {
        return { error: `browser_snapshot: ${(e as Error)?.message ?? String(e)}` };
      }
    },
  };

  const screenshot: ToolDefinition = {
    name: 'browser_screenshot',
    description:
      'Take a PNG screenshot of the current page. Returns the saved file path. ' +
      'Default path is a temp directory file (snapshots are not committed to git).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Optional absolute .png file path' } },
    },
    timeoutMs: 15_000,
    execute: async (rawArgs): Promise<ToolOutput> => {
      const args = expectObject(rawArgs ?? {}, 'browser_screenshot');
      const requested = optionalString(args, 'path');
      const path = requested ?? join(tmpdir(), `harness2-browser-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
      if (!path.toLowerCase().endsWith('.png')) {
        return { error: 'browser_screenshot: 截图仅支持 .png 路径' };
      }
      try {
        const { result, notes } = await pool.withPage(sessionKey, async (page) => {
          await page.screenshot({ path, type: 'png' });
          return `截图已保存: ${path}`;
        });
        return { output: result + disposeSuffix(notes) };
      } catch (e) {
        return { error: `browser_screenshot: ${(e as Error)?.message ?? String(e)}` };
      }
    },
  };

  const close: ToolDefinition = {
    name: 'browser_close',
    description: 'Close the session browser context and free resources (contexts also auto-close after idle timeout).',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 10_000,
    execute: async (): Promise<ToolOutput> => {
      try {
        const closed = await pool.closeKey(sessionKey);
        return { output: closed ? '浏览器上下文已关闭' : '浏览器上下文未打开（无需关闭）' };
      } catch (e) {
        return { error: `browser_close: ${(e as Error)?.message ?? String(e)}` };
      }
    },
  };

  return [navigate, click, type, snapshot, screenshot, close];
}

// —— 安装（harness2 browser install） ——

/**
 * 安装 chromium（Playwright 浏览器二进制）：以 playwright 包自带的 cli.js 起子进程执行
 * `playwright install chromium`（继承 stdio，exit code 透传）。从 core 上下文解析依赖，
 * CLI 无需直接依赖 playwright。
 */
export async function installBrowserRuntime(): Promise<number> {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const cliPath = require.resolve('playwright/cli.js');
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
