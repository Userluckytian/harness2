// P6-B 模型配置页主进程侧（D-50～D-59）：**A1 起为薄适配**。
//
// A1（2026-10-11）：模型文档读/写/删 + 渠道密钥写 + 凭据状态 + 分层合并 + 校验归一 + 发现模型
// 已**下沉 core**（`@harness2/core` → `settings/models-document.ts`，单一事实源，桌面/serve 共用）。
// 本文件只经 CJS/ESM 桥（`./core.js`）把 core 同名能力与原类型别名/W 事件发射器再导出，
// 使 IPC 面、preload、既有行为与测试**零回归**；不含第二套读写/合并语义。
//
// 红线（由 core 模块执行，此处仅再声明）：
//   1) 密钥只落 ~/.harness2/auth.json 的 channels.<route>.apiKey（或环境变量）；
//   2) config.json 只持有**具名引用**（providers.<id>.envKey = <ROUTE>_API_KEY），永不持有密钥值；
//   3) 渲染端只写不回读明文——回读只有「已确认 / 已确认缺失 / 未确认」与引用名；
//   4) 所有出口（错误消息、校验告警）过 redactSecrets。
import {
  MODELS_OVERLAY_FILE,
  ackModelsDeclaration,
  deleteModelsProvider,
  deriveApiKeyRef,
  discoverModelsFor,
  normalizeProviderInput,
  readCredentialStatuses,
  readModelsDocument,
  readModelsDocumentWithLayers,
  updateModelsProvider,
  validateApiKeyInput,
  validateProviderInput,
  writeChannelKey,
} from './core.js';
import type { SettingsEventFrame } from '../shared/protocol.js';

// —— core 同名能力再导出（与下沉前桌面实现逐字同语义；测试/桥的引用面不变） ——
export {
  MODELS_OVERLAY_FILE,
  ackModelsDeclaration,
  deleteModelsProvider,
  deriveApiKeyRef,
  discoverModelsFor,
  normalizeProviderInput,
  readCredentialStatuses,
  readModelsDocument,
  readModelsDocumentWithLayers,
  updateModelsProvider,
  validateApiKeyInput,
  validateProviderInput,
  writeChannelKey,
};

// —— 请求/结果类型再导出（唯一事实源 = core `settings/models-document.ts`；形状与 ui-shared 同形） ——
export type {
  DeleteModelsRequest,
  DiscoverModelsRequest,
  DiscoveryFetch,
  ModelsDocumentContext,
  ProviderFieldIssue,
  ProviderValidationContext,
  UpdateModelsRequest,
  ValidationResult,
} from '@harness2/core' with { 'resolution-mode': 'import' };

/** 设置域事件发射器（主进程 → 渲染端；D-58 订阅而非轮询）。缺省不发射（单测直接调纯函数） */
export type SettingsEmitter = (frame: SettingsEventFrame) => void;
