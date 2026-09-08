# CodexMonitor → harness2：独立源码调研与取舍（历史参考）

> **2026-09-08 R2 方向调整：用户已撤回以 CodexMonitor 为桌面复刻对象的要求。当前桌面目标是功能优先的 coding-agent harness，不要求界面美观或视觉相似。** 本文保留原始源码比较，避免丢失证据；下文“复刻”“决断”和原D轨顺序均为当时建议，不再构成实施指令。当前目标、任务依赖和验收以同目录 [04-implementation-plan.md](04-implementation-plan.md) R2 的§5.2、F1-F8、S7与D0-D6为准。不要因为本文存在就复制CodexMonitor组件树、布局或后端。

> Notion AI 子代理独立取证，主代理整理。2026-09-08。未运行应用、构建、测试、性能基准；测试源码存在不等于测试已通过。未读取其他协作者新写的研究/计划。本报告不废止任何现有文档。

## 1. 原始结论（不再作为当前桌面目标）

**桌面端按 CodexMonitor 的信息层级和操作规则重做，保留 Electron、preload 隔离、harness2 serve、JSONL、快照与审批内核。** 可以复用许可证允许的纯 React/TS/CSS 片段，但不整套搬入 Tauri/Rust 与 Codex app-server。用户想要的是好用的交互，不是换模型后端。

- 上游：`D:\AI_Projects\refs\CodexMonitor`，commit `dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5`，包版本 0.7.68。
- 对照：`D:\AI_Projects\harness2`，业务代码基线 `b1c2d81530b794a5559a28a967129ed2d71bde7e`。
- C/ 表示 CodexMonitor 根；H/ 表示 harness2 根。行号用于初始定位，后续用符号复核。
- **确认**为源码控制流；**风险**为由源码推导、未实机复现；**目标**为新计划，不冒充现有能力。

## 2. 复用许可证

C/`LICENSE:1-21` 为 MIT，Copyright (c) 2026 Thomas Ricouard。复制软件的重要部分须保留版权与许可声明，维护来源 commit/文件映射。

根 MIT 不能自动覆盖所有素材：`scripts/sync-material-icons.mjs:6-23` 从第三方包复制图标；`package.json:41-62` 还有 Tauri、diff、图标、Sentry 等依赖，须逐项核查。不要复制品牌、Logo、更新器、遥测初始化；`useThreadMessaging.ts:180-192` 的 Sentry prompt metric 不属于交互复刻所需。不对 harness2 根项目许可作未经核实的推断。

## 3. 原始比较与替换矩阵（仅供参考）

| 能力 | 上游源码事实 | 我们的差距 | 决断 |
|---|---|---|---|
| IME/Enter | C/src/utils/keys.ts:16-32 `isComposingEvent`；composer/hooks/useComposerKeyDown.ts:33-174 先IME后候选再提交 | H/App.tsx:483-494 未检查 composition | 复用小型判断函数与优先级规则，P0 |
| 多行编辑 | useComposerInputLayout.ts:45-59 自动高度；Composer.tsx:446-479 光标恢复/粘贴 | 基础textarea，缺完整编辑反馈 | 仿实现自动高度/展开；围栏与列表续行可关闭 |
| 草稿 | app/hooks/useComposerController.ts:72-139 按thread保存 | H/App.tsx:403-407 pane组件局部state | 改为session草稿；持久化是我们新增，不假称上游已有 |
| Queue | useQueuedSend.ts + ComposerQueue.tsx 提供队列/编辑/删除 | H核心有pendingTexts，但App.tsx:430-433忙时不提交 | 保留服务端队列，补可见性/确认/幂等 |
| Steer | C/src-tauri/src/shared/codex_core.rs:528-550 `turn/steer`+expectedTurnId | 无对应控制通道 | 先queue；安全step边界steer后开能力，不伪装原生实时插话 |
| 文件引用 | useComposerAutocomplete.ts:40-170 排名/范围；AutocompleteState.ts:159-232 多种触发 | 正则+展开字符串，没有结构化附件 | 复刻路径候选/chip；主进程读取边界保留且加固 |
| 滚动 | useMessagesViewState.ts:52-111 近底才跟随；阈值120px | H/App.tsx:410-413每次items变化强拉到底 | 优先替换，增加每会话锚点与回到最新 |
| 卡片 | MessageRows.tsx:363-469,686-895 Markdown/输出/折叠/状态 | H/App.tsx:320-392纯文本、普通工具输出不可读 | 复刻层级与控件，真实diff仍来自我们快照 |
| 渲染 | useThreadItemEvents.ts:129-154逐delta dispatch；行memo | 我们逐帧notify、每次全量projectChatItems | 借鉴分层，不照搬状态管理；补批量更新/局部订阅 |
| 子代理 | threadItems.collab.ts:305-368 + useThreadLinking.ts:146-189建关系/角色/状态 | childId到tool/result才可见 | 仿实现早期发现、任务树、跳转、进度 |
| 审批 | useThreadApprovals.ts:38-51成功后移除 | H/app-controller.ts finally无条件移除 | 服务端ack后收口；失败保留可重试，P0 |
| 布局 | 工作区/线程树，可调整侧栏和面板 | 已有1/2/3分屏和持久化，不能丢掉 | 复刻默认桌面布局；我们的多分屏作为可选模式保留 |

表中未带全路径的 C 前端文件位于 `src/features/composer/`、`app/`、`messages/` 或 `threads/` 对应 hooks/components 目录；实施时以文件名搜索确认具体子目录，不凭表格拼路径。

## 4. 不能照搬的五件事

