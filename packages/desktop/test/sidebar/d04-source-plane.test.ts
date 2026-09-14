// D-04 源平面拆分（P4-② 补缺：侧栏面）。
// B 棒 `sidebar/**` 与 A 棒 `layout/**` + `slots/**` 同属浏览器渲染面，同样不得 import
// 宿主侧（main / preload / electron）。既有守门只扫了 layout/ 与 slots/
// （见 test/layout/no-persistence.test.ts 第 3 条），本用例把 P4 新增的 sidebar/ 也纳入，
// 避免「新包漏扫」——渲染进程零 Node，越界 import 会在打包后直接炸。
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sidebarDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'sidebar');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|css|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('源平面拆分（D-04）：侧栏不 import 宿主侧', () => {
  it('sidebar/** 不出现 main / preload / electron 的 import', () => {
    const hits: string[] = [];
    for (const file of walk(sidebarDir)) {
      const text = readFileSync(file, 'utf8');
      if (/from '\.\.?\/(main|preload)\//.test(text) || /from 'electron'/.test(text)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });

  it('sidebar/** 不碰浏览器存储（D-14 口径同样适用于侧栏面）', () => {
    const hits: string[] = [];
    for (const file of walk(sidebarDir)) {
      const text = readFileSync(file, 'utf8');
      if (/localStorage|sessionStorage|indexedDB/.test(text)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});
