# harness2 交互底座独立复核

> 作者：Notion AI 主代理。2026-09-08；本轮只读源码调研，没有运行程序、测试或性能基准；下述是源码确认的机制与由此推导的风险，不是实机故障复现报告。不读取其他协作者新写的研究/计划，不更新共享日志。

## 基线

- `D:\AI_Projects\harness2`：`main`，`b1c2d81530b794a5559a28a967129ed2d71bde7e`。本轮首次 `git status -sb` 无未提交项。
- 已包含先前 TUI + desktop 合并及后续修复；不能再用上轮 `feat/desktop-settings` 的状态作当前基线。
- 参考：grok-build `72a61251fcffb464bcc687aeb5a998e5a98ec0c9`；CodexMonitor `dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5`。
- 下述文件相对 harness2 根目录，行号按该基线；接手时按符号重新定位。

## 已确认、值得保留

1. `packages/core/src/agent/loop.ts:291-308`：每 step 从 `loadSession` / `buildChatMessages` 重建请求。保留事件溯源、单写者、快照/undo，不为复刻外观换掉整个 agent loop。
2. `packages/core/src/provider/openai.ts:209-239`：明确检查 `[DONE]`；断流报 `stream_truncated`；完整结束后才产生组装后的 tool-call。保留“半截工具参数不能执行”的安全边界。
3. `packages/core/src/tools/executor.ts:120-184` 的 `runWave`：safe 连续波次并发、unsafe 独占、同 lockKey 串行。不是完全无并发能力，应复用安全调度约束。
4. `packages/core/src/agent/subagent.ts:152-219`：独立子会话、血缘、父 signal 传播、子会话独立 SnapshotStore；`SubagentHooks` 有落盘事件和完成观察缝。`subagent_continue` 对身份与父子关系检查应继续保留。
5. `packages/core/src/server/sessions.ts:343-414`：不同会话独立运行，同会话内存消息队列串行。已有队列底座，缺的是用户可见性、确认和恢复，不应另外造一个互不相知的客户端自动发送队列。
6. `packages/cli/src/tui/useTurnStream.ts:40-67`：已有 50ms 缓冲，不是每 token 都更新 TUI；改进点在消息结构、清理和历史，而非从零加节流。

## 具体差距

### H1 — TUI 忙碌时输入与取消路径不完整（P0交互）

证据：`packages/cli/src/tui/Composer.tsx` 的 `useInput` 开头 `if (busy) return`，激活条件 `active && !busy`；Ctrl+C 逻辑同处该回调。`runInkChat.tsx:110-112` 配置 `exitOnCtrlC:false`；忙碌期另一个监听只切 reasoning（`r`）；`submit:298-330` 没有调用已有的 `runtime.abortTurn()`；该方法实际由 `chat-setup.ts:506-507` 提供，缺的是 UI 接线，不是内核没有取消能力。

判断：忙时输入草稿/排队和停止没有完整接线。不能据注释声称有 Ctrl+C 取消。空闲第一次 Ctrl+C 还会把提示文字追加进真实输入，可能污染下一条 prompt；应改成临时 footer hint。

决断：重做 Composer/focus 与 turn controller 连接，busy 不禁草稿；Esc 停当前 turn，Ctrl+C 按明示的退出协议；取消和退出分离。终端键盘编码是否支持 Shift+Enter 需真机矩阵，不作空口保证。

### H2 — TUI 历史是字符串，交互卡片无法保持（P1）

证据：`runInkChat.tsx:136-149` settled 为 `string[]`，commit 只保存 text；`Transcript.tsx:86-109` settled 进 `Static`，reasoning/tools 只在 busy 时显示。`useTurnStream.ts:73-95` 同时把工具调用写入正文缓冲，又维护 tool map。

判断：当前具备临时卡片，不是持久可交互的消息时间线；不能完成运行后继续展开 reasoning/diff 的目标。`Static` 并非固定 viewport 的虚拟化列表，不能把采用 Static 等同于真正全屏长历史导航。

决断：采用有稳定 itemId 的 typed transcript；正文、工具、reasoning、attempt、child 分离。历史可操作区域不放进不可更新的 Static。保留可退回的 legacy。

### H3 — Provider 失败立即结束，没有有界重试（P0流畅性）

