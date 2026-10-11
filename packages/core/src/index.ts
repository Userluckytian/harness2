// @harness2/core —— 会话内核（事件日志、投影、轨迹）+ agent loop + 工具系统 + Provider 缝。
export * from './session/types.js';
// D02 事件类型开放化（2026-10-11）加性导出：扩展事件类型注册表 + 扩展事件解析。
export * from './session/extension-events.js';
export * from './session/writer.js';
export * from './session/reader.js';
export * from './session/snapshots.js';
export * from './session/manager.js';
export * from './session/undo.js';
// Z6-A17（2026-10-11）加性导出：bash 副作用清单查询（undo/redo 结果携带；GUI 警告条数据源）。
export * from './session/bashCommands.js';
export * from './session/fork.js';
export * from './session/export.js';
// P7-B（2026-09-14）H-11～H-14 会话能力补齐：纯加性导出（新模块，无删除/改名/种类变更）。
export * from './session/searchIndex.js';
export * from './session/layeredCompaction.js';
export * from './session/portability.js';
export * from './session/titles.js';
export * from './session/capabilities.js';
export * from './trajectory/view.js';
export * from './provider/types.js';
export * from './provider/mock.js';
export * from './provider/openai.js';
export * from './provider/anthropic.js';
export * from './provider/factory.js';
// Z6 批次2（2026-10-11）加性导出：A01 模型动态发现 + A03 推理档位映射（纯加性新模块）。
export * from './provider/discover.js';
export * from './provider/reasoning.js';
export * from './interaction/types.js';
export * from './interaction/run-config.js';
export * from './interaction/plan-state.js';
export * from './interaction/execution-view.js';
export * from './interaction/change-review.js';
export * from './interaction/steer-sink.js';
export * from './config/index.js';
export * from './config/report.js';
export * from './tools/types.js';
export * from './tools/registry.js';
export * from './tools/executor.js';
export * from './tools/inventory.js';
export * from './tools/toolsets.js';
export * from './tools/selection.js';
export * from './tools/manage.js';
export * from './tools/rpc.js';
export * from './tools/rpc-stdio.js';
export * from './tools/script.js';
export * from './tools/predefined/index.js';
export * from './tools/predefined/browser.js';
export * from './approval/policy.js';
// Z6-A16（2026-10-11）加性导出：权限规则 DSL 的 glob 匹配（* / ?，自写小函数）。
export * from './approval/glob.js';
// P7-D（2026-09-14）H-44 / H-66～H-68：特权请求流（sudo/secret）+ 统一 flow 契约/状态机/审计。
// 纯加性导出（新模块），配套更新 api-surface 基线。
export * from './approval/privileged.js';
export * from './flows/index.js';
export * from './memory/store.js';
export * from './memory/tool.js';
export * from './memory/pending.js';
export * from './memory/nudge.js';
export * from './memory/mode.js';
export * from './skills/store.js';
export * from './skills/tool.js';
export * from './skills/authoring.js';
export * from './agent/types.js';
export * from './agent/compaction.js';
// Z6-A05（2026-10-11）加性导出：压缩断路器（连续失败熔断，会话级状态）。
export * from './agent/compactionBreaker.js';
export * from './agent/contextUsage.js';
export * from './agent/loop.js';
export * from './agent/subagent.js';
export * from './agent/subagent-fanout.js';
export * from './server/sessions.js';
export * from './server/http.js';
export * from './server/ws.js';
export * from './server/trust.js';
export * from './cron/index.js';
export * from './plugins/types.js';
export * from './plugins/loader.js';
export * from './plugins/bus.js';
export * from './mcp/client.js';
export * from './doctor/index.js';
export * from './doctor/crash.js';
export * from './commands/index.js';
// D02 服务容器（2026-10-11）加性导出：ServiceContainer + createCoreContainer（内建挂两注册表）。
export * from './container.js';

export { CORE_VERSION } from './version.js';
