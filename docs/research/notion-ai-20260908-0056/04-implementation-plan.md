# harness2 I1：Grok 终端复刻 + 功能优先桌面 Harness 实施计划

> 状态：计划已就绪，尚未实施/验收。作者：Notion AI。2026-09-08。
> 修订 R2（2026-09-08，用户方向调整）：Grok 终端规格与 T0-T5 保持不变；桌面取消 CodexMonitor 界面复刻目标，改为 Codex 类 coding-agent harness 的功能闭环。桌面不再验收视觉相似度，不要求获得或复制 Codex 的专有界面源码。
> 独立方案：不读取、覆盖、合并或废止其他协作者的新文档；是否采用由用户决定。不要将本文件改称整个项目唯一权威计划。
> 研究包：01-grok-build-research.md、03-harness2-core-audit.md。02-codexmonitor-research.md 保留为历史参考，不再是桌面产品规格或必读移植清单。本文可独立交接；当前桌面目标以本文件 R2 的功能契约、任务和验收为准。

## 1. Goal / Architecture / Tech

**Goal：终端继续尽量复刻 Grok 的操作手感；桌面先成为能真正完成「选项目 → 理解代码 → 制定/确认计划 → 工具执行与修改 → 跑命令/测试 → 审查差异 → 继续、撤销或收尾」的 coding-agent harness。先完成真实功能闭环，不以界面美观、布局相似或复刻 CodexMonitor 为目标。输入不丢、执行可控、过程可见、结果可核验、会话可恢复。**

**Architecture：**保留 core 的日志投影、Provider、工具、快照/undo、子会话；增加共享运行状态/交付/任务契约。CLI 通过进程内适配器消费，desktop 通过受限 Electron preload + serve HTTP/WS 消费。UI是投影，不是第二个模型上下文来源。

**Tech：**TypeScript、React；终端首选现有Ink但重做编辑器/viewport；桌面保留Electron，不迁移Tauri。参考Rust代码移植为TS行为与测试，不引入整个Grok运行时。

**实施档位：**全能：实现+自动测试+独立代码审查；本版核心体验还必须真机签收，未签收不得称交互完成。**子代理：启用**；共享内核、TUI、Desktop分工，审查不由实现者自判。

## 2. 基线、位置与协作红线

- harness2：`D:\AI_Projects\harness2`；业务代码研究基线 `b1c2d81530b794a5559a28a967129ed2d71bde7e`。
- 研究期间HEAD变成`83228b9897c2bd37e36008b7d85b75c6375e45a4`，主代理核对packages无diff；其他人新增文档未读。
- Grok：`D:\AI_Projects\refs\grok-build` @ `72a61251fcffb464bcc687aeb5a998e5a98ec0c9`。
- 历史比较资料：CodexMonitor @ `dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5`；R2 不要求按其布局、组件树或协议实现桌面。不把对 Codex 产品某一部分源码可得性的判断扩展为全部 Codex 均开源或均闭源；本阶段不依赖该前提，也不宣称完整复刻 Codex。
- 本计划位置：`docs/research/notion-ai-20260908-0056/04-implementation-plan.md`。这个独立目录只承载本轮成果，避免与别人的阶段编号/日志冲突。
- 开工读`AGENTS.md`、`CODE_REVIEW.md`、`docs/ai-framework/phased-plan-driven.md`、`workflow-delegation.md`及本文件。遵守用户最新授权；不自动整合别人文档，不自动更新共享HANDOFF/OPEN/ROADMAP。
- 不在主工作树切分支打断他人；从实施开始时已核对的main建独立worktree：`feat/notion-i1-runtime`；共享契约合入集成分支后，UI两轨从该commit建`feat/notion-i1-tui`与`feat/notion-i1-desktop`。旧分支/worktree不删除，git不reset/clean，默认不push。
- Git只显式add本任务文件；不使用`git add -A`打包其他人改动。修改同一文件前检查是否有并发变化。
- 密钥、真实用户会话/附件、prompt日志不上传；测试使用本地stub和临时HOME/cwd；不改用户全局配置或审批模式。
- 本轮只生成计划，未运行build/test/GUI。先前71/158等结果不作为新基线；不能宣称本方案已验证流畅。

## 3. 明确做与不做

### 本版本必须做到

