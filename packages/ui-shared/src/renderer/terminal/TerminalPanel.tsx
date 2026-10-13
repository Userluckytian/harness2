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
 * `port.open({ cols, rows, cwd? })` 拿 id → 订阅 `onData`（写进本 xterm）/ `onExit`（显示退出码）。
 * 键入：`term.onData` → `port.write(id, data)`。
 * 尺寸：`ResizeObserver` / 标签激活 → `fit()` → 尺寸变化时 `port.resize(id, cols, rows)`。
 * 卸载：退订 + `port.close(id)` + `term.dispose()`（不泄漏）。
 */
function TerminalTabView({
  port,
  cwd,
  theme,
  active,
}: {
  port: TerminalPort;
  cwd?: string;
  theme?: 'light' | 'dark';
  active: boolean;
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

  // 生命周期：创建 xterm / open 端口 / 订阅数据与退出；卸载时全量回收。
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
    let offData: (() => void) | undefined;
    let offExit: (() => void) | undefined;
    const inputSub = term.onData((data) => {
      const id = idRef.current;
      if (id !== null) port.write(id, data);
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
          void port.close(opened.id); // 挂载期已被卸载：立即回收，避免泄漏真实 PTY
          return;
        }
        idRef.current = opened.id;
        lastSizeRef.current = { cols, rows };
        offData = port.onData((id, data) => {
          if (id === opened.id) term.write(data);
        });
        offExit = port.onExit((id, code) => {
          if (id === opened.id) {
            setExitCode(code);
            setStatus('exited');
          }
        });
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
      offData?.();
      offExit?.();
      const id = idRef.current;
      if (id !== null) void port.close(id);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      idRef.current = null;
      lastSizeRef.current = null;
    };
  }, [port, cwd, fitAndResize]);

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
          <TerminalTabView key={key} port={port} cwd={cwd} theme={theme} active={key === activeKey} />
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
