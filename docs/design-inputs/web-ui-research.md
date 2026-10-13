# AI 桌面产品 UI 设计调研（Web UI Research）

调研日期：2026-10-13  
范围：ChatGPT Desktop、Claude Desktop、Cursor、Windsurf、GitHub Copilot Chat、Zed、Warp、Raycast、Linear、Perplexity Desktop 等同类产品在 2025-2026 的桌面 UI 设计实践。  
本文面向 harness2（Electron 桌面壳，对话 + 工具调用 + 项目/会话侧栏）的 UI 修复与体验打磨。


## 1. 无边框 / 自绘标题栏布局

- **Electron 官方教程（Custom Title Bar）**：macOS 上 `titleBarStyle: 'hidden'` 移除默认标题栏但保留左上角 traffic lights；Windows/Linux 必须配合 `titleBarOverlay: true` 才能在叠加区看到原生窗控；拖拽区通过 `app-region: drag` 声明；用 `env(titlebar-area-x / -width / -height)` 为原生按钮预留安全区。来源：https://www.electronjs.org/docs/latest/tutorial/custom-title-bar 。适配建议：把关闭/最小化/最大化从会话头组件里剥离，改为 BrowserWindow 级别的原生控件，避免“空态无按钮”。

- **Electron 官方（Window Customization）**：`titleBarOverlay` 支持对象形式，可单独设置 `color`、`symbolColor`、`height`，并接受 `rgba()/hsla()/#RRGGBBAA` 及透明；macOS 可用 `titleBarStyle: 'hiddenInset'` 或 `trafficLightPosition` 精细定位 traffic lights，也可用 `setWindowButtonVisibility` 运行时控制。来源：https://www.electronjs.org/docs/latest/tutorial/window-customization 。适配建议：让原生窗控与自绘 header 同高同主题色，避免 Windows/Linux 与 macOS 两套壳。

- **DoltHub 工程博客（2025-02-11）**：实践做法是 macOS 用 `titleBarStyle: 'hiddenInset'` + `titleBarOverlay: { height: HEADER_HEIGHT }`，并用 `trafficLightPosition: { x, y: HEADER_HEIGHT/2 - 7 }` 将红绿灯垂直居中到 header。来源：https://www.dolthub.com/blog/2025-02-11-building-a-custom-title-bar-in-electron/ 。适配建议：把 header 高度作为单一常量驱动 traffic-light 定位，减少多平台视觉偏差。

- **Cherry Studio 相关议题**：Electron 应用在 frameless 场景下大量出现“空态/无会话时窗控消失”的同类 complaint 与修复 PR，说明应把窗控放在主窗口壳而非内容视图里。来源：https://github.com/CherryHQ/cherry-studio/issues/21413 与 https://github.com/CherryHQ/cherry-studio/pull/21416 。适配建议：empty state 仍保留顶部 app shell 与窗控，不要把窗控绑到会话视图。

- **通用 Electron 社区（StackOverflow）**：frameless 窗口常要求自行处理拖拽区与系统按钮包络，且建议给自绘区域设置 draggable/no-drag 区域。来源：https://stackoverflow.com/questions/35876939/frameless-window-with-controls-in-electron-windows/35878545 。适配建议：对 header 内的按钮、输入框设置 `-webkit-app-region: no-drag`，仅 header 背景为 drag。


## 2. Windows 托盘图标惯例

- **Electron 官方 API（Tray）**：提供 `new Tray(icon)`、`tray.setContextMenu(Menu)`、`click` 事件与 tooltipsetter；托盘菜单由 `Menu.buildFromTemplate` 构建，可包含默认项/分隔符/角色，点击主窗口时通过 `mainWindow.show()` 恢复。来源：https://www.electronjs.org/docs/latest/api/tray 。适配建议：主进程持有 Tray 生命周期，菜单含 “Open / Hide / 分隔 / Quit” 四组，并在 app ready 前初始化。

