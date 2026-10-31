// process-env.ts — 子进程安全环境白名单（P1-2 审查统一：单一共享出口）。
//
// 背景：core 的 bash/script/grep/browser 与 cli 的 status-line runner / tui shell-exec
// 曾各自维护一份逐字重复的 buildSafeEnv（finding #305 / #5942 / #5989 引入），白名单
// 缺 USERPROFILE / HOMEDRIVE / HOMEPATH / PATHEXT / TMPDIR 等系统变量，弱于
// hooks/executor.ts 的 buildHookEnv。本文件收编为单一 helper：白名单 = 6 份副本清单
// ∪ buildHookEnv 系统变量集 ∪ 审查建议补充，只增不删。

/**
 * 子进程安全环境白名单（**唯一共享出口**，测试与实现同源）：
 *   - Shell 解析与系统运行必需：PATH / PATHEXT / ComSpec / SystemRoot（SYSTEMROOT）/
 *     SystemDrive（SYSTEMDRIVE）/ windir / OS / TEMP / TMP / TMPDIR / HOME /
 *     USERPROFILE / HOMEDRIVE / HOMEPATH；
 *   - Windows 常用系统目录与架构：PROGRAMFILES / APPDATA / LOCALAPPDATA /
 *     ALLUSERSPROFILE / PROCESSOR_ARCHITECTURE；
 *   - Git Bash 与 locale：GIT_BASH / LANG / LC_ALL；POSIX 用户标识：USER / USERNAME。
 * 显式不含任何宿主业务密钥变量（API key / token / 凭据等）——未列入的一律不透传。
 *
 * 大小写口径：Windows 环境变量名不区分大小写（Node 在 win32 上大小写不敏感访问），
 * 历史上 6 份副本用 SYSTEMROOT/SYSTEMDRIVE 大写、buildHookEnv 用 SystemRoot/SystemDrive——
 * 两形并留（POSIX 上这些变量本就不存在，多列无害，且满足并集「只增不删」）。
 *
 * @param base 环境源（缺省 process.env；测试注入构造 env，不污染宿主）
 */
export function buildSubprocessSafeEnv(base: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const whitelist = [
    // shell 解析与系统运行必需
    'PATH',
    'PATHEXT',
    'ComSpec',
    'windir',
    'OS',
    // 临时目录
    'TEMP',
    'TMP',
    'TMPDIR',
    // 用户主目录（POSIX + Windows 两套口径）
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    // Windows 系统根（历史两形并留，见函数注）
    'SystemRoot',
    'SYSTEMROOT',
    'SystemDrive',
    'SYSTEMDRIVE',
    // Windows 常用系统目录与架构（审查建议补充）
    'PROGRAMFILES',
    'APPDATA',
    'LOCALAPPDATA',
    'ALLUSERSPROFILE',
    'PROCESSOR_ARCHITECTURE',
    // Git Bash 与 locale
    'GIT_BASH',
    'LANG',
    'LC_ALL',
    // POSIX 用户标识
    'USER',
    'USERNAME',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of whitelist) {
    const value = base[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
