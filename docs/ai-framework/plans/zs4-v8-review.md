# ZS4 V8 独立审查（补欠账）

- 审查性质：只读独立审查，未修改任何源码，未 commit
- 审查范围：`01de328`（window-controller mutateTask 接线）、`29d873a`（revisionClock + resolveModelConfig）、`c5833b8`（探针/runbook）、`616113a`（core deleteSession）、ZS4 期 task-service/archive 写面（`packages/zcode-adapter/src/real/task-*.ts`、`project-service.ts`、`provider-writes.ts`、`provider-views.ts` 非 discoverModels 段）
- 明确跳过：provider-views.ts 的 `discoverModels` / `addDiscoveredModels` / `enrichShellModelsForProvider` 段（已审两次）
- 证据：`git show` + 源码走查 + 现有测试对照；adapter 测试 151 passed，core 1637 passed（2 个超时失败为环境/超时，非本次范围）

## P0

无。未发现红线⑩「假成功」、密钥明文出口、或 deleteSession 锁被绕过/目录穿越的直接证据。deleteSession 已用 `SESSION_ID_PATTERN` 拒绝非法 id，锁占用时 `SessionLockedError` fail-closed，UI 确认路径仍由调用方负责。

## P1

1. `packages/core/src/session/manager.ts:362` — `rename`（及 `:368` `autoTitle`、`:375` `clearTitle`）未复用 `SESSION_ID_PATTERN` 校验，与 `deleteSession:428` 不一致；`locate` 直接拼接 id，`../` 可穿越到其他会话目录并改写其 `title.json`。建议在 `locate` 入口统一校验 id 形状，或在各写方法入口拒绝非法 id。
2. `packages/zcode-adapter/src/real/task-service.ts:170` — `archiveTask`/`unarchiveTask`（`:180`/`:204`/`:215`/`:238`/`:257`）直接 `manager.locate(taskId)`，未校验 taskId 形状；非法/穿越 id 会静默落到 locate 的 null/false 分支（`getTaskMeta` 返回 null、`deleteArchivedTask` 返回 false），语义上把「不存在/非法」伪装成正常空态。建议适配层统一 `validateSessionId`，非法 id 明确 throw。
3. `packages/core/src/session/manager.ts:437` — deleteSession 对 `SessionWriter.open` 的非锁异常静默吞掉后直接 `rmSync`；坏日志清理的正当性成立，但权限/IO 错误会被掩盖为「删除成功」。建议区分 `ENOENT`/权限错误，至少把非锁异常记入返回或日志，避免掩盖故障。
4. `packages/zcode-adapter/src/real/task-service.ts:194` — `renameTask` 未校验 `title` 类型与长度，`title` 为非字符串时 `manager.rename` 才在 sanitize 后抛；适配层应先拒绝非字符串/空白/超长输入，避免把类型错误推迟到 core。

## P2

1. `packages/zcode-adapter/test/task-service-write.test.ts`（01de328 追加的 42 行）覆盖：旧桩 `mutateTask` throw、`archive`、`unarchive`、`pin`、`rename`、`open` no-op、`delete`。未覆盖：`mark-read`/`mark-unread`（含 `expectedUnreadAt` 守卫）、`delete-archived` 单条、`deleteArchivedTasks` 批量经 controller、`resume` no-op、任务不存在时的返回（`getTaskMeta` null / `deleteArchivedTask` false）、运行时未知 `mutation.kind` 的穷尽分支、无 taskService 时 `deleteArchivedTask`/`deleteArchivedTasks` 仍 throw。
2. `packages/zcode-adapter/src/real/task-index.ts:53` — `writeSessionMeta` 使用固定 `.tmp` 文件名，无并发保护；多调用并发写同一会话目录可能相互覆盖。建议带 pid/nonce 或目录锁。
3. `packages/zcode-adapter/src/real/provider-views.ts:535` — `deletePersonalProvider` 的 auth 清理为 best-effort 吞错；auth 文件损坏时密钥残留，且删除已落盘。建议失败时至少返回/记录清理失败，而不是完全静默。
4. `packages/zcode-adapter/src/real/provider-views.ts:567` — `reorderPersonalProviders` 不校验 id 合法性/存在性，未知 id 被 `reorderRecord` 静默忽略，可能产生「成功但无效果」的假象。
5. `packages/zcode-adapter/src/real/provider-views.ts:332` — `enrichShellModelsForProvider` 为 fire-and-forget 且无超时/取消；目录拉取卡住时仅被外层 catch 兜底，无法观测。建议登记或加超时。
6. `packages/zcode-adapter/src/real/task-service.ts:64` — `buildMeta` 不回传 `pinned`/`archived` 字段；controller `mutateTask` 返回的 meta 在 pin/archive 后无法让 UI 直接反映状态，依赖刷新。建议按 ZCodeTaskMeta 契约补齐。

## 测试覆盖小结（01de328）

- 已测操作：archive、unarchive、pin、rename、open、delete（6 类，含旧桩 throw 断言）
- 未测操作：mark-read、mark-unread、delete-archived、deleteArchivedTasks 批量、resume、mark-read+expectedUnreadAt 守卫、缺失任务分支

## 结论

⚠️ 有条件通过（P0=0，P1=4 待闭环，P2=6 登记；V8 欠账可视为已补，但 P1 建议在下阶段或 ZS5 清偿前闭环）

## 自证（§14）

```
git status --short docs/ai-framework/plans/zs4-v8-review.md
?? docs/ai-framework/plans/zs4-v8-review.md
wc -l docs/ai-framework/plans/zs4-v8-review.md
```

> 编排者注：原代理报告尾部混入一段自述草稿残文（"Wait wc -l…"），收口时删除；条目内容经抽查核实（manager.ts:362/429、locate 拼接、task-service.ts:170 均属实）。