1. Grok风格固定视口、完整多行编辑、粘贴chip、命令/参数候选、历史草稿、持久可展开工具/推理/任务卡。
2. 功能优先的桌面 harness：项目与会话、模型与有效配置、上下文/指令/文件引用、计划与执行、工具/命令过程、审批与权限、变更审查/撤销、任务/子代理、取消/恢复。普通列表、按钮、表单、日志与Diff即可，不先做主题、动画或视觉克隆。
3. 两端统一plan/normal/auto/allow-approve含义，沿用现有alias映射，不凭名称猜权限；默认不扩大权限。
4. 有界模型attempt重试、明确失败/恢复状态；消息接受去重；服务存活时重连恢复订阅和在途状态。
5. 子任务启动即出现、进度/等待审批/终态可见；显式后台派发、status/wait/cancel/continue；默认只读并发2，共享目录写任务串行。
6. 队列运行不因切走会话而停止。当前轮停止后待发队列暂停，需用户继续；队列清空是独立操作。
7. 安全step边界的steer仍按共享 S6 实施，终端依赖不变；桌面优先可靠排队和停止，S6 未交付时不阻塞基础 harness 功能验收，steer隐藏或disabled并解释。不得用停止后重发冒充实时插话，缺能力要如实列出。
8. 保留现有1/2/3分屏、真实快照diff/undo、设置/模型/MCP/插件/记忆入口，不为复刻删除内核已有能力。

### 不做

- 不整体移植Grok认证/云端/遥测/更新/语音栈，不启动第二套Codex后端，不迁移Tauri。
- 终端保留 Grok 核心交互高保真目标及 Windows 字体/按键差异登记；桌面不做 Codex/CodexMonitor 像素复刻、视觉相似度评分、主题/动画打磨。基本可读性、键盘可操作、焦点可见与错误反馈仍是功能要求。不复制品牌Logo或未经许可素材。
- 本版不新增完整IDE/Git工作台、交互式PTY终端、codemap、语音/移动端。但必须能从桌面运行/观察 agent 的真实命令与测试，显示实际shell/cwd、输出、退出码和取消状态；必须有项目文件浏览/搜索/引用、按任务聚合的真实diff及可控撤销。日志面板不是PTY，但不能因不做PTY而缺少命令执行闭环。无后端能力不得摆可点击假入口。
- 不把取消当undo，不把重连当重发，不对任意shell/MCP承诺exactly-once，不默认自动重试工具。
- 不把Grok32并发、CodexMonitor仅活动线程出队/提前显示已停、缺消息虚拟化等不足照搬。

## 4. 阶段开头：遗留与新发现

| 项目 | 来源与证据 | 本版入口 | 状态 |
|---|---|---|---|
| 旧api-surface超时、旧真机欠账 | 上轮聊天结果，非本轮复测 | S0重新build后复跑，不先归因环境 | 未复测 |
| TUI忙时无取消接线、退出可能留Promise/timer/锁 | runInkChat.tsx:83-112,166-173；chat-setup.ts:469-507 | T0 | 源码发现，待进程级复现 |
| 取消后后续工具仍可能先execute | core/tools/executor.ts:96-101,123-180 | S1 | 源码控制流风险，先红后绿 |
| TUI审批只工具名、单pending、授权scope漂移 | chat-setup.ts:264-282,435-449,525-527 | S2/T0 | 待自动化复现 |
| TUI命令表与执行分叉、历史卡片丢失 | command-registry/commands/runInkChat；Transcript | T0/T3 | 源码确认 |
| WS重连未补订阅/审批，delta无attempt水位 | core/server/ws.ts:24-50,166-170；desktop/main/bridge.ts:215-252 | S3/D0 | 源码确认 |
| desktop IME/草稿/强拉到底 | App.tsx:403-413,430-494 | D1/D2 | 源码风险，真机待证 |
| child审批可能在子任务可见前被过滤 | subagent.ts输出时机；ws.ts按子订阅过滤 | S2/S5 | 故障注入必测 |
| 每会话执行cwd取hub全局cwd | core/server/sessions.ts:384-394,456-465 | S1 | A/B临时项目测试 |

“未做”与“失败”分开登记。不因自动测试绿就移除Windows输入法/原生窗口验收。

## 5. 终端复刻规格与桌面功能契约（必须对照验收）

### 5.1 终端屏幕与键盘

固定区域顺序：状态头（项目/分支/模型/mode/context）→可收起任务摘要→可滚动历史→待发队列/本轮状态→输入框→快捷键提示。80×24仍有可用历史与输入区域；输入框最多占约1/3屏，内部滚动，不把历史推出屏幕。overlay有高度上限，焦点唯一。

- grapheme编辑、词移动、Home/End、软折行上下移动；到输入首尾边界才浏览历史；历史往返恢复原draft/selection。
- Enter：IME/粘贴事务/候选先消费，剩下才提交；候选Enter接受，不同时发消息；Shift+Enter换行，终端不能区分时提供footer明确的替代键/反斜杠续行。
- busy仍可输入；Enter送入可见队列。全局取消不受输入焦点禁用；有弹层时Esc只退当前层，无弹层busy时Esc请求停止。Ctrl+C按明示规则取消/二次退出；`/exit`正常退出码0，确认的SIGINT退出码130。绝不把提示写入draft。
- 多行或大粘贴显示chip，展开/复制/撤销/删除原子；提交用完整原文；包含`/exit`的paste不能自动触发命令。
- 上翻停止follow；新内容只显示“有新消息”，回最新恢复follow；resize保留entry+row锚点；完成后工具/diff/reasoning/child仍能独立展开。
- reasoning只显示provider已明确暴露的内容，沿用用户开关；不生成伪推理。

