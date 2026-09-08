# grok-build → harness2：独立源码调研与取舍

> Notion AI 子代理独立取证，主代理整理。2026-09-08。只读源码、测试源码、包声明和许可证；没有运行程序、构建、测试或性能基准。未读取其他协作者的新研究/计划，不覆盖或废止其文档。

## 1. 决断与基线

**采用 Grok 的输入、焦点、视口、卡片与任务生命周期规则，以 TypeScript 仿实现；保留 harness2 core，不整体搬 Rust runtime。** 不再将纵向Box+Static称作已经完成的全屏交互。Ink保留为首选渲染器，但必须通过终端能力闸门；若无法达标，暂停该轨，不用降级效果冒充复刻完成。

- 参考目录：`D:\AI_Projects\refs\grok-build`。
- Git：`72a61251fcffb464bcc687aeb5a998e5a98ec0c9`；SOURCE_REV：`a549186d9d39311f2d3ee4208db62af8c65aa476`；pager包1.0.16。
- H基线：`b1c2d81530b794a5559a28a967129ed2d71bde7e`。研究末次HEAD为`83228b9897c2bd37e36008b7d85b75c6375e45a4`，packages无diff；只观察到别人新增文档，未读其内容。
- P/=`crates/codegen/xai-grok-pager/src/`；R/=`crates/codegen/xai-grok-pager-render/src/`；S/=`crates/codegen/xai-grok-shell/src/`；T/=`crates/codegen/xai-grok-tools/src/`；M/=`crates/codegen/xai-grok-sampler/src/`；E/=`crates/codegen/xai-ratatui-textarea/src/`。H/表示harness2根。

## 2. 最重要的差距与替换建议

| 主题 | Grok源码证据 | harness2现状 | 确定做法 |
|---|---|---|---|
| Unicode编辑 | E/editor.rs:932-981按grapheme边界；P/views/prompt_widget/mod.rs:1544-1830 TextArea编辑 | Composer按UTF-16下标增减，未按cursor绘制位置，上下键总是历史 | 重做输入reducer，grapheme+显示列宽+软折行；复刻词移动/选区/撤销/多行编辑 |
| Enter边界 | prompt_widget/mod.rs:2081-2110 `route_enter`区分候选/续行/Submit | 高亮候选不等于Enter会接受，反斜杠看整段末尾 | 候选优先消费；续行看光标前；提示不混进真实prompt |
| 长粘贴 | prompt_widget/mod.rs:2205-2268原子chip，:2763展开 | 无应用级Paste事务、原子内容或体积管理 | bracketed paste归一化、CRLF处理、折叠/展开/删除/发送原文 |
| 历史草稿 | S/session/prompt_history.rs:10-96；P/app/agent_view/prompt.rs:747-775先stash | 只有组件内历史，向下越界清空草稿 | 当前会话历史无损往返，CWD历史后补，优先由已有日志派生 |
| 焦点 | P/app/agent_view/key_owner.rs:10-214明确KeyOwner和Esc层级 | 多useInput约定互斥；busy关闭输入 | 一个焦点仲裁器，全局取消独立；busy可编辑草稿/排队 |
| 全屏视口 | P/app/mod.rs:1417-1421 alternate screen；views/agent.rs:234-304区域预算 | 纵向Box+Static，无固定viewport/follow/会话视图隔离 | 固定头/历史/队列/输入/footer，真实viewport与手动锚点 |
| 长历史 | P/scrollback/state/layout.rs:1675-1733二分paint window，:570-657锚点/测量窗口 | settled为string[]，无法操作历史卡片 | typed transcript+稳定ID+可见窗口测量缓存 |
| 流式调度 | P/app/event_loop.rs:553-614 Presenter；:2524-2581输入优先让出ACP | 已有50ms合并，但整段text重绘、工具双重表达 | 保留合并思想；结构事件即时、token有界合并，稳定前缀/变化尾段 |
| 卡片 | P/scrollback/blocks/tool/mod.rs:152-235类型化工具块 | reasoning/tools仅busy期可见；展开共用一个开关 | 持久独立卡片/独立展开态，真实output和快照diff |
| 重试 | M/actor/request_task.rs:343-525分级决策/可取消退避；S/session/acp_session_impl/sampler_turn.rs:15-114预算 | provider异常直接turn error | 复刻attempt级重试/倒计时，不重跑整个turn |
| 子代理 | task coordinator+admission+注册确认+父子任务投影 | start等待最终JSON，默认unsafe串行 | 保留start/continue兼容，显式background模式+status/wait/cancel |

