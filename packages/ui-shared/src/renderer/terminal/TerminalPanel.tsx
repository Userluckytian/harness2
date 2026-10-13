// Z9-4：终端面板本体（壳无关）—— 多实例标签条 + 每标签一个 @xterm/xterm 实例。
//
// 边界：只做**渲染端 UI**。端口实现（desktop IPC / web WS）与两壳装配（注册进
// TERMINAL_SEAT、Ctrl+J 接线）都是后续批次，不在本文件。本文件零 Node / 零 Electron /
// 零 `window.harness2`：终端的一切数据只经 props 注入的 `TerminalPort`。
//
// 红线⑩（如实，不摆假终端）：
//   * `port.available === false` → 只渲染「终端不可用」+ 原因，**不创建 xterm、不摆假提示符**；
//   * `port.open` 失败 → 该标签内如实显示错误文本（不伪装成正常输出、不假装已连接）；
//   * `port.onExit` 到达 → 该标签内如实显示退出码。
//
// 主题取色（二选一并说明）：**用 getComputedStyle 读壳的语义 token**（`--color-terminal-*` /
// `--color-background` / `--color-foreground`），不硬编色值、不新增 token —— 壳切浅/深主题时
// token 值随之变化，`theme` prop 仅作为「重新取色」的失效信号（可选）。这样 UI 无需知道
// 具体色值，天然跟随 `styles.css` 的 `.theme-zai-light` / `.theme-zai-dark` 契约。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { cn } from '../../lib/utils.js';
import type { TerminalPort } from './port.js';

export interface TerminalPanelProps {
  /** 渲染端终端端口（壳注入；`available === false` 时如实禁用，见红线⑩） */
  readonly port: TerminalPort;
  /** 新建终端的工作目录（可选；透传给 `port.open`） */
  readonly cwd?: string;
  /** 端口不可用时的原因文案（可选；与「终端不可用」一并显示） */
  readonly unavailableReason?: string;
  /** 壳主题（浅/深）；仅作**重新取色**的失效信号，实际色值读 CSS 语义 token（见文件头） */
  readonly theme?: 'light' | 'dark';
}

/** 单标签内部状态：打开中 / 已连接 / 已退出 / 打开失败（如实呈现，不伪装） */
type TabStatus = 'opening' | 'open' | 'exited' | 'error';

/**
 * 单标签在**面板级注册表**中的登记项。
 *
 * 键是 `port.open()` 返回的**终端 id**，值是持有该 id 的 xterm 实例与退出回调 —— 数据/退出
 * 一律按 id 精确分发（`registry.get(id)`）：找不到对应实例（已关闭 / 未知 id）就**如实丢弃**，
 * 绝不回落到「第一个 / 当前激活」实例。这样每标签的实例与 id 严格一一对应，不会因
 * StrictMode 双调用 / 重复 effect 而错位。
 */
interface TerminalRegistration {
  readonly term: Terminal;
  /** 该终端退出时的回调（把退出码写回所属标签的 state）。 */
  readonly onExit: (exitCode: number | undefined) => void;
}

/** 面板级注册表：终端 id → { xterm 实例, 退出回调 }。稳定单例，跨渲染存活（见 TerminalTabs）。 */
type TerminalRegistry = Map<string, TerminalRegistration>;

/**
 * 开发期诊断：未知 id 的数据被如实丢弃时留一条线索。
 *
 * 默认静默（生产 / 测试不产生噪音），仅在宿主显式置 `globalThis.__HARNESS2_TERMINAL_DEBUG__ = true`
 * 时输出 —— 不引用 node/`process`（本文件零宿主依赖）。
 */
function devLog(message: string): void {
  const enabled = (globalThis as { __HARNESS2_TERMINAL_DEBUG__?: unknown }).__HARNESS2_TERMINAL_DEBUG__;
  if (enabled === true) console.debug(`[h2-terminal] ${message}`);
}

/** 读一个语义 token 的计算值；空串（jsdom / 未加载样式）视为缺失，交由 xterm 默认值兜底 */
function readToken(name: string): string | undefined {
  if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
  const raw = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw.length > 0 ? raw : undefined;
}

