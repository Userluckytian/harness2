// Electron 主进程入口：spawn serve → 桥接 IPC → 创建窗口（contextIsolation + preload）。
// --smoke 冒烟模式：无头窗口 + mock 服务就绪 + 渲染端加载完成后向 stdout 打一行 JSON 并退出
// （自动化冒烟；窗口交互/拖拽等 GUI 项仍需真机人工验收，见 docs/issue-log/OPEN.md）。
import { app, BrowserWindow, Menu, dialog, nativeImage, nativeTheme, Tray } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, registerBridgeIpc, type Bridge } from './bridge.js';
import { ServeManager } from './serve-manager.js';
import { createCloseWindowHandler } from './close-window-handler.js';
import { startTerminal, stopTerminal } from './terminal.js';
import { resolveDefaultWorkspaceRoot } from './workspace-root.js';
import { createTray, type TrayHandle } from './tray.js';
import { createQuitIntent, decideWindowClose, resolveCloseToTray, type QuitIntent } from './window-lifecycle.js';
import { readPreferences } from './preferences-file.js';
import type {
  ConnectionStatus,
  SettingsEventFrame,
  StatusDetail,
  TerminalEventFrame,
  TrayUiEvent,
  WsFrame,
} from '../shared/protocol.js';
import { IPC_TRAY_EVENT, IPC_WINDOW_STATE } from '../shared/protocol.js';

const SMOKE = process.argv.includes('--smoke');

/** serve CLI 入口：dev = 仓库内 packages/cli/dist（tsc 产物）；打包 = extraResources 的
 *  cli 单文件 bundle（esbuild 产出，零 node_modules 依赖，ELECTRON_RUN_AS_NODE 运行） */
function resolveCliEntry(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'cli', 'harness2-cli.cjs');
  return join(__dirname, '..', '..', '..', 'cli', 'dist', 'index.js');
}

/** 默认工作区根（serve --root：工具执行 cwd + 无 cwd 新建会话的分组根 + 终端根）。
 *  R0-3②：旧 resolveRepoRoot 打包态解析到安装目录（缺陷），现委托纯函数：
 *  dev = 仓库根（harness2/），打包态 = 用户主目录。见 workspace-root.ts。 */
function defaultWorkspaceRoot(): string {
  return resolveDefaultWorkspaceRoot({ isPackaged: app.isPackaged, dirname: __dirname, homeDir: homedir() });
}

interface DesktopHandles {
  serve: ServeManager;
  bridge: Bridge;
  win: BrowserWindow;
  /** Z-47：托盘句柄（null = 平台门不通过 / 创建失败 / smoke 不建）；tray:status 与关窗裁决据此 */
  tray: TrayHandle | null;
  /** 显式退出意图（托盘「退出」mark → quit；对话框取消回滚） */
  quitIntent: QuitIntent;
  /** serve 首次 connected（或启动失败 reject） */
  ready: Promise<{ port: number }>;
}

