// R0-3② / §81 取证二：桌面端「默认工作区根」解析（纯函数，可注入两态）。
//
// 旧实现 `resolveRepoRoot()` = `join(__dirname, '..','..','..')`，注释写「仓库根」但两态都不对：
//   - 打包态：__dirname = `<install>/resources/app.asar/dist-electron/main` → 上三级 = **安装目录
//     `resources/`**（缺陷证据 §81：用户会话 cwd 落在 `D:\Program Files\harness2\resources`，
//     模型开局翻安装包文件）；
//   - dev 态：__dirname = `packages/desktop/dist-electron/main` → 上三级 = `packages/`（也非仓库根，
//     再上一级才是 `harness2/`）。
//
// 现按语义拆成可注入纯函数，两态各自明确（调用点：serve --root、bridge deps.root、terminal root）：
//   - dev（未打包）：上跳 **4 级**到仓库根（dist-electron/main → desktop → packages → 仓库根）；
//   - 打包态：回落 `os.homedir()`（安装目录绝不能当工作区，用户主目录才是合理落点）。
// 纯函数化是为 C3 用例注入 isPackaged/dirname 断言两态，避免测主进程入口的 Electron 副作用。
import { join } from 'node:path';

export interface WorkspaceRootEnv {
  /** app.isPackaged（注入而非直读，便于单测两态） */
  isPackaged: boolean;
  /** 主进程 __dirname（dev = `.../packages/desktop/dist-electron/main`） */
  dirname: string;
  /** 打包态回落的用户主目录（os.homedir()） */
  homeDir: string;
}

/** dev 态从 __dirname 上跳到仓库根的层级数（现产物布局：dist-electron/main → desktop → packages → 仓库根） */
const DEV_REPO_ROOT_HOPS = 4;

/** 解析桌面默认工作区根（serve 工具执行 cwd + 无 cwd 时新建会话的分组根）。 */
export function resolveDefaultWorkspaceRoot(env: WorkspaceRootEnv): string {
  if (env.isPackaged) return env.homeDir;
  const hops: string[] = [];
  for (let i = 0; i < DEV_REPO_ROOT_HOPS; i += 1) hops.push('..');
  return join(env.dirname, ...hops);
}
