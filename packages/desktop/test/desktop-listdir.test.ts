// PD7（D-P2）：工作区只读列目录 IPC —— 安全敏感（P0 级门禁项）。
// 威胁模型：渲染进程被攻破后经 preload 白名单 IPC 枚举用户文件系统。
// 防线：①preload 只透传一个窄命令（不暴露通用 fs）；②主进程根恒为 serve --root（主进程持有，
// 渲染端不可指定）；③仅接受相对路径，字符串层先拒 NUL/绝对路径/`..`；④realpath（解析符号链接
// 与 Windows junction）之后核对边界，链接到根外一律拒绝；⑤只 readdir+dirent 类型，不读内容。
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { listWorkspaceDir } from '../src/main/workspace-fs.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'h2-ls-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# hi', 'utf8');
  writeFileSync(join(root, 'src', 'a.ts'), 'export {};', 'utf8');
  return root;
}

describe('listWorkspaceDir：正常列举', () => {
  it('根目录与相对子目录均可列举；目录优先 + 名称稳定排序；无 .tmp 等写入行为', () => {
    const root = makeWorkspace();
    const listing = listWorkspaceDir(root, '');
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(listing.entries.map((e) => e.name)).toEqual(['docs', 'src', 'README.md']); // 目录优先、字典序
    expect(listing.entries.map((e) => e.kind)).toEqual(['dir', 'dir', 'file']);
    expect(listing.truncated).toBe(false);

    const sub = listWorkspaceDir(root, 'src/');
    expect(sub.ok).toBe(true);
    if (!sub.ok) return;
    expect(sub.entries).toEqual([{ name: 'a.ts', kind: 'file' }]);
    expect(listWorkspaceDir(root, '.').ok).toBe(true); // 当前目录段等价根
  });
});

describe('listWorkspaceDir：越界拒绝矩阵', () => {
  it('`..` 段（含深嵌套与结尾变体）一律拒绝', () => {
    const root = makeWorkspace();
    for (const p of ['..', '../', '../outside', 'src/../../outside', 'a/..', 'a/../..', '..\\..\\x']) {
      const r = listWorkspaceDir(root, p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('越界');
    }
  });

  it('绝对路径（Windows 盘符 / POSIX 斜根 / UNC）与 NUL 字节拒绝', () => {
    const root = makeWorkspace();
    for (const p of ['C:\\Users', 'C:/Users', '/etc', '//server/share', 'src\0/..', 'a\0']) {
      const r = listWorkspaceDir(root, p);
      expect(r.ok).toBe(false);
    }
  });

  it('符号链接 / junction 指向工作区外 → realpath 边界拒绝；指向工作区内 → 放行', () => {
    const root = makeWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'h2-ls-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'x', 'utf8');
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      symlinkSync(outside, join(root, 'escape'), type); // 根内链接 → 根外
      symlinkSync(join(root, 'src'), join(root, 'inside'), type); // 根内链接 → 根内
    } catch {
      // 无符号链接权限的环境跳过该用例（CI 有权限；个别沙箱例外）
      return;
    }
    const escaped = listWorkspaceDir(root, 'escape');
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.error).toContain('越界');

    const inside = listWorkspaceDir(root, 'inside');
    expect(inside.ok).toBe(true); // 链接目标在根内：合法
  });

  it('不存在的目录 / 非目录目标 → 明确报错（不臆造空列表）', () => {
    const root = makeWorkspace();
    const missing = listWorkspaceDir(root, 'no/such/dir');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('不存在');
    const notDir = listWorkspaceDir(root, 'README.md');
    expect(notDir.ok).toBe(false);
  });

  it('根不存在 → 明确报错', () => {
    const r = listWorkspaceDir(join(tmpdir(), 'h2-ls-nonexistent-zz'), '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('工作区根');
  });
});

describe('listDir IPC 面（preload 白名单 + 主进程接线）', () => {
  it('preload 白名单含 listDir 且只透传 invoke（静态一致性校验）', () => {
    const preloadSrc = readFileSync(join(process.cwd(), 'src/preload/preload.ts'), 'utf8');
    expect(preloadSrc).toContain("cmd: 'listDir'");
    expect(preloadSrc).not.toMatch(/require\(['"]node:fs['"]\)/); // 不暴露通用 fs
    const bridgeSrc = readFileSync(join(process.cwd(), 'src/main/bridge.ts'), 'utf8');
    expect(bridgeSrc).toContain('listWorkspaceDir(deps.root'); // 根由主进程持有
  });
});