/** 把壳的语义 token 映射成 xterm 的 ITheme（Z-67 Ansi16 + 光标/选区）。缺失的键不写入。 */
function readXtermTheme(): ITheme {
  const theme: ITheme = {};
  const assign = (key: keyof ITheme, token: string): void => {
    const value = readToken(token);
    if (value !== undefined) (theme as unknown as Record<string, unknown>)[key] = value;
  };
  assign('background', '--color-background');
  assign('foreground', '--color-foreground');
  assign('cursor', '--color-terminal-cursor');
  assign('cursorAccent', '--color-background');
  assign('selectionBackground', '--color-terminal-selection');
  assign('black', '--color-terminal-black');
  assign('red', '--color-terminal-red');
  assign('green', '--color-terminal-green');
  assign('yellow', '--color-terminal-yellow');
  assign('blue', '--color-terminal-blue');
  assign('magenta', '--color-terminal-magenta');
  assign('cyan', '--color-terminal-cyan');
  assign('white', '--color-terminal-white');
  assign('brightBlack', '--color-terminal-bright-black');
  assign('brightRed', '--color-terminal-bright-red');
  assign('brightGreen', '--color-terminal-bright-green');
  assign('brightYellow', '--color-terminal-bright-yellow');
  assign('brightBlue', '--color-terminal-bright-blue');
  assign('brightMagenta', '--color-terminal-bright-magenta');
  assign('brightCyan', '--color-terminal-bright-cyan');
  assign('brightWhite', '--color-terminal-bright-white');
  return theme;
}

/** 不可用占位（红线⑩）：明确「终端不可用」+ 原因，不创建 xterm、不摆假提示符。 */
function TerminalUnavailable({ reason }: { reason?: string }): ReactNode {
  return (
    <div className="h2-terminal h2-terminal--unavailable" data-testid="terminal-panel" data-terminal-available="false">
      <div className="h2-terminal__notice" data-testid="terminal-unavailable" role="note">
        <p className="h2-terminal__notice-title">终端不可用</p>
        {reason !== undefined && reason.length > 0 && <p className="h2-terminal__notice-reason">{reason}</p>}
      </div>
    </div>
  );
}

/**
 * 单个终端标签的视图：拥有自己的 xterm 实例与生命周期。
 *
 * 挂载：new Terminal → 挂 FitAddon → `open(host)` → `fit()` 取整数 cols/rows →
 * `port.open({ cols, rows, cwd? })` 拿 id → 把 (id → { term, onExit }) **登记进面板级注册表**
 * （数据/退出由面板**单一订阅**按 id 精确分发；本视图不再各自订阅）。键入：`term.onData` →
 * `port.write(id, data)`。尺寸：`ResizeObserver` / 标签激活 → `fit()` → 尺寸变化时 `port.resize`。
 * 卸载：从注册表注销 + `port.close(id)` + `term.dispose()`（不泄漏）。
 *
 * **幂等（StrictMode 双调用）**：id 用**本 effect run 自有**的局部变量 `ownedId`（不用共享「当前 id」），
 * cleanup 只回收「本次真正开出」的 id 与登记项；被提前取消的那次 open 在拿到 id 后立即 close，
 * 从不登记 —— 因此不会出现「id 已被 close、实例却仍挂着旧 id」的错位。
 */