### 5.2 桌面：本版本的最小 coding-agent harness

这里的“标准 harness”指本计划定义的最小可用能力集合，不声称是行业统一规范。Codex 类工具仅作为「能围绕仓库自主使用工具、修改、验证，并受用户控制」的产品定位参考。桌面必须是现有 agent runtime 的控制与观察入口，不能只是聊天窗口或工具日志播放器。

**功能闭环：**打开项目 → 检查有效模型/权限/工具 → 新建或恢复会话 → 引用文件/指令 → 只读计划或执行任务 → 审批 → 读取/搜索/修改/运行测试 → 审查实际变更 → 继续修复或安全撤销 → 保存和恢复会话。

| 能力 | 用户必须能做什么 | 权威来源与不能伪造的边界 | 对应任务 |
|---|---|---|---|
| 工作区/会话 | 选本地项目；查看真实root/cwd/分支；新建、恢复、切换、分叉会话；查看历史 | 以会话header和文件系统为准，A/B项目不串cwd/草稿；脏工作树不自动清理 | S1/D0/D5 |
| 模型/角色/配置 | 查看当前provider/model、main/subagent等角色、工具连接与错误；修改可用配置并知道何时生效 | 读取core有效配置，不是仅保存UI偏好；新turn冻结配置快照；运行中改模型只影响下一turn，凭据不进renderer/日志 | S7/D0/D6 |
| 上下文/指令 | 浏览/搜索文件，选区或路径引用；查看本轮引用、项目指令/skills来源、上下文占用与压缩状态 | 复用现有解析/注入路径，防重复注入；UI显示原始输入，模型可见展开内容可追溯；未知token值显示未知 | S7/D1/D5/D6 |
| 计划→执行 | plan模式只读研究，给出目标/步骤/待确认事项；用户明确切到执行权限后继续；显示每步待执行/进行中/受阻/完成 | 自然语言计划不是授权；不能画完列表就标已执行；执行结果绑定turn/task/tool证据 | S2/S7/D3/D6 |
| 工具/命令 | 看到read/glob/grep/write/edit、shell/MCP的参数、状态与真实结果；发起或由agent运行测试，失败可继续修复 | 显示真实shell、cwd、开始/结束、stdout/stderr或明确标注合并输出、exit code、取消/超时；Windows不冒称cmd为bash | S1/S7/D2/D6 |
| 权限/审批 | 理解当前mode、写/命令/网络能力；看实际命令、路径、参数、拟议修改和父子来源；允许一次/拒绝/撤销作用域授权 | 审批不等于OS沙箱；没有OS隔离明确显示；项目外/敏感操作按真实策略处理；不因点击“执行计划”自动bypass | S2/S7/D3 |
| 变更审查 | 按本轮/子任务查看改了哪些文件、真实before/after与diff；打开文件；选择支持粒度的undo/redo | 模型总结不是diff；保留任务前既有用户改动，检测执行后外部修改；不确定来源标明，禁止静默覆盖 | S1/S7/D2/D5 |
| 任务/子代理 | 启动即见状态，查看子会话/失败原因/进度，等待/继续/单独停止；父子审批统一可见 | 复用S5调度，只读受限并发，写资源互斥；未知结果不报成功，后台任务不能随关面板失去控制 | S5/D3/D4 |
| 交付/恢复/预算 | 运行时可输入/排队；取消、断线重连、失败继续；看重试/step预算/上下文限制及停因 | ack与本地发送分开；取消确认与请求分开；服务重启不假恢复进程；重连不重跑副作用 | S3/S4/S7/D1/D4 |

**界面约束仅为可用性：**导航、会话输入、执行日志、变更审查、设置/任务/审批入口可用普通tabs或面板组织，没有规定必须左树右栏或可调布局。已有1/2/3分屏保留，新增面板拖调、主题和动画不列必交。IME/草稿隔离/长输出折叠/稳定滚动/加载失败入口/键盘焦点不可省；上翻阅读日志时不得被新token强拉到底。

**持久化范围：**按session保存draft与引用，按稳定ID关联会话、计划、工具、任务与变更；关窗口前提示仍在运行的任务并选择保持后台或请求停止，不能关闭UI就宣称任务已停止。首次实施使用临时项目与stub，不自动打开真实仓库写入权限。

### 5.3 分开验收：Grok终端对照，桌面完整工作流

