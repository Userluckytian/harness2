// web-composer-controls.tsx — Z10-2b composer 左右簇控件（web）的数据桥。
//
// 与桌面 `composer-controls-bridge.ts` 同职责，但走 **serve 设置端口**（web 无 window.harness2）：
//   * 读：`GET /api/settings/config`（A2 已落地，经 `WebSettingsDataPorts.getConfig` 适配为
//     `SettingsConfigShape`）→ 模型菜单（providers/roles.main）与权限模式（approval.mode）；
//   * 写：`PUT /api/settings/config`（白名单顶层 key 深合并，含 roles / approval）→ 切换模型/模式；
//   * 响应回带合并后的新 config 视图 → 直接刷新缓存（无第二次请求），订阅者重渲。
//
// ⚠️ 如实差异（红线⑩，写给每个改动者）：
//   * **思考档位在 web 已接通**（Z10-2b 后续）：core `readSettingsConfigView` 现回 `roles.*.effort` 与
//     模型 `providers.<c>.models.<m>.reasoning`，serve 客户端 `mapServeConfigPayload` 逐字保留 → 本壳
//     用 ui-shared `buildThoughtLevel` 装配档位控件，Ctrl+T（`webCycleComposerThoughtLevel`）写回
//     `roles.main.effort`（同一 PUT 白名单路径）。模型未声明 `reasoning.values` 时如实不出档位控件。
//   * 「管理模型」入口不渲染：web 无「打开设置并直达模型分区」通道（桌面经 openSettingsAtSection）。
//   * config 缓存只存模块内存（不落任何浏览器存储 —— D-14）。
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type {
  ComposerModeSwitchProps,
  ComposerModelSelectProps,
  ComposerThoughtLevelProps,
} from '@harness2/ui-shared/renderer/conversation/composer/Composer.js';
import {
  approvalModePatch,
  buildModelMenu,
  buildThoughtLevel,
  firstAvailableModel,
  modelSelectionPatch,
  nextApprovalMode,
  nextThoughtLevel,
  thoughtLevelPatch,
  COMPOSER_MAIN_ROLE,
} from '@harness2/ui-shared/renderer/conversation/composer/composer-config.js';
import type { ComposerModelRef } from '@harness2/ui-shared/renderer/conversation/composer/composer-config.js';
import type { SettingsConfigShape } from '@harness2/ui-shared/shared/settings.js';
import type { WebSettingsDataPorts } from './web-settings.js';

/** web composer 控件 props（与桌面 ComposerControls 同形） */
export interface WebComposerControls {
  readonly modelSelect?: ComposerModelSelectProps;
  readonly modeSwitch?: ComposerModeSwitchProps;
  /** 思考档位（模型声明了 `reasoning.values` 才出；未声明 = 不渲染，如实） */
  readonly thoughtLevel?: ComposerThoughtLevelProps;
}

// —— 模块级 config 缓存（多席位共享一次请求；只存内存，D-14） ——

let cached: SettingsConfigShape | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function peekWebComposerConfig(): SettingsConfigShape | null {
  return cached;
}