function TerminalTabView({
  port,
  cwd,
  theme,
  active,
  registry,
}: {
  port: TerminalPort;
  cwd?: string;
  theme?: 'light' | 'dark';
  active: boolean;
  registry: TerminalRegistry;
}): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [status, setStatus] = useState<TabStatus>('opening');
  const [exitCode, setExitCode] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  /** fit → 读整数尺寸 → 尺寸变化时通知端口 resize（隐藏/零尺寸时 fit 为 no-op，不误发） */
  const fitAndResize = useCallback((): void => {
    const id = idRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (id === null || term === null || fit === null) return;
    try {
      fit.fit();
    } catch {
      return; // 容器尚无尺寸（隐藏标签）等：如实跳过，不误报
    }
    const cols = Math.max(1, Math.round(term.cols));
    const rows = Math.max(1, Math.round(term.rows));
    const last = lastSizeRef.current;
    if (last !== null && last.cols === cols && last.rows === rows) return;
    lastSizeRef.current = { cols, rows };
    port.resize(id, cols, rows);
  }, [port]);

  // 生命周期：创建 xterm / open 端口 / 登记进注册表；卸载时全量回收。
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const fontFamily = readToken('--font-mono');
    const term = new Terminal({
      cursorBlink: true,
      theme: readXtermTheme(),
      ...(fontFamily !== undefined ? { fontFamily } : {}),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    let cancelled = false;
    // 本 effect run **自有**的终端 id：cleanup 只回收它，与 term 实例严格一一对应。
    let ownedId: string | null = null;
    const inputSub = term.onData((data) => {
      if (ownedId !== null) port.write(ownedId, data);
    });
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            fitAndResize();
          })
        : undefined;
    observer?.observe(host);

    const boot = async (): Promise<void> => {
      try {
        fit.fit();
        const cols = Math.max(1, Math.round(term.cols));
        const rows = Math.max(1, Math.round(term.rows));
        const opened = await port.open({ cols, rows, ...(cwd !== undefined ? { cwd } : {}) });
        if (cancelled) {
          void port.close(opened.id); // 挂载期已被卸载：立即回收，避免泄漏真实 PTY（且从不登记）
          return;
        }
        ownedId = opened.id;
        idRef.current = opened.id; // 供 fitAndResize 定位（本 run 自有 id）
        lastSizeRef.current = { cols, rows };
        // 登记进面板级注册表：数据 / 退出从此**只**按该 id 分发到本实例的 xterm。
        registry.set(opened.id, {
          term,
          onExit: (code) => {
            setExitCode(code);
            setStatus('exited');
          },
        });
        // 修复（dock 收起时挂载 → xterm 永远停在 1 行）：open 前若容器零尺寸，fit() 会把 PTY
        // 建到 rows=1；而挂载期 ResizeObserver 回调在 id 就绪前会空跑（`fitAndResize` 见 idRef
        // 为 null 直接 return），dock 展开这次回调可能恰逢 `await port.open` 未 resolve —— 于是
        // open 之后再无任何 fit，尺寸永远停在 1 行。此处 open、id 与登记都就绪后**补一次 fit**：
        // 容器已具真实尺寸 → 立即重算并经 `port.resize` 通知 PTY；仍为零尺寸 → 交由后续 RO 回调
        // 纠正（那时 id 已就绪，不会再空跑）。`fitAndResize` 的 `lastSizeRef` 去重保证不误发。
        fitAndResize();
        setStatus('open');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    };
    void boot();

    return () => {
      cancelled = true;
      observer?.disconnect();
      inputSub.dispose();
      if (ownedId !== null) {
        // 注销该 id 的分发（close 后再来该 id 的数据 → 无实例 → 如实丢弃，不写进别的实例）
        registry.delete(ownedId);
        void port.close(ownedId);
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      idRef.current = null;
      lastSizeRef.current = null;
    };
  }, [port, cwd, fitAndResize, registry]);

  // 主题切换：只更新已存在实例的 theme 选项，不重建终端（保留屏幕缓冲）。
  useEffect(() => {
    const term = termRef.current;
    if (term !== null) term.options.theme = readXtermTheme();
  }, [theme]);

  // 标签激活：从隐藏切回可见时重算尺寸（隐藏期间 ResizeObserver 无可信尺寸）。
  useEffect(() => {
    if (active) fitAndResize();
  }, [active, fitAndResize]);

  return (
    <div
      className="h2-terminal__body"
      data-testid="terminal-tab-body"
      data-terminal-tab-active={active ? 'true' : 'false'}
      data-terminal-status={status}
      style={{ display: active ? 'block' : 'none' }}
    >
      <div className="h2-terminal__xterm" data-testid="terminal-xterm" ref={hostRef} />
      {status === 'opening' && (
        <div className="h2-terminal__status" data-testid="terminal-tab-status">
          正在打开终端…
        </div>
      )}
      {status === 'exited' && (
        <div className="h2-terminal__status" data-testid="terminal-tab-status" data-terminal-exit-code={exitCode ?? ''}>
          {`终端已退出（退出码 ${exitCode === undefined ? '未知' : exitCode}）`}
        </div>
      )}
      {status === 'error' && (
        <div className="h2-terminal__status h2-terminal__status--error" data-testid="terminal-tab-status" role="alert">
          {`终端打开失败：${error ?? '未知错误'}`}
        </div>
      )}
    </div>
  );
}

