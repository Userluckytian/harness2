// 分屏布局持久化（主进程）：~/.harness2/desktop-layout.json 读写。
// 读容错：文件缺失/损坏/形状非法 → defaultLayout（normalizeLayout 统一校验）；
// 写前先 normalize（防 IPC 侧传入非法结构落盘）。公共读写逻辑见 json-file.ts（B2 抽取共用）。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultLayout, normalizeLayout, type DesktopLayout } from '../shared/layout.js';
import { readJsonWithDefault, writeJsonNormalized } from './json-file.js';

export const LAYOUT_FILE = 'desktop-layout.json';

export function layoutFilePath(home: string): string {
  return join(home, '.harness2', LAYOUT_FILE);
}

export function readLayout(home: string): DesktopLayout {
  return readJsonWithDefault(layoutFilePath(home), normalizeLayout, defaultLayout);
}

export function writeLayout(home: string, layout: unknown): DesktopLayout {
  return writeJsonNormalized(layoutFilePath(home), layout, normalizeLayout);
}

/** 默认 home（进程级；测试不依赖） */
export function defaultHome(): string {
  return homedir();
}
