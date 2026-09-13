// PD7：工作区只读列目录（文件树 IPC 的主进程实现）。安全设计（安全敏感，P0 级门禁）：
//   - **只读**：只 readdir + dirent 类型判断，不读文件内容、不写、不删、不暴露通用 fs；
//   - **单一根**：基目录恒为主进程持有的 serve --root，渲染端只能传**相对路径**（不接受绝对路径）；
//   - **字符串层先拒**：NUL 字节、绝对路径、`..` 段、反斜杠归一后的 `..` 一律拒绝（快速失败）；
//   - **realpath 边界**：对根与目标各做 realpathSync（解析符号链接 / Windows junction / 大小写），
//     解析后必须仍落在根的真实路径之内 —— 链接到工作区外的符号链接/junction 在此被拒；
//   - **限量**：单目录条目数截断（防巨目录拖垮渲染端）。
// 已知边界：条目类型用 dirent（lstat 语义，不跟随）；指向目录内或外的链接在「类型」上按链接处理时
// 如实标注 isSymlink，不假装是普通文件/目录；跨盘 rename 无关本模块（不写盘）。
import { readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface WorkspaceDirEntry {
  name: string;
  kind: 'dir' | 'file' | 'symlink' | 'other';
}

export type DirListing =
  { ok: true; path: string; entries: WorkspaceDirEntry[]; truncated: boolean } | { ok: false; error: string };

/** 单目录条目上限（超出截断并如实标注，不静默丢） */
const MAX_ENTRIES = 5000;

export function listWorkspaceDir(root: string, relativePath: string): DirListing {
  if (typeof relativePath !== 'string') return { ok: false, error: 'relativePath 必须是字符串' };
  if (relativePath.includes('\0')) return { ok: false, error: '路径非法（含 NUL 字节）' };
  if (relativePath.length > 1024) return { ok: false, error: '路径过长' };
  // 统一分隔符后逐段校验：拒绝绝对路径与 ..（ Windows 盘符/UNC 也在绝对路径判定内 ）
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized !== '' && isAbsolute(normalized)) {
    return { ok: false, error: '只允许工作区内的相对路径' };
  }
  const segments = normalized
    .split('/')
    .filter((s) => s.length > 0 && s !== '.')
    .map((s) => s);
  if (segments.some((s) => s === '..')) {
    return { ok: false, error: '路径越界（不允许 ..）' };
  }

  // 根的真实路径（根本身由主进程持有；不存在 → 明确报错）
  let baseReal: string;
  try {
    baseReal = realpathSync(root);
  } catch {
    return { ok: false, error: '工作区根不存在或不可访问' };
  }

  const target = segments.length > 0 ? join(baseReal, ...segments) : baseReal;
  let targetReal: string;
  try {
    targetReal = realpathSync(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, error: code === 'ENOENT' ? '目录不存在' : `目录不可访问: ${code ?? (e as Error).message}` };
  }

  // realpath 之后核对边界：符号链接/junction 指向根外在此被拒
  const rel = relative(baseReal, targetReal);
  const relNormalized = rel.split(sep).join('/');
  if (!(
    relNormalized === '' ||
    (!relNormalized.startsWith('../') && relNormalized !== '..' && !isAbsolute(relNormalized))
  )) {
    return { ok: false, error: '路径越界（目标经符号链接/junction 指向工作区外）' };
  }

  let dirents: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
  try {
    dirents = readdirSync(targetReal, { withFileTypes: true }) as never;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, error: code === 'ENOTDIR' ? '目标不是目录' : `列举失败: ${code ?? (e as Error).message}` };
  }

  const truncated = dirents.length > MAX_ENTRIES;
  const entries: WorkspaceDirEntry[] = dirents.slice(0, MAX_ENTRIES).map((d) => ({
    name: d.name,
    kind: d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other',
  }));
  entries.sort((a, b) => {
    if (a.kind === 'dir' && b.kind !== 'dir') return -1;
    if (a.kind !== 'dir' && b.kind === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });
  return { ok: true, path: normalized, entries, truncated };
}