/** 可用态：多实例标签条 + 各标签视图。初始自动开一个（面板出现即用户显式开终端的动作）。 */
function TerminalTabs({ port, cwd, theme }: { port: TerminalPort; cwd?: string; theme?: 'light' | 'dark' }): ReactNode {
  const [tabKeys, setTabKeys] = useState<readonly number[]>(() => [0]);
  const [activeKey, setActiveKey] = useState<number | null>(0);
  const nextKeyRef = useRef(1);
  // 面板级注册表（稳定单例，跨渲染存活）：终端 id → { xterm, onExit }。各标签把自己的实例登记进来，
  // 面板**单一订阅**按 id 精确分发 —— 不用「当前激活 id」这类全局单值，杜绝跨实例错写。
  const registryRef = useRef<TerminalRegistry>(new Map());

  // **单一订阅**：只在 port 身份变化时重建（不随每次渲染 / 每个标签重建，订阅不会丢）。
  // 数据只写进 id 对应的实例；找不到对应实例（已关闭 / 未知 id）→ 如实丢弃并留一条 dev 线索，
  // **绝不**回落到第一个 / 激活实例。
  useEffect(() => {
    const registry = registryRef.current;
    const offData = port.onData((id, data) => {
      const entry = registry.get(id);
      if (entry === undefined) {
        devLog(`丢弃未知终端 id 的数据（无对应实例）：${id}`);
        return;
      }
      entry.term.write(data);
    });
    const offExit = port.onExit((id, code) => {
      registry.get(id)?.onExit(code);
    });
    return () => {
      offData();
      offExit();
    };
  }, [port]);

  const addTab = (): void => {
    const key = nextKeyRef.current;
    nextKeyRef.current += 1;
    setTabKeys((prev) => [...prev, key]);
    setActiveKey(key);
  };

  // 用当前渲染值算后继激活项（不在 state updater 里做副作用）
  const closeTab = (key: number): void => {
    const index = tabKeys.indexOf(key);
    const next = tabKeys.filter((k) => k !== key);
    setTabKeys(next);
    if (activeKey === key) setActiveKey(next[Math.min(index, next.length - 1)] ?? null);
  };

  return (
    <div className="h2-terminal" data-testid="terminal-panel" data-terminal-available="true">
      <div className="h2-terminal__tabstrip" role="tablist" aria-label="终端标签" data-testid="terminal-tabstrip">
        {tabKeys.map((key) => {
          const isActive = key === activeKey;
          return (
            <div
              key={key}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              data-testid="terminal-tab"
              data-terminal-tab-key={key}
              data-terminal-tab-active={isActive ? 'true' : undefined}
              className={cn('h2-terminal__tab', isActive && 'h2-terminal__tab--active')}
              onClick={() => setActiveKey(key)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setActiveKey(key);
                }
              }}
            >
              <span className="h2-terminal__tab-label">{`终端 ${key + 1}`}</span>
              <button
                type="button"
                className="h2-terminal__tab-close"
                data-testid="terminal-tab-close"
                aria-label={`关闭 终端 ${key + 1}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(key);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="h2-terminal__new-tab"
          data-testid="terminal-new-tab"
          aria-label="新建终端"
          onClick={addTab}
        >
          ＋
        </button>
      </div>
      <div className="h2-terminal__bodies" data-testid="terminal-bodies">
        {tabKeys.map((key) => (
          <TerminalTabView
            key={key}
            port={port}
            cwd={cwd}
            theme={theme}
            active={key === activeKey}
            registry={registryRef.current}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 渲染终端面板。
 * @param props - 端口（含 available）、可选 cwd / 原因 / 主题失效信号。
 * @returns 可用态 = 标签条 + xterm；不可用态 = 如实禁用占位（红线⑩）。
 */
export function TerminalPanel({ port, cwd, unavailableReason, theme }: TerminalPanelProps): ReactNode {
  if (!port.available) return <TerminalUnavailable reason={unavailableReason} />;
  return <TerminalTabs port={port} cwd={cwd} theme={theme} />;
}