**终端保持原闸门：**在S0为12个场景建Grok参考清单：空闲、长草稿、候选、引用、多行paste、文本流、工具进行中、审批、子任务并行、错误/重试、长历史、切会话。记录上游commit、终端尺寸、缩放、主题与步骤。可运行参考时录屏对照；否则标注“仅源码规格，终端视觉待真机签收”。每场景按布局层级、操作结果、状态反馈三项0/1评分；核心输入/取消/审批/恢复满分，其余整体目标≥90%，剩余差异显式签收。不得以换色/卡片数量替代交互验收。

**桌面完全移除视觉相似度闸门：**不要求安装Codex/CodexMonitor作视觉基准，不以配色、布局、动画、截图相似度决定完成。以下F1-F8必须全部走通，证据为真实事件/命令输出/文件diff/恢复结果；可用录屏说明操作，但不替代执行证据。

| 流程 | 验收操作 | 成功标准 |
|---|---|---|
| F1 项目与会话 | 打开临时项目A，引用README询问结构；切B再恢复A、分叉会话 | root/cwd、模型/指令来源可见；文件读取确在A/B各自目录；草稿/历史不串；分叉不改原会话 |
| F2 只读计划 | plan模式要求修改文件并执行危险写命令；先产出计划，再由用户切换执行模式 | plan阶段无文件/命令写副作用；切权限是显式动作；UI显示本轮实际生效配置，不假称计划等于授权 |
| F3 修改并测试 | agent修改一个临时函数，运行测试；制造一次测试失败，让agent继续修复并重跑 | 有tool参数/命令/shell/cwd/output/退出码；失败真实显示、修复后以新测试结果判定；最终摘要链接实际diff和测试记录 |
| F4 审批与拒绝 | 写/命令及子任务同时ask，拒绝一项；中途断线、重复点击响应 | 全部待批可见、拒绝项未执行、ack前不消失；作用域授权不泄漏到B会话 |
| F5 变更与撤销 | 项目起始已有用户未提交改动；agent改另一处；用户在agent结束后再改文件，然后执行undo/redo | 展示任务变更与既有改动的区别；无冲突路径可复原；外部修改冲突被提示并阻止静默覆盖；粒度如实显示 |
| F6 子任务控制 | 派2个只读任务，查看子进度/审批；停止一个并继续另一个 | 实际执行有重叠、父子归属清楚；停止不误伤兄弟；结果与状态可恢复；失败不冒充完成 |
| F7 断流与队列 | 发送后丢ack、途中断WS、provider中途EOF、取消退避，最后重启UI/serve | 不重复提交/工具副作用；重订阅恢复状态；预算耗尽有明确停因；服务死亡任务标中断/unknown；未启动队列恢复paused |
| F8 配置与上下文 | 选择可用模型，注入文件/项目指令/skill，触发上下文压缩；模拟provider/MCP不可用 | 请求实际使用选定配置，运行中配置不突变；输入可追溯；压缩状态与失败可见，密钥脱敏；无配置/连接失败有可行动提示 |

F1-F8任一未通过，不得宣称“桌面harness功能完成”；美化可独立排到后续版本。

## 6. 共享契约（S0冻结；以下为拟新增，不是现有API）

### 身份、事实源与兼容

- `sessionId / turnId / stepId / attemptId / callId / taskId / clientMessageId`用途分开，禁止取“日志最后turn”猜终态归属。
- 永久会话事件继续append-only、同会话单写者；模型可见输入仍从session日志投影生成。临时delta不成为下一轮模型上下文。
- 新增版本化runtime journal（建议每session `runtime.v1.jsonl`，由协调器单写）记录accepted queue、去重、task lifecycle、call started/outcome及恢复水位；这是操作状态账本，不存第二套对话正文。
- journal与session.log跨文件没有原子事务，必须用稳定ID可恢复对账：先durable accepted后ack，启动user/message含clientMessageId；崩溃后扫描已有事件判断未启动/已启动/unknown，不能盲目再追加或执行。
- WS能力协商使用protocolVersion=2；旧客户端继续既有帧，未协商不突然切形状。现有持久事件仅添加可选元数据时保持老字段；若新增模型可见事件类型，必须同步parser/projector/export/replay/fixture和迁移策略，不允许旧reader静默丢steer。

### 必需操作与状态

