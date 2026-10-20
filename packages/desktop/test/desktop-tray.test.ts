// Z-47 托盘测试（注入式，零 Electron 运行时）：fake Tray/Menu/loadIcon 覆盖
// 平台门（mac 不建）、图标空/构造抛错 → null、tooltip、菜单模板顺序与 label、
// 「导出日志」占位 disabled（不许静默没反应）、左键/双击 = show+focus（不 toggle）、
// 菜单动作转发（newSession/addProject/quit 各回调一次）。
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildTrayMenuTemplate,
  createTray,
  resolveTrayIconPath,
  TRAY_LABELS,
  TRAY_TOOLTIP,
  type TrayActions,
  type TrayDeps,
  type TrayInstanceLike,
  type TrayMenuItem,
} from '../src/main/tray.js';

class FakeTray implements TrayInstanceLike {
  toolTip = '';
  contextMenu: unknown = null;
  destroyed = 0;
  handlers = new Map<string, Array<() => void>>();
  setToolTip(toolTip: string): void {
    this.toolTip = toolTip;
  }
  setContextMenu(menu: unknown): void {
    this.contextMenu = menu;
  }
  on(event: 'click' | 'double-click', handler: () => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  destroy(): void {
    this.destroyed += 1;
  }
  fire(event: 'click' | 'double-click'): void {
    for (const h of this.handlers.get(event) ?? []) h();
  }
}

function makeActions(): TrayActions {
  return {
    showMainWindow: vi.fn(),
    newSession: vi.fn(),
    addProject: vi.fn(),
    showAbout: vi.fn(),
    quit: vi.fn(),
  };
}

interface FakeEnv {
  deps: TrayDeps;
  tray: FakeTray;
  actions: ReturnType<typeof makeActions>;
  menuItems: TrayMenuItem[];
}

function makeEnv(overrides: Partial<TrayDeps> = {}): FakeEnv {
  const actions = makeActions();
  const tray = new FakeTray();
  const menuItems: TrayMenuItem[] = [];
  const deps: TrayDeps = {
    platform: 'win32',
    isPackaged: false,
    resourcesPath: 'C:\\resources',
    dirname: 'D:\\repo\\packages\\desktop\\dist-electron\\main',
    loadIcon: () => ({ isEmpty: () => false }),
    createTrayInstance: () => tray,
    buildMenu: (items) => {
      menuItems.push(...items);
      return { items };
    },
    actions,
    ...overrides,
  };
  return { deps, tray, actions, menuItems };
}

describe('resolveTrayIconPath（Z-47：打包 resources/tray_icon.ico / dev assets/icon.ico）', () => {
  it('打包态 = resourcesPath 下 tray_icon.ico（electron-builder extraResources 映射）', () => {
    expect(resolveTrayIconPath({ isPackaged: true, resourcesPath: '/app/resources', dirname: '/irrelevant' })).toMatch(
      /tray_icon\.ico$/,
    );
  });
  it('dev 态 = desktop/assets/icon.ico（从 dist-electron/main 上跳两级；平台中立路径）', () => {
    // 断言不得硬编码 Windows 反斜杠 dirname：path.join 在 POSIX 不把 \ 当分隔符（CI linux/mac 必红，2026-10-20 实证）。
    // dirname 语义 = src/main 的 ESM 模块 dirname(import.meta.url)——测试用当前平台风格任意合法前缀构造。
    const fakeRoot = join(process.cwd(), 'desktop-dev-test-root');
    const p = resolveTrayIconPath({
      isPackaged: false,
      resourcesPath: join(fakeRoot, 'irrelevant'),
      dirname: join(fakeRoot, 'packages', 'desktop', 'dist-electron', 'main'),
    });
    expect(p).toBe(join(fakeRoot, 'packages', 'desktop', 'assets', 'icon.ico'));
  });
});

describe('createTray 平台门与失败回落', () => {
  it('darwin 不创建托盘（mac 走 Dock，Z-47）', () => {
    const env = makeEnv({ platform: 'darwin' });
    expect(createTray(env.deps)).toBeNull();
    expect(env.tray.destroyed).toBe(0);
    expect(env.menuItems.length).toBe(0);
  });
  it('未知平台（freebsd）不创建', () => {
    expect(createTray(makeEnv({ platform: 'freebsd' }).deps)).toBeNull();
  });
  it('图标为空（资源缺失）→ null，不构造 Tray', () => {
    const create = vi.fn();
    const env = makeEnv({ loadIcon: () => ({ isEmpty: () => true }), createTrayInstance: create });
    expect(createTray(env.deps)).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
  it('图标加载抛错 → null', () => {
    const env = makeEnv({
      loadIcon: () => {
        throw new Error('ico unreadable');
      },
    });
    expect(createTray(env.deps)).toBeNull();
  });
  it('Tray 构造抛错（平台无托盘能力）→ null（创建失败如实上报，关窗走确认退出）', () => {
    const env = makeEnv({
      createTrayInstance: () => {
        throw new Error('no tray support');
      },
    });
    expect(createTray(env.deps)).toBeNull();
  });
  it('win32 / linux 创建成功：tooltip「harness2」、contextMenu 已挂、destroy 幂等可用', () => {
    for (const platform of ['win32', 'linux']) {
      const env = makeEnv({ platform });
      const handle = createTray(env.deps);
      expect(handle).not.toBeNull();
      expect(env.tray.toolTip).toBe(TRAY_TOOLTIP);
      expect(env.tray.toolTip).toBe('harness2');
      expect(env.tray.contextMenu).not.toBeNull();
      handle?.destroy();
      expect(env.tray.destroyed).toBe(1);
    }
  });
});

describe('托盘右键菜单（顺序照 Z-47）', () => {
  it('模板顺序与 label：打开 harness2 ┃ 新建会话 / 添加项目 ┃ 分隔 ┃ 关于 / 导出日志(disabled) ┃ 分隔 ┃ 退出', () => {
    const items = buildTrayMenuTemplate(makeActions());
    expect(items.map((i) => (i.type === 'separator' ? '──' : i.label))).toEqual([
      TRAY_LABELS.open,
      TRAY_LABELS.newSession,
      TRAY_LABELS.addProject,
      '──',
      TRAY_LABELS.about,
      TRAY_LABELS.exportLogs,
      '──',
      TRAY_LABELS.quit,
    ]);
    // 导出日志：占位 disabled（现无成体系日志落盘通道——要么能点要么灰，不静默没反应）
    expect(items[5]?.enabled).toBe(false);
    // 其余可点项不携带 disabled
    for (const idx of [0, 1, 2, 4, 7]) expect(items[idx]?.enabled).toBeUndefined();
  });

  it('创建后 contextMenu 即此模板（经注入 buildMenu 断言真实接线）', () => {
    const env = makeEnv();
    createTray(env.deps);
    expect(env.menuItems.length).toBe(8);
  });

  it('菜单动作：新建会话/添加项目 → 对应 actions；关于 → showAbout()；退出 → quit()（main 侧 mark+app.quit）', () => {
    const env = makeEnv();
    createTray(env.deps);
    const items = env.menuItems;
    items[0]?.click?.(); // 打开 harness2
    expect(env.actions.showMainWindow).toHaveBeenCalledTimes(1);
    items[1]?.click?.(); // 新建会话
    expect(env.actions.newSession).toHaveBeenCalledTimes(1);
    items[2]?.click?.(); // 添加项目
    expect(env.actions.addProject).toHaveBeenCalledTimes(1);
    items[4]?.click?.(); // 关于
    expect(env.actions.showAbout).toHaveBeenCalledTimes(1);
    items[7]?.click?.(); // 退出
    expect(env.actions.quit).toHaveBeenCalledTimes(1);
  });
});

describe('左键/双击 = show + focus 主窗（不是 toggle 隐藏，Z-47）', () => {
  it('click 与 double-click 均触发 showMainWindow', () => {
    const env = makeEnv();
    createTray(env.deps);
    env.tray.fire('click');
    env.tray.fire('double-click');
    expect(env.actions.showMainWindow).toHaveBeenCalledTimes(2);
    // 不 toggle：没有任何 hide/quit 旁路动作被触发
    expect(env.actions.quit).not.toHaveBeenCalled();
  });
});
