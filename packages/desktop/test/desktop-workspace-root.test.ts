// U1 T1 / R0-3② 预算用例 C3：resolveDefaultWorkspaceRoot 两态断言（纯函数，无 Electron 依赖）。
// 缺陷证据（§81 取证二）：旧 resolveRepoRoot 打包态解析出安装目录（用户会话 cwd 落在
// `D:\Program Files\harness2\resources`，模型开局翻安装包文件）、dev 态解析出 packages/。
// 两态各钉死：dev = 仓库根（上跳层级数即缺陷本体，防止回退），打包态 = 用户主目录。
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDefaultWorkspaceRoot } from '../src/main/workspace-root.js';

describe('C3 resolveDefaultWorkspaceRoot 两态（R0-3②）', () => {
  const repoRoot = join('D:', 'AI_Projects', 'harness2');
  // dev 产物 __dirname = <repo>/packages/desktop/dist-electron/main（现 tsconfig.electron 布局）
  const devDirname = join(repoRoot, 'packages', 'desktop', 'dist-electron', 'main');

  it('dev 态 = 仓库根（上跳 4 级，钉住不回退到 packages/）', () => {
    const got = resolveDefaultWorkspaceRoot({
      isPackaged: false,
      dirname: devDirname,
      homeDir: join('C:', 'Users', 'me'),
    });
    expect(got).toBe(repoRoot);
    // 旧缺陷：上跳 3 级停在 packages/ ——显式排除
    expect(got).not.toBe(join(repoRoot, 'packages'));
  });

  it('打包态 = 用户主目录（绝不落回安装目录 resources/）', () => {
    const homeDir = join('C:', 'Users', 'me');
    const installDirname = join('D:', 'Program Files', 'harness2', 'resources', 'app.asar', 'dist-electron', 'main');
    const got = resolveDefaultWorkspaceRoot({ isPackaged: true, dirname: installDirname, homeDir });
    expect(got).toBe(homeDir);
    expect(got).not.toContain('Program Files');
  });
});