function startDesktop(opts: {
  show: boolean;
  provider: 'mock' | 'config';
  home?: string;
  /** Z-47：创建系统托盘（smoke 传 false：无头环境不建托盘，保证退出干净） */
  tray: boolean;
}): DesktopHandles {
  const home = opts.home ?? homedir();
  /** R0-3②：默认工作区根（serve --root / bridge deps.root / terminal root 共用一处求值） */
  const workspaceRoot = defaultWorkspaceRoot();
  /** D4：渲染端上报的运行态（关窗口提示依据） */
  const runtime = { busy: false, runningTurns: 0, backgroundTasks: 0 };
  /** Z-47：显式退出意图（托盘「退出」mark → app.quit；D4 对话框放弃退出经 onQuitAborted 回滚） */
  const quitIntent = createQuitIntent();
  /** Z-47：托盘句柄（下方窗口创建后按平台门/smoke 决定；null = 驻留能力不可用） */
  let trayHandle: TrayHandle | null = null;
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
  // P6-B（D-58）：设置域事件通道（模型配置页订阅 settings/credentials/llm/connection，不轮询）。
  // 通道名与 shared/protocol.ts 的 IPC_SETTINGS_EVENT 一致（preload 内联，protocol.test 静态校验）。
  const sendSettingsEvent = (frame: SettingsEventFrame): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('harness2:settings-event', frame);
    }
  };
  // Z9-3：终端事件通道（data/exit）；终端管理器为进程级单例，PTY 仅在渲染端显式 open 时创建。
  const sendTerminalEvent = (frame: TerminalEventFrame): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('harness2:terminal-event', frame);
    }
  };
  // Z-47：托盘 → 渲染端事件通道（新建会话/添加项目意图；T3 接监听，无监听者静默不报错）
  const sendTrayEvent = (event: TrayUiEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_TRAY_EVENT, event);
    }
  };

  const serve = new ServeManager({
    cliEntry: resolveCliEntry(),
    root: workspaceRoot,
    home, // home = opts.home ?? homedir()（上方已计算）：dev 启动也有 home，serve.lock token 可读、健康检查可过
    provider: opts.provider,
    onStatus: (status, detail) => {
      if (status === 'connected' && detail?.port !== undefined) {
        bridge.connectWs(); // 首次就绪与断线重启后都重连事件通道
        resolveReady({ port: detail.port });
      }
      sendStatus(status, detail);
    },
  });

  const bridge = createBridge({
    serve,
    root: workspaceRoot,
    home,
    sendEvent,
    sendStatus,
    sendSettingsEvent,
    // D4：渲染端上报运行态 → 关窗口前提示（关 UI 不等于停任务）
    setBusy: (info) => {
      runtime.busy = info.busy;
      runtime.runningTurns = info.runningTurns;
      runtime.backgroundTasks = info.backgroundTasks;
    },
    // Z-47：tray:status 读托盘创建结果（trayHandle 在窗口创建后赋值，闭包晚绑定安全）
    isTrayCreated: () => trayHandle !== null,
  });
  registerBridgeIpc(bridge);
  // Z9-3：启动进程级终端传输（core TerminalManager 单例；不 spawn 任何 PTY 直到 open）
  startTerminal({ root: workspaceRoot, sendEvent: sendTerminalEvent });

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: opts.show,
    title: 'harness2',
    // Z1-05：加载期底色对齐 Zai token，避免首帧白闪（默认偏好 system，按系统深浅取底色）
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161616' : '#f8f8f8',
    // Z2-01b（Z-02 / Z-04）：无独立标题栏 ——
    //   macOS 保留系统红绿灯（隐藏标题栏，渲染端留 96px 安全区）；
    //   Windows / Linux 无边框，窗口控件由渲染端自绘（ConversationHeader 右侧）。
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : { frame: false }),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true, // 红线：渲染进程零 Node
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Z2-01b：最大化/还原状态推给渲染端（linux 最大化去圆角 + 窗控图标切换）
  const sendWindowState = (): void => {
    const state = { maximized: win.isMaximized() };
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(IPC_WINDOW_STATE, state);
    }
  };
  win.on('maximize', sendWindowState);
  win.on('unmaximize', sendWindowState);
  win.webContents.on('preload-error', (_e, path, err) => {
    console.error(JSON.stringify({ level: 'preload-error', path, message: err.message }));
  });
  // B1 保留调试能力：移除应用菜单后默认加速键不再注册，
  // 手动挂 Ctrl+Shift+I / Cmd+Opt+I 打开 DevTools（渲染层零 Node 不受影响）。
  win.webContents.on('before-input-event', (event, input) => {
    const isDevtoolsKey =
      input.type === 'keyDown' &&
      input.key.toLowerCase() === 'i' &&
      ((process.platform === 'darwin' && input.meta && input.alt) ||
        (process.platform !== 'darwin' && input.control && input.shift));
    if (isDevtoolsKey) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });
  void win.loadFile(join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));

  // —— Z-47：系统托盘（win32/linux；mac 不建，关窗语义维持现状）+ 关窗裁决三重门 ——
  // smoke 不建（opts.tray=false）：无头环境避免托盘残留，保证 {ok:true} 后 exit 0 干净。
  if (opts.tray) {
    trayHandle = createTray({
      platform: process.platform,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      dirname: __dirname,
      loadIcon: (p) => nativeImage.createFromPath(p),
      createTrayInstance: (image) => new Tray(image as unknown as Electron.NativeImage),
      buildMenu: (items) => Menu.buildFromTemplate(items),
      actions: {
        // 左键/双击/「打开 harness2」= show + focus 主窗（从最小化恢复；不是 toggle 隐藏）
        showMainWindow: () => {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        },
        newSession: () => sendTrayEvent({ type: 'tray:new-session' }),
        addProject: () => sendTrayEvent({ type: 'tray:add-project' }),
        // 「关于」（复审 P1-1）：系统关于面板，版本号取 app.getVersion()（不硬编码）
        showAbout: () => {
          app.setAboutPanelOptions({
            applicationName: 'harness2',
            applicationVersion: app.getVersion(),
            copyright: 'harness2',
          });
          app.showAboutPanel();
        },
        // 退出写法（Z-47）：先 markExplicitQuit 再 app.quit——防止被「关窗即隐藏」吞掉
        quit: () => {
          quitIntent.mark('tray-quit');
          app.quit();
        },
      },
    });
  }
  /** 关窗裁决（纯函数核见 window-lifecycle.ts）：hide 驻留托盘 or 放行既有 D4 链路 */
  const closeToTrayEnabled = (): boolean => resolveCloseToTray(readPreferences(home).closeToTray, process.platform);
  /** D4「请求停止并退出」进入最终 close 时置真：二次 close 事件不得再被 hide 门吞回（否则永远退不出） */
  let forceClosing = false;

  // D4/PD8：关窗口 ≠ 已停止任务。决策接线提取到 close-window-handler（依赖注入，可自动化测试）。
  // Z-47 前置裁决：托盘驻留三重门全过 → hide + preventDefault（不进 D4 对话框，窗口仍在）；
  // 否则维持现状：放行 close 事件 → close-window-handler（busy 对话框 → 最后窗口销毁 → quit）。
  const closeWindowHandler = createCloseWindowHandler({
    runtime: () => runtime,
    showDialog: (opts) => dialog.showMessageBox(win, opts),
    minimize: () => win.minimize(),
    requestStopAll: () => win.webContents.send('harness2:stop-all'),
    close: () => {
      forceClosing = true;
      win.close();
    },
    scheduleClose: (fn) => setTimeout(fn, 400),
    onQuitAborted: () => {
      // 用户取消 / 保持后台 / 弹窗失败：本次不会退出 → 回滚显式标志
      // （否则陈旧的 tray-quit 标志会让后续关窗绕过 hide 裁决）
      quitIntent.rollback();
    },
  });
  win.on('close', (event) => {
    if (!forceClosing) {
      const action = decideWindowClose({
        platform: process.platform,
        closeToTrayEnabled: closeToTrayEnabled(),
        trayCreated: trayHandle !== null,
        explicitQuit: quitIntent.isExplicit(),
      });
      if (action === 'hide-to-tray') {
        event.preventDefault();
        win.hide();
        return;
      }
    }
    closeWindowHandler(event);
  });

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
    stopTerminal();
    void serve.stop();
  });

  return { serve, bridge, win, tray: trayHandle, quitIntent, ready };
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
  // 提前声明（finish 闭包引用）：若 40s 超时在 smokeHome 初始化前触发（如 mkdtempSync 抛错），
  // 闭包读到的是 null 而非 TDZ ReferenceError
  let smokeHome: string | null = null;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    console.log(JSON.stringify(result));
    void (async () => {
      if (handles !== null) {
        handles.bridge.disconnectWs();
        stopTerminal();
        await handles.serve.stop().catch(() => {});
      }
      try {
        if (smokeHome !== null) rmSync(smokeHome, { recursive: true, force: true });
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

  const home = mkdtempSync(join(tmpdir(), 'h2-smoke-home-')); // 独立 home：不碰真实 ~/.harness2（锁/会话）
  smokeHome = home;
  try {
    await app.whenReady();
    // Z-47：smoke 不建托盘（无头环境驻留无意义，且保证退出干净）
    handles = startDesktop({ show: false, provider: 'mock', home, tray: false });
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
    // B1 菜单精简：移除 File/Edit/View/Window/Help 整套默认菜单。
    // 非 macOS 直接移除整个应用菜单；macOS 系统菜单栏需保留一项 App 菜单
    // （含关于/退出/开发者工具三条，保留 Ctrl+Shift+I 调试能力）。
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: app.name,
            submenu: [
              { role: 'about', label: '关于 harness2' },
              { type: 'separator' },
              { role: 'quit', label: '退出 harness2' },
              { type: 'separator' },
              { role: 'toggleDevTools', label: '开发者工具' },
            ],
          },
        ]),
      );
    } else {
      Menu.setApplicationMenu(null);
    }
    startDesktop({ show: true, provider: process.env['H2_PROVIDER'] === 'mock' ? 'mock' : 'config', tray: true });
  });
  // window-all-closed：关窗裁决（Z-47）在 win.on('close') 已先行拦截 hide 驻留路径；
  // 能走到这里说明是真关闭（托盘退出/设置关/平台门不过）→ 维持既有 quit 语义。
  app.on('window-all-closed', () => {
    app.quit();
  });
}