证据：`packages/core/src/provider/openai.ts:149-176` 单次 fetch；`loop.ts:352-380` catch 写 assistant/attempt + step/end 后直接 return error；`provider/types.ts` ProviderError 只有 code，没有 retryAfter 等结构化信息。

判断：HTTP建连错误、429、503、首 token 后断流需要分级处理。不能给整个 runTurn 外包无限 retry，那会重复 user/message 或已执行工具。

决断：在当前 model step 内做有界 attempt 重试，未完成文本作为 provisional，失败留 attempt 不伪装完整回复。已完成工具结果保持日志权威；网络流不能接着此前半截文本盲拼。取消/鉴权/权限/拒绝不可自动重试。

### H4 — 桌面 socket 重连不等于会话恢复（P0）

证据：`packages/desktop/src/main/bridge.ts:215-252` 关闭后 1s 重连，open 仅设置 socket，没有订阅集合重发；`renderer/app-controller.ts:89-112` connected 时刷新列表，没有全量恢复选中/分栏/后台订阅。`packages/core/src/server/ws.ts:24-50` delta 无 turnId/attemptId/offset，turn-end 亦无 turnId；`subscribe:166-170` 只注册会话。

判断：断开后服务仍在运行，与服务进程重启，是两类情况；现在缺重订阅/水位/运行中 snapshot。不能把连接角标恢复算作对话恢复。

决断：引入可恢复订阅握手、连接代次、session+turn+step+attempt 标识和 chunk 水位。重连只补状态，不自动重发用户消息。服务重启不能假装恢复已经死掉的模型流/子任务。

### H5 — 重放与在途状态缺少边界（P0）

证据：`renderer/store.ts:249-260` applyReplay 直接清空 live；`applyFrame:275-292` delta 无去重直接拼接，turn-end 用日志最近 turnId 归属并清空 live。`applyFrame` 每帧 notify；`app-controller.ts:174-181` 审批响应 finally 无论成功失败都移除本地审批。

判断：切换或重放可能擦掉仍在运行的临时内容；重复/迟到 delta 无法分类；审批发送失败可能让用户失去待处理入口。需要注入延迟/乱序/断线测试确认，不宣称已实机复现。

决断：持久 seq 与 transient chunk offset 分离；snapshot+cursor 原子恢复；审批按 server ack 移除，网络失败保留卡片并可重试。

### H6 — 子代理会挡住父级继续调度（P1）

证据：`subagent.ts:133-219` startTool 没有 concurrencySafe，execute 内 await runTurn；`executor.ts:132-137` 默认 unsafe 独占。`sessions.ts:464-470` 子事件/结束上抛，但没有 child 的 token delta 观察缝；启动时 childSessionId 在最终工具结果里返回。

判断：同批多个 subagent_start 被串行执行；父级要等结果后才方便定位子会话。现有取消/快照良好，不应靠一行 concurrencySafe=true 换取无约束写并发。

决断：加 background task lifecycle（start 返回 handle，status/wait/continue/cancel 分离），启动即建立父子映射和可订阅进度；默认共享工作区含写能力子任务串行；只读过滤注册表后可限额并发；显式隔离 worktree 的写任务另行授权。

### H7 — max_steps/paused 需要用户可行动的收尾（P1）

证据：`loop.ts:278-280` maxSteps 达到后直接 break，finalText 可能为空；`loop.ts:397-401` paused 显式声明未实现续跑。

决断：本版本提供结构化结果条：已做什么、停因、保留草稿、查看任务/安全继续。不要因没有答案静默结束；不要冒充实现了厂商断点续传。

## 方案必须锁定的边界

- 网络重试只重试当前未完成 model attempt，不包围整个工具执行 turn。
- IPC/WS恢复只补事件和运行状态，不凭客户端超时推断请求没被接受。
- user message 使用 clientMessageId + 服务端确认去重；队列只有一个权威所有者。
- 工具调用在完整响应且参数合法后执行；取消后不再启动新的工具；不能保证任意第三方工具立即停下，UI区分取消请求与取消完成。
- 子任务取消、等待、审批与父子权限一起建模，禁止广开默认auto/bypass。
- reasoning仅展示服务端明确提供的可见内容；不推断或伪造模型内部思维。
- 本轮没有重跑上一轮71/158等测试，不能把旧成绩当当前验收；下一执行者必须 build 后重测。