1. **没有消息虚拟列表。** C/src/features/messages/components/Messages.tsx:240-250 是 `groupedItems.map`。`useVirtualizer` 实际在 `files/components/FileTreePanel.tsx:431` 和 `git/components/GitDiffViewer.tsx:213`。不能将 package 依赖当成消息虚拟化证据。我们的长消息列表应单独实现动态高度虚拟化，同时降低数据投影成本。
2. **内存队列只针对活动线程出队。** `useQueuedSend.ts:133-171,368-423` 的内存状态与activeThreadId effect，不是可靠服务端outbox。切走任务不能因此暂停出队；前后端不能各持一个权威队列。
3. **发送即清空不是可靠交付。** `Composer.tsx:396-420` 调onSend后立即清空；queue编辑也会先移除再回填。我们应保留recoverable draft/outbox，accepted ack后再转换状态。
4. **“Session stopped”可能早于中断确认。** `useThreadMessaging.ts:431-485` 先本地清状态再请求interrupt。我们用stopping/confirmed/unknown，不复制假停止。
5. **模型重试不是这个前端实现的。** `useThreadTurnEvents.ts:411-421` 收到willRetry直接return；底层Codex负责真正重试。`app_server.rs:499-542` 的RPC id只证明请求关联，不证明持久幂等或工具exactly-once。我们应显示重试原因/次数/等待，而不是忽略错误。

## 5. 必须解决的可靠性链条

### 5.1 连接恢复不是重发问题

H/`packages/desktop/src/main/bridge.ts:211-252` close后1s重连，open只赋值socket；H/core/server/ws.ts:153-155 每条连接都是空subs；H/renderer/app-controller.ts:91-111 connected只刷新列表。**确认缺重订阅。**

借鉴 C/`useRemoteThreadLiveConnection.ts:173-282` 的key合并、sequence阻止陈旧请求、旧订阅清理、live/polling/disconnected状态。注意它是remote链路，不宣称覆盖其全部本地实现。

目标：恢复订阅集合、persisted seq、in-flight snapshot、pending approvals、task states。服务存活时补状态；服务重启时诚实标记原任务中断/结果未知。不得自动重发user-message。

### 5.2 消息交付与去重

H/bridge.ts:327-329发送sessionId+text，ws.ts:179-181直接入队；没有clientMessageId/accepted ack。seq去重只针对回放事件，不防重复发送。

目标：草稿→本地待确认→服务端已接受/排队→运行→完成；服务端持久幂等键与查询。客户端断线后先查是否接受；过期无法证明未接受时进入unknown，不自动执行第二次。队列支持查看/编辑/移除未启动项。

### 5.3 子审批是发布阻断场景，不只是子任务卡片

证据链：H/subagent.ts:177-207执行完才输出childSessionId；H/chat-model.ts:141-156从tool/result提取；H/ws.ts:108-117按子session订阅过滤；审批也按child session广播。**风险：子任务在用户自动发现/订阅之前就等待审批，父工具可能一直悬挂。**

目标：启动即child-created；父观察者能发现并订阅子进度；根任务审批中心显示父子路径；pending approvals可恢复；子token delta需接入onStream，不是仅镜像落盘事件。

### 5.4 取消与执行cwd

H/tools/executor.ts的 `raceAbort(signal, Promise.resolve(def.execute(...)))` 会先求值execute；runWave没有每个后续工具的取消前置门。同步write可能已写才返回cancelled。调用前/审批后/出队后检查取消；不合作工具标记outcome_unknown并阻止冲突写任务自动放行。

H/server/sessions.ts:382-400 的runOne使用 `this.options.cwd`，与会话实际创建cwd需逐项核对。多项目侧栏上线前必须用两个临时项目复现：各自read/write/子任务只落在所属项目。错误执行目录不能靠UI显示项目名掩盖。

## 6. 交互验收脚本

所有项本轮状态均为“未运行，待实施者/真机执行”。

- 微软拼音：Enter确认候选不发送，再按Enter只发送一次；Shift+Enter换行；候选/命令面板/输入框不会同时消费按键。
- A草稿写一半，切B输入另半句，再回A；草稿/附件/光标按session恢复。分屏增减不混草稿。
- A运行时排队两条，切B后A仍依服务端策略推进；编辑/移除未启动消息可对账；ack丢失重试查询不产生第二个turn。
- 流式时上翻历史不被强拉到底；展开diff/图片加载/分页前插保持锚点；回到最新按钮可用。
- 暂断WS而serve继续运行，重连后最终正文逐字一致、无重复turn、审批与子任务重新出现；杀serve时不假称任务恢复运行。
- 让子任务先申请写入审批：父会话界面在子任务完成前即显示审批来源和内容；拒绝后没有写入；断线重连审批不丢。
- 点击Stop后出现正在停止；后台确认前不显示已停；取消后未启动工具调用计数为0。
- 1000条消息、100k字符流、3pane：用固定stub复测性能。输入p95目标≤50ms、无持续>100ms UI阻塞；这是拟定预算不是现状成绩。

## 7. 原轨道交接顺序（已由 R2 替代，不执行）

D0 数据身份/transport adapter → D1 Composer/草稿/引用 → D2 消息列表/滚动/卡片 → D3 工作区线程树/任务审批中心 → D4 恢复与故障态联调 → D5 Windows真机对照。共享runtime必须先冻结契约；本轨道不私改provider、core事件和子任务调度。

以上为首次调研时的历史顺序。当前按同目录 `04-implementation-plan.md` R2 的 S0-S7、D0-D6 与F1-F8实施；不再要求参考产品的布局/视觉相似度。本文源码观察仍只针对原研究commit，不等于上游未来版本或harness2当前实现的承诺。
