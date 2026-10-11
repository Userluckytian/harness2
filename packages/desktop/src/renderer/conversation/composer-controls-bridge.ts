// composer-controls-bridge.ts — Z3-04（Z-94）composer 控件的数据桥（桌面壳接线棒）。
//
// 职责：把 `settings:getConfig` / `settings:updateConfig` 两条既有 IPC 通道适配成 composer
// 的 `modeSwitch` / `modelSelect` props（ui-shared 只收 props，不抓 IPC）。
//
// ⚠️ 如实差异（写给每个改动者）：
//   * 模型（roles.main）与权限模式（approval.mode）都是 **config 级**选择，写的是全局
//     config.json（白名单深合并，desktop config-file.ts），影响**之后的会话**；运行中会话
//     是否跟进取决于 core 读配置时机 —— UI 只如实反映 config 当前值，不声称「本会话已切换」。
//   * 数据源选型：`settings:getConfig`（而非 `settings:getModels`）。理由：
//       1) 它就是写回路径（updateConfig 响应直接回带合并后的新 config 视图）——读、写、
//          刷新同源，无第二次 IPC；
//       2) composer 需要的字段（roles.main / providers.<channel>.models 键集 / approval.mode）
//          它都有；getModels 的增量价值（displayName 覆层、凭据态、revision 乐观锁）属于
//          设置页的编辑场景，composer 只做选择不需要；
//       3) Z-94 的 trigger 本就是「provider 前缀 + 模型名」，config 的 channel id + model id
//          恰好就是该形状。
//   * 写回失败不静默吞掉也不假装成功：console.error 记录 + config 保持旧值（trigger 显示
//     的仍是生效配置）。桌面壳当前无全局 toast 通道，弹层提示留待 toast 宿主落地（受限项）。
//   * config 缓存只存模块内存（不落任何浏览器存储 —— D-14）。
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type {
  ComposerModeSwitchProps,
  ComposerModelSelectProps,
} from '@harness2/ui-shared/renderer/conversation/composer/Composer.js';
import {
  approvalModePatch,
  buildModelMenu,
  modelSelectionPatch,
} from '@harness2/ui-shared/renderer/conversation/composer/composer-config.js';
import type { SettingsConfigShape } from '../../shared/protocol.js';
import { openSettingsAtSection } from '../layout/shell-overlays.js';
import { MODELS_SECTION_ID } from '../settings/shell/contributions.js';

// —— 模块级 config 缓存（多席位共享一次 IPC；只存内存，D-14） ——

let cached: SettingsConfigShape | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function peekComposerConfig(): SettingsConfigShape | null {
  return cached;
}

export function subscribeComposerConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 首载（幂等；并发调用共享同一在途 Promise）。失败不缓存——下次挂载重试。 */
export function loadComposerConfig(): Promise<void> {
  if (cached !== null) return Promise.resolve();
  if (inflight === null) {
    // Promise.resolve().then 包一层：桥缺失（旧宿主/测试桩无 settingsGetConfig）时调用
    // 同步抛 TypeError，也要落进同一 catch（如实记录、不缓存），绝不炸调用方渲染。
    inflight = Promise.resolve()
      .then(() => window.harness2.settingsGetConfig())
      .then((config) => {
        cached = config;
        emit();
      })
      .catch((error: unknown) => {
        console.error('[composer-controls] 读取 config 失败（控件将保持不渲染）', error);
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** 写 config（白名单 patch 深合并）；成功即用响应回带的新 config 视图刷新缓存（无第二次 IPC） */
export async function patchComposerConfig(patch: Record<string, unknown>): Promise<void> {
  const res = await window.harness2.settingsUpdateConfig(patch);
  if (!res.ok) throw new Error(res.error ?? '配置写入失败');
  if (res.config !== undefined) {
    cached = res.config;
    emit();
  }
}

function logPatchError(error: unknown): void {
  console.error('[composer-controls] 配置写入失败（config 保持旧值）', error);
}

/** 订阅 + 触发首载的 hook（多席位各自调用，加载被模块缓存去重） */
export function useComposerConfig(): SettingsConfigShape | null {
  useEffect(() => {
    void loadComposerConfig();
  }, []);
  return useSyncExternalStore(subscribeComposerConfig, peekComposerConfig, peekComposerConfig);
}

// —— props 装配 ——

/** composer 左右簇控件 props（均可选；undefined = 控件不渲染） */
export interface ComposerControls {
  readonly modelSelect?: ComposerModelSelectProps;
  readonly modeSwitch?: ComposerModeSwitchProps;
}

/**
 * 由 config 视图装配 composer 控件 props：
 *   - `roles.main` 缺失 → 不出模型选择（没有「当前模型」可如实展示）；
 *   - 权限模式恒可切换（未设置时按 core 缺省 default 展示与写盘）。
 */
export function composerControlsOf(config: SettingsConfigShape | null): ComposerControls {
  if (config === null) return {};
  if ((globalThis as { __Z304_DISABLE__?: boolean }).__Z304_DISABLE__ === true) return {};
  const role = config.roles?.main;
  const modelSelect = role === undefined ? undefined : buildModelSelect(config, role);
  const modeSwitch: ComposerModeSwitchProps = {
    mode: config.approval?.mode,
    onModeChange: (mode) => {
      void patchComposerConfig(approvalModePatch(mode)).catch(logPatchError);
    },
  };
  return {
    ...(modelSelect !== undefined ? { modelSelect } : {}),
    modeSwitch,
  };
}

function buildModelSelect(
  config: SettingsConfigShape,
  role: { channel: string; model: string },
): ComposerModelSelectProps | undefined {
  const menu = buildModelMenu(config);
  if (menu === undefined) return undefined;
  return {
    menu,
    onSelectModel: (target) => {
      void patchComposerConfig(modelSelectionPatch(role, target)).catch(logPatchError);
    },
    // 桌面壳有设置弹窗 → 直达「模型配置」分区；web 壳无此通道（composer-controls-bridge 仅桌面接线）
    onManageModels: () => openSettingsAtSection(MODELS_SECTION_ID),
  };
}

/** 壳层一次取齐两个控件的 props（记忆化：config 引用不变就不重算） */
export function useComposerControls(): ComposerControls {
  const config = useComposerConfig();
  return useMemo(() => composerControlsOf(config), [config]);
}

/**
 * 仅测试可见的缓存重置（不进生产调用面）：模块级缓存是生产语义（多席位共享一次 IPC），
 * vitest ESM 无模块重置，测试用它恢复「未载入」初态。命名带 `_` 前缀 + 显式注释，防误用。
 */
export function _resetComposerConfigForTest(): void {
  cached = null;
  inflight = null;
}
