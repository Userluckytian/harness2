// 主进程 → @harness2/core 的 CJS/ESM 桥（B2 引入的 core 复用点都经这里）。
// 原因：desktop 主进程编译产物是 CommonJS（package.json "type": "commonjs"），
// 而 @harness2/core 是 ESM-only（"type": "module"，exports 无 require 分支）。
// 运行时 Node ≥22 支持 require(esm)，但 tsc 的 Node16 模式禁止 CJS 静态 import ESM，
// 故集中用 createRequire 加载一次；类型经 `typeof import(..., resolution-mode: import)`
// 保留（CJS 文件对 ESM 做类型导入必须带 resolution-mode 属性）。
import { createRequire } from 'node:module';

const requireCore = createRequire(__filename);

const core = requireCore('@harness2/core') as typeof import('@harness2/core', { with: { 'resolution-mode': 'import' } });

export const {
  defaultConfigPaths,
  deepMerge,
  loadConfig,
  parseConfig,
  readAuthFile,
  writeAuthFile,
  redactSecrets,
  runDoctor,
  crashReportDir,
  getContextUsage,
  DEFAULT_BROWSER_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_PLUGINS_CONFIG,
  DEFAULT_SUBAGENT_CONFIG,
} = core;

export type { AuthFile, HarnessConfig, ProviderConfig } from '@harness2/core' with { 'resolution-mode': 'import' };