## 3. 当前默认TUI的P0，不应等美化后才修

### 取消、退出、资源释放

- H/`packages/cli/src/tui/Composer.tsx:38-40,164` busy禁用监听；`runInkChat.tsx:166-173`忙时只处理r。已有 `chat-setup.ts:506-507 abortTurn()`没有接上。
- `runInkChat.tsx:83-99`审批未消费调用方的AbortSignal。
- `runInkChat.tsx:101-112`外层Promise与200ms interval只在stdin.destroyed时结束；`/exit`只调用Ink exit，未使用传入的onExit，也未调用`runtime.finish()`。
- `chat-setup.ts:469-496 finish()`才关闭writer、插件、MCP资源。

**源码风险，尚未进程级复现：**退出可能只停止渲染而遗留计时器/会话锁。下一实施者必须用进程退出与锁再打开测试验证；不能根据上轮一次进程列表就断言没有残留。不要误杀其他应用Node进程。

### 工具取消前置门

H/`tools/executor.ts:99-101`先求值`def.execute`再进入`raceAbort`；`runWave:128-180`不逐调用检查父取消；内置`write.ts:20-24`同步写。

**可由代码推导：**已取消时后续write仍可能先写再报cancelled。修复需审批后/出队后/执行前检查。取消不等于undo；不合作外部工具返回unknown，不自动重试，也不能立即释放冲突写资源。

### 审批与命令不能退化

- `chat-setup.ts:525-527 toolPrompt`仅工具名；“总是允许”按工具名记且`switchSession:435-449`未清作用域。
- `runInkChat.tsx:43-65`单pending被新审批resolve，无法承载并发等待。
- `command-registry.ts:10-24`宣告的`/new /resume /fork /undo /redo`已有`commands.ts:51-87`逻辑，但Ink另写switch漏接。
- `/compact`不能用“下轮自动检查”冒充手动压缩；`/tasks`不能只指向cron命令冒充子任务面板。

决断：统一命令执行器，UI只收参数；结构化审批队列含requestId/session/tool/args/父子来源；允许一次与作用域授权分开；切会话不能继承旧会话临时授权。

## 4. Grok输入与渲染：值得学，但不神化

- `P/app/event_loop.rs:3868-3944`非bracketed paste采用首次2ms、后续10ms和扩展次数阈值；`:4044-4175`处理CRLF/Windows拖放路径。这些是启发式，不是可以直接复制的Windows时间常量。
- R/terminal/mod.rs:151-154针对Otty的IME识别；R/clipboard/mod.rs:854-887对比剪贴板文本避免IME误判图片；所见专项PTY用例主要Linux/macOS。**不证明Windows 10 LTSC与微软拼音已通过。**
- 全屏绘制有缓存淘汰，但 `evict_offscreen_render_caches`仍遍历entries；巨型Markdown单块也可能复制全部输出。分别测“很多小块”和“一个超大块”，不能只测窗口数量。
- 粘贴chip只是视觉折叠，原文仍在编辑数据里。大文本每键复制成本仍需测，不能把chip当作内容卸载。
- event_loop约6561行，prompt_widget约3631行（包含测试），不应原样复制代码组织；拆input/reducer/layout/transport/commands。
- 50ms节流已存在于H，不重复发明。需要修reset/unmount清timer、attempt隔离、final flush、按事件seq增量投影；完成后的卡片不再退化成text。
- H/StatusBar.tsx:34-40只依赖dir；应在会话revision/turn-end/compaction后刷新占用，不能每token同步读磁盘。

## 5. 断流恢复：分层复刻，不重复工具

### Grok证据

- M/actor/request_task.rs:343-515分普通退避、限流、认证/client重建、fatal等；:519-525等待可取消。
- S/session/acp_session_impl/sampler_turn.rs:15-114：每step transient resubmit上限3、prompt累计10、10分钟episode、2/10/30秒退避。这些是该层预算，不能误作全部网络尝试总数。
- S/session/acp_session_impl/turn.rs:2726-2770发Retrying；P/app/acp_handler/session_notification.rs:1612-1688处理retrying/exhausted/failed。
- P/app/event_loop.rs:316-359,2930-3180按agent/cursor/连接generation恢复；P/app/acp_handler/mod.rs:169-218去重，真正应用后才推进水位。

### 我们应保留

H/openai.ts:175-239要求[DONE]，完整边界后组装工具调用；H/loop.ts失败写assistant/attempt，不伪装assistant/message；每次模型输入来自日志投影。