- `submit`：clientMessageId、sessionId、rawText、结构化references、intent(queue/steer)、可选expectedTurnId。ack为accepted/rejected；超时是unknown，不等于rejected。
- 同id同内容返回既有receipt；同id不同内容拒绝。未启动queue项可按id+revision edit/remove；默认每session上限20，可配置，超限保留draft并提示。重启恢复queue默认paused，不惊喜执行。
- `resumeSubscription`：lastSeq+连接epoch；返回带水位的durable replay范围、active attempt完整snapshot+offset、tasks、pending approvals、queue。握手期间先缓冲后合并，禁止snapshot与delta间空窗；旧epoch和重复offset丢弃，缺口重新同步。
- text/reasoning delta携带完整归属+chunkOffset；终态带turnId/attemptId；完成事件先flush当前buffer再settle。epoch只区分连接代次，不改变持久事件身份。
- `approval`：requestId、session/parent/task、tool、args、cwd、scope、expiresAt；respond有decision ack。失败卡保留；重复/过期结果明确；“本会话总是”不得跨session泄漏。
- `cancel`：requestId+target(turn/task)+expectedId；UI立即stopping；确认后cancelled；连接不明/工具不配合为unknown。停止父turn默认取消其所属child并暂停队列；单child取消不杀兄弟；取消不撤销已完成文件变更。
- `task`：registered→queued→starting→running/waiting-approval→stopping→completed/failed/cancelled/unknown。终态单调；操作status/wait/cancel/continue；旧subagent_start默认等待最终结果，`background:true`成功注册后返回handle。
- `steer`：有capability才可用，绑定expectedTurnId与唯一id；仅在下一安全模型step边界接受为日志中的模型可见输入；不能立即改变正在执行的工具。轮次已结束时返回stale，保留draft供用户改排队，不能偷偷abort/resend。

### 桌面功能闭环补充契约（S7冻结/实现，两端复用）

- `effectiveRunConfig`：会话root/cwd、provider/model与角色、模式/策略、可用工具、连接状态、指令/skill来源、上下文窗口与预算。只返回脱敏信息；配置修改走已有core配置读写与校验，不建立桌面私有平行配置。新turn记录配置revision，生效时点明确。
- `planState`：稳定planId、目标、步骤、状态与关联证据ID。计划内容/更新须可重建，复用日志或版本化记录，不只存组件state；自动标完成必须有对应执行结果，用户手动标记须区分。确认计划不放宽工具权限。
- `toolExecutionView`：callId/taskId/turnId、tool、参数、cwd、实际shell、开始/结束、输出引用/截断信息、exitCode（非命令工具可空）、执行/取消/超时状态。先核查现有输出字段，缺什么补什么，不从自然语言“ok”猜退出码。大型输出按范围读取，显示完整输出入口；敏感信息出站脱敏。
- `changeReview`：使用现有SnapshotStore和调用归属聚合changeSet；区分拟议diff与真实diff，记录路径与before/after摘要/hash。undo/redo前比对当前文件是否仍为预期版本；有外部修改不静默覆盖。不承诺无法证明的行级所有权，不自动git reset/clean/stash/commit。
- 能力声明区分approval policy、文件路径检查与OS sandbox；未提供OS级隔离必须明示，不能把plan/ask包装为沙箱。项目外路径/网络/命令的权限依据真实实现显示；不能仅在UI置灰、后台仍执行。

### 重试默认策略（新产品决定，不照抄上游数字）

仅模型step内、完整工具计划尚未提交时自动重试：网络/超时/429/可恢复5xx/stream_truncated；最多额外3次，2/10/30秒指数式档位加抖动；整turn最多额外6次且累计等待≤120秒。Retry-After优先但超过剩余预算时停止并告知，不提前违规重试。401/403、参数错误、quota不足、用户取消、拒绝与内容过滤不重试；paused单独呈现。

失败attempt文本保留为“不完整”可展开，新的attempt不能直接续拼旧半句。重试进度包括原因/次数/等待/取消。已完成工具不因恢复重跑；started无result的副作用先核验或人工决断，禁止外包`runTurn`无限retry。

## 7. Task分工、依赖与交付

所有新增路径为建议，S0可细化但不改变职责。每Task执行：先写失败用例→最小实现→指定测试→记录证据→独立小commit。每项验收初始均为未执行。