export function subscribeWebComposerConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 首载（幂等；并发调用共享同一在途 Promise）。失败不缓存——下次挂载重试。 */
export function loadWebComposerConfig(ports: WebSettingsDataPorts): Promise<void> {
  if (cached !== null) return Promise.resolve();
  if (inflight === null) {
    inflight = Promise.resolve()
      .then(() => ports.getConfig())
      .then((config) => {
        cached = config;
        emit();
      })
      .catch((error: unknown) => {
        console.error('[web-composer-controls] 读取 config 失败（控件将保持不渲染）', error);
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** 写 config（白名单 patch 深合并）；成功即用响应回带的新 config 视图刷新缓存（无第二次请求） */
async function patchWebConfig(ports: WebSettingsDataPorts, patch: Record<string, unknown>): Promise<void> {
  const res = await ports.updateConfig(patch);
  if (!res.ok) throw new Error(res.error ?? '配置写入失败');
  if (res.config !== undefined) {
    cached = res.config;
    emit();
  }
}

/** 订阅 + 触发首载的 hook（各席位各自调用，加载被模块缓存去重） */
export function useWebComposerConfig(ports: WebSettingsDataPorts | undefined): SettingsConfigShape | null {
  useEffect(() => {
    if (ports !== undefined) void loadWebComposerConfig(ports);
  }, [ports]);
  return useSyncExternalStore(subscribeWebComposerConfig, peekWebComposerConfig, peekWebComposerConfig);
}

/**
 * 由 config 视图装配控件 props：
 *   - config 未载入（null）→ 空对象（控件不渲染）；
 *   - 模型选择初值 = roles.main（优先），缺失回落 providers 列表首项（3b，两壳同口径）；
 *     无任何 provider/models 声明才不出模型选择；权限模式恒可切换；
 *   - 思考档位仅当所引模型声明了 `reasoning.values` 才出（无档位可选时不摆控件，如实）。
 */
export function webComposerControlsOf(
  config: SettingsConfigShape | null,
  ports: WebSettingsDataPorts,
): WebComposerControls {
  if (config === null) return {};
  const role: ComposerModelRef | undefined = config.roles?.main ?? firstAvailableModel(config);
  const modelSelect: ComposerModelSelectProps | undefined =
    role === undefined
      ? undefined
      : (() => {
          const menu = buildModelMenu(config, role);
          if (menu === undefined) return undefined;
          return {
            menu,
            onSelectModel: (target) => {
              void patchWebConfig(ports, modelSelectionPatch(role, target)).catch((e: unknown) =>
                console.error('[web-composer-controls] 模型切换写回失败（config 保持旧值）', e),
              );
            },
            // web 无「打开设置直达模型分区」通道 → 不摆「管理模型」死入口（红线⑩）
          };
        })();
  const modeSwitch: ComposerModeSwitchProps = {
    mode: config.approval?.mode,
    onModeChange: (mode) => {
      void patchWebConfig(ports, approvalModePatch(mode)).catch((e: unknown) =>
        console.error('[web-composer-controls] 模式切换写回失败（config 保持旧值）', e),
      );
    },
  };
  const thoughtLevel = buildThoughtLevel(config);
  return {
    ...(modelSelect !== undefined ? { modelSelect } : {}),
    modeSwitch,
    ...(thoughtLevel !== undefined && role !== undefined
      ? {
          thoughtLevel: {
            current: thoughtLevel.current,
            values: thoughtLevel.values,
            onSelectLevel: (level) => {
              void patchWebConfig(ports, thoughtLevelPatch(COMPOSER_MAIN_ROLE, role, level)).catch((e: unknown) =>
                console.error('[web-composer-controls] 思考档位写回失败（config 保持旧值）', e),
              );
            },
          } satisfies ComposerThoughtLevelProps,
        }
      : {}),
  };
}

/** web 会话席位处装配控件 props（config 未载入或端口缺失 = 返回空对象，控件不渲染） */
export function useWebComposerControls(ports: WebSettingsDataPorts | undefined): WebComposerControls {
  const config = useWebComposerConfig(ports);
  return useMemo(() => (ports === undefined ? {} : webComposerControlsOf(config, ports)), [config, ports]);
}

/**
 * Ctrl+Shift+M（Z-94 cycleSessionMode，web）：按 config 当前 `approval.mode` 循环到下一模式并写回。
 * 端口缺失 → 无操作；config 未载入 → 先载入再循环（写路径与控件同一 PUT，不新造第二套状态）。
 */
export function webCycleComposerMode(ports: WebSettingsDataPorts | undefined): void {
  if (ports === undefined) return;
  void loadWebComposerConfig(ports)
    .then(() => {
      if (cached === null) return undefined;
      return patchWebConfig(ports, approvalModePatch(nextApprovalMode(cached.approval?.mode)));
    })
    .catch((e: unknown) => console.error('[web-composer-controls] 模式循环写回失败', e));
}

/**
 * Ctrl+T（Z-94 cycleThoughtLevel，web）：按模型声明的档位顺序循环到下一档并写回 `roles.main.effort`。
 * 端口缺失 → 无操作；config 未载入 → 先载入再循环；模型未声明档位 / 档位不足两档 → 无操作（如实，不假造）。
 * 写路径与档位控件同一 PUT（白名单 roles 深合并），不新造第二套状态。
 */
export function webCycleComposerThoughtLevel(ports: WebSettingsDataPorts | undefined): void {
  if (ports === undefined) return;
  void loadWebComposerConfig(ports)
    .then(() => {
      if (cached === null) return undefined;
      const level = buildThoughtLevel(cached);
      if (level === undefined) return undefined;
      const next = nextThoughtLevel(level.current, level.values);
      if (next === undefined) return undefined;
      const role = cached.roles?.[COMPOSER_MAIN_ROLE];
      if (role === undefined) return undefined;
      return patchWebConfig(ports, thoughtLevelPatch(COMPOSER_MAIN_ROLE, role, next));
    })
    .catch((e: unknown) => console.error('[web-composer-controls] 思考档位循环写回失败', e));
}

/** 仅测试可见：重置模块级缓存（vitest ESM 无模块重置）。命名带 `_` 前缀防误用。 */
export function _resetWebComposerConfigForTest(): void {
  cached = null;
  inflight = null;
}
