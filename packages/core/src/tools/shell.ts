// Windows shell 探测（A1-1）：bash 工具在 Windows 上不再硬走 cmd.exe。
//
// 探测顺序（高 → 低）：
//   1. config.bash.shell（用户显式指定；见 config/schema.ts）；
//   2. Git Bash：GIT_BASH 环境变量（可直接指向 bash.exe，或 Git 安装根目录）→ 常见安装路径；
//   3. cmd.exe 回退（保持旧行为，错误可读；输出解码见 process-output.ts）。
//
// POSIX 一律走 Node 的 shell:true（/bin/sh -c），行为与改造前完全一致。
// 本模块只做「选哪个 shell」，不执行命令；实际 spawn 在 predefined/bash.ts。
import { existsSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { CONFIG_FILE_NAME, HARNESS_DIR, loadConfig } from '../config/load.js';

export type BashShellKind = 'posix' | 'configured' | 'git-bash' | 'cmd';

export interface BashShellSpec {
  kind: BashShellKind;
  /** 展示用（doctor / 错误消息）：说明最终选了哪个 shell 以及为什么 */
  display: string;
  /** 可执行文件：git-bash/configured 直接 spawn；cmd/posix 交给 Node 的 shell:true */
  executable: string;
  /** 直接 spawn 时的参数前缀（命令字符串追加在其后） */
  argsPrefix: string[];
  /** true = 用 Node 的 shell:true 解释命令（POSIX /bin/sh、Windows cmd.exe） */
  useNodeShell: boolean;
}

export interface ResolveBashShellOptions {
  /** config.bash.shell（最高优先级；空串/纯空白视为未配置） */
  configured?: string | undefined;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** 存在性探测（测试注入；缺省 fs.existsSync） */
  exists?: (path: string) => boolean;
}

/** 是否把配置值当作 cmd.exe（而非 bash 兼容 shell） */
function isCmdExecutable(value: string): boolean {
  return /(^|[\\/])cmd(\.exe)?$/i.test(value.trim());
}

/** 把 GIT_BASH 的值归一为 bash.exe 路径（允许给安装根目录或直接给 bash.exe） */
function normalizeGitBashEnv(value: string): string | undefined {
  const raw = value.trim();
  if (raw.length === 0) return undefined;
  if (/bash\.exe$/i.test(raw)) return raw;
  return win32.join(raw, 'bin', 'bash.exe');
}

/** 常见 Git for Windows 安装位置（含 64/32 位与用户级安装）+ PATH 里的 Git bash.exe
 *  （Git 装在非 C 盘时 ProgramFiles 推不出来，PATH 是可靠的第二来源） */
function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [
    env['GIT_BASH'] !== undefined ? normalizeGitBashEnv(env['GIT_BASH']) : undefined,
    env['ProgramFiles'] !== undefined ? win32.join(env['ProgramFiles'], 'Git') : undefined,
    env['ProgramW6432'] !== undefined ? win32.join(env['ProgramW6432'], 'Git') : undefined,
    env['ProgramFiles(x86)'] !== undefined ? win32.join(env['ProgramFiles(x86)'], 'Git') : undefined,
    env['LOCALAPPDATA'] !== undefined ? win32.join(env['LOCALAPPDATA'], 'Programs', 'Git') : undefined,
    'C:\\Program Files\\Git',
    'C:\\Program Files (x86)\\Git',
  ];
  const out: string[] = [];
  for (const root of roots) {
    if (root === undefined) continue;
    out.push(root); // GIT_BASH 直接给 bash.exe 时 root 就是可执行文件
    out.push(win32.join(root, 'bin', 'bash.exe'));
    out.push(win32.join(root, 'usr', 'bin', 'bash.exe'));
  }
  // PATH 中的 Git 目录（仅限路径含 git，避免误选 WSL / 其它 bash）。
  // 注意：PATH 里通常只有 `...\Git\cmd`（git.exe 所在），bash.exe 在兄弟目录 bin\ 与 usr\bin\，
  // 因此除了 entry 自身，还要用 dirname(entry) 推出 Git 安装根目录再拼一次（Git 装在非 C 盘时这是唯一可靠来源）。
  for (const raw of (env['PATH'] ?? '').split(win32.delimiter)) {
    const entry = raw.trim().replace(/^"|"$/g, '');
    if (entry.length === 0 || !/git/i.test(entry)) continue;
    out.push(win32.join(entry, 'bash.exe'));
    const root = win32.dirname(entry);
    out.push(win32.join(root, 'bin', 'bash.exe'));
    out.push(win32.join(root, 'usr', 'bin', 'bash.exe'));
  }
  return [...new Set(out)];
}

/** 探测顺序：config.bash.shell > Git Bash（GIT_BASH / 常见路径）> cmd 回退 */
export function resolveBashShell(options: ResolveBashShellOptions = {}): BashShellSpec {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  if (platform !== 'win32') {
    return {
      kind: 'posix',
      display: '/bin/sh（POSIX 默认，Node shell:true）',
      executable: '/bin/sh',
      argsPrefix: [],
      useNodeShell: true,
    };
  }

  const configured = options.configured?.trim();
  if (configured !== undefined && configured.length > 0) {
    if (isCmdExecutable(configured)) {
      return {
        kind: 'configured',
        display: `${configured}（config.bash.shell）`,
        executable: configured,
        argsPrefix: [],
        useNodeShell: true,
      };
    }
    return {
      kind: 'configured',
      display: `${configured}（config.bash.shell）`,
      executable: configured,
      argsPrefix: ['-c'],
      useNodeShell: false,
    };
  }

  for (const candidate of gitBashCandidates(env)) {
    if (candidate.toLowerCase().endsWith('bash.exe') && exists(candidate)) {
      const fromEnv = candidate === normalizeGitBashEnv(env['GIT_BASH'] ?? '');
      return {
        kind: 'git-bash',
        display: `${candidate}（Git Bash${fromEnv ? '，来自 GIT_BASH' : ''}）`,
        executable: candidate,
        argsPrefix: ['-c'],
        useNodeShell: false,
      };
    }
  }

  const cmd = env['ComSpec'] !== undefined && env['ComSpec'].trim().length > 0 ? env['ComSpec'] : 'cmd.exe';
  return {
    kind: 'cmd',
    display: `${cmd}（未找到 Git Bash，回退 cmd.exe）`,
    executable: cmd,
    argsPrefix: [],
    useNodeShell: true,
  };
}

/** 从 startDir 逐级向上找最近的 .harness2/config.json（项目配置发现，与多数工具同口径） */
export function findProjectConfigPath(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, HARNESS_DIR, CONFIG_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * 读取 config.bash.shell（bash 工具每次执行时解析；配置改动无需重启进程）。
 * 全局 ~/.harness2/config.json 始终参与合并；项目配置从会话 cwd 逐级向上发现。
 * 任何加载/解析异常都吞掉并返回 undefined——shell 探测失败不能拖垮工具执行
 * （doctor 会如实报告；bash 仍可用 Git Bash/cmd 回退）。
 */
export function loadConfiguredBashShell(startDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const projectPath = findProjectConfigPath(startDir);
    const loaded = loadConfig({
      root: startDir,
      env,
      ...(projectPath !== undefined ? { projectPath } : {}),
    });
    return loaded.config?.bash?.shell;
  } catch {
    return undefined;
  }
}
