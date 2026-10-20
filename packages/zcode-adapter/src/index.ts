/**
 * @harness2/zcode-adapter —— ZCode 壳后端适配层（ZS1 骨架）
 *
 * - `createHarness2Services()`：57 频道桩注册（A/B/C 分类见 channel-registry）
 * - `host-entry.ts`：桩 host 进程入口（经 build/host-bundle.mjs 打包为独立 bundle，
 *   由壳 main 进程经 ZS1_HOST_MODULE_PATH 环境变量注入）
 *
 * 类型与运行时依赖：ZS1 scratch 构建区（Apache-2.0，随附 LICENSE-ZCODE.md）。
 */
export { createStubService, notImplementedError, type StubClassification, type StubSpec } from "./stub-factory.js";
export { CHANNEL_REGISTRY, assertRegistryMatchesServiceChannels, type ChannelRegistryEntry } from "./channel-registry.js";
export { createHarness2Services, type Harness2ServicesResult } from "./createHarness2Services.js";