- **dev.to（fwldom）**：实现示例包括 `Tray('path/to/icon.png')`、`setToolTip('My Electron App')`、右键菜单含 “Show App / Hide App / Exit”，且 Show 调 `mainWindow.show()`、Hide 调 `mainWindow.hide()`、Exit 调 `app.quit()`。来源：https://dev.to/fwldom/how-to-show-the-app-electronjs-in-the-systemtray-4250 。适配建议：菜单文案和快捷键保持一致（Open/Hide/Quit），并把隐藏/显示逻辑集中到 tray controller。

- **dev.to（jenueldev）**：将窗口关闭到托盘运行被描述为“管理资源与提升系统性能的常见实践”（Close to tray）。来源：https://dev.to/jenueldev/electronjs-how-to-minimizeclose-window-to-system-tray-or-in-the-background-11c6 。适配建议：X 按钮默认隐藏到托盘而不是退出，托盘菜单中单独提供 Quit 以减少误退出；可在设置中允许切换。

- **StackOverflow（44258831）**：Electron 中拦截窗口 `close` 事件并 `hide()`、在托盘菜单/双击上 `show()`/`restore()` 的实现模式，是关闭到托盘的主流社区做法。来源：https://stackoverflow.com/questions/44258831/only-hide-the-window-when-closing-it-electron/44263263 。适配建议：主进程注册 `win.on('close')` 并根据 tray-mode 决定 hide vs quit；双击 tray 图标恢复主窗。

- **Electron 社区（MPD tray 相关 issue 讨论）**：Signal Desktop 的 tray 体验长期 issue 中强调托盘应具备打开/完全退出语义、避免重复实例。来源：https://github.com/signalapp/Signal-Desktop/issues/1480 。适配建议：确保单实例锁与托盘退出真正 terminate，避免“藏起来却仍在跑多个实例”的负面体验。


## 3. 项目 / 工作区侧栏交互

- **OpenAI 帮助："Projects in ChatGPT"**：侧栏通过 “New project” 创建项目，项目内可发起聊天；删除项目通过更多选项（•••）“Delete project”，永久移除其聊天/指令/文件，且“cannot be undone”。来源：https://help.openai.com/en/articles/10169521-projects-in-chatgpt （经 WebFetch 获取）。适配建议：项目行提供新建/删除/重命名入口，删除必须明确“不可撤销”并二次确认。

- **OpenAI 帮助："Delete / Archive chats"**：单条聊天通过 ••• 删除需确认，而 Archive 无需确认；归档聊天在 Settings > Data controls 中管理并可 Unarchive/Delete；还提供批量 “Archive all / Delete all” 并确认。来源：https://help.openai.com/en/articles/8809935-how-to-delete-and-archive-chats-in-chatgpt （经 WebFetch 获取）。适配建议：删除 requiring confirm，归档一键无确认；把“归档”作主删除后的轻量替代，防止误删。

- **Claude 帮助："Create and manage projects"**：通过左侧 “Projects” 与 “+ New Project” 创建，项目内可 initiate chats；删除项目再次确认（“Yes, delete”）；归档项目进入 archived tab 可继续访问。来源：https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects （经 WebFetch 获取）。适配建议：项目面板把“新建对话”放在项目行或项目头部，删除需显式确认，归档提供可恢复渠道。

- **Claude 帮助："Delete or rename a conversation"**：侧栏悬停会话条目，点击 “⋮” 可 Rename/Delete；删除再 confirm；删除在历史中立即消失、后台在 30 天内移除。来源：https://support.claude.com/en/articles/8230524-delete-or-rename-a-conversation （经 WebFetch 获取）。适配建议：会话条目使用 hover ellipsis 操作，删除二次确认，并提供“恢复/时间窗口”信息降低误操作焦虑。

- **ai-tldr《Chatbot UX Patterns》**：跨会话历史的存储与列表 UX：自动从首条消息生成约 50 字标题、按 Today/Yesterday/Last 7 days 分组、在会话数 >20 时提供搜索/过滤；并提供 Delete/Clear history。来源：https://ai-tldr.dev/learn/building-ai-apps/ai-ux-patterns/chatbot-ux-patterns/ 。适配建议：改为“按天分组 + 可搜索”，会话条目 hover 才显示操作控件，避免侧栏按钮 clutter。

