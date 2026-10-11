// 设置分区贡献注册表（D-6x「通过席位或 ctx 注入」的落点）。
//
// 用途：让**能力模块**（如 B 棒的 `settings/models`）在自身模块里注册设置分区，
// 而不必让壳反过来 import 它（方向正确的依赖：能力 → 壳的注册面，壳不依赖能力）。
// 未注册时分区仍存在（宿主给的内建分区），注册后退化为「同名 id 覆盖内建正文」。
//
// 只存内存、不落任何浏览器存储（D-14 口径）；注册表引用在无变化时稳定，便于 React 订阅。
import type { SettingsSectionContribution, SettingsSectionDefinition } from './section-model.js';
import { sortSections } from './section-model.js';

/** 模型配置分区的 id（B 棒 `settings/models` 的落点；D-50～D-59、D-85） */
export const MODELS_SECTION_ID = 'models';

const contributions: SettingsSectionContribution[] = [];
let cache: readonly SettingsSectionContribution[] | null = null;

/** 当前已注册的分区贡献快照（order 升序；无变化时同一引用） */
export function settingsSectionContributions(): readonly SettingsSectionContribution[] {
  if (cache === null) cache = Object.freeze(sortSections(contributions));
  return cache;
}

/**
 * 注册一份分区贡献；返回**幂等 disposer**。
 * 同一 id 重复注册（含与内建分区撞 id）视为「接管」：后注册者覆盖，不再并存两份正文。
 */
export function registerSettingsSection(contribution: SettingsSectionContribution): () => void {
  const index = contributions.findIndex((c) => c.id === contribution.id);
  if (index >= 0) contributions.splice(index, 1); // 接管：保持「同 id 只一份」
  contributions.push(contribution);
  cache = null;
  let disposed = false;
  return () => {
    if (disposed) return; // 幂等 disposer
    disposed = true;
    const i = contributions.indexOf(contribution);
    if (i < 0) return;
    contributions.splice(i, 1);
    cache = null;
  };
}

/** 取某 id 的分区贡献（未注册 → undefined；宿主据此决定用内建正文还是显式占位） */
export function findSettingsSection(id: string): SettingsSectionContribution | undefined {
  return settingsSectionContributions().find((c) => c.id === id);
}

/** 清空全部贡献（测试 / 壳重挂载用；幂等） */
export function resetSettingsSections(): void {
  if (contributions.length === 0) return;
  contributions.length = 0;
  cache = null;
}

/**
 * 分区贡献 → 分区声明（把「组件 + 静态 props」折成壳认的形状）。
 * 组件只收到宿主事实 `{ active: true }`（只有激活分区会被渲染）。
 */
export function sectionFromContribution(contribution: SettingsSectionContribution): SettingsSectionDefinition {
  const { component, props, ...meta } = contribution;
  return {
    ...meta,
    render: () => {
      const Comp = component;
      return <Comp {...(props ?? {})} active />;
    },
  };
}
