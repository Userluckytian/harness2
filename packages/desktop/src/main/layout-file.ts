// 分屏布局持久化（主进程）：~/.harness2/desktop-layout.json 读写。
// 读容错：文件缺失/损坏/形状非法 → defaultLayout（normalizeLayout 统一校验）；
// 写前先 normalize（防 IPC 侧传入非法结构落盘）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultLayout, normalizeLayout, type DesktopLayout } from '../shared/layout.js';

export const LAYOUT_FILE = 'desktop-layout.json';

export function layoutFilePath(home: string): string {
  return join(home, '.harness2', LAYOUT_FILE);
}

export function readLayout(home: string): DesktopLayout {
  const path = layoutFilePath(home);
  if (!existsSync(path)) return defaultLayout();
  try {
    return normalizeLayout(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return defaultLayout();
  }
}

export function writeLayout(home: string, layout: unknown): DesktopLayout {
  const normalized = normalizeLayout(layout);
  const path = layoutFilePath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

/** 默认 home（进程级；测试不依赖） */
export function defaultHome(): string {
  return homedir();
}
