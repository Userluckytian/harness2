// 几何/开合「不持久化」的反向守卫（D-14）。
// 计划书 P4 ③ 的审查口径：「面板几何是否真的未持久化（搜 localStorage 无命中）」——
// 这里把该口径固化成测试，任何人把几何塞进浏览器存储或旧的分屏持久化通道都会被挡住。
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rendererDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|css|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('面板几何不持久化（D-14）', () => {
  it('渲染端源码不出现 localStorage / sessionStorage / indexedDB', () => {
    const hits: string[] = [];
    for (const file of walk(rendererDir)) {
      const text = readFileSync(file, 'utf8');
      if (/localStorage|sessionStorage|indexedDB/.test(text)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });

  it('layout/ 与 slots/ 不经分屏持久化通道（saveLayout/loadLayout）保存几何', () => {
    const hits: string[] = [];
    for (const file of [...walk(join(rendererDir, 'layout')), ...walk(join(rendererDir, 'slots'))]) {
      const text = readFileSync(file, 'utf8');
      if (/saveLayout|loadLayout|draftsSet|metadataSet/.test(text)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });

  it('源平面拆分（D-04）：layout/ 与 slots/ 不 import 宿主侧（main / preload / electron）', () => {
    const hits: string[] = [];
    for (const file of [...walk(join(rendererDir, 'layout')), ...walk(join(rendererDir, 'slots'))]) {
      const text = readFileSync(file, 'utf8');
      if (/from '\.\.?\/(main|preload)\//.test(text) || /from 'electron'/.test(text)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });

  it('几何只由 React state 承载：几何纯函数无副作用（同入参同出参）', async () => {
    const { computeFrameGeometry } = await import('../../src/renderer/layout/geometry.js');
    const input = {
      viewportWidth: 1000,
      sidebarWidth: 280,
      sidebarCollapsed: false,
      rightbarOpen: true,
      rightbarWidth: 450,
    };
    const a = computeFrameGeometry(input);
    const b = computeFrameGeometry(input);
    expect(a).toEqual(b);
    // 无内建缓存：返回的是新对象（状态由调用方持有）
    expect(a).not.toBe(b);
  });
});