| ID | 负责人/依赖 | Files与动作 | 完成条件/关键用例 |
|---|---|---|---|
| S0 | 共享，无 | 新增`packages/core/src/interaction/types.ts`与协议fixtures；核对原types/protocol；新增本方案专属evidence目录 | 冻结共享契约、Grok终端12场景与桌面F1-F8功能清单、基线命令真实结果；先盘点已有harness能力再补缺，不为视觉重写核心 |
| S1 | 共享，S0 | 修改tools/executor.ts、内置副作用工具、server/sessions.ts；建议新增执行生命周期观察接口 | 已取消execute计数0；审批后竞态不启动第二write；不合作工具unknown；每session从header得到真实cwd，A/B目录不串 |
| S2 | 共享，S1 | 提炼结构化approval队列；修改server/ws/sessions与agent/subagent.ts | 两并发审批不覆盖；父用户在child结束前见审批；response ack、scope、过期、重连恢复；不得无授权自动allow |
| S3 | 共享，S1/S2 | 新增interaction/runtime-journal.ts、delivery.ts；修改server/ws/http/sessions与session可选元数据 | 重复submit只一次接受；ack丢失/跨文件崩溃可对账；snapshot+replay+delta无缺口；queue可恢复且不在重启后自动执行 |
| S4 | 共享，S3 | provider/types/adapters、agent/loop/types；建议interaction/retry-policy.ts | 429/503/EOF/401分开；预算/Retry-After/退避取消；工具调用半截不执行；已完成工具不重跑；finalText为空仍有可行动结果 |
| S5 | 共享，S2/S3 | agent/subagent.ts + 新增agent/task-coordinator.ts；工具注册/资源锁；CLI/server仅接线 | 注册ack后立即handle；只读capability过滤后K=2真实重叠；共享写全局串行；status/wait/continue/cancel与父子隔离/终态单调 |
| S6 | 共享，S3/S4/S5 | loop控制输入+interaction types+投影兼容测试 | 安全step边界steer；stale拒绝且保draft；重复id不双注入；无法取消工具时不强行新step |
| S7 | 共享，S1/S2/S3；先于桌面闭环联调 | 核查并补齐config/schema/load、agent/types/loop、tools/types/executor、session/snapshots与server/http/sessions；拟新增interaction/run-config.ts、plan-state.ts、execution-view.ts、change-review.ts，最终路径由S0确认 | 有效模型/角色/权限与指令来源真实可见；运行配置按turn冻结；命令输出/退出码与变更归属可查询；plan状态有证据；undo冲突检测。复用既有接口，禁止做第二套工具执行器或配置存储 |
| T0 | TUI，S0；审批接S2 | runInkChat.tsx、chat-setup.ts、commands.ts、command-registry.ts | 全局abortTurn；幂等shutdown调用finish并清timer；`/exit`进程退出/锁释放；legacy/Ink核心命令一致，能力缺失明确disabled |
| T1 | TUI，T0 | 建tui/input state/reducer/normalize/layout与focus；替换Composer | grapheme/视觉cursor/软折行/词编辑；history往返；IME/候选/Enter优先级；busy可draft；不把提示塞正文 |
| T2 | TUI，T1 | 新增tui/input/paste.ts与terminal-capabilities.ts | 分片paste一次原子插入、CRLF/chip/1MB限额；raw/alt screen/resize/cleanup；Windows四场景能力闸门通过再默认开启 |
| T3 | TUI，T1/S3 | typed transcript/reducer/viewport；改Transcript/useTurnStream/StatusBar | 结构事件身份、真实tool output/diff；历史卡片可展开；session切换重投影；follow/anchor/高度缓存；context按revision刷新 |
| T4 | TUI，T2/T3/S4/S5 | task/approval/retry/queue panels与scheduler | 有界UI批处理、输入优先、final flush；两审批/多任务；重试倒计时可停；step解释→工具→解释顺序保真 |
| T5 | TUI，T4/S6 | 兼容steer与legacy；新增PTY/进程/压力fixture | 所有已实现commands可用；无timer/子进程/锁遗留；参考12场景终端部分录屏签收 |
| D0 | Desktop，S0/S3；S7接线可分步 | shared/protocol、preload、main/bridge、renderer/app-controller/store | 盘点真实后端能力并绑定受限adapter；恢复订阅/ack；暴露有效配置、工具、执行结果与变更查询；无配置/连接失败可处理。renderer仍零Node、不暴露任意fs/shell |
| D1 | Desktop，D0 | features/composer；store session-draft；shared/file-ref+main读接口 | IME不误发；session草稿/附件持久；可靠queue；原始输入与模型上下文分离；项目指令/文件引用来源可见；路径边界/字节预算/二进制测试 |
| D2 | Desktop，D0/S7 | features/timeline、拟新增features/execution、chat-model、store、DiffCard | 真实tool/命令日志、参数/shell/cwd/输出/exit code/取消状态；大输出范围读取、复制、错误详情；稳定滚动与局部更新，达到性能预算。优先复用渲染原语，不为样式全面重做 |
| D3 | Desktop，D1/D2/S2/S5/S7 | 拟新增PlanPanel、TaskPanel、ApprovalCenter；重用现有设置/命令入口 | 计划/执行状态有证据；模式切换明确且不自动提权；主子审批/早期任务发现/等待/继续/停止可用；只读并发与写互斥真实生效；不是只有状态卡 |
| D4 | Desktop，D3/S4 | 错误/重试/加载失败、恢复与通知；shared能力门控 | F4/F6/F7闭环；不永久loading、不假报停止；断线补任务/审批/队列，关窗口行为明确；steer仅S6交付后启用，可靠排队可独立验收 |
| D5 | Desktop，D0/S1/S7；可与D1-D4并行 | 拟新增features/workspace、features/changes；改main/bridge、controller、DiffCard与已有会话入口 | F1/F5：选择项目/新建恢复分叉、文件浏览搜索引用、按任务聚合变更、实际diff、可支持粒度undo/redo；保留用户脏改动、外部改动冲突阻止覆盖；不做完整Git/PTY工作台 |
| D6 | Desktop，D1-D5/S7 | 复用SettingsDialog/CommandPalette；补有效配置/上下文面板、F1-F8 e2e fixtures与执行证据 | F2/F3/F8：桌面选模型配置真正生效，plan→执行→修改→失败测试→修复重跑→变更审查→恢复可完整操作；工具/MCP/skills/预算诊断可见，禁止只接mock。全F流程通过才交桌面 |
| V0 | 独立验收，全轨 | 仅本版测试证据/缺陷表与录屏产物，不自动改共享文档 | 集成commit上复跑全量+故障矩阵+真机；P0/P1未闭环不得发布；给出通过/有条件/不通过 |