- **Cursor 社区线索**：Cursor 论坛持续出现“单击删除会话 / 缺少 delete 按钮只显示 archive”等需求，说明仅提供归档会引发用户困惑，删除入口与确认必须显式且可发现。来源：https://forum.cursor.com/t/missing-delete-button-for-conversations-only-seeing-archive/161916 。适配建议：同时提供 Archive 与 Delete，前者无确认、后者需确认，避免只留其一。


## 4. 发送失败 / 离线 / 模型不可用的错误呈现

- **NN/g《Error Message Guidelines》**：错误应在发生点附近呈现，轻微问题用 notice/banner，严重阻塞用 modal；消息具体、可行动、非指责；保留用户输入减少返工；错误状态可由用户 dismiss 或自动清除。来源：https://www.nngroup.com/articles/error-message-guidelines/ （经 WebFetch 获取）。适配建议：发送失败在输入区域附近行内显示、draft 不丢失并提供 Retry，不用全屏/无上下文 toast 代替。

- **Pencil & Paper《Error Message UX》**：错误反馈应在相关时刻及时沟通、按风险选择 modality、帮助用户恢复；Don't persist error state；把技术细节可选展开。来源：https://www.pencilandpaper.io/articles/ux-pattern-analysis-error-feedback 。适配建议：失败 surfaced 立即，错误状态可 dismissed/auto-remove，并给出明确下一步动作。

- **ai-tldr《Chatbot UX Patterns》**：把发送错误分类为 429/网络/策略/上下文溢出等，UI 必须包含 classification、human-readable message、Recovery（retry 或建议）；网络/超时失败时“keep the message in the input so they don't retype”；流式中断必须显示“Response interrupted — retry?”而不是半截消息静默停止。来源：https://ai-tldr.dev/learn/building-ai-apps/ai-ux-patterns/chatbot-ux-patterns/ 。适配建议：harness2 的发送失败至少提供 draft 保留 + Retry，工具/模型错误应进入消息流内联错误块而非空态。

- **常见 ChatGPT 错误文案 community 记录**：ChatGPT 在生成失败时常用 “Something went wrong while generating the response” 并提供刷新/重试路径。来源：https://community.openai.com/t/chat-gpt-error-something-went-wrong-if-this-issue-persists-please-contact-us-through-our-help-center-at-help-openai-com/467241 。适配建议：错误文案以用户语言出现（非原始异常堆栈），并导向 retry/reload，而非按钮无反馈。


## 5. 流式、长工具调用与界面不卡顿

- **ai-tldr《Chatbot UX Patterns》**：TTFT 空窗应显示 typing indicator，流式过程中提供 Stop button 并把 reader.cancel 绑定；模型做 tool call/retrieval 时把状态文案从 “Thinking…” 升级为 “Searching…/Generating…” 等，区分阶段；markdown 用 accumulated string 重渲染，auto-scroll 到底部。来源：https://ai-tldr.dev/learn/building-ai-apps/ai-ux-patterns/chatbot-ux-patterns/ 。适配建议：harness2 必须把“思考中”和“执行中 tool X”区分开（含 elapsed time + cancel），避免仅一个 spinner。

- **ai-tldr《Chatbot UX Patterns》（Regenerate vs Retry）**：Regenerate = 重新生成更好答案；Retry = API 调用失败后的可靠性补救，并且 retry 康新消息、regenerate 不应混用。来源：同上。适配建议：失败消息下“Retry”、完成消息下“Regenerate/重跑工具”，按钮语义分离，防止用户不知道点哪个。

- **ai-tldr《Chatbot UX Patterns》（Accessibility/Performance 细节）**：流式回复外层用 `aria-live="polite"`、错误用 `aria-live="assertive"`；长回复提供 collapse/“Show more” 与渐进披露。来源：同上。适配建议：消息列表虚拟化/增量渲染之外，至少加 collapse 对 2000+ 字回复，并让读屏用户感知流式内容。

- **Zed 官方博客《120fps》**：GUI 层通过 triple-buffer instance buffers、display refresh 同步、在输入后仍 present 1s 防 ProMotion 降频，避免阻塞到 commit；目标 frame time < 4ms/120fps。来源：https://zed.dev/blog/120fps 。适配建议：渲染/动画阶段不让 UI 线程等待 JS，长工具调用的 spinner/计时应不阻塞主渲染循环。

