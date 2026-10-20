// Z-47 / 复审 P1-2（Z-47 能力双条件门）：Linux 托盘能力探测（纯函数，零 Electron 依赖）。
//
// 背景：Electron 的 new Tray() 在无托盘 host 的 Linux 桌面（典型：GNOME 未装 AppIndicator
// 扩展）上通常**构造不抛错但图标不可见**——静默失败。若关窗裁决只看「托盘创建成功」，
// 窗口隐藏后没有任何入口可唤回（失联）。故 linux 必须额外探测 session DBus 上
// org.kde.StatusNotifierWatcher 是否有 owner；win32 无此概念恒 true，darwin 不用托盘恒 true。
// 手法出处：D:/AI_Projects/refs/ZCode/packages/desktop/src/main/desktopTraySupport.ts:38-76
// （三级回退 gdbus → busctl → qdbus，任一给出明确结果即采纳，全部失败按「不可用」安全默认）。
//
// 可测性：execFile 经 deps 注入（真实实现由 main.ts 用 promisify(childProcess.execFile) 包装），
// vitest 喂 fake 即可覆盖首路命中 / ENOENT 回退 / 三路全败 / 三路全缺失，不真起子进程。

/** 被探测的托盘 host 服务名（StatusNotifierItem 规范 watcher） */
const STATUS_NOTIFIER_WATCHER = 'org.kde.StatusNotifierWatcher';

export interface TraySupportDeps {
  /** process.platform（注入而非直读，平台门可在 vitest 全覆盖） */
  platform: NodeJS.Platform;
  /** 执行外部命令并返回 stdout（真实 = promisify(execFile)；失败/命令缺失一律 reject） */
  execFile: (cmd: string, args: string[]) => Promise<unknown>;
}

/** 依次尝试的探测工具：gdbus（GNOME 系标配）→ busctl（systemd 系标配）→ qdbus（QT 系） */
const PROBE_COMMANDS: ReadonlyArray<{ cmd: string; args: string[] }> = [
  {
    cmd: 'gdbus',
    args: [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.DBus',
      '--object-path',
      '/org/freedesktop/DBus',
      '--method',
      'org.freedesktop.DBus.ListNames',
    ],
  },
  { cmd: 'busctl', args: ['--user', 'list'] },
  {
    cmd: 'qdbus',
    args: ['org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames'],
  },
];

/** 从命令输出裁决 watcher 是否在位：含服务名 → true；空输出 → null（交给下一路）；其余 → false */
function hasWatcherInOutput(stdout: string): boolean | null {
  const text = stdout.trim();
  if (!text) return null;
  // 命令成功执行但输出里没有 watcher 名 = 桌面没有托盘 host；安全默认按不可用处理
  return text.includes(STATUS_NOTIFIER_WATCHER);
}

/**
 * Linux 托盘能力探测：
 *   非 linux → 恒 true（win32 托盘始终可用；darwin 走 Dock，不进本门）；
 *   linux → gdbus → busctl → qdbus 依次试，任一给出明确结果即采纳；
 *   三路全失败/全命令缺失（ENOENT）→ false（安全默认：绝不允许隐藏后失联）。
 */
export async function probeTraySupport(deps: TraySupportDeps): Promise<boolean> {
  if (deps.platform !== 'linux') return true;
  for (const probe of PROBE_COMMANDS) {
    try {
      const result = await deps.execFile(probe.cmd, probe.args);
      const stdout = typeof result === 'string' ? result : ((result as { stdout?: unknown })?.stdout ?? '');
      const verdict = hasWatcherInOutput(String(stdout));
      if (verdict !== null) return verdict;
    } catch {
      // 工具缺失 / DBus 会话不可用 / 超时：换下一路
    }
  }
  return false;
}