### 可以并行的边界

S0冻结后：共享内核组做S1→S5并交付S7桌面功能契约，再完成S6；TUI组仍按T0-T5原依赖推进，终端目标不降级；Desktop组可在mock adapter上做D1/D2/D5，待共享能力到位联调。桌面按D0→D1/D2/D5→D3→D4→D6收口，S6只控制steer增强，不阻塞基础harness交付。真正模型/工具执行、变更、恢复/任务/审批必须依赖共享实现，不能拿mock成功冒充端到端成功。

同一`core`、`shared/protocol`、lockfile仅一个owner；Desktop提出协议变更交共享owner，TUI不复制第二套重试/任务管理。共享契约先合入集成分支，再两UI分支合并；每次合并重新build后test。不要预言无冲突。

## 8. 验证命令与测试族

从各自worktree根执行；PowerShell5.1命令分行，每条检查`$LASTEXITCODE`。不使用shell的`&&`串联。新增测试名必须真实存在且命中数量>0，仓库`--passWithNoTests`会造成假绿，验收不能只看exit0。

```powershell
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm --filter @harness2/core test
pnpm --filter harness2 test
pnpm --filter @harness2/desktop test
pnpm -r test
```

新测试至少涵盖：executor-cancel-before-start、session-cwd、approval-queue、delivery-idempotency、runtime-journal-crash、subscription-resume、attempt-retry、subagent-coordinator、steer-boundary；TUI keyboard/paste/shutdown/transcript/viewport；Desktop composer/queue/draft/scroll/stream/reconnect/child-approval，以及 effective-run-config、plan-execution-boundary、command-output-exit-code、change-review-user-dirty、undo-external-conflict、context-source-compaction、workspace-switch、harness-workflow-F1-F8。

测试一律用本地stub：可按token/工具边界精确断流、返回429/503、丢ack、重复/迟到帧、取消后晚结果；临时HOME/cwd，不触用户数据。实际模型只用于最后用户授权的体验验收。

**性能预算（拟定目标，不是研究结果）：**固定机器记录CPU/内存/DPI/Node与终端版本；1000条展示消息/万级事件、100k字符连续流、独立1MB工具输出、多pane同时更新。Desktop输入p95≤50ms，TUI≤100ms；无持续>100ms UI阻塞；历史DOM/绘制范围随视口而非总历史线性增长；内存重复切换20次后不单调泄漏。未达预算先profiling修复，不篡改fixture或删断言过关。

## 9. 验收总表（全部待执行）

| 编号 | 硬性通过条件 | 责任 |
|---|---|---|
| A1 | 中文IME确认不发、真正发送一次、emoji/组合字符不拆坏、粘贴不执行命令 | 单测+用户Windows真机 |
| A2 | busy仍能draft/queue；A/B会话/分屏不串草稿；引用失败输入可恢复 | 自动化+真机 |
| A3 | 取消后未开始工具execute计数0；不合作工具unknown；停止不等于undo | core自动化/独立审查 |
| A4 | TUI退出0/SIGINT130符合契约、raw screen恢复、锁/MCP/timer收尾 | 进程/PTY+真机 |
| A5 | WS断线期间服务继续：无需手切会话，最终文本/任务/审批恢复，无重复turn | 故障注入 |
| A6 | accepted ack丢失与崩溃窗口对账，无盲目重跑副作用；超出保留窗口明确unknown | 故障注入/审查 |
| A7 | 429/5xx/EOF有界重试；401/取消不重试；退避可停；失败attempt独立 | 自动化 |
| A8 | 子任务完成前可见/可读/可审批；2只读实际并行、共享写无冲突；继续/取消不越父关系 | 自动化+两端联调 |
| A9 | 持久日志/replay/live/undo/redo投影一致；旧v1会话可读；现有命令/设置/分屏不退化 | 全量回归 |
| A10 | 滚动不强拉、历史卡片可展开、前插/resize锚点稳定、性能预算有真实trace | 压力测试+用户 |
| A11-T | Grok终端12场景对照核心满分、整体≥90%，差异用户签收；TUI目标未削弱 | 用户真机 |
| A11-D | 桌面F1-F8全部走通；不验视觉相似度，普通界面可交付；核心运行功能无占位 | 自动化+用户真机 |
| A13 | 模型/角色/权限/指令/上下文是实际生效值；plan不执行写操作，显式切模式不等于bypass | core/desktop集成+审查 |
| A14 | agent修改→运行测试失败→修复重跑→真实输出/exit code/diff→安全undo/redo完整闭环；不覆盖用户既有/后续修改 | 临时仓库端到端 |
| A12 | build/typecheck/test真实命中且全通过；独立审查无未闭环P0/P1；许可复制清单齐全 | 独立验收 |

