// Electron 主进程入口：spawn serve → 桥接 IPC → 创建窗口（contextIsolation + preload）。
// --smoke 冒烟模式：无头窗口 + mock 服务就绪 + 渲染端加载完成后向 stdout 打一行 JSON 并退出
// （自动化冒烟；窗口交互/拖拽等 GUI 项仍需真机人工验收，见 docs/issue-log/OPEN.md）。
import { app, BrowserWindow } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, registerBridgeIpc, type Bridge } from './bridge.js';
import { ServeManager } from './serve-manager.js';
import type { ConnectionStatus, StatusDetail, WsFrame } from '../shared/protocol.js';

const SMOKE = process.argv.includes('--smoke');

/** serve CLI 入口：dev = 仓库内 packages/cli/dist（tsc 产物）；打包 = extraResources 的
 *  cli 单文件 bundle（esbuild 产出，零 node_modules 依赖，ELECTRON_RUN_AS_NODE 运行） */
function resolveCliEntry(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'cli', 'harness2-cli.cjs');
  return join(__dirname, '..', '..', '..', 'cli', 'dist', 'index.js');
}

/** 仓库根（dev 模式的 serve --root：工具执行 cwd + 会话分组） */
function resolveRepoRoot(): string {
  return join(__dirname, '..', '..', '..');
}

interface DesktopHandles {
  serve: ServeManager;
  bridge: Bridge;
  win: BrowserWindow;
  /** serve 首次 connected（或启动失败 reject） */
  ready: Promise<{ port: number }>;
}

function startDesktop(opts: { show: boolean; provider: 'mock' | 'config'; home?: string }): DesktopHandles {
  const home = opts.home ?? homedir();
  let resolveReady!: (v: { port: number }) => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<{ port: number }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const sendStatus = (status: ConnectionStatus, detail?: StatusDetail): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('harness2:status', status, detail);
    }
  };
  const sendEvent = (frame: WsFrame): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('harness2:event', frame);
    }
  };

  const serve = new ServeManager({
    cliEntry: resolveCliEntry(),
    root: resolveRepoRoot(),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    provider: opts.provider,
    onStatus: (status, detail) => {
      if (status === 'connected' && detail?.port !== undefined) {
        bridge.connectWs(); // 首次就绪与断线重启后都重连事件通道
        resolveReady({ port: detail.port });
      }
      sendStatus(status, detail);
    },
  });

  const bridge = createBridge({ serve, root: resolveRepoRoot(), home, sendEvent, sendStatus });
  registerBridgeIpc(bridge);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: opts.show,
    title: 'harness2',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true, // 红线：渲染进程零 Node
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.on('preload-error', (_e, path, err) => {
    console.error(JSON.stringify({ level: 'preload-error', path, message: err.message }));
  });
  void win.loadFile(join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));

  serve
    .start()
    .then(({ port }) => {
      // 端口就绪事件已由 onStatus 触发 connectWs；此处仅做失败兜底
      void port;
    })
    .catch((e: Error) => {
      sendStatus('offline', { error: e.message });
      rejectReady(e);
    });

  app.on('before-quit', () => {
    bridge.disconnectWs();
    void serve.stop();
  });

  return { serve, bridge, win, ready };
}

// —— smoke 冒烟模式：stdout 一行 JSON {ok, port, rendererLoaded, error?}，exit 0/1 ——
interface SmokeResult {
  ok: boolean;
  port?: number;
  rendererLoaded: boolean;
  /** preload 桥是否真实暴露 window.harness2（webContents.executeJavaScript 校验） */
  bridgeReady: boolean;
  error?: string;
}

async function runSmoke(): Promise<void> {
  const result: SmokeResult = { ok: false, rendererLoaded: false, bridgeReady: false };
  let handles: DesktopHandles | null = null;
  let code = 1;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    console.log(JSON.stringify(result));
    void (async () => {
      if (handles !== null) {
        handles.bridge.disconnectWs();
        await handles.serve.stop().catch(() => {});
      }
      try {
        rmSync(smokeHome, { recursive: true, force: true });
      } catch {
        // temp 清理失败不阻塞退出
      }
      app.exit(code);
    })();
  };
  const timeout = setTimeout(() => {
    result.error = result.error ?? 'smoke 超时（40s）';
    finish();
  }, 40000);

  const smokeHome = mkdtempSync(join(tmpdir(), 'h2-smoke-home-')); // 独立 home：不碰真实 ~/.harness2（锁/会话）
  try {
    await app.whenReady();
    handles = startDesktop({ show: false, provider: 'mock', home: smokeHome });
    handles.win.webContents.on('did-finish-load', () => {
      result.rendererLoaded = true;
    });
    const { port } = await handles.ready;
    result.port = port;
    // 等渲染端加载，然后校验 preload 桥真实暴露（渲染端零 Node的出口存在且可用）
    for (let i = 0; i < 50 && !result.rendererLoaded; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const bridgeType = await handles.win.webContents.executeJavaScript('typeof window.harness2');
    result.bridgeReady = bridgeType === 'object';
    result.ok = result.rendererLoaded && result.bridgeReady;
    code = result.ok ? 0 : 1;
  } catch (e) {
    result.error = (e as Error).message;
    code = 1;
  }
  clearTimeout(timeout);
  finish();
}

if (SMOKE) {
  void runSmoke();
} else {
  void app.whenReady().then(() => {
    startDesktop({ show: true, provider: process.env['H2_PROVIDER'] === 'mock' ? 'mock' : 'config' });
  });
  app.on('window-all-closed', () => {
    app.quit();
  });
}