- **Zed 官方博客《GPUI ownership》**：App 持有所有 entity，更新以 run-to-completion 方式成批 flush notify/emit，reentrant update 通过 pending_updates 守卫；脏 window 在下一帧失效重绘。来源：https://zed.dev/blog/gpui-ownership 。适配建议：把状态更新 gathering 成批 flush，避免并发 tool 事件导致竞态/重复渲染。

- **Electron 官方《Performance》**：主进程绝不能阻塞；异步 I/O 与 Web Workers / requestIdleCallback 卸载；按需（just-in-time）分配资源；避免同步 IPC 与 `@electron/remote`；减少启动期 JSON 大文件解析。来源：https://www.electronjs.org/docs/latest/tutorial/performance 。适配建议：单条 84s 命令的计时与取消必须在 worker/子进程或 IPC 异步链路上完成，主进程只更新终态与 elapsed。

- **VS Code / Monaco 一类编辑器经验（AI-UX 文章引申）**：流式期间避免每次 token 重新解析整段 markdown； accumulated full-string buffered renderer 是标准修法。来源：https://ai-tldr.dev/learn/building-ai-apps/ai-ux-patterns/chatbot-ux-patterns/ 。适配建议：对 messages 做 virtualization/incremental render，避免 100+ 轮会话时 O(n) 全量重绘。


## 6. Electron 桌面应用性能惯例

- **Electron 官方《Performance》**：启动分阶段——“Measure, Measure, Measure”，延迟加载模块（lazy require），避免启动时解析超大 JSON、削减 bundle、`Menu.setApplicationMenu(null)` 等；主/渲染阻塞在 checklist 中逐条核查。来源：https://www.electronjs.org/docs/latest/tutorial/performance 。适配建议：harness2 启动先渲染空壳 + 最小 hydration，再异步恢复会话列表与项目，避免首屏阻塞。

- **Electron 官方《Performance》（main process）**：同步 I/O 与 blocking main process 会使整 app 冻结；优先异步 fs/child_process，长任务移 worker/独立进程，避免 synchronous IPC。来源：同上。适配建议：所有 IPC（包括 project dialog/选择文件）节流与异步化，“点 + 弹系统文件框要等几秒”应改为 main 侧 stream/defer。 

- **Electron 官方《Performance》（renderer）**：Web Platform 最佳实践 apply：`requestIdleCallback`、Web Workers、按优先级调度、保持滚动 60fps。来源：同上。适配建议：会话列表虚拟列表 + 空闲预取，消息流使用增量 append 而非 setMessages 重建。

- **Zed 官方博客《120fps》**：通过帧预算（<4ms/frame @120Hz）与合成器提交策略保持流畅。来源：https://zed.dev/blog/120fps 。适配建议：长工具调用期间维持 60fps 基线（不扩展节点、不重算大列表），把耗时显示放到轻量计时器。


## 综合建议 Top 6

1. **原生窗控常驻**：把 X/最小化/最大化从会话头移到 BrowserWindow 层（macOS `hiddenInset/trafficLightPosition`、Windows `titleBarOverlay`），空态就有关闭按钮。
2. **托盘**：X 默认隐藏到托盘；托盘菜单 Open/Hide/Quit，双击恢复；托盘 Quit 才真正退出。
3. **项目侧栏**：在项目行提供 **New Chat** 入口并支持 Rename/Archive/Delete；删除 requiring confirm，归档一键；支持自动标题 + 日期分组 + 搜索。
4. **发送失败必须有反馈**：保留 draft、在输入附近行内显示错误、提供 Retry；按 429/网络/策略/溢出分流，流式中断显示 truncated + retry。
5. **长任务可视化**：Thinking vs Executing 明确分态，含 elapsed time、Cancel/Stop、terminal state（completed/interrupted/error）与 retry，避免“转圈像死掉”。
6. **性能**：启动分阶段与懒加载；IPC 全异步/节流；主进程不跑长任务；渲染用增量 append + 虚拟列表 + 帧预算，保证“不卡顿”主诉求。