Windows目标：Windows10 LTSC；Windows Terminal+PS5.1、VS Code集成终端、传统控制台、非TTY；桌面100/125/150%DPI、中文路径/空格/junction、通知点击定位。macOS/Linux未测不可宣称通过。

## 10. 风险、降级与停线条件

- Ink无法满足固定视口/Unicode/粘贴/输入公平性：T2停线，提供最小复现和替代renderer评估；不能一边继续堆卡片一边默认开启。用户未确认迁移前不带入Rust sidecar/重写发布链。
- 自动重试可能重复计费：保持预算与可取消倒计时；同一次请求恢复只重模型attempt。引用降级或删附件必须显式提示，不能偷偷改变输入。
- 任意shell/MCP不可保证终止：unknown保留，写资源不盲放行；禁止“自动retry工具”逃避。
- 公共事件类型变更需兼容旧会话/导出/基线；API快照变更必须记录原因，不机械刷新。
- 新工作区视图必须以session真实cwd执行；通过A/B隔离前不要开放跨项目便捷操作。
- 未经许可的复制只借鉴行为；Grok Apache-2.0、CodexMonitor MIT分别保留版权/许可/修改说明，第三方素材逐项核查。无品牌与遥测复制。
- 桌面只要F1-F8与功能验收全部通过，即可作为基础harness交付，配色/动画/像素复刻/新面板拖调不是欠账，也不阻塞。steer缺失要标能力未启用，不冒充完整Codex；终端仍按原Grok规格验收。若删减模型工具执行、测试、变更审查、审批或恢复等桌面核心能力，仍属部分交付；不能靠漂亮界面抵扣。

## 11. 给接手者的零上下文提示词

你负责实现harness2 I1 R2：“Grok终端复刻 + 功能优先桌面Harness”，不是再写一份方案。桌面原CodexMonitor复刻目标已被用户撤回，不得沿用旧视觉验收。

**基线：**仓库`D:\AI_Projects\harness2`；读本文件及同目录研究包，业务研究基线b1c2d815。先查当前main与源码变化，从当前已核对基线建自己的worktree。别切换/清理别人的worktree，不读取或覆盖其他协作者的新研究/计划。默认不push、不改用户配置、不提交密钥。

**目标：**终端高保真复刻`D:\AI_Projects\refs\grok-build`的输入/焦点/viewport/卡片/任务交互，规格保持不变。桌面以§5.2的最小harness能力和F1-F8为目标：选项目/配置模型/管理上下文→计划与权限确认→agent读改代码/跑测试/修复→实际变更审查/安全撤销→会话/任务恢复。先功能后美观，不需要安装或复制Codex/CodexMonitor；02研究只作历史参考。保留harness2 core、JSONL、快照、模型工具能力与Electron隔离，不替换成第二套后端。

**分工：**共享owner做S0-S7；TUI owner做T0-T5（原规格不变）；Desktop owner做D0-D6。S0冻结后才能并行写各自UI。共享S7优先保障桌面真实配置/计划/命令/变更契约，UI不得自行造第二套配置、工具执行、retry/task/queue。fixture仅供开发，最后必须在真实本地runtime与临时项目上联调。

**工作顺序：**基线build→typecheck→test；修取消/退出/审批/身份/cwd；再输入+typed timeline；再重试/恢复/受控子任务；最后steer与细节。每Task先失败测试，再实现，显式add本Task文件，小commit；不要仅改断言让测试变绿。

**验证：**按§8与§9重跑；每项记录命令、exit、测试数量、commit、fixture、日志和真机证据。终端继续12场景Grok对照；桌面做F1-F8真实工作流，不做视觉相似度评分。必须证明真实模型配置、工具执行、命令退出码、文件diff与恢复结果；不能凭截图或mock状态宣称harness完成。自动化通过与用户真机签收分开。

**交卷：**分支与commit清单；逐Task/逐A项已做/未做/失败；源码与license复制映射；真实测试输出；Windows录屏/性能trace；已知风险。任何P0/P1未闭环给“不通过”或明确阻塞，不宣称完成。所有自己启动的进程在结束前按PID归属关闭，报告是否有遗留，不误杀他人Node。

现在从S0开始；如只被分配单轨，先确认共享契约commit与依赖已就绪，未就绪用fixture做隔离开发并显式标未联调。