### 我们应新增

当前失败step内部的attempt身份/预算/可取消退避；UI显示原因、尝试次数和手动继续。重新连接只恢复观察，不能重新提交问题。已有tool/result直接使用，不重跑工具。

任何外部“副作用已经发生、结果尚未落盘”的崩溃窗口都标unknown，不能承诺任意shell/MCP exactly-once。Grok的 `sampler_turn.rs:217-251 call_with_auth_retry`恢复认证后可能再次调用闭包；其本身没有通用工具幂等检查，**不能照搬为自动重试所有工具**。

取消也不能照搬全部Send-now后台化：S/session/acp_session_impl/cancel.rs:424-489有前后台、子owner、spawn admission不同处理，源码承认窄竞态。我们先明确“停止当前轮并取消所属子任务；待发队列暂停”，不把保留后台命令默认为已停止。

## 6. 子代理：复刻任务生命周期，而非只画几个头像

### Grok实现参考

- T/implementations/grok_build/task/mod.rs:574-627建立任务身份与取消；:629-696后台启动等待注册确认；:699-735前台可转后台。
- task/admission.rs:6-30,106-134默认32与Queue/Fail；task/coordinator.rs:265-356持有队列与active。
- S/agent/subagent/mod.rs:306-308共享sampling semaphore。
- attempt_runner.rs:23-38取消/注册ack/结果/超时优先级。
- handle_request.rs:362-470禁止resume运行中源、验证身份/模型/worktree；:996-1013禁止插件子代理靠permissionMode提权。
- P/app/subagent.rs:29-108任务元数据与ChildTranscript；:465,598,702按需回放/历史先于live；P/app/acp_handler/subagent_activity.rs:6-40终态后忽略晚到活动。

### 我们已有且保留

H/subagent.ts有独立session、父子身份、深度限制、父signal、SnapshotStore、continue校验。服务端已有child event/turn-end/approval hooks；CLI尚未完整接通，子token delta还要新增观察缝。

### 本版本目标

1. 子任务注册成功即出现，未注册不能显示已启动；queued/starting/running/waiting-approval/stopping/terminal可见。
2. 保留旧start默认等待结果；新增显式background参数或独立任务操作，返回稳定handle。
3. status/wait/cancel/continue分离，面板可查看子transcript、错误和已完成结果。
4. 默认2个经过工具注册表只读过滤的子任务并行，总预算与队列上限可配；不复制32。
5. 共享工作区有写能力任务默认串行，并与父写操作共同受全局资源策略约束；不是每个executor自己串行就安全。
6. 同child继续排他；父取消、单子取消、晚到progress、跨父continue全部测。终态不复活。

## 7. 许可证边界

根LICENSE为Apache-2.0，Copyright 2023-2026 SpaceXAI；pager/textarea的Cargo同样声明Apache-2.0。允许按条款复制/修改，但保留许可、适用notices、来源、修改声明，不授予商标权。

T对应crate的`THIRD_PARTY_NOTICES.md:16-63`还记录来自Codex Apache/OpenCode MIT的工具；跨语言逐段移植也是修改，不应全部改写成自有MIT。CLI/core包清单声明MIT不等于整仓库每个文件/外部素材皆为MIT。

不搬认证、云端上传、遥测、更新器、语音、Mermaid全依赖闭包；发布前逐复制文件/第三方依赖核查。本轮未审完整THIRD-PARTY-NOTICES，不能承诺整仓库无条件复刻。

## 8. 验收与先后次序

先取消/退出/审批/命令 → 输入状态机与typed transcript → 粘贴/viewport/调度 → 子任务与attempt重试。

必须自动化：取消后execute计数0；两审批不覆盖；命令注册表无假入口；history往返不丢draft；任意chunk的paste不触发submit；卡片live与replay顺序一致；reset/unmount没有旧timer；相同attempt重复chunk不双拼；已完成工具不重跑；子terminal不被晚progress复活。

真机矩阵：Windows Terminal+PowerShell5.1、VS Code终端、传统控制台、实际中文输入法、非TTY逃生；80×24与resize、Unicode/emoji、长中文空格路径、多行及1MB粘贴、长会话小卡片与巨型输出、同时两审批、退避中取消、带MCP退出后进程与锁释放。macOS/Linux在准备宣称支持前补验证。

拟定目标：压力下输入到绘制p95≤100ms；取消立即显示正在停止，终止确认独立等待；空闲无持续重绘。以上全是未来验收目标，不是本次测得性能。完整任务与交接见 `04-implementation-plan.md`。
