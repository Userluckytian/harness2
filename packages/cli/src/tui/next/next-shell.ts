// next-shell.ts — W3：next 渲染层接入 chat 命令（HARNESS2_RENDERER=next 开关，默认关闭）。
//
// 职责：与 runInkChat 平行的第二条 chat 装配——复用 setupChatSession（同一 runtime/审批/
// 会话语义，禁止两套装配），渲染与输入改走 next 库：Screen + createInputParser +
// createChatController + renderChat 画帧。开关在 runInkChat.tsx 入口分支
// （process.env.HARNESS2_RENDERER === 'next' → runNextChat），其余路径一行不动。
//
// 装配对照（与 InkShell 的对齐面与取舍，均如实钉死）：
// - 转录流式：复用 useTurnStream 导出的 terminalEvent 纯函数；handler 的 50ms 缓冲逻辑为
//   等价复刻（useTurnStream 是 React hook，不可直接复用），见 createTurnStreamBridge。
//   差异：Ink 的 live 快照渲染在转录底部、不产生转录项；next 的 Scrollback 无原地更新能力，
//   live 文本以 `assistant/step`（turnId+stepIndex 稳定 id，reducer put 原地替换）承载，
//   每次替换触发全量重投影（取舍：换增量追加的简单性；长会话下 50ms 全量重投影是已知开销）。
// - 投影增量：记住上次投影的 item 引用数组与行数；item 前缀引用全等（reducer 不改旧 item，
//   替换必产生新引用）→ 只 appendLines 新增行；否则（tool/result 原地合并、live step 替换、
//   折叠变化）全量重投影重建 Scrollback（follow/scrollTop 尽力保留，注明取舍）。
// - 提交路径：对齐 InkShell——Enter → submit(text)；忙时 FIFO 入队、收尾 drain（选对齐面
//   最小者：完整复刻队列语义，但队列取消面板（早批 Ctrl+X 取消）未接，见文件尾「next 模式暂缺项」）。
// - 审批：askApproval → ApprovalGate → Approval overlay（标题 'Approval' + y/a/n 项，
//   ↑↓ / 数字 1-3 / Enter 选择，Esc / Ctrl+C 取消）。choice 映射与 Ink 版一致（allow→y、
//   allow-always→a、deny→n；gate 直接产出 y/a/n，由 setupChatSession 归一）。
//   未复用 runInkChat 的 createDialogController：其 DialogRequest.render 是 React 节点，
//   与 next 渲染不兼容，且会引入 ink/react 依赖与模块环；gate 为其非 React 等价复刻。
// - Ctrl+C：createCtrlCGuard（忙时取消 / 空闲 2s 窗口双击退出，退出码 130）——对齐 Composer。
//   Ctrl+D：按 2026-09-12 keymap 裁决 = 半页下滚（chat-controller 内置消费），**不退出**——
//   退出只走 Ctrl+C 双击与 /exit（Ink Composer 的空草稿 Ctrl+D 退出语义不带入 next 层）。
// - 退出：createShutdown + bindShutdownSignals（SIGTERM/SIGHUP 同一幂等路径）；raw mode 由
//   本层管理（screen.start 后 setRawMode(true)，退出还原）；SIGINT 不绑定（Ctrl+C 走键盘
//   协议，raw mode 下内核不投递 SIGINT，与 Ink 行为一致）。另有 process 'exit' 兜底还原
//   （bindEmergencyExitRestore：exit 回调内只能同步写，见函数注释）。
// - notifier / steer 观察 / resize（screen.resize + resizeChat + 强制全量重投影）/ DECSET
//   1004 焦点上报（parser 产出 focus 事件 → focused 标记，notifier 策略自然生效）均已接。
//
// next 模式暂缺项（对齐 Ink 的差距，诚实登记、不伪造）：
//   1. 斜杠命令已全集接齐（P3-C；P1-Dev-2 起为表驱动分发）：core 命令（/help /? /exit /quit
//      /new /resume /fork /undo /redo /sessions /context /compact /tasks 与未知命令）统一经
//      ink-commands.runSharedCommand → core runCoreCommand（与 legacy/ink 同一份 core 实现，
//      磁盘重投影语义不变）；shellOnly 命令（/reasoning /minimal /fullscreen + P3-A 八条
//      只读命令 session-info/export/timeline/doctor/memory/skills/plugins/mcps）走
//      shell-commands 分发器（三壳同一份实现）；/mode 以 shell-commands override 注册本壳
//      UI 四态语义；/plan /auto /always-approve /theme /search 为 next 层本地命令表。
//      登记差异：/sessions 无参为转录文本列表（ink 为选择浮层）；P3-F 已补 Ctrl+R 会话选择器
//      浮层（G-34，Enter 经 /resume 切换）；/mode 无参 =
//      UI 模式循环一次（等价 Shift+Tab）、带参接受四态名 + catalog 别名 allow-approve
//      （→ always-approve，P2-2；ink/legacy 为 core 审批模式别名，core 契约冻结不改）；
//      未知命令走共享「未知命令」文案。
//   2. 队列面板（Ctrl+; 打开；P3-F 起 Ctrl+X 不再是别名）与重试信息已接齐（P3-E）——差异登记：
//      队列面板 = 浮层列表（Queue · N 项 + 高亮走行），裸 x 取消高亮项（ink 只取消队首）、
//      q/Esc 关闭、取消回报「已取消排队」system 行（ink 无回报行）；重试信息 = 转录 system 行
//      （formatRetryBudget 文案与 ink RetryPanel 一致）+ 状态行「重试 used/max」标记
//      （ink 为结构化底部面板；React 组件不可复用，形态差异如实登记）。
//      状态行/快捷键条上下文化（P3-E）：状态行 = cwd(~) · model · ctx% · 模式(非 normal)
//      · 重试标记 · 运行中标记（数据驱动纯函数 statusLineFor）；快捷键条 = shortcutsFor 多态
//      （审批接管 > 帮助/会话选择器浮层 > 子视图 > busy > 空闲，busy 组含 Ctrl+; 队列(N)）。旧「core 模式名/已排队 N」
//      状态行段移除（模式由 UI 四态承载、队列数移至快捷键条），如实登记。
//   3. 工具卡 output 的磁盘补齐（enrichSubagentResults）未接：live 流 tool/result 不带 output，
//      工具结果行只有状态无输出摘要；live 工具卡也不显示 childSessionId 入口（StreamEvent 契约
//      所限）——子会话候选改由 onChildEvent 登记补齐（见 P3-D），磁盘重投影后转录 item 自带。
//   4. 工具卡/推理块仍为纯文本行近似（无边框/反色）；逐行前景色已落地（P3-A：
//      projection fg → Scrollback 行对象 fg → drawScrollback 逐行绘制，单 fg 兜底保留）。
//   5. 软折行视觉行内 ↑↓ 移动（Infinity 宽度逻辑行移动）未接；候选补全已接（P3-C，见下）。
//
// P3-D 子代理块（耗时/动画）+ 全屏子视图（2026-09-12，对齐 grok 16-subagents）：
//   - 耗时：subagent tool/call → tool/result 的 turn 事件流间隔（UI 层近似计时——含审批
//     等待/调度延迟，非 core runTurn durationMs，如实登记）；投影文案 `完成（43s）`（对齐
//     grok "Subagent completed in 43s"）；<1s 视为即时完成不显示（0s 噪音）；无记录不伪造。
//   - 运行动画：busy 且存在运行中子代理块（subagentStarts 非空）时 150ms setInterval 循环
//     invalidation（braille spinner SPINNER_FRAMES，next-shell 持有帧序并传入投影，只替换
//     运行中子代理行前缀）；空闲/无运行中块停表；spinner tick 走 reprojectAll 全量重建
//     （items 引用不变时 syncProjection 会早退）。
//   - 全屏子视图：滚动区焦点 `v` 打开（键位裁决与差异登记见 keymap 文档冲突项 6；grok 为
//     选中块 Enter/Ctrl+F）。0 个子会话 = 瞬时提示；1 个 = 直开；多个 = overlay 列表选择
//     （↑↓/j/k/数字/Enter，Esc/q 取消）。视图 = 独立 Scrollback（projectSession 磁盘重放
//     ∪ onChildEvent 事件，seq id 幂等合并）+ composer 层降为 1 行「q/Esc 返回」提示行
//     （chat-screen.subagentView 态：草稿/候选/指示不画）；运行中的子会话经 SubagentHooks
//     .onChildEvent 实时追加进该视图（setupChatSession 装配层传参 → runNextChat sink 延迟
//     转发 → harness；core 零改动）。视图内 ↑↓ 单行 / PgUp/PgDn 翻页 / 滚轮 ±3。
//
// P3-C 斜杠命令全集 + 模糊补全（2026-09-12，对齐 grok `/` 内联下拉 + ink matchCommands）：
//   - 候选触发：draft 以 '/' 开头且不含空格/换行（= ink Composer 的 commandNameActive 语义）；
//     逐字过滤实时重算（syncCandidates 在 invalidate 内，draft 变化必经 feed → invalidate）。
//   - 过滤排序 filterCommands：前缀命中 > 子序列命中（isSubsequence），各自按字典序（ink 的
//     matchCommands 是纯前缀，本层为其模糊超集；空输入 = 全部命令字典序）。
//   - Tab / Enter 接受候选：草稿写回 `/cmd `（**含尾随空格**，即退出候选态；再按 Enter 才
//     发送）。差异登记：grok 选中即执行、ink Enter 提交原草稿；本层采用任务规格的两段式
//     （接受 → 可继续补参数 → 再 Enter 发送）。
//   - 悬停/滚轮改选（grok panes.rs:958）：候选画在 composer 层顶部，命中测试
//     composer.candidateItemAt（相对候选区顶行 → item 下标，含滚动窗口映射）；next 层在
//     dispatcher 装 candidateMouseLayer（approval 与 composer 之间）：move 命中候选行改
//     activeIndex、滚轮在候选行上 ±1 循环（候选区外滚轮照常滚转录）。真机悬停需 all-motion
//     鼠标上报，本层补写 DECSET 1003（MOUSE_ALL_MOTION_ON，与 renderer MOUSE_ON 的
//     1000;1002;1006 叠加；退出对称关闭）。
//   - /undo /redo /new /resume /fork /sessions /exit 的重投影语义复用 runSharedCommand：
//     rewind/会话切换后以 projectSession(dir) 整体重建转录（reprojectFromDisk；磁盘读取失败
//     保底重投影内存转录，不伪造），并清空折叠覆盖集（对齐 ink 重投影清 expandedIds）。
//
// P3-A 键位（2026-09-12 keymap-parity 裁决落地，next 层）：
//   - Tab = 输入框/滚动区双态焦点（候选可见时 Tab 仍是接受候选，dispatcher 候选优先）；
//     滚动区焦点下 h/l/e/E 生效（块折叠键族），其余字母键自动回到输入框照常插入
//     （grok simple 模式语义）；指示器显示 'scrollback'。
//   - e = 展开全部块 / E = 折叠全部块（collapsed 覆盖集全量重置：e = 收录全部可折叠
//     item 下标，E = 清空集）；h/l = 折叠/展开最近一次工具/推理 item（next 无块光标，
//     取最近可折叠 item，对齐旧 Ctrl+O 定位策略；grok 是选中块导航，差异登记 keymap 文档）。
//   - Ctrl+O = always-approve 切换（grok YOLO）：UI 开关自动代答 'a'——新审批 ask 时经
//     gate.choose('a') 走 gate 的 resolve 路径，**不绕过 core 审批队列**（红线 6）；开关
//     开启瞬间已挂起的审批不自动代答（当次仍手动回答）；底边指示器显示 'always-approve'。
//     旧 Ctrl+O 折叠语义由 e/E/h/l 接管。
//
// P3-B 键位（2026-09-12 keymap-parity 裁决落地，next 层）：
//   - 审批 blocking card 键位对齐 grok permission prompt：Tab/Shift+Tab 在选项间循环走行
//     （↑↓ 保留）；1-3 数字直选；Enter 确认高亮项；Ctrl+F 展开/收起审批 query 全文（按
//     显示宽度折行进 items，差异：chat-setup 的审批 query 只携带工具名文案、不含工具参数
//     ——askApproval 契约冻结不可改，grok 是「展开完整参数」，此处展开的是全文案，参数级
//     展开待 gate 契约扩展，差异已登记 keymap 文档）；Ctrl+C 取消（ASK_CANCELLED）；Ctrl+O
//     always-approve（保留）。
//   - Esc = 寄放焦点（grok permission prompt 语义）：关闭键盘接管但**不回答不关闭卡片**——
//     overlay 保留显示、审批仍挂起（gate.pending() 非 null），controller.focus() 键盘回
//     composer（照常编辑/提交）；寄放态 Tab 显式回卡重新接管；新 gate.ask / settle 均复位
//     寄放态。寄放态下 Ctrl+C 走 composer 路径 → interrupt() → gate.cancel()（grok 同义）。
//   - Shift+Tab = 模式循环 Normal→Plan→Auto→Always-approve→Normal（composer 焦点下生效；
//     审批卡接管时 dispatcher 卡片层优先消费 Shift+Tab = 反向走行，层级天然区分；寄放态
//     键盘在 composer，Shift+Tab 循环模式、Tab 回卡）。
//   - 模式四态落地语义（红线 6：审批不得弱化，mode 不自动回答审批）：
//     normal = 现状；plan / auto = **UI 声明态**——core 无 plan/auto 模式契约且冻结，仅底边
//     指示 + 提交时转录打 [plan mode]/[auto mode] 灰色 system 提示行，**不改变任何审批/执行
//     行为**（诚实实现，不伪造 core 能力；grok 的 auto=自动审批与红线 6 冲突，故不做「gate
//     默认高亮 allow 项」，避免诱导一键放行）；always-approve = 与 Ctrl+O 共享同一状态
//     （单态变量：开启时**新**审批经 gate.choose('a') 走 resolve 路径代答，红线 6 不绕过
//     core 审批队列；挂起当次不代答；关闭回 normal）。
//   - 斜杠命令 /plan /auto /always-approve 直接设置对应模式（/always-approve 为 toggle，
//     grok 语义；/plan /auto 幂等设置）。
//   - 底边指示顺序：模式（normal 省略）· scrollback 焦点 · 寄放提示 · 瞬时 hint。
//
// P4-1 选择与复制（OSC52）+ 超链接（OSC8）（2026-09-12）：
//   - 鼠标拖选：滚动区矩形内左键 down → move 扩展 → up 完成（方向无关、跨行、宽字符
//     按首列整字）；单击（无移动）= 清除选择。焦点无关（scrollback 焦点/非焦点均可）；
//     approval/queue/subagent/候选层在先，既有点击语义零变化；滚轮放行照常滚动。
//     已知简化：拖选中滚轮不更新选择；子视图/picker 打开时鼠标被 subagentLayer 接管，
//     选择仅作用于主转录（如实登记）。
//   - 复制（OSC52）：Ctrl+C 有选择时优先复制（写 `\x1b]52;c;<base64>\x1b\\` 到 stdout、
//     清选择、hint「已复制 N 字符」），无选择走既有 guard 协议（优先级不打扰）；Esc 清
//     选择（先于 busy abort/清草稿）；y（滚动区焦点）同样复制。Windows Terminal 1.17+
//     支持 OSC52，老终端忽略序列（无害）。
//   - 超链接（OSC8）：scrollback 绘制时检测 `https?://` 非空白区段标 linkId，
//     diff-presenter 按连续 run 包裹（见 renderer/osc.ts 兼容面注释）；软折行切断的
//     URL 尾段不标（不给错误 href）。开关：HARNESS2_SELECT=0 关选择复制、
//     HARNESS2_OSC8=0 关超链接（均默认开启，=0 完全旁路）。
//
// P4-2 主题系统 + /theme + /search + busy 状态行 spinner（2026-09-13，P4 收口包）：
//   - 主题：next/theme.ts 命名色板（dark = 现状默认色逐值对齐，切换往返 dark 视觉零变化；
//     light = 深字浅底自定合理值，bg 假定浅色仅登记口径——cell-buffer 无 bg 通道）。
//     投影/滚动区选中高亮/composer 光标与 active 候选/浮层高亮/子视图提示色全部从主题取；
//     next-shell 持有 theme 状态（state.theme 下发 chat-screen），/theme 切换走 reprojectAll
//     全量重投影（行级 fg 烤进行对象）。会话内存级不持久化（grok 写 config.toml + 5 主题 +
//     auto 系统外观 + picker，差异如实登记）。theme.ts 预留 spinner fg 槽：状态行/composer
//     为单 fg 整行绘制，未逐段接线（不伪造已生效）。
//   - /theme：无参 = 列出可用并提示当前；带名 = 切换（大小写不敏感，grok 同语义）；未知名报错。
//   - /search（简版，任务规格裁决）：/search <文本> 从当前视口底之后找首个命中逻辑行 →
//     anchor 定位到视口顶（底部钳制）+ 命中行整行高亮（主题 searchHit，行级单 fg 无行内分段）
//     + system 行「N 处命中（第 k 处）」；再次同查询/无参 = 跳下一处（末尾回卷）；clear 清高亮；
//     命中判定大小写不敏感、中文按子串；命中计数排除搜索回显与状态行（防自匹配放大 N）；
//     高亮保留到下次搜索或 clear（无定时清除）；折叠/换主题重投影后按文本重算仍正确；
//     不作用于子视图。差异登记：grok 为 /find 交互式搜索栏（Esc-steal、n/N 语义），
//     本层不做 / 交互输入框（评估后取简：composer 焦点态/输入框接线工作量大、收益低）。
//   - busy 状态行 spinner：updateSpinner 启动条件扩展为 busy 即运转——无运行中子代理时
//     tick 只刷 chrome，状态行「⏺ 运行中…」的 ⏺ 换 SPINNER_FRAMES 当前帧（150ms，复用
//     P3-D 帧集与定时器）；有运行中子代理时行级动画接管（P3-D 语义不回退），状态行保持 ⏺；
//     空闲停表。行为变化（任务规格要求）：busy 无子代理时状态行不再静止显示 ⏺，
//     p3e-chrome 对应断言已同步。
//
// P2-C 接线（2026-09-13，Esc 语义 + 焦点环/键位 + 渲染模式 + core 配置加性）：
//   - Esc 语义切新规格（G-14～G-20，reduceEsc 纯 reducer 专管，旧「Esc 停止/清稿」废止）：
//     回合中 Esc 永不取消 → hint-cancel 提示（逐字 'Press Ctrl+C to cancel the turn'，
//     toast 通道每用户回合最多一条去重）+ G-19 宽限推进；取消统一走 Ctrl+C（G-38）。
//     取消请求后、turn 收尾前 = cancelling 态：此间 Esc 全吞（G-15）、Ctrl+C 升级
//     requestExit（G-38）。空闲 Esc = 800ms 双击窗（G-17 清空+stash，Ctrl+S/Alt+S
//     stash/pop 切换（P1-1 上游语义：非空=暂存并清空、空=恢复）；
//     空草稿+有历史双击 = G-18 rewind picker——本壳接现有 /undo 能力做最小 picker，
//     条目 = 转录用户回合（新在前），Enter = /undo n 真实执行，无假入口）。
//   - 审批卡 Esc（G-20）：单击即寄放改为 reduceEsc 逐级退出（本壳卡片恒 1 层 → 退完即
//     park），park 落点从 composer 改为 scrollback（G-20 语义）+ ESC_PARK_HINT_TEXT 提示；
//     寄放态 Tab 回卡逻辑保留（优先于焦点环——卡片待答须先回卡，登记取舍）。
//   - 焦点环/键位（G-08/G-09/G-10 + keymaps.ts 表）：Tab 双态（经 focus.ts reduceFocus）；
//     simple 下 Space 回输入框（vim i 同点位，vim 模式本阶段未启用——登记）；scrollback
//     焦点下 j/k/↑↓ 行滚、g/G 首尾、Ctrl+K/Ctrl+J 行滚（两窗格）接入现有 scrollback API。
//     PageUp/PageDown/Ctrl+U/D 沿用 chat-controller 内置（G-10 同语义，不重复接线）。
//     差异登记：G-09 turn 粒度导航（Shift+H/L/J/K）无 next 等价 API（Scrollback 无 turn
//     锚点）→ 本阶段不接线（保持字符插入语义），下放 P3；输入模式恒 simple。
//   - 渲染模式（G-01～G-03）：RenderMode 状态机接入（初值 = config [ui] screen_mode，
//     core schema 已加性支持；缺省 fullscreen）；/minimal /fullscreen /full 三命令经
//     shell-commands 壳表 + RenderModeControl 缝驱动；G-03 commandSupportInMode 谓词接入
//     命令分发。minimal 基座 P2-C 未接入（当时降级为「重进 REPL」指引）。
//   - fullscreen 渲染接线：chat-screen 布局收敛到 allocateRegions+RegionLayoutManager
//     （八区域中五个已接线，数据面板缺省隐藏），见 chat-screen.ts P2-C 注释。
//
// P3-D minimal 基座实体化 + 下放项接线（2026-09-13，本批）：
//   - G-01/G-02：双渲染基座真·进程内切换。fullscreen = Screen（alt-screen 全帧 diff，
//     Screen 实例一次性——stop 后弃用，回切时新建）；minimal = minimal-view.ts 追加式
//     管线（已落定块一次性写进终端原生滚动区、live 尾部落定后追加、底部 statusline/
//     浮层/候选/草稿构成 prompt 块做擦除重绘；不进 alt-screen、不接管鼠标）。与 P2-C
//     否决结论的差异：P2-C 否决的是「复用整帧 renderChat 呈现 minimal」（转录会逐帧
//     重复进原生 scrollback）；本批走 ink `<Static>` 式「追加式转录 + 底部 prompt 行」
//     管线（minimal-view.ts），两基座共享同一份 transcript/草稿/会话运行时。
//     切换语义：fullscreen→minimal = 退 alt-screen + 全量重放已落定转录 + minimal prompt；
//     minimal→fullscreen = 擦掉 prompt 块 + 新建 Screen 进 alt-screen + 全帧重画。
//     会话/草稿/折叠/队列等运行时状态跨切换保留（G-02「当场切换不重启」落地）。
//     config [ui] screen_mode = minimal 初值现在直接以 minimal 基座启动（P2-C 的降级
//     声明废止）；GROK_SCREEN_MODE_SWITCH=exec 重执行变体维持下放登记（mode.ts）。
//   - G-03：门控真实生效——minimal 下 fullscreen 专属命令（/find /jump /search /timeline
//     /theme /tutorial /dashboard）被 commandSupportInMode 拒绝，拒绝文案补上游「指向替代」
//     语义（运行 /fullscreen 切换本会话）；fullscreen 下 /expand 同理指向 /minimal。
//     /expand 在 minimal 落地为真实动作 = 完整转录重放（resetMinimalReplay）。本壳
//     本地 /search（/find 替代）P1-2 起纳入 render/minimal.ts 的 FULLSCREEN_ONLY_COMMANDS，
//     面板 badge 与实际拒绝同源（不再自持第二份门控）。
//   - G-05：folds.ts 规格机接管折叠（P3-A 旧裁决 e=全展/E=全收废止，规格迁移）：
//     h/l/←/→ = 折叠/展开聚焦块、e = toggle、Shift+E = 全部展开、Ctrl+E = thinking 开合、
//     r = 原始视图（next 映射：工具行 args 原文 + 不截断，见 projection.rawMarkdown 注）。
//     聚焦块 = 最近可折叠 item（P3-A 定位策略保留，登记差异：grok 为选中块导航）。
//     块账按稳定 item id 记（f:<item.id>）；respect_manual_folds 两处可观测消费：
//     ① live 尾部（流式 step / pending 工具）每轮 autoFold——true（缺省）不覆盖手动
//     展开态、false 覆盖；② 重投影（/undo /new 等）——true 按 id 保留手动开合、false
//     重置默认。配置经 deps.respectManualFolds 注入（runNextChat 读
//     scrollback.scroll.respect_manual_folds，parseRespectManualFolds 严格解析）。
//     minimal 下折叠/视图键如实提示「仅影响后续输出」（追加式转录已写出内容不可撤回）。
//   - G-06：block-ops 真实回调注入（P2-C 的 noop 注入废止）：y/Shift+Y 经 OSC52 复制
//     块正文/正文+元数据（复用 P4-1 复制通道与提示样式），Enter/Ctrl+F 打开现有 overlay
//     查看器（正文按宽折行进浮层条目；Esc/q/Enter/Ctrl+F 关闭——查看器不滚动的体量
//     局限如实登记）。y 优先级：有选择先复制选择（P4-1 语义保持），无选择复制最近块。
//   - G-09：turn 粒度导航接线。Scrollback 新增 turn 锚点 API（markTurn/clearTurns/
//     jumpTurn），投影层按「用户回合首逻辑行」注册锚点；scrollback 焦点下 Shift+H/L
//     （按 turn 前后）与 Shift+J/K（视口顶上/下方 turn）接 keymaps nav.turn-* /
//     nav.viewport-turn-*（P2-C 的「无 API 不接线」登记废止）。minimal 下如实提示
//     终端原生滚动。
//   - G-11：`!` shell 模式消费（shell-mode.ts 检测器接线）。提交前 detectShellMode 命中
//     → 回显 `> !cmd` → shell-exec.ts 执行（spawn shell:true，30s 超时杀进程）→ 输出
//     逐行进转录系统行 + 退出码如实标注（[exit N] / signal / timeout）。语义边界：
//     用户亲手敲的 shell 命令**不走 core 工具审批**（审批保护的是 agent 的执行提议，
//     不适用用户本人操作；与 core bash 工具是两条通道）。忙时入队（G-26 队列语义，
//     与普通消息一致）；多条 `!` 命令按提交序串行执行。
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChatOptions } from '../../legacy-chat.js';
import {
  ASK_CANCELLED,
  setupChatSession,
  type ChatRuntime,
  type StreamEvent,
  type TurnResult,
  type TurnStreamHandler,
} from '../../chat-setup.js';
import {
  describeCapabilities,
  getContextUsage,
  loadConfig,
  parseCoreCommand,
  type AnySessionEvent,
  type ParsedCoreCommand,
} from '@harness2/core';
import { runSharedCommand, type InkCommandIo } from '../ink-commands.js';
import { createShellCommandDispatcher } from '../../shell-commands.js';
// —— P3-E 接线1（palette，G-31/G-50~G-53；A 棒模块五步缝消费）——
import {
  buildPaletteEntries,
  filterPaletteRows,
  paletteBackspace,
  paletteCardDepth,
  paletteClosed,
  paletteEnter,
  paletteCommandLine,
  paletteMove,
  paletteOpenState,
  paletteSetQuery,
  type PaletteEntry,
  type PaletteState,
  type ShellPaletteEntry,
} from '../commands/palette-model.js';
// —— P3-E 接线2（卡片调度，G-21/G-25；B 棒模块）——
import { activeCard, initialCardQueue, pushCard, resolveCard, type CardQueueState } from '../cards/queue.js';
import { renderCard } from '../cards/render.js';
import {
  cardFocusActionFromKey,
  globalFocusSuspended,
  initialCardFocus,
  reduceCardFocus,
  type CardFocusState,
} from '../cards/focus.js';
import { permissionCardFromApproval, type BlockCard } from '../cards/types.js';
// —— P3-E 接线3（队列/转向，G-26~G-30；C 棒模块）——
import {
  createQueueState,
  dequeueHead,
  DEFAULT_FOLLOW_UP_BEHAVIOR,
  enqueueFollowUp,
  removeFollowUpById,
  resolveFollowUpBehavior,
  type FollowUpBehavior,
  type QueueState,
} from '../queue/queue.js';
import {
  clampQueuePanelSelection,
  createQueuePanelState,
  focusTargetForUp,
  matchesQueuePanelOpenKey,
  moveQueuePanelSelection,
  renderQueuePanelRows,
  setQueuePanelOpen,
  toggleQueuePanel,
  type QueuePanelState,
} from '../queue/panel.js';
import {
  matchesSendNow,
  reduceFollowUpInput,
  resolveFollowUpInput,
  type FollowUpReduction,
  type SendNowTerminalFamily,
} from '../queue/wiring-contract.js';
// —— P3-E 接线4（状态行，G-42~G-49；C 棒模块）——
import { appendStatusLineFailureLog, runStatusLineCommand, unifiedLogPath } from '../status-line/runner.js';
import {
  defaultStatusLineSettings,
  parseStatusLineSettings,
  type ResolvedStatusLineSettings,
} from '../status-line/config.js';
import {
  buildStatusLinePayload,
  serializeStatusLinePayload,
  type StatusLineDataSource,
  type StatusLineTrigger,
} from '../status-line/contract.js';
import {
  createStatusLineGovernorState,
  reduceStatusLineGovernor,
  runsScript as statusLineRunsScript,
  type StatusLineDirective,
  type StatusLineGovernorState,
  type StatusLinePaint,
  type StatusLineRunOutcome,
} from '../status-line/governor.js';
import { applyPadding, renderBuiltinStatusLine, shapeCommandOutput } from '../status-line/render.js';
import { expandContextRefs, hasContextRefs } from '../../context-ref.js';
import { createInputParser, type InputParser } from '../../input/parser.js';
import { createInputDispatcher, type InputDispatcher, type InputLayer } from '../../input/dispatcher.js';
import type { InputEvent } from '../../input/types.js';
// P2-C：Esc 语义状态机（G-14～G-20）+ 键位表/焦点环（G-07～G-10）接入
import { ESC_PARK_HINT_TEXT, reduceEsc, type EscPane, type TurnState } from '../input/esc-machine.js';
import { resolveKeyAction, matchesShortcutsHelp, matchesSessionPicker, type InputModeId } from '../input/keymaps.js';
import { focusActionFromKey, initialFocusState, reduceFocus, type FocusState } from '../input/focus.js';
// P2-C：渲染模式状态机（G-01/G-02）与模式限定命令谓词（G-03）
import { commandSupportInMode } from '../render/minimal.js';
// P3-D G-05/G-06：folds 规格机 + block-ops 动作表（真实回调注入）
import {
  emptyFoldsState,
  isCollapsed,
  parseRespectManualFolds,
  reduceFoldKey,
  reduceFolds,
  type FoldBlockSpec,
  type FoldableBlockKind,
  type FoldKey,
  type FoldsState,
} from '../render/folds.js';
import { dispatchBlockOp, type BlockContent, type BlockOpCallbacks } from '../render/block-ops.js';
// P3-D G-11：shell 模式检测器 + 执行器
import { detectShellMode } from '../input/shell-mode.js';
import { formatShellTranscript, runShellCommand, type ShellExecResult } from './shell-exec.js';
// P3-D G-01：minimal 追加式渲染基座
import { composeMinimalPrompt, MinimalView } from './minimal-view.js';
import {
  DEFAULT_RENDER_MODE,
  createRenderModeState,
  resolveInitialRenderMode,
  switchRenderMode,
  type RenderMode,
  type RenderModeState,
} from '../render/mode.js';
import { summarizeArgs, turnSummaryLine } from '../../render.js';
import { describeSteerResult } from '../../steer.js';
import { createUiScheduler, type UiScheduler } from '../scheduler.js';
import {
  bindShutdownSignals,
  createCtrlCGuard,
  createShutdown,
  type ExitReason,
  type ShutdownController,
} from '../shutdown.js';
import { createNotifier, stderrSink, type Notifier } from '../notify.js';
import {
  emptyTranscript,
  isSubagentTool,
  projectSession,
  sessionEventToTranscript,
  transcriptReducer,
  type TranscriptEvent,
  type TranscriptItem,
  type TranscriptState,
} from '../transcript.js';
import type { WriteTarget } from '../renderer/diff-presenter.js';
import { ALT_SCREEN_EXIT, MOUSE_OFF, SHOW_CURSOR } from '../renderer/ansi.js';
import { osc52Copy } from '../renderer/osc.js';
import { Screen } from '../renderer/screen.js';
import {
  renderChat,
  resizeChat,
  layoutChat,
  queueEntryPreview,
  shortcutsFor,
  shortcutsHelpLines,
  SHORTCUTS_HELP_TITLE,
  SHORTCUTS_HELP_HINT,
  statusLineFor,
  type ChatScreenState,
} from './chat-screen.js';
import { projectTranscript, subagentDescription, type ProjectionLine } from './projection.js';
import { Scrollback, type SelectionPoint } from './scrollback.js';
import { wrapTextByWidth } from './overlay.js';
import { DEFAULT_THEME, getTheme, themeNames, type Theme } from './theme.js';
import { candidateItemAt } from './composer.js';
import {
  attachInput,
  createChatController,
  createComposerLayer,
  type AttachedInput,
  type ChatController,
} from './chat-controller.js';
import { terminalEvent } from '../useTurnStream.js';

/** next 渲染开关（runInkChat 入口分支用；默认关闭 → legacy ink 不变） */
export function shouldUseNextRenderer(env: Record<string, string | undefined>): boolean {
  return env.HARNESS2_RENDERER === 'next';
}

/** P4-1 选择开关：HARNESS2_SELECT=0 时鼠标拖选/键盘复制完全旁路（默认开启） */
export function selectionEnabledForEnv(env: Record<string, string | undefined>): boolean {
  return env.HARNESS2_SELECT !== '0';
}

// —— 常量（对齐既有装配的口径）——
const CTRL_C_WINDOW_MS = 2000; // Composer.CTRL_C_WINDOW_MS
const LIVE_FLUSH_MS = 50; // useTurnStream.FLUSH_MS
const IDLE_FLUSH_MS = 50; // chat-controller 文件头建议的空闲冲刷周期
const HINT_CLEAR_MS = 2000; // Composer 瞬时提示展示时长
const BRACKETED_PASTE_ON = '\x1b[?2004h'; // ansi.ts 无此常量（既有文件只读），本层自定义
const BRACKETED_PASTE_OFF = '\x1b[?2004l';
const FOCUS_REPORT_ON = '\x1b[?1004h'; // DECSET 1004 焦点上报（ansi.ts 无现成常量，同上自定义）
const FOCUS_REPORT_OFF = '\x1b[?1004l';
// DECSET 1003 全 motion 鼠标上报（真机悬停改选必需；renderer 的 MOUSE_ON 只有 1000;1002;1006
// = 按钮/拖动 motion。本层补写开启、退出对称关闭；headless 测试直接喂 SGR 序列不受影响）
const MOUSE_ALL_MOTION_ON = '\x1b[?1003h';
const MOUSE_ALL_MOTION_OFF = '\x1b[?1003l';

const SHORTCUTS: readonly string[] = ['Enter 发送', 'Shift+Enter 换行', 'Ctrl+C 停止', 'Ctrl+C 退出', 'PgUp/PgDn 滚动'];

// —— P3-E 重试预算快照（对齐 ink panels/retry-panel.tsx 的信息量；该模块是 ink/React 组件，
// next 层不可跨用（会引入 react/ink 依赖进 headless 装配），故按其冻结文案做纯函数等价复刻；
// 契约类型从 core TurnResult 派生，不复制 core 定义）——

/** 冻结契约类型（从 TurnResult 派生，与 ink retry-panel 的 RetryBudgetSnapshot 同源） */
export type RetryBudgetSnapshot = NonNullable<TurnResult['retryBudget']>;

/** 预算是否有值得展示的活动：发生过重试或明确停因（turn 正常无重试时不占行，对齐 ink） */
export function retryBudgetHasActivity(budget: RetryBudgetSnapshot): boolean {
  return budget.usedAttempts > 0 || budget.stopReason !== 'none';
}

const RETRY_STOP_REASON_LABEL: Record<RetryBudgetSnapshot['stopReason'], string> = {
  none: '未停',
  'budget-exhausted': '次数预算耗尽',
  timeout: '等待预算耗尽',
  'retry-after': 'Retry-After 超预算',
};

/** 预算快照 → 单行可读文本（纯函数；文案与 ink panels/retry-panel.formatRetryBudget 一致） */
export function formatRetryBudget(budget: RetryBudgetSnapshot): string {
  const waitSec = Math.round(budget.waitMs / 1000);
  const maxSec = Math.round(budget.maxWaitMs / 1000);
  return `重试 已用 ${budget.usedAttempts}/${budget.maxExtraAttempts} · 剩余 ${budget.remainingAttempts} 次 · 等待 ${waitSec}s/${maxSec}s · 停因 ${RETRY_STOP_REASON_LABEL[budget.stopReason]}`;
}

// —— P3-D 子代理块（耗时/动画）与全屏子视图 ——
/** spinner 帧序（braille 圆点，grok 运行中块动画同类字符族） */
export const SPINNER_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** spinner 推进周期（ms） */
export const SPINNER_INTERVAL_MS = 150;
/**
 * P3-D 键位裁决（差异登记 keymap 文档）：滚动区焦点下 `v` 打开子代理全屏视图（多子代理 =
 * 列表选择）。grok 是「选中块 + Enter/Ctrl+F」——本层无块光标，且 Enter 在滚动区焦点保留
 * 提交语义（肌肉记忆不迁移），故取独立字母键 v（view）。
 */
export const SUBAGENT_VIEW_KEY = 'v';
/** 视图态 composer 层提示行 */
const SUBVIEW_HINT = 'q/Esc 返回 · ↑↓/PgUp/PgDn/滚轮 滚动';

/**
 * 模式四态（P3-B，grok Shift+Tab 循环序）：plan / auto 为 UI 声明态（core 无契约且冻结，
 * 不改变审批/执行行为，红线 6）；always-approve 与 Ctrl+O 共享同一状态。
 */
export type UiMode = 'normal' | 'plan' | 'auto' | 'always-approve';
const MODE_CYCLE: readonly UiMode[] = ['normal', 'plan', 'auto', 'always-approve'];

/**
 * /mode 参数 → UI 四态（P2-2）：本壳同时接受 core catalog 声明的 legacy 别名
 * allow-approve（映射 always-approve）与自身四态名——避免「面板提示 allow-approve、
 * 本壳报未知模式」的双源错误；catalog 文案不动（还有 legacy/ink 消费）。
 */
const MODE_ALIAS_INPUT: Readonly<Record<string, UiMode>> = {
  normal: 'normal',
  plan: 'plan',
  auto: 'auto',
  'always-approve': 'always-approve',
  'allow-approve': 'always-approve',
};

/** /mode 未知参数的「可选值」提示（catalog 四别名 + 本壳 always-approve，去重保序） */
const MODE_INPUT_NAMES: readonly string[] = ['normal', 'allow-approve', 'auto', 'plan', 'always-approve'];

/** plan 态提交消息时打进转录的声明提示（灰色 system 行） */
const PLAN_MODE_NOTICE = '[plan mode] 下一条消息建议以规划为主：先探索并给出实现计划（UI 声明态：不改变审批/执行行为）';

// —— P3-C 命令注册表（next 层命令全集；wiring = 行为来源，note = 与 ink 的差异登记）——

/**
 * 命令接线方式：local = 本层实现（与 ink 同文案/语义）；shared = 委托
 * ink-commands.runSharedCommand；shell = P3-A shellOnly 命令的壳侧真实现
 * （tui/commands/shell-command-impls.ts，经 shell-commands 壳表分发——P1-1 起与
 * legacy/ink 共用同一份，handleCommand 经 createShellCommandDispatcher 路由）。
 */
export type NextCommandWiring = 'local' | 'shared' | 'shell';

export interface NextCommandEntry {
  /** 命令名（不含 '/'） */
  name: string;
  wiring: NextCommandWiring;
  /**
   * 命令别名（不含 '/'，小写规范形；G-84：`/theme` 的 `/t`）。core catalog 已解析的别名
   * （如 `/full`）不经本字段——本字段只承载**壳侧自持**命令的别名，由
   * resolveShellCommandName 在门控/分发/候选三处一致解析为规范 name。
   */
  aliases?: readonly string[];
  /** 一句话描述（P3-E 接线：palette 壳条目派生源，禁止第三份清单；缺省回退 wiring 说明） */
  summary?: string;
  /** 与 ink 的差异登记（缺省 = 无差异） */
  note?: string;
}

/**
 * next 层斜杠命令注册表（P3-C 全集 + P3-A shellOnly 批次）。core catalog 条目（含 8 条
 * shellOnly 新命令）在 palette 由 describeCapabilities 直接取（G-50 单一来源）；本表同时
 * 登记它们是为了 / 模糊补全候选与接线完备性（shell-command-impls 真实现，非 core 降级文案）。
 * quit / ? 为共享实现的别名（不在候选表，与 ink matchCommands 的候选口径一致）。
 */
export const NEXT_COMMANDS: readonly NextCommandEntry[] = [
  { name: 'new', wiring: 'shared' },
  { name: 'sessions', wiring: 'shared', note: '无参 = 转录文本列表（ink 为选择浮层，浮层化登记暂缺）' },
  { name: 'resume', wiring: 'shared' },
  { name: 'fork', wiring: 'shared' },
  { name: 'undo', wiring: 'shared' },
  { name: 'redo', wiring: 'shared' },
  { name: 'help', wiring: 'shared', note: 'core runCoreCommand（与 ink/legacy 同一份 core 实现）' },
  { name: 'exit', wiring: 'shared' },
  { name: 'session-info', wiring: 'shell', summary: '查看当前会话详情（id/事件与消息统计）' },
  { name: 'export', wiring: 'shell', summary: '导出当前会话轨迹为 ZIP（只读打包）' },
  { name: 'timeline', wiring: 'shell', summary: '只读输出会话轨迹时间线（仅 fullscreen）' },
  { name: 'doctor', wiring: 'shell', summary: '环境自检分节报告' },
  { name: 'memory', wiring: 'shell', summary: '查看长期记忆条目与用量（只读）' },
  { name: 'skills', wiring: 'shell', summary: '列出可用 skills（两级扫描合并）' },
  { name: 'plugins', wiring: 'shell', summary: '列出插件目录与装载审批状态' },
  { name: 'mcps', wiring: 'shell', summary: '列出配置的 MCP 服务器（只读）' },
  {
    name: 'mode',
    wiring: 'local',
    note: 'UI 四态声明态（P3-B）：无参 = 循环一次（等价 Shift+Tab）、带参接受四态名——经 shell-commands dispatcher override 注册（core 的 mode 为审批模式别名，core 契约冻结不改）',
  },
  {
    name: 'context',
    wiring: 'shared',
    note: 'core runCoreCommand（contextUsage 缝取 runtime 既有口径，输出与改造前逐字一致）',
  },
  {
    name: 'compact',
    wiring: 'shared',
    note: 'core /compact：有活动会话 = 分层压缩（H-12，与 /compact-layers 同一实现）；无活动会话 = 如实降级文案',
  },
  // —— P7 加性（B/C 棒 core 能力接线）：会话能力命令 + 工具面命令，wiring 'shared'（runSharedCommand
  //    → core runCoreCommand，三壳同一份实现）。注：next 另有 /search（local 转录搜索，P4-2）
  //    与 core /search（会话全文检索）同名——本壳路由优先 local（登记差异：next 用 /reindex /title
  //    等会话能力可用；会话全文检索在 legacy/ink 可执行，next 面板行执行落到 local 转录搜索）。
  //    P2-4：面板行如实标**壳**（source 'shell'，见 shadowedCoreCommands/buildNextPaletteEntries），
  //    不再以 core badge 冒充 core 实现。 ——
  { name: 'reindex', wiring: 'shared', note: 'core 会话检索索引重建（H-11）' },
  { name: 'import', wiring: 'shared', note: 'core 会话导出包导入（H-13）' },
  { name: 'title', wiring: 'shared', note: 'core 会话标题查看/设置/自动生成（H-14）' },
  { name: 'compact-layers', wiring: 'shared', note: 'core 分层压缩（H-12；/compact 默认路径同实现）' },
  { name: 'tools', wiring: 'shared', note: 'core 工具面 list/show/select（H-31）' },
  { name: 'reasoning', wiring: 'shared', note: '壳侧 shell-commands 表（三壳同一份实现，legacy 基准文案）' },
  { name: 'tasks', wiring: 'shared', note: 'core runCoreCommand 降级文案（runtime 无 cron 存储句柄，如实不注入）' },
  {
    name: 'minimal',
    wiring: 'shared',
    note: '渲染模式切换（P2-C：shell-commands 壳表 + RenderMode 状态机；minimal 基座未接入 = G-02 🟡 降级指引，core catalog shellOnly 元数据）',
  },
  {
    name: 'fullscreen',
    wiring: 'shared',
    note: '渲染模式切换（P2-C：/full 为别名，core catalog aliases；同模式幂等提示）',
  },
  {
    name: 'plan',
    wiring: 'local',
    summary: '声明 plan 模式（UI 提示态，不改执行）',
    note: 'next 层 UI 声明态（ink 无此命令）',
  },
  {
    name: 'auto',
    wiring: 'local',
    summary: '声明 auto 模式（UI 提示态，不自动放行）',
    note: 'next 层 UI 声明态（ink 无此命令）',
  },
  {
    name: 'always-approve',
    wiring: 'local',
    summary: '开关 always-approve（新审批自动代答 a）',
    note: 'next 层 always-approve 开关（ink 无此命令）',
  },
  {
    name: 'theme',
    wiring: 'local',
    aliases: ['t'], // G-84：/theme（/t）——规格含缩写别名
    summary: '切换主题 dark|light（会话内存级）',
    note: 'next 层主题切换 dark|light（P4-2）：无参列出可用并提示当前，未知名报错；会话内存级不持久化（grok 为 picker + config.toml 持久化 + auto 系统外观，差异登记）',
  },
  {
    name: 'search',
    wiring: 'local',
    summary: '转录文本搜索定位（仅 fullscreen）',
    note: '滚动区文本搜索（P4-2 简版）：/search <文本> 命中定位+高亮，无参重复上次，clear 清高亮；不做 / 交互输入框（grok 为 /find 交互式搜索栏，差异登记）；G-03：仅 fullscreen（定位作用于应用内视口，minimal 终端原生滚动无此视口）。P2-4：与 core /search（会话全文检索）同名且本壳路由优先 local——面板行按本壳实现如实标 badge「shell」（不再冒充 core）。',
  },
  {
    name: 'expand',
    wiring: 'local',
    summary: '完整转录重放到原生滚动区（仅 minimal）',
    note: 'G-03 仅 minimal：完整转录重放到原生滚动区（追加式转录在 rewind/会话切换后的旧内容仍留终端历史，本命令把当前转录全量重写一遍；fullscreen 下被模式门控拒绝）',
  },
];

/** pattern 是否为 target 的子序列（空 pattern 恒真） */
function isSubsequence(pattern: string, target: string): boolean {
  if (pattern.length === 0) return true;
  let i = 0;
  for (const ch of target) {
    if (ch === pattern[i]) i += 1;
    if (i >= pattern.length) return true;
  }
  return false;
}

/**
 * 壳命令别名解析（G-84）：word（可带 '/'）命中 NEXT_COMMANDS 的 name 或 aliases → 返回规范
 * name；未命中返回规范化后的 key 原样（未知命令仍走共享「未知命令」文案）。门控
 * （commandSupportInMode）/ 分发（handleCommand）/ 候选（filterCommands）三处统一走本函数，
 * 保证 `/t` 与 `/theme` 的门控判定、分发路由完全一致（core 已解析的别名不影响——传入的
 * parsed.id 本就是规范 id）。
 */
export function resolveShellCommandName(word: string): string {
  const key = (word.startsWith('/') ? word.slice(1) : word).toLowerCase();
  const entry = NEXT_COMMANDS.find((c) => c.name === key || (c.aliases ?? []).includes(key));
  return entry?.name ?? key;
}

/**
 * 模糊过滤候选（P3-C）：输入草稿（'/...'）→ 候选列表（带 '/' 前缀）。
 * 前缀命中 > 子序列命中（isSubsequence），各自按字典序；空输入 = 全部命令字典序。
 * ink 的 matchCommands 是纯前缀过滤，本层为其模糊超集（候选口径同源：注册表名 + next 扩展）。
 * G-84：别名命中（如 '/t' → theme 的 't'）计入**前缀命中**；候选仍以规范 name 呈现
 * （候选表 = 规范命令集，别名只影响命中与排序，不新增候选行）。
 */
export function filterCommands(input: string): string[] {
  const prefix = input.replace(/^\/+/, '').toLowerCase();
  const names = NEXT_COMMANDS.map((c) => c.name).sort();
  if (prefix.length === 0) return names.map((n) => `/${n}`);
  const aliasHits = new Set(
    NEXT_COMMANDS.filter((c) => (c.aliases ?? []).some((a) => a.startsWith(prefix))).map((c) => c.name),
  );
  const prefixHits = names.filter((n) => n.startsWith(prefix) || aliasHits.has(n));
  const subHits = names.filter((n) => !prefixHits.includes(n) && isSubsequence(prefix, n));
  return [...prefixHits, ...subHits].map((n) => `/${n}`);
}

// —— 审批 gate（createDialogController 的非 React 等价，见文件头取舍说明）——

export interface ApprovalGate {
  /** 审批提问：resolve 值为 'y' | 'a' | 'n' | ASK_CANCELLED（与 setupChatSession 契约一致） */
  ask(query: string): Promise<string>;
  /** 用户选择（数字/Enter 路径）；未挂起时 no-op */
  choose(answer: 'y' | 'a' | 'n'): void;
  /** 取消（Esc / Ctrl-C / 新提问挤占）；未挂起时 no-op */
  cancel(): void;
  /** 当前挂起的提问（null = 无） */
  pending(): string | null;
}

export interface ApprovalGateBindings {
  /** ask() 挂起时回调（装配层据此打开 overlay） */
  onOpen(query: string): void;
  /** ask() 结算（选择/取消/挤占）后回调（装配层据此关闭 overlay） */
  onSettled(): void;
}

/** 创建审批 gate；bind 由装配层在创建 harness 时调用（ask 可先于 bind 发生，事件不回放） */
export function createApprovalGate(): ApprovalGate & { bind(bindings: ApprovalGateBindings): void } {
  let bindings: ApprovalGateBindings | null = null;
  let current: { query: string; resolve: (answer: string) => void } | null = null;

  function settle(answer: string): void {
    const c = current;
    if (c === null) return;
    current = null;
    bindings?.onSettled();
    c.resolve(answer);
  }

  return {
    ask(query) {
      if (current !== null) settle(ASK_CANCELLED); // 新提问挤占旧挂起（对齐 dialog.open 的 pending.resolve）
      return new Promise<string>((resolve) => {
        current = { query, resolve };
        bindings?.onOpen(query);
      });
    },
    choose(answer) {
      settle(answer);
    },
    cancel() {
      settle(ASK_CANCELLED);
    },
    pending: () => (current !== null ? current.query : null),
    bind(b) {
      bindings = b;
    },
  };
}

// —— turn 流桥（useTurnStream 的非 React 等价复刻；terminalEvent 纯函数直接复用）——

interface TurnStreamBridge {
  handler: TurnStreamHandler;
  /**
   * G-01 minimal：当前「开口」live step 的 transcript item id（turnId+stepIndex 稳定 id，
   * 与 transcriptReducer 的 assistant/step id 同式）。此 item 正被 50ms flush 原地替换
   * （正文持续增长），minimal 追加式管线据此暂扣该块、落定（flushStep 关闭 / turn 收尾）
   * 后一次性写出。null = 无开口 step。
   */
  openStepId(): string | null;
  /** turn 结束：清 timer 并产出终态事件（final/partial/empty；与 useTurnStream.finalize 同语义） */
  finalize(result: TurnResult | undefined): TranscriptEvent | null;
  reset(): void;
  dispose(): void;
}

/**
 * 差异说明（与 useTurnStream 对照）：Ink 的 live 快照只驱动 React 重渲、不产生转录项；
 * next 的 Scrollback 无法原地更新，live 文本以 assistant/step（turnId+stepIndex 稳定 id）
 * 承载——50ms flush 用当前 stepIndex 原地替换（reducer put 幂等），工具边界 flushStep
 * 递增 stepIndex 另起新段。终态 turn-final 与末段 step 文本重复时由装配层去重跳过
 * （否则 assistant:<turnId> 与 step:N 会显示两份相同正文）。
 */
function createTurnStreamBridge(onEvent: (event: TranscriptEvent) => void): TurnStreamBridge {
  let buffer: { turnId: string | undefined; text: string; reasoning: string } = {
    turnId: undefined,
    text: '',
    reasoning: '',
  };
  let stepIndex = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // G-01 minimal：开口 step 的 item id（emitStep 时置位、flushStep/finalize/reset 清空）
  let openStep: string | null = null;

  /** 与 transcriptReducer 的 assistant/step id 同式（turnId 存在且非空 → turnId 作用域） */
  function stepIdFor(turnId: string | undefined, index: number): string {
    return turnId !== undefined && turnId.length > 0 ? `assistant:${turnId}:step:${index}` : `assistant:step:${index}`;
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** 50ms live flush：把当前累积作为 step 项原地替换（有正文/推理才发，避免空气泡） */
  function flushLive(): void {
    timer = null;
    emitStep();
  }

  function emitStep(): boolean {
    const hasText = buffer.text.trim().length > 0;
    const hasReasoning = buffer.reasoning.trim().length > 0;
    if (!hasText && !hasReasoning) return false;
    openStep = stepIdFor(buffer.turnId, stepIndex);
    onEvent({
      type: 'assistant/step',
      ...(buffer.turnId !== undefined ? { turnId: buffer.turnId } : {}),
      stepIndex,
      text: hasText ? buffer.text : '',
      ...(hasReasoning ? { reasoning: buffer.reasoning } : {}),
    });
    return true;
  }

  /** 工具边界 flushStep（对齐 useTurnStream：发了才递增 stepIndex 并清空缓冲） */
  function flushStep(): void {
    clearTimer();
    if (emitStep()) {
      stepIndex += 1;
      openStep = null; // step 已被工具边界关闭：该块落定（minimal 可写出）
      buffer = { turnId: buffer.turnId, text: '', reasoning: '' };
    }
  }

  function scheduleFlush(): void {
    if (timer !== null) return;
    timer = setTimeout(flushLive, LIVE_FLUSH_MS);
  }

  const handler: TurnStreamHandler = (event: StreamEvent) => {
    if (event.type === 'text-delta') {
      buffer.turnId = event.turnId;
      buffer.text += event.text;
      scheduleFlush();
      return;
    }
    if (event.type === 'reasoning-delta') {
      buffer.turnId = event.turnId;
      buffer.reasoning += event.text;
      scheduleFlush();
      return;
    }
    if (event.type === 'tool-call') {
      buffer.turnId = event.turnId;
      flushStep(); // 顺序保真：先落本 step 正文，再落工具项（后续文本另起一段）
      onEvent({
        type: 'tool/call',
        seq: 0,
        callId: event.call.id,
        tool: event.call.name,
        args: event.call.arguments,
        summary: summarizeArgs(event.call.arguments),
        turnId: event.turnId,
      });
      return;
    }
    // tool-result
    buffer.turnId = event.turnId;
    onEvent({
      type: 'tool/result',
      callId: event.callId,
      ok: event.ok,
      ...(event.error !== undefined ? { error: event.error } : {}),
      turnId: event.turnId,
    });
  };

  return {
    handler,
    openStepId: () => openStep,
    finalize(result) {
      clearTimer();
      openStep = null; // turn 收尾：末段 step 落定（minimal 可写出）
      return terminalEvent(result, {
        turnId: buffer.turnId,
        text: buffer.text,
        reasoning: buffer.reasoning,
      });
    },
    reset() {
      clearTimer();
      stepIndex = 0;
      openStep = null;
      buffer = { turnId: undefined, text: '', reasoning: '' };
    },
    dispose() {
      clearTimer();
    },
  };
}

// —— 装配层依赖（测试注入缝；runNextChat 传真终端）——

/**
 * P3-D：子会话事件缝（SubagentHooks.onChildEvent 的接收端）。runNextChat 用一个可变 sink
 * 桥接 setupChatSession（装配期先于 harness 创建，故经 set 延迟注册 handler）。
 */
export interface SubagentEventSink {
  set(handler: (sessionId: string, event: AnySessionEvent) => void): void;
}

export interface NextChatHarnessDeps {
  /** 渲染输出（Screen 的 WriteTarget；columns/rows 提供初始尺寸） */
  out: WriteTarget & { columns?: number; rows?: number };
  /** 装配期启动行（setupChatSession 的 line 钩子收集） */
  bootLines?: readonly string[];
  /** 环境变量（notifier 策略等；缺省 {} —— 测试确定性） */
  env?: Record<string, string | undefined>;
  /** 提醒 sink（缺省 stderrSink） */
  notifyWrite?: (s: string) => void;
  /** 审批 gate（runNextChat 先创建再传给 setupChatSession.askApproval） */
  gate: ApprovalGate & { bind?: (b: ApprovalGateBindings) => void };
  /** shutdown.finish 内的终端还原（runNextChat：拆屏/还原 raw mode/runtime.finish） */
  cleanup?: () => void | Promise<void>;
  /** 退出码出口（缺省 no-op；测试捕获，runNextChat 写 process.exitCode） */
  exit?: (code: number) => void;
  /** 外部已 start 的 Screen（runNextChat 自管启动序列时传入；缺省内部创建并 start） */
  screen?: Screen;
  /** P3-D：子会话事件缝（缺省不接——无实时追加，视图只走磁盘重放/内存累积降级） */
  subagentEventSink?: SubagentEventSink;
  /** P3-E：状态行 cwd（缺省装配期取 process.cwd()；测试注入确定性缝） */
  cwd?: string;
  /** P3-E：~ 短化基准主目录（缺省 os.homedir()；测试注入确定性缝） */
  home?: string;
  /**
   * P2-C：渲染模式初值（G-01；缺省 fullscreen）。真实装配（runNextChat）从 config
   * [ui] screen_mode 经 resolveInitialRenderMode 解析后传入；headless 测试直接注入。
   * P3-D 起初值如实生效：minimal = 以 minimal 基座启动（不建 alt-screen Screen）。
   */
  initialRenderMode?: RenderMode;
  /**
   * P3-D G-05：[scrollback.scroll] respect_manual_folds（缺省 true）。真实装配从
   * loadConfig 的 scrollback.scroll.respect_manual_folds 解析（parseRespectManualFolds
   * 严格布尔，非法回退缺省——解析在 runNextChat）；headless 测试直接注入。
   */
  respectManualFolds?: boolean;
  /**
   * P3-D G-01：minimal 的 status line 开关（缺省 = MINIMAL_STATUS_LINE_DEFAULT false，
   * 最接近 legacy readline 形态）。true 时状态行画在 prompt 块顶（1 行）。
   */
  minimalStatusLine?: boolean;
  /**
   * P3-D G-11：shell 执行缝（缺省 = shell-exec.runShellCommand 真实 spawn）。测试注入
   * 假执行器（不发进程）；真实装配用缺省实现（cwd = runtime.root）。
   */
  shellExec?: (command: string, opts: { cwd: string }) => Promise<ShellExecResult>;
  /**
   * P3-E 接线3（G-26）：[ui].follow_up_behavior 解析结果（缺省 queue = 入队不打断）。
   * 真实装配（runNextChat）从 config 经 resolveFollowUpBehavior 解析后传入；headless 测试
   * 直接注入（'steer' 态走转向注入主路径测试用）。
   */
  followUpBehavior?: FollowUpBehavior;
  /**
   * P3-E 接线4（G-42~G-49）：[ui.status_line] 解析结果（缺省 disabled = 维持 P3-E chrome
   * 状态行）。真实装配从 config 经 parseStatusLineSettings 解析（含告警回收）；builtin 型 =
   * C 棒 builtin 段渲染接管状态行；command 型 = governor/runner 驱动外部脚本。
   */
  statusLine?: ResolvedStatusLineSettings;
}

export interface NextChatHarness {
  /** Chat 整帧状态（滚动区/草稿/浮层/状态行——测试断言面） */
  readonly state: ChatScreenState;
  /** 喂原始输入字节（parser→dispatcher→controller 全链；有事件则渲染） */
  feed(bytes: Uint8Array | string): number;
  /** 空闲冲刷（孤立 ESC / 断流 paste 兜底）；真实路径由 50ms 定时器驱动 */
  flushIdle(now?: number): number;
  /** 立即排空 UI 调度器并渲染（测试确定性缝） */
  flushUi(): void;
  /** 终端尺寸变化（screen.resize + scrollback cols 契约同步） */
  resize(cols: number, rows: number): void;
  /** 提交入口（对齐 InkShell.submit：忙时入队、空闲执行；命令/turn 同一入口） */
  submit(text: string): void;
  /** Ctrl+C 语义入口（guard 协议；测试可直调，键盘路径经 controller.onInterrupt） */
  interrupt(): void;
  /** 退出请求（忙时先 abort、收尾后收敛；对齐 InkShell commandIo.requestExit） */
  requestExit(reason?: ExitReason): void;
  /** 审批选择/取消（编程入口；键盘路径经 approval 层） */
  approve(answer: 'y' | 'a' | 'n'): void;
  cancelApproval(): void;
  pendingApproval(): string | null;
  /** scrollback 逻辑行快照（测试断言用；wrap 段拼回 = 原逻辑行） */
  logicalLines(): string[];
  /** P4-2：逻辑行前景色（undefined = 默认色；主题/搜索高亮断言用） */
  logicalLineFg(index: number): number | undefined;
  /** P4-1：当前选中文本（无选择 = 空串；测试断言用） */
  selectedText(): string;
  /** P4-1：是否存在非零宽选择（测试断言用） */
  hasSelection(): boolean;
  /** P3-D：子视图逻辑行快照（null = 视图未打开） */
  subagentViewLines(): string[] | null;
  isBusy(): boolean;
  queueSnapshot(): readonly string[];
  /** P2-C：当前渲染模式（G-01；初值来自 config [ui] screen_mode，缺省 fullscreen） */
  renderMode(): RenderMode;
  /**
   * P3-D G-05：折叠账本快照（测试断言面）。collapsed/manual 皆为稳定 item id
   * （f:<item.id>，只列折叠状态可观测的已注册块）。
   */
  foldSnapshot(): {
    rawMarkdown: boolean;
    respectManualFolds: boolean;
    collapsed: string[];
    manual: string[];
  };
  /** P3-D G-09：scrollback 的 turn 锚点（逻辑行下标，升序；测试断言面） */
  turnAnchors(): number[];
  /** P3-D G-01：minimal 当前性已写出的转录行（文本快照；fullscreen 态为空数组） */
  minimalPrintedLines(): readonly string[];
  awaitDone(): Promise<number>;
  /** 仅清理 timers（不触发退出；测试 afterEach 用） */
  dispose(): void;
}

export function createNextChatHarness(runtime: ChatRuntime, deps: NextChatHarnessDeps): NextChatHarness {
  const env = deps.env ?? {};
  // —— P3-D G-01：双渲染基座（fullscreen = Screen alt-screen / minimal = 追加式直写）——
  // Screen 实例一次性（stop 后不可重启）：fullscreen→minimal 时 stop 并弃用，回切时新建。
  // minimal 初值不建 Screen（不进 alt-screen、不接管鼠标）；deps.screen 与 minimal 初值
  // 同给（防御）时如实 stop 退回主屏。
  const initialMode = deps.initialRenderMode ?? DEFAULT_RENDER_MODE;
  let activeScreen: Screen | null = null;
  if (initialMode === 'fullscreen') {
    activeScreen =
      deps.screen ??
      (() => {
        const s = new Screen(deps.out, Math.max(1, deps.out.columns ?? 80), Math.max(1, deps.out.rows ?? 24));
        s.start({ mouse: env.HARNESS2_MOUSE !== '0' });
        return s;
      })();
  } else if (deps.screen !== undefined) {
    deps.screen.stop();
  }

  // DECSET 1004 焦点上报（与屏幕基座无关：两种模式都经 parser focus 事件驱动 notifier）；
  // 关闭序列在 runNextChat 的 cleanup 统一写出（幂等）。
  deps.out.write(FOCUS_REPORT_ON);
  if (activeScreen !== null) {
    // P4-1：OSC8 开关随 deps.env 驱动（headless 测试注入；真机 process.env 同值）
    activeScreen.setOsc8Enabled(env.HARNESS2_OSC8 !== '0');
    // DECSET 1003 全 motion 鼠标上报（P3-C 悬停改选；与 screen.start 的 MOUSE_ON 叠加，
    // 幂等）。minimal 不接管鼠标——回切全屏时 enterFullscreenBase 补写（幂等）。
    deps.out.write(MOUSE_ALL_MOTION_ON);
  }

  // —— 双基座视口来源：全屏 = Screen 尺寸；minimal = 终端本体（out.columns/rows）——
  const viewCols = (): number => (activeScreen !== null ? activeScreen.cols : Math.max(1, deps.out.columns ?? 80));
  const viewRows = (): number => (activeScreen !== null ? activeScreen.rows : Math.max(1, deps.out.rows ?? 24));

  // —— 状态 ——
  let transcript = emptyTranscript();
  const bootLines = deps.bootLines ?? [];
  bootLines.forEach((text, i) => {
    transcript = transcriptReducer(transcript, { type: 'system', id: `boot:${i}`, text });
  });
  // —— P4-2 主题与搜索状态（会话内存级，不持久化——如实登记，grok 写 config.toml）——
  // 注意：state 字面量引用 theme，须先于其声明（dark = 现状默认色，零变化契约）。
  let theme: Theme = DEFAULT_THEME;
  let searchState: { query: string; lastHit: number } | null = null; // null = 无活动搜索/高亮
  const state: ChatScreenState = {
    env: deps.env,
    scrollback: new Scrollback([], Math.max(1, viewCols() - 1)),
    draft: '',
    cursor: 0,
    candidates: null,
    overlays: [],
    shortcuts: SHORTCUTS,
    statusline: '',
    indicators: [],
    theme,
  };

  // G-01 minimal 基座实例（追加式转录 + 底部 prompt 块；宽随 viewCols 动态取）
  const minimalView = new MinimalView(deps.out, viewCols);

  let busy = false;
  let exitRequested = false;
  let pendingExitReason: ExitReason = 'exit';
  let userSeq = 0;
  let sysSeq = 0;
  let steerSeq = 0;
  let hint: string | null = null;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  let focused = true; // DECSET 1004 焦点（缺省聚焦；unfocused 策略下不响，保守处理）
  // —— P3-E 接线3（G-26~G-30）：follow-up 队列（C 棒 queue.ts 纯状态）替代旧 string[] FIFO。
  // 行为 = deps.followUpBehavior（真实装配从 config [ui].follow_up_behavior 解析；缺省 queue）。
  let followUpQueue: QueueState = createQueueState(deps.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR);
  // —— P3-E 接线1（G-31）：命令面板状态（A 棒 palette-model；query 与草稿相互独立——
  // draft-preserving：面板绝不改写 composer 草稿，对齐上游 SendSlashCommandPreservingDraft）
  let paletteState: PaletteState = paletteClosed();
  let paletteEntries: PaletteEntry[] = []; // 打开时按当前渲染模式重建（modeSupport 随 G-03 谓词变化）
  // —— P3-E 接线2（G-21/G-25）：阻塞卡调度器（B 棒 cards）。本壳唯一真实卡源 = core 审批流
  // （permission；cancel-turn/question/elicitation 在 harness2 无来源——调度器类型留着不造假卡）。
  let cardQueue: CardQueueState = initialCardQueue();
  let cardFocus: CardFocusState = initialCardFocus();
  let approvalAskSeq = 0; // permission 卡 id 序列（route.requestId 的壳侧标识；应答走既有 gate 通道）
  // 模式四态（P3-B，见文件头语义说明）：plan/auto 为声明态不改行为；always-approve 与
  // Ctrl+O 共享此单态变量（开启时新审批经 gate.choose('a') 代答，红线 6）。
  let uiMode: UiMode = 'normal';
  let scrollbackFocus = false; // Tab 双态焦点：false = 输入框（默认），true = 滚动区（折叠键族生效）

  // —— P2-C 渲染模式状态机（G-01/G-02；P3-D 起状态提交随双基座切换真实落盘）——
  // 初值 = deps.initialRenderMode（runNextChat 从 config [ui] screen_mode 解析；缺省
  // fullscreen）；minimal 初值 = minimal 基座直接启动（上方 activeScreen 初始化已处理）。
  let renderModeState: RenderModeState = createRenderModeState(initialMode);

  // —— P2-C Esc 语义状态机（G-14～G-20；reduceEsc 接线，纯 reducer + 装配层执行副作用）——
  let turnState: TurnState = 'idle'; // running（回合中）/ cancelling（已请求取消、收尾前）/ idle
  let lastEscAt: number | null = null; // 双击武装时刻（reduceEsc 回写）
  let rewindGraceUntil = 0; // G-19 宽限 deadline（reduceEsc 回写；0 = 无）
  let hintCancelTurnSeq = -1; // G-14 提示去重：已提示过的用户回合号（每回合最多一条）
  let draftStash: string | null = null; // G-17 单槽 stash（双击 Esc 清空 / Ctrl+S+Alt+S 暂存的草稿；composer 空时恢复）
  // G-08 焦点环状态（focus.ts reducer；scrollbackFocus 为其投影，见 applyFocus）
  let focusRing: FocusState = initialFocusState();
  // 输入模式（G-07）：本阶段恒 simple（vim 未接配置/命令入口，登记差异）；键位表仍按模式取。
  const inputMode: InputModeId = 'simple';

  // —— P4-1 选择与复制（OSC52）状态 ——
  // 开关：HARNESS2_SELECT=0 完全旁路（鼠标不进选择态、Ctrl+C/y 不复制）。选择几何
  // （anchor/head）挂在 state.scrollback 上（本层只驱动）；子视图/picker 打开时鼠标
  // 被 subagentLayer 整体接管，选择仅作用于主转录（如实登记，不做子视图内选择）。
  const selectEnabled = selectionEnabledForEnv(env);
  let selDragging = false; // 鼠标左键拖选进行中（down 于滚动区 → move 扩展 → up 结束）
  let selMoved = false; // down 后是否发生过位置变化（up 时区分拖选与单击清除）
  let selDownPt: SelectionPoint | null = null; // 本次拖选起点（move 位移检测基准）

  // —— P3-D 子代理块（耗时/动画）与全屏子视图状态 ——
  // 耗时为 UI 层近似计时：subagent tool/call → tool/result 的 turn 事件流间隔（含审批等待/
  // 调度延迟，非 core runTurn durationMs），如实登记差异；<1s 视为即时完成不显示（0s 噪音）。
  const subagentStarts = new Map<string, number>(); // callId → Date.now()（运行中）
  const subagentDurations = new Map<string, number>(); // callId → 秒（完成/失败后保留，重投影用）
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  // 子会话登记（onChildEvent 桥；childId → 描述 = 子会话首条 user/message 文本）。
  // live 流的 tool/result 不带 output（StreamEvent 契约），childSessionId 不能从父转录解析——
  // 视图候选以本登记 + 转录 item（磁盘重投影后）并集为准。
  const childSessions = new Map<string, string | undefined>();
  const childEvents = new Map<string, AnySessionEvent[]>(); // onChildEvent 原始事件（打开视图时与磁盘合并）
  const childTranscripts = new Map<string, TranscriptState>(); // 增量累积（视图实时追加用）
  let subView: { childId: string } | null = null; // 非 null = 全屏子视图
  let subPicker: { items: string[]; targets: string[]; activeIndex: number } | null = null; // 多子代理选择

  // —— P3-E 状态行上下文化 / 队列取消面板 / 重试标记 ——
  // cwd 装配期取定（任务规格）；~ 短化基准 home 缺省 os.homedir()（测试注入）。
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? homedir();
  // ctx 占用缓存：keyed by (会话 dir, 转录 item 数)——item 数不变（流式原地替换/纯滚动）不重算，
  // 避免 50ms flush / 150ms spinner 帧每帧读盘；item 增减（新消息/工具项）才重读（getContextUsage
  // 同步可得，故为动态值而非「最近一次 /context」快照，诚实对齐任务规格的动态分支）。
  let usageCache: { dir: string | null; items: number; value: number | undefined } | null = null;
  // 上一 turn 的重试标记（turn 开始清空、有活动收尾时置位；状态行「重试 used/max」）
  let lastRetry: { used: number; max: number } | null = null;
  // —— P3-E 接线3（G-29）：队列面板状态机（C 棒 panel.ts）。open+focus+activeIndex 单源；
  // 打开键位 = G-29 三变体（Ctrl+; / Ctrl+' / Ctrl+4）。P3-F 冲突修复：Ctrl+X 不再是本面板
  // 别名（该和弦归 G-39 快捷键帮助；面板内取消高亮行 = 裸 `x`）。
  let queuePanelState: QueuePanelState = createQueuePanelState();
  // —— P3-F（G-39）：快捷键帮助浮层状态（可滚动；activeIndex 单源）——
  // 打开键 = keymaps.ts AGENT_CHORD_TABLE 的 help.shortcuts（Ctrl+. 主键 / Ctrl+X 备用）。
  let helpState: { open: boolean; activeIndex: number } = { open: false, activeIndex: 0 };
  // —— P3-F（G-34）：会话选择器浮层状态（items/targets 平行数组；targets = 会话 id）——
  let sessionPicker: { items: string[]; targets: string[]; activeIndex: number } | null = null;
  // —— P3-E 接线4（G-42~G-49）：状态行 governor/runner 装配 ——
  const statusSettings: ResolvedStatusLineSettings = deps.statusLine ?? defaultStatusLineSettings();
  let statusGovernor: StatusLineGovernorState = createStatusLineGovernorState(statusSettings);
  // command 型当前绘制行（null = 尚无输出——builtin/disabled 不走此路径）
  let statusPaintLines: readonly string[] | null = null;
  let turnStartedAt: number | undefined; // builtin turn-timer / payload.turn 数据源
  const statusTimers = new Set<ReturnType<typeof setTimeout>>();
  // steer 回帧 → 队列展示行的映射（core submitSteer id → 本队列 entry.id）
  const steerRowByCoreId = new Map<string, string>();
  // 「下一个回合先发」槽（G-27 send-head / G-28 send-now / G-30 direct-send 共用；
  // turn 收尾 finally 先发槽内文本再 drain 队列——单槽 + 溢出回队尾防丢失，见接线注释）
  let nextTurnText: string | null = null;
  // —— P3-D G-05 折叠规格机（folds.ts 接管；P3-A 旧 collapsed 覆盖集废止）——
  // 块账按稳定 item id（f:<item.id>）：rewind/会话切换后存活块的 id 不变，手动开合可
  // 按 respect_manual_folds 决定去留。缺省 true = 自动折叠不覆盖手动折叠。
  let foldsState: FoldsState = emptyFoldsState(deps.respectManualFolds ?? true);
  // G-05 r（原始视图）之外的运行期开关都走 reduceFolds；配置值仅构造期注入。

  // —— P3-D G-06 块查看器（现有 overlay 承载；Esc/q/Enter/Ctrl+F 关闭）——
  let blockViewer: { specTitle: string } | null = null;

  // —— P3-D G-01 minimal 管线状态 ——
  // minimalPrintedUpTo：minimal 期间已写进原生滚动区的 item 前缀长度（[0, n) 已写出）。
  // 写出序 = 转录序；live 尾部（开口 step / pending 工具）及其后的条目暂扣，落定后追加。
  // 注意与 fullscreen 的 Scrollback 重建解耦：reprojectAll 不动本值（spinner/主题等重建
  // 不触发重放）；转录整体替换（rewind/会话切换）与 /expand 才 reset 重放。
  let minimalPrintedUpTo = 0;
  const minimalPrinted: string[] = []; // 已写出的逻辑行文本快照（测试断言面；随 reset 清空）
  // G-11：`!` shell 命令串行链（多条命令按提交序执行；空链 = 立即执行）
  let shellChain: Promise<void> = Promise.resolve();

  const contentCols = (): number => Math.max(1, viewCols() - 1);

  // —— 投影同步（增量追加 / 全量重建，见文件头取舍） ——
  let syncedItems: readonly TranscriptItem[] = [];
  let syncedLineCount = 0;

  function projectLines(): ProjectionLine[] {
    syncFolds(); // G-05：折叠账本随转录同步（注册新块 + live 尾部 autoFold）
    const lines = projectTranscript(transcript.items, {
      cols: contentCols(),
      collapsed: collapsedIndices(), // G-05：由 folds 状态机派生（P3-A 旧覆盖集废止）
      theme, // P4-2：主题色板（缺省 dark；/theme 切换走 reprojectAll 全量重投影）
      rawMarkdown: foldsState.rawMarkdown, // G-05 r：原始视图（工具行 args 原文 + 不截断）
      // P3-D：耗时命中才随行显示；spinner 仅在动画定时器活动时传当前帧
      ...(subagentDurations.size > 0 ? { durations: subagentDurations } : {}),
      ...(spinnerTimer !== null ? { spinner: SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length] } : {}),
    });
    return applySearchHighlight(lines);
  }

  // —— P3-D G-05 折叠规格机接线（folds.ts）——
  // 块种类映射（钉死）：tool → 'tool'（edit/write 产 diff 卡 → 'diff'）；assistant 带推理
  // → 'thinking'。defaultCollapsed 恒 true（对齐 TranscriptView/projection 默认折叠规则）。
  function foldKindOf(item: TranscriptItem): FoldableBlockKind | null {
    if (item.kind === 'tool') return item.tool === 'edit' || item.tool === 'write' ? 'diff' : 'tool';
    if (item.kind === 'assistant' && item.reasoning !== undefined) return 'thinking';
    return null;
  }

  const foldBlockId = (item: TranscriptItem): string => `f:${item.id}`;

  /** 折叠账本同步：注册新块（id 稳定重登记幂等）+ live 尾部 autoFold（respect_manual_folds 生效点之一） */
  function syncFolds(): void {
    const specs: FoldBlockSpec[] = [];
    const autoUpdates: { blockId: string; collapsed: boolean }[] = [];
    const openStep = bridge.openStepId();
    for (const item of transcript.items) {
      const kind = foldKindOf(item);
      if (kind === null) continue;
      specs.push({ id: foldBlockId(item), kind, defaultCollapsed: true });
      // live 尾部 = 开口 step（50ms 原地替换的流式块）与 pending 工具（call↔result 原地
      // 合并中）——它们是「自动折叠」的作用对象；true = 手动展开不被覆盖，false = 覆盖
      if ((item.kind === 'tool' && item.status === 'pending') || (item.kind === 'assistant' && item.id === openStep)) {
        autoUpdates.push({ blockId: foldBlockId(item), collapsed: true });
      }
    }
    let next = reduceFolds(foldsState, { type: 'register', blocks: specs });
    next = reduceFolds(next, { type: 'autoFold', updates: autoUpdates });
    foldsState = next;
  }

  /**
   * folds 状态 → projection 的 collapsed 覆盖集（item 下标）。
   * 语义换算：覆盖集「在集 = 与默认折叠态取反」= 未折叠（展开）； folds「未折叠」同义。
   */
  function collapsedIndices(): Set<number> {
    const out = new Set<number>();
    transcript.items.forEach((item, i) => {
      if (foldKindOf(item) === null) return;
      if (!isCollapsed(foldsState, foldBlockId(item))) out.add(i);
    });
    return out;
  }

  /** 聚焦块（G-05 键位作用对象）= 最近可折叠 item（P3-A 定位策略保留；差异登记见文件头） */
  function focusedFoldBlockId(): string | null {
    for (let i = transcript.items.length - 1; i >= 0; i -= 1) {
      const item = transcript.items[i];
      if (item !== undefined && foldKindOf(item) !== null) return foldBlockId(item);
    }
    return null;
  }

  /**
   * G-05 折叠/视图键（h/l/←/→/e/Shift+E/Ctrl+E/r）经规格机裁决。
   * minimal 下如实提示（追加式转录已写出内容不可撤回，折叠变更仅影响后续输出）；
   * 全屏下状态变化 → 全量重投影（reducer 原引用 = 无变化，跳过重建）。
   */
  function applyFoldKey(key: FoldKey): void {
    if (renderModeState.mode === 'minimal') {
      showHint('minimal：折叠/视图变更仅影响后续输出（追加式转录）');
      return;
    }
    const before = foldsState;
    foldsState = reduceFoldKey(foldsState, key, focusedFoldBlockId());
    if (foldsState !== before) reprojectAll();
  }

  // —— P4-2 搜索高亮（post-pass）——
  // 命中判定 = 逻辑行文本大小写不敏感子串（中文按子串）；命中行整行 fg 换主题 searchHit
  // （next 行级单 fg 约束，无行内分段高亮）。自身回显/状态行排除（避免命中计数被自匹配放大）。
  // 高亮保留到下次搜索或 /search clear（无定时清除，任务规格）；每次重投影按当前文本重算，
  // 折叠/换主题/spinner 重建后仍正确，新追加的流式行命中同样着色。
  const SEARCH_STATUS_PREFIX = '搜索 "';
  const SEARCH_ECHO_PREFIX = '> /search';

  function isSearchNoise(text: string): boolean {
    return text.startsWith(SEARCH_STATUS_PREFIX) || text.startsWith(SEARCH_ECHO_PREFIX);
  }

  function applySearchHighlight(lines: ProjectionLine[]): ProjectionLine[] {
    if (searchState === null) return lines;
    const q = searchState.query.toLowerCase();
    if (q.length === 0) return lines;
    return lines.map((l) => {
      if (isSearchNoise(l.text)) return l;
      if (l.text.toLowerCase().includes(q)) return { ...l, fg: theme.fg.searchHit };
      return l;
    });
  }

  function rebuildScrollback(lines: readonly ProjectionLine[]): void {
    const old = state.scrollback;
    // 行对象直传（text + fg）：projection 的逐行配色随行进入 scrollback（P3-A 配色落地）
    const sb = new Scrollback(lines, contentCols());
    if (!old.follow) {
      // anchor 模式尽力保留视口：绝对 scrollTop 平移（新 maxScroll 钳制；取舍：重建即丢
      // wrap 缓存，anchor 语义以物理行数近似保持）
      sb.goToTop();
      if (old.scrollTopRow > 0) sb.scrollBy(old.scrollTopRow);
    }
    state.scrollback = sb;
  }

  function syncProjection(): void {
    const lines = projectLines();
    const items = transcript.items;
    let appendable = items.length >= syncedItems.length;
    if (appendable) {
      for (let i = 0; i < syncedItems.length; i += 1) {
        if (items[i] !== syncedItems[i]) {
          appendable = false;
          break;
        }
      }
    }
    if (appendable && items.length === syncedItems.length && lines.length === syncedLineCount) return; // 无变化
    if (appendable) {
      const added = lines.slice(syncedLineCount);
      if (added.length > 0) state.scrollback.appendLines(added); // ProjectionLine 直传（text + fg）
    } else {
      rebuildScrollback(lines);
    }
    syncTurnAnchors(lines); // G-09：用户回合首行注册为 turn 锚点（重建/追加后都重放，O(n)）
    syncedItems = [...items];
    syncedLineCount = lines.length;
  }

  /** 折叠/强制全量重投影（折叠变化时整体重建，见任务规格取舍） */
  function reprojectAll(): void {
    const lines = projectLines();
    rebuildScrollback(lines);
    syncTurnAnchors(lines);
    syncedItems = [...transcript.items];
    syncedLineCount = lines.length;
    invalidate();
  }

  // —— P3-D G-09 turn 锚点注册（投影层已知 user turn 边界）——
  // 锚点 = 每个用户回合的首个投影逻辑行（kind='user' 且 lineIndex 首次出现）。锚点挂
  // state.scrollback（G-09 jumpTurn 的跳转目标集）；minimal 下仍照常维护（回切全屏即用）。
  function syncTurnAnchors(lines: readonly ProjectionLine[]): void {
    const sb = state.scrollback;
    sb.clearTurns();
    let lastUserItem = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      if (line.kind === 'user' && line.lineIndex !== lastUserItem) {
        lastUserItem = line.lineIndex;
        sb.markTurn(i);
      }
    }
  }

  // —— P3-D G-01 minimal 追加式管线（与 fullscreen 的 renderChat 互斥的单基座路径）——

  /**
   * 首个「未落定」item 下标（[0, n) 视为已定稿可写出）。两类原地可变块会推迟落定线：
   * - pending 工具（call↔result 原地合并）；
   * - 开口 live step（50ms flush 原地替换、正文持续增长；bridge.openStepId 给出 id）。
   * 落定线之前的条目序即写出序——pending 工具之后的稳定条目（如 steer 系统行）一并
   * 暂扣，保证写入顺序与转录顺序一致。
   */
  function firstUnsettledItemIndex(): number {
    const openStep = bridge.openStepId();
    for (let i = 0; i < transcript.items.length; i += 1) {
      const item = transcript.items[i];
      if (item === undefined) continue;
      const mutable =
        (item.kind === 'tool' && item.status === 'pending') || (item.kind === 'assistant' && item.id === openStep);
      if (mutable) return i;
    }
    return transcript.items.length;
  }

  /** minimal 重放记账清零（进入 minimal / 转录整体替换 / /expand 前调用） */
  function resetMinimalReplay(): void {
    minimalPrintedUpTo = 0;
    minimalPrinted.length = 0;
    minimalView.reset();
  }

  /** minimal 基座渲染：追加落定转录行 + 重绘底部 prompt 块（statusline/浮层/候选/草稿） */
  function minimalSync(): void {
    const lines = projectLines();
    const settled = firstUnsettledItemIndex();
    if (settled > minimalPrintedUpTo) {
      const pending = lines.filter((l) => l.lineIndex >= minimalPrintedUpTo && l.lineIndex < settled);
      minimalView.printLines(pending);
      for (const l of pending) minimalPrinted.push(l.text);
      minimalPrintedUpTo = settled;
    }
    // P3-E 接线4：command 型多行状态行在 minimal 的单行缝（MinimalPromptInput.statusline）
    // 只展示**末行**——登记取舍（fullscreen 按行数取高全量呈现；minimal prompt 块状态行
    // 槽为 1 行，取末行 = 最接近 prompt 的新鲜行）。
    const statusRowText =
      state.statusLines !== undefined && state.statusLines.length > 0
        ? state.statusLines[state.statusLines.length - 1]
        : state.statusline;
    minimalView.renderPrompt(
      composeMinimalPrompt({
        draft: state.draft ?? '',
        cursor: state.cursor,
        ...(state.candidates !== null ? { candidates: state.candidates } : {}),
        ...(state.indicators !== undefined && state.indicators.length > 0 ? { indicators: state.indicators } : {}),
        ...(deps.minimalStatusLine === true && typeof statusRowText === 'string' && statusRowText.length > 0
          ? { statusline: statusRowText }
          : {}),
        overlays: state.overlays, // 阻塞卡（审批等）在 minimal 画进 prompt 块上方——不可隐形
        // P3-E 接线1：palette 进 minimal prompt 块（与 fullscreen 同一 drawPalette 绘制体）
        ...(paletteState.open
          ? { palette: { state: paletteState, rows: filterPaletteRows(paletteState.query, paletteEntries) } }
          : {}),
        cols: viewCols(),
      }),
    );
  }

  // —— P3-D 运行动画 + P4-2 状态行 spinner：busy 时 150ms 循环（目标二选一/共存分发）——
  // 启动条件（P4-2 扩展）：原为 busy 且存在运行中子代理块（行级 spinner 改运行中子代理行
  // 前缀，items 引用不变 → tick 走 reprojectAll 全量重建）；现扩展为 busy 即运转——
  // busy 且**无**运行中子代理时，tick 只刷 chrome（invalidate），把状态行「⏺ 运行中…」的
  // ⏺ 换成 SPINNER_FRAMES 当前帧（scrollback 无变化，免全量重建）；空闲停表。
  function updateSpinner(): void {
    const shouldRun = busy;
    if (shouldRun && spinnerTimer === null) {
      spinnerFrame = 0;
      spinnerTimer = setInterval(() => {
        spinnerFrame += 1;
        if (subagentStarts.size > 0)
          reprojectAll(); // 行级 spinner（P3-D 语义不回退）
        else invalidate(); // 状态行 spinner（P4-2）
      }, SPINNER_INTERVAL_MS);
    } else if (!shouldRun && spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }

  // —— P3-D 全屏子视图（滚动区焦点 v 打开；q/Esc 返回；键位差异登记 keymap 文档）——

  /** 子会话候选：转录 item（有 childSessionId，磁盘重投影后才有）∪ onChildEvent 登记，保序去重 */
  function subagentCandidates(): Array<{ childId: string; desc: string }> {
    const out: Array<{ childId: string; desc: string }> = [];
    const seen = new Set<string>();
    for (const item of transcript.items) {
      if (item.kind === 'tool' && isSubagentTool(item.tool) && item.childSessionId !== undefined) {
        seen.add(item.childSessionId);
        out.push({ childId: item.childSessionId, desc: subagentDescription(item) });
      }
    }
    for (const [childId, desc] of childSessions) {
      if (!seen.has(childId)) out.push({ childId, desc: desc ?? childId });
    }
    return out;
  }

  function syncPickerOverlay(): void {
    if (subPicker === null) return;
    state.overlays = [
      { title: '选择子会话', items: subPicker.items, activeIndex: subPicker.activeIndex, showNumbers: true },
    ];
  }

  /** v 入口：0 个 = 瞬时提示；1 个 = 直开；多个 = 列表选择浮层 */
  function openSubagentPicker(): void {
    const subs = subagentCandidates();
    if (subs.length === 0) {
      showHint('（无可打开的子会话）');
      return;
    }
    if (subs.length === 1) {
      openSubagentView(subs[0]!.childId);
      return;
    }
    subPicker = {
      items: subs.map((s, i) => `${i + 1}. ${s.desc}（${s.childId}）`),
      targets: subs.map((s) => s.childId),
      activeIndex: 0,
    };
    controller.blur(); // 列表接管键盘
    syncPickerOverlay();
    invalidate();
  }

  function closeSubPicker(cancel: boolean): void {
    const picker = subPicker;
    subPicker = null;
    state.overlays = [];
    controller.focus();
    if (!cancel && picker !== null) {
      openSubagentView(picker.targets[picker.activeIndex] ?? picker.targets[0]!);
      return;
    }
    invalidate();
  }

  /** 子会话不可读时的如实降级：错误行进转录（绝不伪造内容） */
  function childTranscriptError(childId: string, message: string): TranscriptState {
    return transcriptReducer(emptyTranscript(), {
      type: 'system',
      id: `subview-err:${childId}`,
      text: `无法读取子会话 ${childId}: ${message}（子会话目录不存在或日志尚未落盘）`,
    });
  }

  function openSubagentView(childId: string): void {
    // 重建子转录 = 磁盘重放（权威，含落盘全量）∪ onChildEvent 事件（运行中/磁盘缺失兜底）。
    // 事件按 seq 派生 id（sessionEventToTranscript），与磁盘同源事件 put() 幂等去重。
    childTranscripts.set(childId, loadChildTranscript(childId));
    subView = { childId };
    controller.blur(); // 视图接管键盘（composer 不画，无输入）
    rebuildSubview();
    invalidate();
  }

  /** 磁盘重放 + live 事件合并（locate 失败/无目录时降级 live 事件；两者皆空 = 如实错误行） */
  function loadChildTranscript(childId: string): TranscriptState {
    let located = false;
    let dirError: string | undefined;
    let ts = emptyTranscript();
    try {
      const dir = runtime.sessionManager.locate(childId);
      if (dir !== undefined) {
        ts = projectSession(dir);
        located = true;
      }
    } catch (e) {
      dirError = (e as Error)?.message ?? String(e);
    }
    for (const ev of childEvents.get(childId) ?? []) {
      const te = sessionEventToTranscript(ev);
      if (te !== null) ts = transcriptReducer(ts, te);
    }
    if (ts.items.length === 0) {
      return childTranscriptError(childId, dirError ?? (located ? '日志为空' : '未定位到子会话目录'));
    }
    return ts;
  }

  /** 子视图重建（打开/实时追加/子转录更新时）：子转录 → 投影 → 独立 Scrollback */
  function rebuildSubview(): void {
    if (subView === null) return;
    const ts = childTranscripts.get(subView.childId) ?? emptyTranscript();
    // P4-2：子视图行级 fg 与主转录同源（同一主题）；搜索高亮不作用于子视图（主转录专属）
    const sb = new Scrollback(projectTranscript(ts.items, { cols: contentCols(), theme }), contentCols());
    state.subagentView = { scrollback: sb, hint: `子会话 ${subView.childId} · ${SUBVIEW_HINT}` };
  }

  function closeSubagentView(): void {
    subView = null;
    state.subagentView = null;
    controller.focus();
    invalidate();
  }

  // —— 渲染与 chrome ——
  /** 当前会话 ctx 占用（带缓存：dir 或转录 item 数不变不重算，见状态区注释） */
  function currentUsage(): number | undefined {
    const dir = runtime.getCurrent()?.dir ?? null;
    const items = transcript.items.length;
    if (usageCache !== null && usageCache.dir === dir && usageCache.items === items) return usageCache.value;
    const value = dir !== null ? getContextUsage(dir) : undefined;
    usageCache = { dir, items, value };
    return value;
  }

  /**
   * P3-E 上下文化 chrome：状态行 = cwd(~) · model · ctx% · 模式(非 normal) · 重试 · 运行中；
   * 快捷键条 = shortcutsFor 四态（审批 > 子视图 > busy > 空闲）。数据驱动（chat-screen 纯函数）。
   * P3-E 接线4 追加：[ui.status_line] 配置了 builtin 时状态行由 C 棒 renderBuiltinStatusLine
   * 接管（G-43/G-44：items 即全部段，chrome 的模式/重试/运行中段让位——登记差异）；command
   * 型时单行 chrome 让位给 governor 驱动的脚本输出（statusPaintLines → state.statusLines）；
   * disabled（缺省）维持本 chrome。palette 渲染数据也在此同步（面板 open 时进浮层栈）。
   */
  function refreshChrome(): void {
    const usage = currentUsage();
    // P4-2：busy 且无运行中子代理时，状态行「⏺ 运行中…」的 ⏺ 用 spinner 帧动画
    // （复用 P3-D 帧集与定时器；有运行中子代理 = 行级动画接管，状态行保持 ⏺ 静止）
    const spinFrame =
      busy && subagentStarts.size === 0 && spinnerTimer !== null
        ? SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]
        : undefined;
    if (statusSettings.type === 'builtin') {
      // G-43/G-44：builtin 段渲染（数据缺席 = 段省略，绝不造假；padding 拼装）。
      // 登记差异：amber 阈值标注在单 fg 行通道不可表达（renderBuiltinStatusLine 返回
      // contextAmber，P3-C 已预告按需上色——next 行级单 fg 暂不上色，P7 归存）。
      const builtin = renderBuiltinStatusLine(
        {
          cwd,
          model: runtime.provider.name,
          ...(usage !== undefined ? { usage } : {}),
          ...(turnStartedAt !== undefined ? { turnStartedAtMs: turnStartedAt } : {}),
        },
        { items: statusSettings.items, cols: viewCols(), nowMs: Date.now() },
      );
      state.statusline = builtin.line === null ? '' : applyPadding(builtin.line, statusSettings.padding);
      state.statusLines = undefined;
    } else if (statusSettings.type === 'command') {
      // G-46/G-47：脚本输出行由 governor 裁决（run-finished paint → statusPaintLines）；
      // 空输出 = 收掉整行（不回退 chrome——上游明文）。错误行由 governor 给出（G-48）。
      state.statusline = '';
      state.statusLines = statusPaintLines ?? [];
    } else {
      state.statusline = statusLineFor({
        cwd,
        home,
        model: runtime.provider.name,
        ...(usage !== undefined ? { usage } : {}),
        ...(uiMode !== 'normal' ? { mode: uiMode } : {}),
        ...(lastRetry !== null ? { retry: lastRetry } : {}),
        ...(busy ? { busy: true } : {}),
        ...(spinFrame !== undefined ? { spinnerFrame: spinFrame } : {}),
      });
      state.statusLines = undefined;
    }
    state.shortcuts = shortcutsFor({
      busy,
      queueCount: followUpQueue.entries.length,
      approvalActive: gate.pending() !== null && !approvalParked,
      subviewOpen: subView !== null || subPicker !== null,
      // P3-F：帮助 / 会话选择器各自有一组真实键位提示（与各自 input layer 一致）
      ...(helpState.open
        ? { modal: 'help' as const }
        : sessionPicker !== null
          ? { modal: 'session-picker' as const }
          : {}),
    });
    // P3-E 接线1：palette 渲染数据同步（面板打开时 rows 随查询/条目变化每帧重建——
    // buildPaletteEntries 在 openPalette/模式切换时已重建，此处只做过滤投影，开销可忽略）
    state.palette = paletteState.open
      ? { state: paletteState, rows: filterPaletteRows(paletteState.query, paletteEntries) }
      : undefined;
    // 底边指示（P3-B 顺序：模式 · 焦点 · 其他）：normal 省略模式名，scrollback（Tab 焦点）、
    // 审批寄放提示常驻，hint 瞬时叠加
    const ind: string[] = [];
    if (uiMode !== 'normal') ind.push(uiMode);
    if (scrollbackFocus) ind.push('scrollback');
    if (approvalParked) ind.push('审批待答（Tab 回卡）');
    if (hint !== null) ind.push(hint);
    state.indicators = ind;
  }

  function invalidate(): void {
    syncCandidates();
    refreshChrome();
    // G-01 双基座互斥渲染：minimal = 追加式管线（minimal-view）；fullscreen = 全帧差量
    // （renderChat）。activeScreen 为空即 minimal（不变式：两基座恰好其一处于活动态）。
    if (renderModeState.mode === 'minimal' || activeScreen === null) {
      minimalSync();
      return;
    }
    renderChat(activeScreen, state);
  }

  // —— 候选补全（P3-C：draft 以 '/' 开头且不含空格/换行 = ink commandNameActive 语义）——
  // controller（冻结）接受候选/编辑后只改 state.draft/candidates.activeIndex，候选重算由本层
  // 在 invalidate 内完成（draft 变化必经 feed → invalidate，天然逐字过滤）。
  function syncCandidates(): void {
    const draft = state.draft ?? '';
    const active = draft.startsWith('/') && !draft.includes(' ') && !draft.includes('\n');
    const prev = state.candidates;
    if (!active) {
      state.candidates = null;
      return;
    }
    const items = filterCommands(draft);
    if (items.length === 0) {
      state.candidates = null;
      return;
    }
    // 过滤结果不变（如纯 ↑↓ 导航）：保留 controller 改写的高亮；否则（增删字符）钳制旧高亮
    const keep = prev !== null && prev.items.length === items.length && prev.items.every((it, i) => it === items[i]);
    const activeIndex = keep
      ? (prev?.activeIndex ?? 0)
      : Math.min(Math.max(0, prev?.activeIndex ?? 0), items.length - 1);
    state.candidates = { items, activeIndex };
  }

  /** 接受当前高亮候选：草稿写回 `/cmd `（含尾随空格 = 退出候选态；再 Enter 才发送） */
  function acceptCandidate(): void {
    const cands = state.candidates;
    if (cands === null || cands.items.length === 0) return;
    const chosen = cands.items[Math.min(cands.activeIndex, cands.items.length - 1)] ?? '';
    if (!chosen.startsWith('/')) return;
    state.draft = `${chosen} `;
    state.cursor = state.draft.length;
  }

  // —— UI 调度器（T4 有界合并，对齐 InkShell 的 16ms/64 批）——
  const scheduler: UiScheduler<TranscriptEvent> = createUiScheduler<TranscriptEvent>({
    flushMs: 16,
    maxBatch: 64,
    onFlush: (batch) => {
      transcript = batch.reduce(transcriptReducer, transcript);
      syncProjection();
      invalidate();
    },
  });

  function dispatch(event: TranscriptEvent): void {
    scheduler.push(event);
  }

  function flushUi(): void {
    scheduler.flushNow();
  }

  function sendSystem(text: string): void {
    sysSeq += 1;
    dispatch({ type: 'system', id: `sys:${sysSeq}`, text });
    flushUi(); // 低频：立即落定可见（对齐 InkShell 命令输出的即时性）
  }

  // —— 提示（Ctrl+C 协议瞬时提示；绝不写入草稿）——
  function clearHint(): void {
    if (hintTimer !== null) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    if (hint !== null) {
      hint = null;
      invalidate();
    }
  }

  function showHint(msg: string): void {
    clearHint();
    hint = msg;
    hintTimer = setTimeout(() => {
      hintTimer = null;
      hint = null;
      invalidate();
    }, HINT_CLEAR_MS);
    invalidate();
  }

  // —— P4-1 选择与复制（OSC52）——
  /**
   * 有选择时复制到系统剪贴板（OSC52 写 stdout，Buffer base64 编码），清选择并提示
   * 「已复制 N 字符」。无选择返回 false（Ctrl+C 落回 guard 协议，优先级不打扰既有语义）。
   */
  function copySelectionToClipboard(): boolean {
    if (!selectEnabled) return false;
    const sb = state.scrollback;
    if (!sb.hasSelection) return false;
    const text = sb.getSelectedText();
    deps.out.write(osc52Copy(text));
    sb.clearSelection();
    ctrlCGuard.reset(); // 复制不是退出意图：重置双击窗口（审查 P2-2，防 2s 内再按直接退出）
    showHint(`已复制 ${[...text].length} 字符`); // 码点数（非 UTF-16 code unit）
    return true;
  }

  /** 鼠标事件 → 选择坐标点（滚动区矩形内换算绝对物理行；行/列钳制） */
  function selectionPointFromMouse(mouseCol: number, mouseRow: number): SelectionPoint {
    const sb = state.scrollback;
    const rect = layoutChat(viewRows(), viewCols(), state).scrollback;
    const win = sb.visibleWindow(rect.height); // 与 drawScrollback 同参：scrollTop 幂等
    const relRow = mouseRow - rect.top;
    const absRow = Math.min(Math.max(0, win.scrollTop + relRow), Math.max(0, sb.totalRows - 1));
    return { row: absRow, col: Math.min(Math.max(0, mouseCol), contentCols() - 1) };
  }

  // —— P3-E 接线2：审批卡走 B 棒调度器（G-21 permission 卡；G-25 卡内焦点环）——
  // 真实来源 = core 审批流（gate.ask；askApproval 契约冻结仅携带文案——P3-B 登记延续）。
  // 卡片构建的诚实边界（逐字段登记）：
  //  - tool：从 gate 查询文案提取（core toolPrompt 形如「允许执行 <tool>? …」）；非该形
  //    （如测试直塞的自定义 ask）回退整句查询作为标识；
  //  - args：undefined（契约不携带参数数据——P3-B「参数级展开待 gate 契约扩展」延续；
  //    卡层 permissionArgsText 呈现「（无参数）」）；
  //  - sessionId：当前会话 id（无活动会话 = 空串，如实缺省）；
  //  - scope：{ mode: 'once' }（内联 ask 即单次提问；'a' 的会话级升级由应答侧 gate 语义承担）；
  //  - expiresAt：CLI 内联 gate **无过期语义** → 远期哨兵（卡层与接线层均不消费该字段，
  //    过期裁决归 core isApprovalExpired；本壳无 respond 通道，哨兵不产生任何行为）。
  //  - cancel-turn/question/elicitation 三类在本壳**无真实来源**（core 无 ask_user_question、
  //    MCP 无 elicitation、取消是 Ctrl+C 直接语义）——调度器类型保留，绝不造演示卡
  //    （G-22/G-23/G-24 归存 P7）。gate.ask 挤占语义（新 ask 结算旧挂起）使队列至多
  //    一张 permission 卡——调度器的排队/遮盖能力在单卡源下天然空转，属诚实现状。
  let approvalParked = false; // Esc 寄放：卡片只显示不接管键盘，审批仍挂起（G-20）

  /** gate 查询文案 → tool 标识（toolPrompt 形状提取；非该形回退整句） */
  function approvalToolOf(query: string): string {
    const m = /^允许执行 (.+?)\?/.exec(query);
    return m?.[1] ?? query.trim();
  }

  /** 当前活动卡（无卡 = null；本壳至多一张 permission 卡） */
  function activeApprovalCard(): BlockCard | null {
    return activeCard(cardQueue);
  }

  /**
   * 活动卡 → OverlaySpec（B 棒 renderCard 的映射契约：title→title、items[].label→items、
   * 焦点环 index→activeIndex——接线层零换算）。body/notes/hints 不渲染（登记）：
   * body 恒为「（无参数）」占位（契约无参数数据）、notes 遮盖注记在单卡源下恒空、
   * hints 由快捷键条（shortcutsFor approval 组）承载——不渲染重复文案。
   */
  function syncCardOverlay(): void {
    const card = activeApprovalCard();
    if (card === null) return;
    const view = renderCard(card);
    state.overlays = [
      {
        title: view.title,
        items: view.items.map((i) => i.label),
        activeIndex: Math.min(Math.max(0, cardFocus.index), Math.max(0, view.items.length - 1)),
        showNumbers: true, // permission 1-3 直选保留（item id 复用 ApprovalGate 应答空间 'y'|'a'|'n'）
      },
    ];
  }

  function openApproval(query: string): void {
    closeQueuePanel(false); // P3-E：审批最优先（dispatcher 首层），ask 挤占时队列面板让位
    closeRewindPicker(); // P2-C：审批最优先——rewind picker 同为浮层，ask 挤占时让位（防残留接管）
    // P3-F：快捷键帮助 / 会话选择器同为浮层，审批挤占时一并让位（不还键——下方 blur 接管）
    closeShortcutsHelp();
    closeSessionPicker();
    if (paletteState.open) paletteState = paletteClosed(); // P3-E 接线1：palette 同为浮层，让位（不还键——下方 blur）
    approvalParked = false;
    scrollbackFocus = false; // 审批接管时焦点语义回输入框（避免结算后指示器/折叠键族残留滚动区态）
    approvalAskSeq += 1;
    const card = permissionCardFromApproval({
      requestId: `approval-ask:${approvalAskSeq}`,
      sessionId: runtime.getCurrent()?.id ?? '',
      tool: approvalToolOf(query),
      args: undefined,
      scope: { mode: 'once' },
      expiresAt: '9999-12-31T23:59:59.999Z', // 哨兵：见函数头「诚实边界」（无过期语义，字段不被消费）
    });
    cardQueue = pushCard(cardQueue, card); // 优先级 permission 最高（G-21）；重复 id 幂等（seq 单调不触发）
    cardFocus = reduceCardFocus(cardFocus, { type: 'reset', count: renderCard(card).items.length }); // G-25 开卡归第 0 项
    syncCardOverlay();
    controller.blur(); // overlay 互斥接管键盘（对齐 InkShell 的 overlayOpen 语义）
    invalidate();
  }

  /**
   * 寄放（G-20 落地，P2-C 改）：卡片保持显示、审批仍挂起；焦点 park 到 scrollback（焦点环
   * park 动作由 handleEscPress 的 exit-card 分支先行应用，本函数只置寄放标记），键盘经
   * 焦点环语义可达 composer（scrollback 焦点下字母键自动回输入框，grok simple 语义）。
   * P1-1：子视图/picker 打开时**不**交还 composer——键盘属于 subagentLayer（视图层接管），
   * focus composer 会让输入进不绘制的草稿（隐形输入）；寄放态 approval 层放行，视图键照常。
   */
  function parkApproval(): void {
    approvalParked = true;
    if (subView !== null || subPicker !== null) {
      invalidate();
      return;
    }
    controller.focus();
    invalidate();
  }

  /** 寄放态显式回卡（Tab）：重新接管键盘（焦点指示随 closeApproval/retake 复位） */
  function retakeApproval(): void {
    approvalParked = false;
    scrollbackFocus = false; // 回卡后焦点语义复位（卡片接管；结算走 closeApproval 再复位）
    controller.blur();
    invalidate();
  }

  /**
   * 结算（选择/取消/挤占）关闭审批卡：按 B 棒调度器结算移除（resolveCard，G-21），
   * 应答本身已由 gate settle（core-approval 通道 = CLI ApprovalGate.choose/cancel）。
   * P1-1 焦点感知（防「隐形输入进不绘制的草稿」）：
   * - 子视图打开 → 不 focus composer，subagentLayer 继续接管（q/Esc 返回等视图键照常）；
   * - picker 被审批挤占 → 恢复 picker 显示并保持其键盘接管（二选一取方案 a）：用户的选择
   *   进度（activeIndex）保留、行为与「审批从未出现」一致、diff 最小；方案 b（取消 picker）
   *   会无谓丢弃用户上下文，不取。挤占期间 subagentLayer 对 picker/视图让位（见其
   *   approvalActive 处理），不会隐形改选；
   * - 两者皆空 → 现状 focus composer。
   */
  function closeApproval(): void {
    const card = activeApprovalCard();
    if (card !== null) cardQueue = resolveCard(cardQueue, card.id).state;
    state.overlays = []; // 结算移除浮层（picker 恢复分支在下方重同步）
    approvalParked = false;
    scrollbackFocus = false; // 结算回 composer 焦点（审查 P2-1：指示器与折叠键族同步复位）
    if (subView !== null) {
      invalidate();
      return;
    }
    if (subPicker !== null) {
      syncPickerOverlay(); // 恢复被 openApproval 覆盖的列表浮层（controller 保持 blur = picker 接管）
      invalidate();
      return;
    }
    controller.focus();
    invalidate();
  }

  /** 重建审批卡 spec（走行/结算/resize 后统一走此函数，activeIndex 以卡内焦点环下标为源） */
  function syncApprovalOverlay(): void {
    if (activeApprovalCard() !== null) syncCardOverlay();
  }

  /** 按 CardView 项 id（= ApprovalGate 应答空间 'y'|'a'|'n'）回答审批（B 棒 render.ts 契约） */
  function chooseApproval(index: number): void {
    const card = activeApprovalCard();
    if (card === null || card.kind !== 'permission') return;
    const item = renderCard(card).items[index];
    if (item !== undefined && (item.id === 'y' || item.id === 'a' || item.id === 'n')) {
      gate.choose(item.id);
    }
  }

  // —— 模式四态（P3-B；plan/auto 声明态不改行为，红线 6 见文件头）——
  function setMode(mode: UiMode): void {
    if (uiMode === mode) return; // 幂等（/plan /auto 重复设置保持）
    uiMode = mode;
    invalidate();
  }

  /** Shift+Tab 循环：Normal→Plan→Auto→Always-approve→Normal（grok 循环序） */
  function cycleMode(): void {
    const idx = MODE_CYCLE.indexOf(uiMode);
    setMode(MODE_CYCLE[(idx + 1) % MODE_CYCLE.length] ?? 'normal');
  }

  // —— Ctrl+O always-approve（UI 开关；开关态只影响**新**审批的代答，见文件头红线 6）——
  function toggleAlwaysApprove(): void {
    setMode(uiMode === 'always-approve' ? 'normal' : 'always-approve');
  }

  const gate = deps.gate;
  gate.bind?.({
    onOpen: (query) => {
      openApproval(query);
      // always-approve 开启时自动代答 'a'：经 gate.choose 走 resolve 路径（红线 6：
      // 不绕过 core 审批队列）；切换瞬间已挂起的审批不在此路径（onOpen 只对新 ask 触发）
      if (uiMode === 'always-approve') gate.choose('a');
    },
    onSettled: () => closeApproval(),
  });

  // —— Ctrl+C 协议（对齐 Composer）——
  const ctrlCGuard = createCtrlCGuard({ windowMs: CTRL_C_WINDOW_MS });

  function abortCurrentTurn(): void {
    if (!busy) return;
    sendSystem('^C（正在取消当前 turn…）');
    runtime.abortTurn();
    // P2-C：取消已请求、收尾前 = cancelling（G-15 此间 Esc 全吞；G-38 此间 Ctrl+C 升级退出）
    turnState = 'cancelling';
  }

  function interrupt(): void {
    if (gate.pending() !== null) {
      gate.cancel(); // 审批挂起时 Ctrl+C = 取消审批（对齐 Ink 的 Esc/Ctrl+C 便利取消）
      return;
    }
    // G-38：cancelling 期间 Ctrl+C 升级为退出请求（先 abort 等收尾后收敛——requestExit 语义）
    if (turnState === 'cancelling') {
      clearHint();
      requestExit('sigint');
      return;
    }
    const verdict = ctrlCGuard.press({ busy });
    if (verdict === 'cancel') {
      clearHint();
      abortCurrentTurn();
      return;
    }
    if (verdict === 'confirm') {
      clearHint();
      requestExit('sigint');
      return;
    }
    showHint('（再按一次 Ctrl+C 退出）');
  }

  // —— 退出（createShutdown 幂等路径；忙时先 abort、收尾后收敛）——
  const shutdown: ShutdownController = createShutdown({
    finish: async () => {
      attached.detach();
      clearTimers();
      leaveRenderBase(); // G-01：按当前基座还原终端（全屏退 alt-screen / minimal 擦 prompt）
      await deps.cleanup?.();
    },
    exit: (code) => {
      deps.exit?.(code);
    },
  });

  function requestExit(reason: ExitReason = 'exit'): void {
    if (shutdown.isShuttingDown()) return;
    if (busy) {
      // turn 进行中：先取消，等本轮收尾后由 finally 触发退出（对齐 InkShell requestExit）
      exitRequested = true;
      pendingExitReason = reason;
      runtime.abortTurn();
      return;
    }
    shutdown.request(reason);
  }

  // —— P3-E 接线3：提交 / 队列 / 转向（G-26~G-30；C 棒 queue.ts + wiring-contract.ts）——
  // 队列本体 = QueueState（behavior/entries/seq 单源）；编程入口 submit 与键盘 Enter 分工：
  // 编程入口保持「忙时入队」直通语义（不走草稿/历史），键盘 Enter 的完整路由在
  // extraKeyHandler 经 reduceFollowUpInput 裁决（见下）。
  function enqueue(text: string): void {
    const { state: next, outcome } = enqueueFollowUp(followUpQueue, text);
    followUpQueue = next;
    if (outcome.kind === 'rejected') {
      // 容量满/空白（编程路径不产生空白）：如实回报，不入队（core QUEUE_MAX 语义）
      sendSystem(outcome.message);
      return;
    }
    if (queuePanelState.open) syncQueueOverlay(); // 面板打开中（编程入口绕过键盘）同步条目数
    invalidate();
  }

  /** 队列展示条目文本快照（测试断言面 + 预览共用） */
  function queueTexts(): string[] {
    return followUpQueue.entries.map((e) => e.text);
  }

  function drainQueue(): void {
    if (shutdown.isShuttingDown()) return;
    if (queuePanelState.open) closeQueuePanel(false); // 面板是 busy 态的伴生浮层，turn 收尾即关
    const { state: next, entry } = dequeueHead(followUpQueue);
    followUpQueue = next;
    if (entry === undefined) return;
    invalidate();
    void handleUserText(entry.text);
  }

  // —— P3-E 接线3：队列面板（G-29；C 棒 panel.ts 状态机 + 壳侧浮层呈现）——
  // 差异登记（对 P3-E 早批面板的迁移）：
  //  - 打开键位 = G-29 三变体（Ctrl+; / Ctrl+' / Ctrl+4，matchesQueuePanelOpenKey）；
  //    P3-F 冲突修复：早批的壳侧附加别名 Ctrl+X **废止**（该和弦归 G-39 快捷键帮助）；
  //    打开条件 = G-29「队列非空」（去掉早批
  //    的 busy 门——空闲 + 非空在 drain 语义下实际不可达，门语义统一交给 panel.ts）；
  //  - 打开高亮 = **末行**（G-29 上游语义「with the last row highlighted」，替代早批高亮 0）；
  //  - 面板内键位 = G-29 表：↑↓ 走行（钳制不回绕，替代早批循环）、Enter 立即发送高亮行
  //    （G-28 cancel-and-send）、e 编辑高亮行（落回 composer）、裸 x 取消高亮行
  //    （壳侧附加能力，经 removeFollowUpById；P3-F 收窄：不再接受 Ctrl+X）、q/Esc 关闭、
  //    Ctrl+X/Ctrl+. = 关面板并开快捷键帮助；
  //  - 标题沿用「Queue · N 项」（C header.title = `Queue · N`，壳侧补「项」单位保持早批
  //    呈现契约）；条目预览复用 C queueEntryPreview（42 列截断，与 chat-screen 同名函数同源）。
  function syncQueueOverlay(): void {
    if (!queuePanelState.open) return;
    if (followUpQueue.entries.length === 0) {
      closeQueuePanel(false);
      return;
    }
    queuePanelState = clampQueuePanelSelection(queuePanelState, { queueCount: followUpQueue.entries.length });
    const { header, rows } = renderQueuePanelRows(followUpQueue.entries, queuePanelState);
    const activeIdx = rows.findIndex((r) => r.active);
    state.overlays = [
      {
        title: `${header.title} 项`,
        items: rows.map((r) => r.preview),
        ...(activeIdx >= 0 ? { activeIndex: activeIdx } : {}),
      },
    ];
  }

  /** 打开面板（G-29 三变体入口；P3-F 起无 Ctrl+X 别名）：审批挂起时拒绝（审批最优先，防顶掉寄放卡） */
  function openQueuePanel(): void {
    if (gate.pending() !== null) {
      showHint('审批待答（Tab 回卡）——先处理审批');
      return;
    }
    const before = queuePanelState;
    const next = toggleQueuePanel(before, { queueCount: followUpQueue.entries.length });
    if (next === before) {
      showHint('（队列为空）'); // G-29「when non-empty」：空队列不开假面板
      return;
    }
    queuePanelState = next; // toggleQueuePanel：open + focus 'queue' + 高亮末行
    controller.blur(); // 浮层接管键盘（P1-1 同款：接管期输入进不了草稿）
    syncQueueOverlay();
    invalidate();
  }

  /**
   * 关闭面板并还键盘给 composer。审批挂起时（寄放卡曾被面板挤占/清除）重建审批卡，
   * 杜绝「盲批」（审查 P1-1）。
   */
  function closeQueuePanel(refresh = true): void {
    if (!queuePanelState.open) return;
    queuePanelState = setQueuePanelOpen(queuePanelState, false, { queueCount: followUpQueue.entries.length });
    state.overlays = state.overlays.filter((s) => s.title?.startsWith('Queue · ') !== true);
    if (gate.pending() !== null) {
      approvalParked = true; // 键盘留在 composer，卡片显示等待 Tab 回卡
      syncCardOverlay();
    }
    controller.focus();
    if (refresh) invalidate();
  }

  /**
   * 取消高亮行（裸 x；经 C removeFollowUpById）+ system 回报行；取空自动关面板。
   * steer 语义取舍（如实提示，登记 P7）：core SessionSteerSink **无 cancel API**（契约冻结，
   * 不 thaw core）——已被 submitSteer 受理的在途 steer 行，面板移除只能撤**展示行**，注入
   * 仍会在安全 step 边界生效；此处按「是否已提交过」区分文案，绝不谎称「已取消注入」。
   */
  function cancelQueuedAt(index: number): void {
    const entry = followUpQueue.entries[index];
    if (entry === undefined || !queuePanelState.open) return;
    // 该展示行是否对应一条已提交（在途）的 steer：coreId → rowId 反查
    let inFlightCoreId: string | undefined;
    for (const [coreId, rowId] of steerRowByCoreId) {
      if (rowId === entry.id) {
        inFlightCoreId = coreId;
        break;
      }
    }
    followUpQueue = removeFollowUpById(followUpQueue, entry.id).state;
    if (inFlightCoreId !== undefined) {
      steerRowByCoreId.delete(inFlightCoreId);
      sendSystem(
        `已撤销排队展示行: ${queueEntryPreview(entry.text)}（该 steer 已提交当前回合，core 无撤回 API——仍将在安全 step 边界生效；登记 P7/解冻备选）`,
      );
    } else {
      sendSystem(`已取消排队: ${queueEntryPreview(entry.text)}`);
    }
    if (followUpQueue.entries.length === 0) {
      closeQueuePanel();
      return;
    }
    queuePanelState = clampQueuePanelSelection(queuePanelState, { queueCount: followUpQueue.entries.length });
    syncQueueOverlay();
    invalidate();
  }

  function submit(text: string): void {
    if (text.trim().length === 0) return;
    if (busy) {
      enqueue(text);
      return;
    }
    void handleUserText(text);
  }

  // —— P3-F 接线（G-39）：快捷键帮助浮层（cheatsheet）─────────────────────────
  // 内容来自 chat-screen.shortcutsHelpLines（首段复用快捷键条数据；Agent 级段取自
  // keymaps.AGENT_CHORD_TABLE，未接入条目带「P7 未接入」后缀——面板里不出现按了没反应的键）。
  // 呈现 = 现有 overlay 浮层（与队列面板/选择器同一渲染通道，两基座一致）；↑↓/j/k 滚动
  // （浮层条目超出可视行时窗口跟随 activeIndex，见 overlay.itemWindow）。
  function helpLines(): string[] {
    return shortcutsHelpLines({
      busy,
      queueCount: followUpQueue.entries.length,
      approvalActive: gate.pending() !== null && !approvalParked,
      subviewOpen: subView !== null || subPicker !== null,
    });
  }

  function syncHelpOverlay(): void {
    if (!helpState.open) return;
    const items = helpLines();
    const max = Math.max(0, items.length - 1);
    const activeIndex = Math.min(Math.max(0, helpState.activeIndex), max);
    helpState = { open: true, activeIndex };
    state.overlays = [{ title: `${SHORTCUTS_HELP_TITLE} · ${SHORTCUTS_HELP_HINT}`, items, activeIndex }];
  }

  /** 打开快捷键帮助（G-39）：审批挂起时拒绝（审批最优先，防顶掉寄放卡）——与队列面板同口径 */
  function openShortcutsHelp(): void {
    if (gate.pending() !== null) {
      showHint('审批待答（Tab 回卡）——先处理审批');
      return;
    }
    helpState = { open: true, activeIndex: 0 };
    controller.blur(); // 浮层接管键盘（P1-1 同款：接管期输入进不了草稿）
    syncHelpOverlay();
    invalidate();
  }

  function closeShortcutsHelp(): void {
    if (!helpState.open) return;
    helpState = { open: false, activeIndex: 0 };
    state.overlays = state.overlays.filter((s) => s.title?.startsWith(SHORTCUTS_HELP_TITLE) !== true);
    controller.focus();
    invalidate();
  }

  /** Ctrl+. / Ctrl+X 入口（G-39 toggle：再按关闭） */
  function toggleShortcutsHelp(): void {
    if (helpState.open) closeShortcutsHelp();
    else openShortcutsHelp();
  }

  // —— P3-F 接线（G-34）：会话选择器浮层 ───────────────────────────────────────
  // 数据源 = runtime.sessionManager.list(root)（mtime 倒序，与 /sessions 同源）；
  // 选中 → 走既有 `/resume <id>` 命令管线（core runResume → switchSession，runSharedCommand
  // 检出会话 id 变化后重投影）——不新造第二套切换语义（同 rewindPicker 的取舍）。
  // 条目展示 = `id · N 条 · 首条用户消息摘要`；当前会话标 `*`。
  /** 会话选择器最多展示条数（浮层可视行有限；其余仍可用 `/sessions <关键字>` 搜索） */
  const SESSION_PICKER_MAX = 30;

  function syncSessionPickerOverlay(): void {
    if (sessionPicker === null) return;
    state.overlays = [
      {
        title: `会话 · ${sessionPicker.items.length}（Enter 切换 · Esc 关闭）`,
        items: sessionPicker.items,
        activeIndex: sessionPicker.activeIndex,
        showNumbers: true,
      },
    ];
  }

  /** Ctrl+R 入口（G-34）：无会话 → 如实提示（不画空壳浮层）；有 → 列表接管键盘 */
  function openSessionPicker(): void {
    if (gate.pending() !== null) {
      showHint('审批待答（Tab 回卡）——先处理审批');
      return;
    }
    if (sessionPicker !== null) return; // 已打开（幂等，避免重复接管）
    const currentId = runtime.getCurrent()?.id ?? null;
    const sessions = runtime.sessionManager.list(runtime.root);
    if (sessions.length === 0) {
      showHint('（无历史会话）');
      return;
    }
    const shown = sessions.slice(0, SESSION_PICKER_MAX);
    const items = shown.map((s) => {
      const marker = s.id === currentId ? '* ' : '';
      const head = s.firstUserText.replace(/\s+/g, ' ').trim();
      const preview = head.length > 30 ? `${head.slice(0, 30)}…` : head;
      return `${marker}${s.id} · ${s.messageCount} 条${preview.length > 0 ? ` · ${preview}` : ''}`;
    });
    sessionPicker = { items, targets: shown.map((s) => s.id), activeIndex: 0 };
    controller.blur(); // 浮层接管键盘（P1-1 同款）
    syncSessionPickerOverlay();
    invalidate();
  }

  function closeSessionPicker(): void {
    if (sessionPicker === null) return;
    sessionPicker = null;
    state.overlays = state.overlays.filter((s) => s.title?.startsWith('会话 · ') !== true);
    controller.focus();
    invalidate();
  }

  /** 确认选中：经既有命令管线切换（`/resume <id>`；空闲态才允许——回合中切换会丢上下文） */
  function confirmSessionPicker(): void {
    const picker = sessionPicker;
    if (picker === null) return;
    const target = picker.targets[Math.min(picker.activeIndex, picker.targets.length - 1)];
    closeSessionPicker();
    if (target === undefined) return;
    if (busy) {
      showHint('回合运行中不可切换会话（Ctrl+C 取消后重试）');
      return;
    }
    handleUserText(`/resume ${target}`);
  }

  // —— P3-E 接线3：Enter 路由 / send-now 和弦 / steer（G-26/G-27/G-28/G-30；C 棒状态机装配）——

  /** send-now 和弦终端族（G-28）：装配层裁定 = default（主 Ctrl+Enter 备 Ctrl+I，kitty 编码）。
   * 登记取舍：apple-terminal 族的 Ctrl+O 在本壳已被 always-approve 占用（P3-A keymap 裁决）、
   * vscode-family 终端能力探测未接（capability 面正交，登记 P7）——固定 default 族。 */
  const SEND_NOW_FAMILY: SendNowTerminalFamily = 'default';

  /** G-30 回合相位：blocked = 卡片等待（审批挂起）；任务/子代理等待无壳侧信号，如实归 running（登记） */
  function turnPhase(): 'idle' | 'running' | 'blocked' {
    if (!busy) return 'idle';
    return gate.pending() !== null ? 'blocked' : 'running';
  }

  /** C 状态机上下文（纯投影）：phase/draft/turnId/panel */
  function followUpContext(): Parameters<typeof reduceFollowUpInput>[1] {
    // currentTurnId 可选调用（部分测试 mock 的 runtime 缺此成员——T5 前接口，防御性兼容）
    const turnId = typeof runtime.currentTurnId === 'function' ? runtime.currentTurnId() : undefined;
    return {
      phase: turnPhase(),
      draft: state.draft ?? '',
      ...(turnId !== undefined ? { turnId } : {}),
      // 机器用该序号构造 SteerRequest（纯数据产物——壳侧实际经 runtime.submitSteer 提交，
      // core 内部按同一 cli steer.ts 纯函数重建请求；此处序号只满足机器契约，不参与 id 语义）
      steerSeq: followUpQueue.nextSeq,
      panel:
        queuePanelState.open && queuePanelState.focus === 'queue'
          ? { open: true, focus: 'queue' as const, activeIndex: queuePanelState.activeIndex }
          : undefined,
    };
  }

  /**
   * C 状态机效果执行（单一出口）。副作用清单（接线契约）：
   *  - enqueue：机器已入队 → chrome 刷新 + 回报行（G-26「入队不打断」）；
   *  - steer：机器已入队展示行 → 经 runtime.submitSteer 提交（core SessionSteerSink 单一实现；
   *    壳侧无 sink.push 缝——C 棒构造的 SteerRequest 为纯数据产物，core 内部按同一 cli steer.ts
   *    纯函数重建，语义同源）。unknown/rejected → 撤展示行 + 草稿回填（draftKept 语义）；
   *    accepted 回帧由 observeSteer 移除展示行（stale/rejected 保留 = 转入下一回合）；
   *  - send-head（G-27）：出队文本进「下一回合先发」槽（不打断当前回合，无 cancel）；
   *  - send-now-x / direct-send（G-28/G-30，cancelTurn=true）：gate 挂起先取消（blocked 直送）→
   *    abortCurrentTurn（^C 如实行）→ 文本进先发槽（turn 收尾 finally 先发槽再 drain）；
   *  - edit-selected：文本落回 composer（行已出队）→ 关面板还键；
   *  - none：reason 进瞬时提示（G-28 空闲 no-op 等边界可见、不静默）。
   * 槽溢出保护：nextTurnText 已占用时新先发文本入队尾（不静默丢消息；顺序让位，登记）。
   */
  function applyFollowUpReduction(reduction: FollowUpReduction): void {
    followUpQueue = reduction.state;
    const effect = reduction.effect;
    switch (effect.kind) {
      case 'none': {
        if (effect.reason.length > 0) showHint(`（${effect.reason}）`);
        break;
      }
      case 'submit-normal': {
        // 不可达：extraKeyHandler 对 submit-normal 返回 'ignored' 落回 controller 内置提交
        // （历史 + 清稿 + onSubmit 全语义）。保留兜底 = 语义单源（直接走提交路径）。
        if (reduction.draftCleared) {
          state.draft = '';
          state.cursor = 0;
        }
        submit(effect.text);
        break;
      }
      case 'enqueue': {
        sendSystem(effect.message);
        break;
      }
      case 'steer': {
        // submitSteer 可选调用（T5 前的测试 mock 缺此成员）：缺失时按 unknown 语义如实降级
        // （撤展示行 + 草稿回填），绝不伪造「已提交」。
        if (typeof runtime.submitSteer !== 'function') {
          followUpQueue = removeFollowUpById(followUpQueue, effect.entry.id).state;
          if ((state.draft ?? '').length === 0) {
            state.draft = effect.entry.text;
            state.cursor = effect.entry.text.length;
          }
          sendSystem('error: steer 未提交：runtime 未提供 steer 通道');
          break;
        }
        const outcome = runtime.submitSteer(effect.entry.text);
        if (outcome.state === 'submitted') {
          steerRowByCoreId.set(outcome.id, effect.entry.id); // accepted 回帧 → 移除展示行
          sendSystem(outcome.message);
        } else {
          // unknown/rejected：撤展示行（注入未受理）+ 草稿回填（outcome.draftKept 语义）
          followUpQueue = removeFollowUpById(followUpQueue, effect.entry.id).state;
          if ((state.draft ?? '').length === 0) {
            state.draft = effect.entry.text;
            state.cursor = effect.entry.text.length;
          }
          sendSystem(`error: ${outcome.message}`);
        }
        break;
      }
      case 'steer-unknown': {
        sendSystem(`error: ${effect.message}`);
        break;
      }
      case 'send-head': {
        // G-27：空 composer 再 Enter = 发送队首一条（不打断当前回合，无 cancel）——
        // 进先发槽，turn 收尾后作为下一回合执行；槽被占用时条目回队尾（防丢失，登记）
        if (nextTurnText === null) nextTurnText = effect.entry.text;
        else enqueue(effect.entry.text);
        break;
      }
      case 'send-now-text':
      case 'direct-send': {
        if (gate.pending() !== null) gate.cancel(); // blocked 直送：先结算审批（ASK_CANCELLED，同 interrupt 路径）
        abortCurrentTurn(); // 如实打 ^C 行 + cancelling 态（turn 收尾后先发槽接管）
        if (nextTurnText === null) nextTurnText = effect.text;
        else enqueue(effect.text);
        break;
      }
      case 'send-now-head':
      case 'send-now-selected': {
        if (gate.pending() !== null) gate.cancel();
        abortCurrentTurn();
        if (nextTurnText === null) nextTurnText = effect.entry.text;
        else enqueue(effect.entry.text);
        if (queuePanelState.open) {
          // 发送即出队（机器已 remove/dequeue）：面板行数变化同步；回合收尾会最终关面板
          queuePanelState = clampQueuePanelSelection(queuePanelState, { queueCount: followUpQueue.entries.length });
          syncQueueOverlay();
        }
        break;
      }
      case 'edit-selected': {
        // G-29 e：文本落回 composer、行已出队；关面板还键（编辑需要 composer 焦点）
        state.draft = effect.entry.text;
        state.cursor = effect.entry.text.length;
        closeQueuePanel();
        break;
      }
    }
    if (
      reduction.draftCleared &&
      (effect.kind === 'enqueue' ||
        effect.kind === 'steer' ||
        effect.kind === 'send-now-text' ||
        effect.kind === 'direct-send')
    ) {
      state.draft = '';
      state.cursor = 0;
    }
    invalidate();
  }

  // —— P3-E 接线1：命令面板（G-31 / G-50~G-53；A 棒五步缝装配）──
  // 缝 #1 打开：Ctrl+P 恒触发；`?` 仅空草稿（打字中的 `?` 进草稿——上游
  // prompt_focused_question_mark_with_shift_still_goes_to_textarea 钉死语义）。条目 =
  // buildPaletteEntries（core describeCapabilities 单源 + 壳条目从 NEXT_COMMANDS 派生并
  // 减去 core 已有条目——禁止第三份清单）。
  // 缝 #2 键盘：查询/退格/↑↓ 归 palette-model reducer；Enter → paletteEnter。
  // 缝 #3 Esc：paletteCardDepth 并入 reduceEsc 的 cardDepth（见 handleEscPress）——面板
  // 无特例分支，exit-card 裁决后由宿主关闭。
  // 缝 #4 渲染：drawPalette 经 chat-screen overlayModal 栈（fullscreen）与 minimal-view
  // prompt 块（minimal）——两基座同一绘制体。
  // 缝 #5 路由：executePaletteCommand → handleUserText('/name') → handleCommand（G-03 门控
  // 自动生效）→ 本表 shellOnly 命令 runPaletteShellCommand / 其余 runSharedCommand。
  // draft-preserving：查询独立于草稿，执行不改写草稿（对齐上游 SendSlashCommandPreservingDraft）。

  /** 壳条目派生（G-50）：NEXT_COMMANDS 中 core catalog 没有的条目（本壳 UI 命令）→ 面板行 */
  function shellPaletteEntries(): ShellPaletteEntry[] {
    const coreIds = new Set(describeCapabilities().commands.map((c) => c.id));
    const shadowed = shadowedCoreCommands();
    // P2-4：同名遮蔽 core 且**由本壳本地分发**的命令（如 /search 的 local 转录搜索）也要出现在
    // 壳条目里——否则面板只剩 core 行（badge core），Enter 却走本地实现（显示 core 却执行 local）。
    return NEXT_COMMANDS.filter((c) => !coreIds.has(c.name) || shadowed.has(c.name)).map((c) => ({
      name: c.name,
      summary: c.summary ?? `${c.wiring} 实现（/${c.name}）`,
      group: '界面',
    }));
  }

  /**
   * 同名遮蔽 core 的本地命令集（P2-4）：从**本壳实际分发表** nextLocalCommands 派生——
   * 只有 core catalog 里有同名命令、且本壳 handleCommand 会先命中本地表时才算遮蔽（当前 = /search）。
   * 派生而非硬编码清单，避免「面板声明」与「实际路由」再次漂移。
   */
  function shadowedCoreCommands(): Set<string> {
    const coreIds = new Set(describeCapabilities().commands.map((c) => c.id));
    return new Set(
      NEXT_COMMANDS.map((c) => c.name).filter((n) => coreIds.has(n) && nextLocalCommands[n] !== undefined),
    );
  }

  /** 面板条目 = core 条目 + 壳条目；同名时以壳条目为准（P2-4：壳知道自己实际执行什么） */
  function buildNextPaletteEntries(): PaletteEntry[] {
    const shell = shellPaletteEntries();
    const shellNames = new Set(shell.map((e) => e.name));
    return buildPaletteEntries(renderModeState.mode, shell).filter(
      (e) => !(e.source === 'core' && shellNames.has(e.name)),
    );
  }

  function paletteRows(): ReturnType<typeof filterPaletteRows> {
    return filterPaletteRows(paletteState.query, paletteEntries);
  }

  function openPalette(): void {
    if (paletteState.open) return;
    if (gate.pending() !== null) {
      showHint('审批待答（Tab 回卡）——先处理审批'); // 审批最优先（dispatcher 首层不变式）
      return;
    }
    // 浮层互斥（P1-1 同款）：palette 独占浮层栈，已有浮层先收起（取消类收起无副作用）
    closeQueuePanel(false);
    closeRewindPicker();
    if (blockViewer !== null) closeBlockViewer();
    paletteEntries = buildNextPaletteEntries();
    paletteState = paletteOpenState(filterPaletteRows('', paletteEntries));
    controller.blur(); // 面板接管键盘（查询进面板，不进草稿）
    invalidate();
  }

  function closePalette(refocus = true): void {
    if (!paletteState.open) return;
    paletteState = paletteClosed();
    if (refocus) controller.focus();
    invalidate();
  }

  function togglePalette(): void {
    if (paletteState.open) closePalette();
    else openPalette();
  }

  /** 面板 Enter 执行（缝 #5）：/{name} 走宿主既有命令分发（echo + G-03 门控 + 路由） */
  function executePaletteCommand(name: string): void {
    handleUserText(paletteCommandLine(name));
  }

  /** 模式切换后重建面板条目（modeSupport badge 与 G-03 门控随模式变化；保留查询与归一高亮） */
  function rebuildPaletteEntriesForMode(): void {
    if (!paletteState.open) return;
    paletteEntries = buildNextPaletteEntries();
    paletteState = paletteSetQuery(
      paletteState,
      paletteState.query,
      filterPaletteRows(paletteState.query, paletteEntries),
    );
  }

  // —— P3-E 接线4：状态行 governor/runner 装配（G-46~G-49；C 棒纯状态机 + 真实时钟/子进程）──
  // 事件源（装配层注入真实世界）：
  //  - state-changed：turn 开始/收尾（runTurnText）、磁盘重投影（新快照 = urgent）、resize
  //    （urgent）；G-46 防抖 300ms / urgent 100ms 由 governor 裁决；
  //  - timer-fire / debounce-elapsed：指令驱动的真实 setTimeout 回填；
  //  - start-run 指令：构造 payload（StatusLineDataSource 从 runtime/会话状态喂）→
  //    runStatusLineCommand 真子进程 → run-finished 回填 → paint 上屏；
  //  - log-failure 指令：~/.harness2/logs/unified.jsonl（G-48）。

  function notifyStatusLineStateChanged(urgent: boolean): void {
    if (!statusLineRunsScript(statusGovernor)) return; // builtin/disabled 不调度（G-46 明文）
    const red = reduceStatusLineGovernor(statusGovernor, { type: 'state-changed', urgent, nowMs: Date.now() });
    statusGovernor = red.state;
    executeStatusDirectives(red.directives);
  }

  /**
   * P3-E 接线4 修复（G-46 自举）：装配完成时发一次 `started`，排出 refresh_interval 的
   * **首个**定时器。缺口：`schedule-timer` 原本只由 `timer-fire` 产出，而本装配层只为
   * 「已排定」的定时器回填 timer-fire——首个定时器无初始来源（鸡生蛋），配了
   * refresh_interval 也从不按周期跑。两基座（fullscreen / minimal）共用同一 governor
   * 装配，故本次自举对二者同时生效（minimal 经 deps.minimalStatusLine 缝展示同一
   * statusLines 输出）。仅排定时器、不发 start-run——首绘仍由 state 变化的事件驱动路径负责。
   */
  function bootstrapStatusLineTimers(): void {
    const red = reduceStatusLineGovernor(statusGovernor, { type: 'started', nowMs: Date.now() });
    statusGovernor = red.state;
    executeStatusDirectives(red.directives);
  }

  function executeStatusDirectives(directives: readonly StatusLineDirective[]): void {
    for (const d of directives) {
      switch (d.kind) {
        case 'schedule-debounce':
        case 'schedule-timer': {
          const delay = Math.max(0, d.fireAtMs - Date.now());
          const t = setTimeout(() => {
            statusTimers.delete(t);
            const event =
              d.kind === 'schedule-debounce'
                ? { type: 'debounce-elapsed' as const, nowMs: Date.now() }
                : { type: 'timer-fire' as const, nowMs: Date.now() };
            const red = reduceStatusLineGovernor(statusGovernor, event);
            statusGovernor = red.state;
            executeStatusDirectives(red.directives); // 链式：到期可能出发 start-run
          }, delay);
          statusTimers.add(t);
          break;
        }
        case 'start-run': {
          runStatusLineNow(d.trigger);
          break;
        }
        case 'log-failure': {
          appendStatusLineFailureLog(
            unifiedLogPath(home),
            { ts: Date.now(), level: 'error', source: 'status_line', message: d.message, timedOut: d.timedOut },
            Date.now(),
          );
          break;
        }
      }
    }
  }

  /** StatusLineDataSource（装配层喂数；缺失字段 = 省略，绝不造假——G-45 红线） */
  function buildStatusLineDataSource(): StatusLineDataSource {
    const current = runtime.getCurrent();
    return {
      cwd,
      sessionId: current?.id ?? '', // 无活动会话 = 空串（契约必填，如实缺省）
      // transcript_path = core 会话目录的 session.v1.jsonl（SESSION_LOG_FILE 约定）；无会话 = 空
      transcriptPath: current !== null ? join(current.dir, 'session.v1.jsonl') : '',
      modelId: runtime.provider.name,
      modelDisplayName: runtime.provider.name,
      ...(turnStartedAt !== undefined ? { turnStartedAtMs: turnStartedAt } : {}),
      // 登记：repoRoot/branch（git 探测）、cost/sessionUsage（runtime 无费用句柄）、
      // context_tokens（getContextUsage 只产出 0..1 比例，无法诚实拆出 token 数）——
      // 均不可 sourced，按 G-45「omit rather than placeholders」省略。
    };
  }

  function runStatusLineNow(trigger: StatusLineTrigger): void {
    const command = statusSettings.command;
    if (command === undefined) return;
    const payload = buildStatusLinePayload(buildStatusLineDataSource(), trigger);
    void runStatusLineCommand({
      command,
      payloadText: serializeStatusLinePayload(payload),
      cwd,
      size: { cols: viewCols(), rows: Math.max(1, statusPaintLines?.length ?? 1) }, // G-49：状态行自身尺寸
    }).then((result) => {
      const outcome: StatusLineRunOutcome = result.ok
        ? { ok: true, lines: shapeCommandOutput(result.stdout) }
        : { ok: false, ...(result.timedOut ? { timedOut: true } : {}), error: result.error };
      const red = reduceStatusLineGovernor(statusGovernor, { type: 'run-finished', outcome, nowMs: Date.now() });
      statusGovernor = red.state;
      applyStatusLinePaint(red.paint);
      executeStatusDirectives(red.directives); // dirty/owed → 后续防抖或立即续跑
      invalidate();
    });
  }

  function applyStatusLinePaint(paint: StatusLinePaint | null): void {
    if (paint === null) return;
    statusPaintLines = paint.kind === 'output' ? paint.lines : [paint.message]; // 错误行 = 单行画入（G-47/G-48 文案）
  }

  function clearStatusTimers(): void {
    for (const t of statusTimers) clearTimeout(t);
    statusTimers.clear();
  }

  async function runTurnText(text: string): Promise<void> {
    bridge.reset();
    busy = true;
    turnState = 'running'; // P2-C：回合运行中（G-14 Esc 提示通道；收尾回 idle）
    lastRetry = null; // P3-E：新 turn 清上一 turn 的重试标记（状态行不残留旧值）
    turnStartedAt = Date.now(); // P3-E 接线4：builtin turn-timer / payload.turn 数据源
    notifyStatusLineStateChanged(false); // P3-E 接线4：会话状态变化 → command 型状态行防抖刷新
    updateSpinner(); // P4-2：turn 开始即启动 spinner 定时器（无运行中子代理时驱动状态行帧动画）
    userSeq += 1;
    // 输入优先：user 回显立即落定（对齐 InkShell dispatchInputNow）
    scheduler.setInputPriority(true);
    scheduler.push({ type: 'user/message', seq: 0, id: `user:live:${userSeq}`, text });
    scheduler.flushNow();
    scheduler.setInputPriority(false);
    invalidate();
    let result: TurnResult | undefined;
    try {
      // @file/@dir 引用解析（对齐 InkShell：发送前预处理，回显保持原文）
      let sendText = text;
      if (hasContextRefs(text)) {
        const ref = expandContextRefs(text, { cwd: runtime.root, root: runtime.root });
        if (ref.hasRefs && ref.header.length > 0) sendText = `${ref.header}\n\n${text}`;
      }
      result = await runtime.runUserTurn(sendText, bridge.handler);
      const terminal = bridge.finalize(result);
      if (terminal !== null && !isDuplicateFinal(terminal)) dispatch(terminal);
      if (result !== undefined) {
        dispatch({ type: 'status', id: `status:${userSeq}`, text: turnSummaryLine(result) });
        // P3-E 重试信息（对齐 ink RetryPanel 信息量：used/remaining/等待/stopReason；形态差异
        // 登记：ink 为结构化面板，本层简化为转录 system 行 + 状态行「重试 used/max」标记——
        // ink RetryPanel 是 React 组件不可复用，且 retryBudget 快照仅 turn 收尾可得，时机一致）
        const budget = result.retryBudget;
        if (budget !== undefined && retryBudgetHasActivity(budget)) {
          lastRetry = { used: budget.usedAttempts, max: budget.maxExtraAttempts };
          dispatch({ type: 'system', id: `retry:${userSeq}`, text: formatRetryBudget(budget) });
        }
      }
    } catch (e) {
      sendSystem(`error: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      bridge.reset();
      busy = false;
      turnState = 'idle'; // P2-C：回合结束（正常/取消/异常一律）——cancelling 期结束（G-15 解除）
      turnStartedAt = undefined; // P3-E 接线4：turn-timer 段随回合结束省略（G-43）
      notifyStatusLineStateChanged(false); // P3-E 接线4：状态变化 → command 型状态行防抖刷新
      // P2-3：turn 收尾（正常/取消/异常一律走此 finally）清空运行中子代理表——残留条目
      // （tool/result 因 abort/异常永不到达）会在下个 turn 给 spinner 续命
      // （updateSpinner 的 shouldRun = busy && size>0），定时器空转、指示字符失真。
      // subagentDurations 保留（已完成耗时属转录内容，重投影仍要显示）。
      subagentStarts.clear();
      updateSpinner(); // P3-D：turn 结束（含取消/异常）→ 空闲停表
      scheduler.flushNow(); // final flush：终态/状态行立即落定
      // P2-3：清表后强制全量重投影——中止前最后一次 flush 可能已把 spinner 帧字符烤进
      // scrollback（pending 行此后不再变化），不重建则冻结帧残留
      reprojectAll();
      invalidate();
      // 回合结束提醒（cancelled 不发；退出中不发；异常结束照发——对齐 InkShell）
      if (!shutdown.isShuttingDown()) {
        notifier.onTurnComplete({ focused, cancelled: result?.stopReason === 'cancelled' });
      }
      // P3-lint：收尾后的「续跑」决策从 finally 尾部抽到 afterTurn()（优先级与副作用逐条不变；
      // 异常路径差异见 afterTurn 注释——刻意不再吞异常）。
      afterTurn();
    }
  }

  /**
   * turn 收尾后的续跑决策（P3-lint：自 runTurnText 的 finally 尾部抽出；不放在 finally 内，
   * 使其中的 return 只离开本函数，不再构成 no-unsafe-finally 的「finally 内 return」）。
   *
   * 优先级（与抽出前逐条一致）：退出请求 > 下一回合待发文本（单槽 nextTurnText）> 队列 drain。
   * 副作用不变：退出分支复位 exitRequested 后 request(pendingExitReason)；待发分支清空单槽、
   * invalidate() 后 void handleUserText(pending)；都不命中才 drainQueue()。
   *
   * 异常路径差异（刻意为之，本重构的既定方向）：原先 finally 内的 return 会在 catch 体自身
   * 抛出时（例如 sendSystem/dispatch 失败）吞掉该异常；抽成独立函数后，afterTurn() 在 finally
   * 内被普通调用、其 return 不覆盖调用方，未被处理的异常会正常向上传播。
   * lint 规则 no-unsafe-finally 本就是防「finally 里的 return 吞异常」，故此处**刻意不再吞异常**。
   * 正常路径（无待传播异常）与抽出前行为等价。
   */
  function afterTurn(): void {
    if (exitRequested && !shutdown.isShuttingDown()) {
      exitRequested = false;
      shutdown.request(pendingExitReason);
      return;
    }
    // P3-E 接线3：G-27 send-head / G-28 send-now / G-30 direct-send 的「下一回合先发」槽
    // 优先于队列 drain（单槽：多效应叠加时后到者把先到者压回队尾防丢失，见 applyFollowUpReduction）
    const pending = nextTurnText;
    if (pending !== null) {
      nextTurnText = null;
      invalidate();
      void handleUserText(pending);
      return;
    }
    drainQueue();
  }

  // —— P4-2 搜索（/search 简版：命令行式，无 / 交互输入框——评估后取简，差异登记见文件头）——
  // 行为：从当前视口底物理行**之后**找第一个命中逻辑行（无 = 回卷首个）；再次同查询 = 上一
  // 命中行之后的第一处（末尾回卷）。命中行 anchor 定位到视口顶（底部钳制）+ 整行高亮
  // （主题 searchHit）。命中计数排除搜索回显（'> /search'）与状态行（'搜索 "'），防自匹配
  // 放大 N。大小写不敏感；中文按子串；无高亮清除定时器（保留到下次搜索或 clear，任务规格）。
  const SEARCH_USAGE = '用法: /search <文本>（无参数 = 重复上次搜索；/search clear 清除高亮）';

  function computeHits(query: string): number[] {
    const sb = state.scrollback;
    const q = query.toLowerCase();
    const hits: number[] = [];
    for (let i = 0; i < sb.lineCount; i += 1) {
      const text = sb.rowOf(i).join('');
      if (isSearchNoise(text)) continue;
      if (text.toLowerCase().includes(q)) hits.push(i);
    }
    return hits;
  }

  function runSearch(query: string, repeat: boolean): void {
    const hits = computeHits(query);
    if (hits.length === 0) {
      searchState = { query, lastHit: -1 }; // 记忆查询（无参重试同词）；未命中 = 高亮清空（属「下次搜索」）
      reprojectAll(); // 清掉上一轮高亮（若有）
      sendSystem(`搜索 "${query}"：未找到`);
      return;
    }
    const prev = searchState;
    let target: number;
    if (repeat && prev !== null && prev.lastHit >= 0) {
      target = hits.find((h) => h > prev.lastHit) ?? hits[0]!; // 循环
    } else {
      // 首搜：从当前视口底物理行之后向下找；无（含贴底跟随态）→ 回卷首个
      const layout = layoutChat(viewRows(), viewCols(), state);
      const win = state.scrollback.visibleWindow(Math.max(1, layout.scrollback.height));
      const bottomRow = win.scrollTop + win.viewportRows - 1;
      target = hits.find((h) => state.scrollback.lineStart(h) > bottomRow) ?? hits[0]!;
    }
    searchState = { query, lastHit: target };
    reprojectAll(); // 命中行高亮（fg 变化需全量重投影；anchor 尽力保留）
    // 注意：reprojectAll 会整体替换 state.scrollback（rebuildScrollback）——定位必须作用于
    // 重建后的新实例，不能用重建前捕获的旧引用（否则跳转落在孤儿实例上，视口不动）。
    const sb = state.scrollback;
    sb.goToTop();
    sb.scrollBy(sb.lineStart(target)); // 命中行定位到视口顶（钳制到底部时仍可见）
    const ordinal = hits.indexOf(target) + 1;
    sendSystem(`搜索 "${query}"：${hits.length} 处命中（第 ${ordinal} 处）`);
  }

  function runSearchCommand(arg: string): void {
    // P1-2 单源门控：/search 已纳入 render/minimal.ts 的 FULLSCREEN_ONLY_COMMANDS，minimal 下
    // 由 handleCommand 的 G-03 谓词统一拒绝并给「指向替代」语义（面板 badge 与拒绝同源），
    // 本函数只在 fullscreen 可达——不再自持第二份模式判断（双源门控消除）。
    if (arg.length === 0) {
      if (searchState !== null) {
        runSearch(searchState.query, true); // 无参 = 重复上次查询（跳下一处）
        return;
      }
      sendSystem(SEARCH_USAGE);
      return;
    }
    if (arg.toLowerCase() === 'clear') {
      searchState = null;
      reprojectAll(); // 清高亮
      sendSystem('搜索高亮已清除');
      return;
    }
    const repeat = searchState !== null && searchState.query === arg;
    runSearch(arg, repeat);
  }

  // —— P4-2 主题切换（/theme）：会话内存级，不持久化（grok 写 config.toml，差异登记）——
  function runThemeCommand(arg: string): void {
    if (arg.length === 0) {
      const list = themeNames()
        .map((n) => (n === theme.name ? `${n}（当前）` : n))
        .join(' · ');
      sendSystem(`主题: ${list} — 用法 /theme ${themeNames().join('|')}`);
      return;
    }
    const next = getTheme(arg);
    if (next === undefined) {
      sendSystem(`error: 未知主题 ${arg}（可用: ${themeNames().join(', ')}）`);
      return;
    }
    if (next.name === theme.name) {
      sendSystem(`主题已是 ${theme.name}（可用: ${themeNames().join(', ')}）`);
      return;
    }
    theme = next;
    state.theme = next;
    reprojectAll(); // 行级 fg 烤进 scrollback 行对象：切主题必须全量重投影（anchor 尽力保留）
    sendSystem(`已切换主题: ${next.name}（会话内存级，不持久化）`);
  }

  // —— 命令（P3-C 全集；P1-Dev-2 起表驱动分发，壳内无 switch/case 命令名）——

  /**
   * next 层本地命令表（仅本壳 UI 命令；core 命令不经此表——分发顺序见 handleCommand）。
   * /mode 走 shell-commands 分发器的 override（见下），不在此表。
   */
  const nextLocalCommands: Readonly<Record<string, (rest: string) => void>> = {
    // plan 声明态：直接设置对应 UI 模式（幂等；不改审批/执行行为，红线 6 见文件头）
    plan: () => {
      setMode('plan');
      sendSystem('[plan mode] 已声明 plan 模式（UI 声明态：仅提示，不改变审批/执行行为；Shift+Tab 可切回）');
    },
    auto: () => {
      setMode('auto');
      sendSystem(
        '[auto mode] 已声明 auto 模式（UI 声明态：grok 的 auto=自动审批与红线 6 冲突，本层不自动放行，审批仍需人工回答）',
      );
    },
    'always-approve': () => {
      const turningOn = uiMode !== 'always-approve';
      setMode(turningOn ? 'always-approve' : 'normal');
      sendSystem(
        turningOn
          ? '[always-approve] 已开启（开启后的新审批自动代答 a，经 gate resolve 路径；再跑 /always-approve 或 Ctrl+O 关闭）'
          : '[always-approve] 已关闭（审批恢复人工回答）',
      );
    },
    theme: (rest) => runThemeCommand(rest.trim().toLowerCase()),
    search: (rest) => runSearchCommand(rest.trim()),
    // G-03（仅 minimal）/expand：完整转录重放到原生滚动区（真实动作，非占位）——
    // 追加式转录在 rewind/会话切换后旧内容仍留终端历史，重放给出一份与当前转录一致的
    // 干净输出。fullscreen 下本命令已被 handleCommand 的模式门控拒绝，到不了这里。
    expand: () => {
      resetMinimalReplay();
      sendSystem('已重新输出完整转录到原生滚动区（/expand）');
    },
  };

  /**
   * 壳侧 ShellCommand 分发器（shell-commands.ts 的表 + 本壳 override）。
   * 差异裁决（登记）：core 的 /mode 是审批模式别名（legacy/ink 语义）；next 的 /mode 是
   * UI 四态声明态（P3-B，测试锁定循环/四态语义，红线 6 不改审批行为）——以 override
   * 注册本壳变体，而非在壳里另写一份分发。/minimal /fullscreen（含 /full 别名）来自
   * 壳表本表（P2-C），经 renderMode 缝驱动 RenderMode 状态机。
   */
  const dispatchShellCommand = createShellCommandDispatcher({
    mode: (ctx, rest) => {
      const arg = rest.trim().toLowerCase();
      if (arg.length === 0) {
        cycleMode(); // 无参 = 循环切换一次（等价 Shift+Tab；任务规格二选一取循环，登记差异）
        showHint(`模式：${uiMode}${uiMode === 'plan' || uiMode === 'auto' ? '（声明态）' : ''}`);
        return;
      }
      // P2-2（不许引入用户可见的新错误）：core catalog 的 /mode argsSpec 声明
      // [normal|allow-approve|auto|plan]（legacy/ink 的审批模式别名语义），面板提示会引导
      // 用户输入 allow-approve——本壳 UI 四态为 normal/plan/auto/always-approve，故把
      // allow-approve 作为 always-approve 的别名（语义同为「审批自动放行」= acceptEdits 的
      // 壳侧对应态）。catalog 文案不动（它同服务 legacy/ink，改文案会引入反向错误）。
      const target = MODE_ALIAS_INPUT[arg];
      if (target !== undefined) {
        setMode(target);
        const aliasNote = target === arg ? '' : `（= ${target}）`;
        const declaredNote = target === 'plan' || target === 'auto' ? '（UI 声明态：不改变审批/执行行为）' : '';
        ctx.print(`已切换模式: ${arg}${aliasNote}${declaredNote}`);
        return;
      }
      ctx.print(`error: 未知模式 ${rest}（可选: ${MODE_INPUT_NAMES.join(', ')}）`);
    },
  });

  function handleUserText(text: string): void {
    // —— G-11 Shell 模式（行首 `!` 直接执行，先于斜杠命令解析——`!` 不是命令）——
    // 语义边界（钉死）：这是用户亲手敲的 shell 命令，**不经 core 工具审批**（审批管线
    // 保护的是「agent 提议在宿主执行什么」，用户本人操作不适用；与 core bash 工具是
    // 两条通道）。忙时与普通消息一致走 FIFO 队列（G-26 语义），drain 后按提交序执行
    // （shellChain 串行化）。
    const shellDecision = detectShellMode(text);
    if (shellDecision.shell) {
      sysSeq += 1;
      scheduler.setInputPriority(true);
      scheduler.push({ type: 'system', id: `echo:${sysSeq}`, text: `> ${text}` });
      scheduler.flushNow();
      scheduler.setInputPriority(false);
      void runShellTurn(shellDecision.command);
      return;
    }
    const parsed = parseCoreCommand(text);
    if (parsed !== null) {
      sysSeq += 1;
      scheduler.setInputPriority(true);
      scheduler.push({ type: 'system', id: `echo:${sysSeq}`, text: `> ${text}` });
      scheduler.flushNow();
      scheduler.setInputPriority(false);
      handleCommand(parsed);
      return;
    }
    // plan 声明态：提交消息时在转录打灰色提示行（不改执行，红线 6 见文件头）
    if (uiMode === 'plan') sendSystem(PLAN_MODE_NOTICE);
    void runTurnText(text);
  }

  // —— P3-D G-11 shell 执行（输出进转录系统行 + 退出码如实标注）——
  /** 串行执行链：多条 `!` 命令按提交序执行（执行期不置 busy——不是模型回合） */
  function runShellTurn(command: string): Promise<void> {
    const exec = deps.shellExec ?? ((cmd: string, opts: { cwd: string }) => runShellCommand(cmd, opts));
    const task = shellChain.then(async () => {
      if (shutdown.isShuttingDown()) return;
      let result: ShellExecResult;
      try {
        result = await exec(command, { cwd: runtime.root });
      } catch (e) {
        sendSystem(`error: shell 执行失败: ${(e as Error)?.message ?? String(e)}`);
        return;
      }
      // 输出行批量落定（一次 flush；id 唯一避免 system upsert 碰撞）
      sysSeq += 1;
      const base = sysSeq;
      const lines = formatShellTranscript(result);
      scheduler.setInputPriority(true);
      lines.forEach((line, i) => {
        scheduler.push({ type: 'system', id: `shell:${base}:${i}`, text: line });
      });
      scheduler.setInputPriority(false);
      scheduler.flushNow();
      invalidate();
    });
    // 防御：链上任一任务抛错不阻断后续命令（exec 内部已 try/catch，此处兜底）
    shellChain = task.catch(() => undefined);
    return task;
  }

  /**
   * P2-1：会话切换（/fork /new /resume，经 reprojectFromDisk 的重投影路径）时清空子会话
   * 瞬时状态：childSessions/childEvents/childTranscripts（onChildEvent 登记，属旧会话）、
   * subagentStarts/subagentDurations（耗时/spinner，属旧会话的 turn 流）。/undo /redo 不换
   * 会话，不清（rewind 后子会话入口仍在）。子会话**入口不从磁盘重建 childSessions 登记**：
   * 重投影后的转录 item 自带 childSessionId（磁盘 result output），subagentCandidates 的
   * 「转录 item ∪ 登记」并集已覆盖入口，描述经 subagentDescription(item) 取自磁盘 args——
   * 入口可完整重建，登记不重建（如实注释，不伪造）。
   */
  function clearChildSessionState(): void {
    childSessions.clear();
    childEvents.clear();
    childTranscripts.clear();
    subagentStarts.clear();
    subagentDurations.clear();
    updateSpinner(); // 表清空 → 若 spinner 在转则停表
    // 防御：切会话瞬间若子视图/picker 仍打开（正常输入路径不可达——视图接管键盘），如实关闭
    if (rewindPicker !== null) closeRewindPicker(); // P2-C：rewind picker 同理（转录已整体重建）
    if (subPicker !== null) closeSubPicker(true);
    if (subView !== null) closeSubagentView();
    // P3-F：帮助/会话选择器同理（会话选择器确认后自身已关；此处防 /resume 等编程路径残留接管）
    if (helpState.open) closeShortcutsHelp();
    if (sessionPicker !== null) closeSessionPicker();
  }

  /**
   * P3-C 重投影（对齐 ink reprojectTranscript）：/undo /redo 追加 rewind/marker、会话切换
   * （/new /resume /fork）之后，用 projectSession 从磁盘会话日志整体重建转录（被遮蔽的
   * user/assistant 条目消失、恢复时再现）。先落定待处理事件；清空折叠覆盖集（对齐 ink 清
   * expandedIds，避免旧 item 下标残留）；磁盘读取失败保底重投影内存转录（不伪造）。
   * P2-1：检测到会话 id 变化时一并清空子会话瞬时状态（见 clearChildSessionState）。
   */
  let reprojectSessionId: string | null = runtime.getCurrent()?.id ?? null;
  function reprojectFromDisk(): void {
    flushUi();
    const current = runtime.getCurrent();
    const currentId = current?.id ?? null;
    if (currentId !== reprojectSessionId) {
      clearChildSessionState();
      reprojectSessionId = currentId;
    }
    // G-05：重投影后的折叠账本按 respect_manual_folds 裁决——true（缺省）按稳定 item id
    // 保留手动开合（rewind/会话切换后存活块的折叠决策跟着走，register 幂等续账）；
    // false = 自动规则接管，重置为纯默认态。旧 collapsed 覆盖集「无条件清空」语义废止
    // （规格迁移：folds.ts 为单一事实来源）。
    if (!foldsState.respectManualFolds) foldsState = emptyFoldsState(false);
    // G-01：转录整体替换（rewind/会话切换）→ minimal 重放记账清零；minimal 态下下一次
    // invalidate 即全量重放（旧输出仍留终端 scrollback 历史——write-through 固有语义）。
    resetMinimalReplay();
    if (current !== null) {
      try {
        transcript = projectSession(current.dir);
      } catch {
        // 磁盘读取失败：保持内存转录（下方 reprojectAll 兜底刷新视图）
      }
    }
    notifyStatusLineStateChanged(true); // P3-E 接线4：新快照 = urgent 变更（G-46）
    reprojectAll();
  }

  /** 共享命令执行缝（委托 ink-commands.runSharedCommand；print/reproject/requestExit 对齐 InkShell） */
  const commandIo: InkCommandIo = {
    print: (t) => sendSystem(t),
    reproject: () => reprojectFromDisk(),
    requestExit: () => requestExit('exit'),
  };

  // —— P2-C 渲染模式缝（shell-commands.RenderModeControl；降级依据见 requestRenderModeSwitch）——
  const renderModeControl = {
    current: (): RenderMode => renderModeState.mode,
    requestSwitch: (to: RenderMode): 'switched' | 'same-mode' | 'degraded-unavailable' => requestRenderModeSwitch(to),
  };

  /**
   * 命令分发（表驱动）：⓪ G-03 模式限定门控（commandSupportInMode 谓词；当前模式不可用
   * 的命令如实拒绝，拒绝文案带上游「指向替代」语义——Run /fullscreen to switch this
   * session.）；① next 本地 UI 命令表（plan/auto/always-approve/theme/search/expand）；
   * ② 壳侧 shellOnly 壳表命令（mode/reasoning/minimal/fullscreen + P3-A 八条只读命令
   * session-info/export/timeline/doctor/memory/skills/plugins/mcps）→ shell-commands 分发器
   * （P1-1：八条与 legacy/ink 共用同一份真实现，mode = 本壳 UI 四态 override，渲染模式经
   * renderMode 缝驱动状态机）；③ 其余（/help /? /exit /quit /new /resume /fork /undo /redo
   * /sessions /context /compact /tasks 与未知命令）→ ink-commands.runSharedCommand → core
   * runCoreCommand（与 legacy/ink 同一份 core 实现；/undo /redo /new /resume /fork 的重投影
   * 语义经 runSharedCommand 保持不变）。
   *
   * G-03 门控（P3-D 起真实生效）：next 有双渲染基座（fullscreen/minimal），谓词按
   * renderModeState.mode 实判——minimal 下 fullscreen 专属命令被拦（见上方文案）、
   * fullscreen 下 /expand 被拦。palette Enter 执行同走本函数（G-31 缝 #5）。
   */
  function handleCommand(parsed: ParsedCoreCommand): void {
    // G-84：壳命令别名先解析为规范 name（/t → theme），门控与分发因此与规范命令完全一致
    // （minimal 下 /t 与 /theme 同样被 G-03 门控拒绝；core 别名如 /full 经 parsed.id 已规范）。
    const word = resolveShellCommandName(parsed.id ?? parsed.raw.replace(/^\//, ''));
    const support = commandSupportInMode(word, renderModeState.mode);
    if (support === 'unavailable-fullscreen-only' || support === 'unavailable-minimal-only') {
      const only = support === 'unavailable-fullscreen-only' ? 'fullscreen' : 'minimal';
      // 上游语义（refs-grok-build G-03 审查遗留）："Run /fullscreen to switch this session."
      const alt = only === 'fullscreen' ? '/fullscreen' : '/minimal';
      sendSystem(
        `当前渲染模式（${renderModeState.mode}）下不可用：/${word}（仅 ${only} 模式提供；运行 ${alt} 切换本会话）`,
      );
      return;
    }
    const local = nextLocalCommands[word];
    if (local !== undefined) {
      local(parsed.rest);
      return;
    }
    if (
      parsed.id !== null &&
      dispatchShellCommand(parsed.id, parsed.rest, {
        print: sendSystem,
        runtime,
        renderMode: renderModeControl,
        // P1-1 壳上下文注入缝：会话目录/根/home（8 条只读命令定位用）
        currentSessionDir: () => runtime.getCurrent()?.dir ?? null,
        root: runtime.root,
        home, // memory/plugins/mcps 全局根（deps.home ?? 真实 home，与状态行 ~ 短化同源）
      })
    ) {
      return;
    }
    void runSharedCommand({ name: parsed.raw, rest: parsed.rest }, runtime, commandIo);
  }

  // —— turn 流桥与终态去重 ——
  let lastStep: { turnId: string | undefined; text: string } | null = null;
  const bridge = createTurnStreamBridge((event) => {
    if (event.type === 'assistant/step') lastStep = { turnId: event.turnId, text: event.text };
    // P3-D 耗时（UI 层近似计时，见状态区注释）：subagent tool/call 起表，tool/result 结算
    if (event.type === 'tool/call' && isSubagentTool(event.tool)) {
      subagentStarts.set(event.callId, Date.now());
      updateSpinner();
    } else if (event.type === 'tool/result' && subagentStarts.has(event.callId)) {
      const startedAt = subagentStarts.get(event.callId) ?? Date.now();
      subagentStarts.delete(event.callId);
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      if (seconds >= 1) subagentDurations.set(event.callId, seconds); // <1s 即时完成不显示
      updateSpinner();
    }
    dispatch(event);
  });

  // —— P3-D：onChildEvent 桥（SubagentHooks → 子会话登记 + 视图实时追加）——
  // runNextChat 在 setupChatSession 装配期注入 SubagentHooks（core 导出面，core 零改动），
  // 事件经 sink 延迟注册到本 handler；writer 先落盘后回调（core 侧保证）。
  deps.subagentEventSink?.set((sessionId, event) => {
    if (!childSessions.has(sessionId)) childSessions.set(sessionId, undefined);
    if (event.type === 'user/message') {
      const text = event.payload.text;
      if (typeof text === 'string' && text.length > 0 && childSessions.get(sessionId) === undefined) {
        childSessions.set(sessionId, text.split('\n')[0]?.trim() || undefined);
      }
    }
    let list = childEvents.get(sessionId);
    if (list === undefined) {
      list = [];
      childEvents.set(sessionId, list);
    }
    list.push(event);
    const te = sessionEventToTranscript(event);
    if (te !== null) {
      const prev = childTranscripts.get(sessionId) ?? emptyTranscript();
      childTranscripts.set(sessionId, transcriptReducer(prev, te));
    }
    if (subView !== null && subView.childId === sessionId) {
      rebuildSubview(); // 实时追加：视图打开中 → 独立 Scrollback 全量重建（子会话行数有限）
      invalidate();
    }
  });

  /** turn-final 与末段 step 文本重复时跳过（避免同正文显示两份，见 bridge 差异说明） */
  function isDuplicateFinal(event: TranscriptEvent): boolean {
    if (event.type !== 'turn-final') return false;
    return (
      lastStep !== null &&
      event.text === lastStep.text &&
      (lastStep.turnId === undefined || event.turnId === undefined || event.turnId === lastStep.turnId)
    );
  }

  // —— P3-D G-06 块内容操作（block-ops.ts 真实回调注入；P2-C 的 noop 注入废止）——
  // 块内容快照：从最近一个转录 item 投影（y=正文、Shift+Y=正文+元数据；next 无块光标，
  // 取最近 item 定位——与折叠聚焦块的 P3-A 策略同源，差异登记 keymap 文档）。
  function lastBlockContent(): BlockContent | null {
    const item = transcript.items[transcript.items.length - 1];
    if (item === undefined) return null;
    const meta: string[] = [];
    let body = '';
    switch (item.kind) {
      case 'user':
        body = item.text;
        meta.push('role: user');
        break;
      case 'assistant':
        body = item.text;
        meta.push('role: assistant');
        break;
      case 'partial':
        body = item.text;
        meta.push('role: assistant（未完成）');
        break;
      case 'empty':
        body = item.error ?? '';
        meta.push('role: assistant（无正文）');
        break;
      case 'tool':
        body = item.output ?? item.error ?? item.summary;
        meta.push(`tool: ${item.tool}`, `status: ${item.status}`, `call: ${item.callId}`);
        break;
      case 'system':
      case 'status':
        body = item.text;
        meta.push('system');
        break;
    }
    return { id: item.id, body, ...(meta.length > 0 ? { metadata: meta } : {}) };
  }

  /** G-06 回调注入：复制走既有 OSC52 通道（P4-1 同款写出 + 提示）；查看器走现有 overlay */
  const blockOpCallbacks: BlockOpCallbacks = {
    copyText: (text, meta) => {
      if (!selectEnabled) {
        showHint('复制通道未启用（HARNESS2_SELECT=0）');
        return;
      }
      deps.out.write(osc52Copy(text));
      ctrlCGuard.reset(); // 复制不是退出意图（与 copySelectionToClipboard 同款防双击误退）
      showHint(
        meta.kind === 'body+metadata'
          ? `已复制块正文+元数据（${[...text].length} 字符）`
          : `已复制块正文（${[...text].length} 字符）`,
      );
    },
    openViewer: (block) => openBlockViewer(block),
  };

  /** 最近块的 G-06 键位动作（未知键返回 null 不执行；block-ops 纯表 + 注入回调） */
  function dispatchBlockOpOnLastBlock(key: 'y' | 'Shift+Y' | 'Enter' | 'Ctrl+F'): void {
    const block = lastBlockContent();
    if (block === null) {
      showHint('（无可操作的块）');
      return;
    }
    dispatchBlockOp(key, block, blockOpCallbacks);
  }

  /** G-06 全屏查看器：现有 overlay 承载（正文按宽折行进条目；无高亮 = 纯文本面板）。
   * 体量登记：overlay 高度钳在草稿上方可用空间内，超长正文截断呈现（查看器不滚动）。 */
  function openBlockViewer(block: BlockContent): void {
    const width = Math.max(16, contentCols() - 2);
    const bodyLines = wrapTextByWidth(block.body.length > 0 ? block.body : '（空块）', width);
    blockViewer = { specTitle: `查看 · ${block.id}` };
    state.overlays = [{ title: blockViewer.specTitle, items: bodyLines }];
    controller.blur(); // 查看器接管键盘（P1-1 同款：接管期输入进不了草稿）
    invalidate();
  }

  function closeBlockViewer(): void {
    if (blockViewer === null) return;
    blockViewer = null;
    state.overlays = [];
    controller.focus();
    invalidate();
  }

  // —— P2-C 焦点环（G-08）：focus.ts reducer 落地，scrollbackFocus 为其投影 ——
  /** 应用焦点环动作：toggle / to-prompt / park（park 由 G-20 卡片退完触发） */
  function applyFocus(action: Parameters<typeof reduceFocus>[1]): void {
    focusRing = reduceFocus(focusRing, action); // FocusState 不可变约定：reducer 返回新对象即整体替换
    scrollbackFocus = focusRing.pane === 'scrollback';
  }

  /** G-20 卡片退完的 park：焦点落 scrollback（与 Tab toggle 共用同一投影） */
  function parkFocusToScrollback(): void {
    applyFocus({ type: 'park' });
  }

  // —— P2-C G-17 草稿 stash（双击 Esc 清空 → 入 stash；Ctrl+S/Alt+S = stash/pop 切换）——
  // 上游 StashPrompt 语义（refs/grok-build prompt_stash.rs handle_stash_prompt_key /
  // defaults.rs:702-714 long_help「One draft at a time: a new stash replaces the old
  // one」，P1-1 语义对齐）：composer 非空 = 当前草稿入单槽 stash（旧 stash 被替换——
  // 数据不丢，新草稿可恢复）并清空 composer；composer 空 = 恢复 stash 并清槽；空且无
  // stash = 如实提示（不伪造恢复）。
  function stashToggle(): void {
    if ((state.draft ?? '').length > 0) {
      draftStash = state.draft ?? ''; // 单槽：新 stash 替换旧 stash（上游「第二次 stash 丢弃槽内旧草稿」）
      state.draft = '';
      state.cursor = 0;
      showHint('草稿已暂存（再按 Ctrl+S / Alt+S 恢复）');
      return;
    }
    if (draftStash === null) {
      showHint('（无暂存草稿）');
      return;
    }
    const restored = draftStash;
    draftStash = null;
    state.draft = restored;
    state.cursor = restored.length;
    showHint('已恢复暂存草稿');
  }

  // —— P2-C G-18 rewind 最小 picker（接现有 /undo 能力；无假入口）——
  // 条目 = 转录中的用户回合（新在前，磁盘重投影后与 /undo 的遮蔽语义一致）；选中第 i 项
  // = /undo (i+1)（撤销该回合及其后全部用户回合）。core runUndo 无「rewind 到指定回合」
  // 的单步接口，n 的换算即最小等价映射（登记：预览/dry-run 未做，Enter 直接执行）。
  let rewindPicker: { items: string[]; undoCounts: number[]; activeIndex: number; armedFrom: EscPane } | null = null;

  function userTurnTexts(): string[] {
    const out: string[] = [];
    for (const item of transcript.items) {
      if (item.kind === 'user') out.push(item.text);
    }
    return out;
  }

  function syncRewindOverlay(): void {
    if (rewindPicker === null) return;
    state.overlays = [
      {
        title: `Rewind · 撤销到哪个回合（${rewindPicker.items.length}）`,
        items: rewindPicker.items,
        activeIndex: rewindPicker.activeIndex,
        showNumbers: true,
      },
    ];
  }

  function openRewindPicker(armedFrom: EscPane): void {
    const texts = userTurnTexts();
    if (texts.length === 0) {
      showHint('（无可撤销的用户回合）'); // reducer 判定与转录间状态被改写的兜底，不画空壳浮层
      return;
    }
    const items = texts
      .map((t, i) => {
        const n = texts.length - i; // 该回合含其后的全部用户回合数 = /undo n
        const oneLine = t.replace(/\s+/g, ' ').trim();
        const preview = oneLine.length > 30 ? `${oneLine.slice(0, 30)}…` : oneLine;
        return `撤销 ${n} 个回合 · ${preview}`;
      })
      .reverse();
    const undoCounts = texts.map((_, i) => texts.length - i).reverse();
    rewindPicker = { items, undoCounts, activeIndex: 0, armedFrom };
    controller.blur(); // 浮层接管键盘（P1-1 同款：接管期输入进不了草稿）
    syncRewindOverlay();
    invalidate();
  }

  function closeRewindPicker(): void {
    rewindPicker = null;
    state.overlays = [];
    controller.focus();
    invalidate();
  }

  function confirmRewindPicker(): void {
    const picker = rewindPicker;
    if (picker === null) return;
    if (busy) {
      closeRewindPicker();
      showHint('回合运行中不可撤销（G-14：取消请按 Ctrl+C）');
      return;
    }
    const n = picker.undoCounts[Math.min(picker.activeIndex, picker.undoCounts.length - 1)] ?? 0;
    closeRewindPicker();
    if (n <= 0) return;
    handleUserText(`/undo ${n}`); // 经既有命令管线：回显 + runSharedCommand（core runUndo）+ 重投影
  }

  // —— P2-C Esc 裁决入口（G-14～G-20；裸 Esc 专用，reduceEsc 纯函数裁决 + 本层执行副作用）——
  function handleEscPress(): void {
    const now = Date.now();
    // P2-2：挂起审批卡存在且已寄放（approvalLayer 对寄放态放行，Esc 落进本策略）时，裸 Esc
    // 整体吞掉——上游 prompt.rs try_handle_esc_policy（758-762）：blocking card 仍 pending
    // 时只消费事件、不进任何后续裁决（卡的 Esc 语义=寄放，是唯一对外语义），防寄放态 Esc
    // 连打误武装双击清稿 / 误开 rewind picker。对齐上游：先废弃 idle 武装再吞（不推宽限、
    // 不给提示——上游此分支无 suppress_rewind_arm / hint）。卡片接管态（未寄放）不在此拦截：
    // Esc 经 approvalLayer 进 reduceEsc 的 exit-card 分支（G-20 逐级退完 park）。
    if (gate.pending() !== null && approvalParked) {
      lastEscAt = null;
      invalidate();
      return;
    }
    const decision = reduceEsc({
      turnState,
      draftLength: (state.draft ?? '').length,
      // G-20/G-31：cardDepth = 阻塞卡（审批 1 层）+ paletteCardDepth（A 棒缝 #3——面板
      // 打开计入浮层栈，Esc 裁决出 exit-card 后由宿主关面板；面板无特例分支）
      cardDepth: (gate.pending() !== null && !approvalParked ? 1 : 0) + paletteCardDepth(paletteState),
      historyCount: userTurnTexts().length,
      now,
      lastEscAt,
      rewindGraceUntil,
      pane: scrollbackFocus ? 'scrollback' : 'prompt',
    });
    const se = decision.sideEffects;
    if (se.lastEscAt !== undefined) lastEscAt = se.lastEscAt;
    if (se.rewindGraceUntil !== undefined) rewindGraceUntil = se.rewindGraceUntil;
    switch (decision.action) {
      case 'hint-cancel': {
        // G-14：toast 通道（瞬时提示）+ 每用户回合最多一条（dedupePerTurn 执行点）
        if (se.hintCancel !== undefined && hintCancelTurnSeq !== userSeq) {
          hintCancelTurnSeq = userSeq;
          showHint(se.hintCancel.text);
        }
        break;
      }
      case 'exit-card': {
        if (paletteState.open) {
          // G-31：palette 关闭走 exit-card 级（A 棒缝 #3）——面板是 composer 锚定模态，
          // 关闭即还键 composer（不产生 G-20 的 scrollback park 语义，无 park 提示）
          closePalette();
          break;
        }
        // G-20：审批卡退完（本壳恒 1 层 → parkedToScrollback=true）——寄放 + park 到滚动区
        parkFocusToScrollback();
        parkApproval();
        if (se.exitCard?.parkedToScrollback === true) showHint(ESC_PARK_HINT_TEXT);
        break;
      }
      case 'clear-stash': {
        // G-17：清空 + stash（绝不进历史）；提示恢复通道
        draftStash = state.draft ?? '';
        state.draft = '';
        state.cursor = 0;
        showHint('草稿已清空并暂存（Ctrl+S / Alt+S 恢复）');
        break;
      }
      case 'open-rewind': {
        openRewindPicker(se.openRewind?.armedFrom ?? 'prompt');
        break;
      }
      case 'swallow':
      case 'none':
      default:
        // G-15/G-19：吞掉（连提示也不给）；'none' = 仅内部状态变化（双击第一击武装）
        break;
    }
    invalidate();
  }

  // —— P3-D 渲染模式切换（G-02 真·进程内切换；P2-C 的降级指引路径废止）——
  /**
   * 状态提交 + 基座切换（顺序钉死：先落状态机事件，再做物理切换——事件是事实，物理
   * 切换是其呈现）。同模式幂等（switchRenderMode 空切换无事件 → 不动基座不重放）。
   *
   * fullscreen → minimal：
   *   1. stop 并弃用当前 Screen（退 alt-screen / 关鼠标上报 / SGR 复位——实例一次性）；
   *   2. minimal 重放记账清零，minimalSync 把**已落定**转录一次性写进原生滚动区
   *      （live 尾部暂扣，落定后追加），并画底部 prompt 块；
   * minimal → fullscreen：
   *   1. 擦掉 minimal 的 prompt 块（不留残影——已写出的转录行留在原生滚动区，即
   *      G-01「转录永久留在终端原生 scrollback」语义）；
   *   2. 新建 Screen 进 alt-screen（鼠标上报 / OSC8 随之开启）；
   *   3. reprojectAll 全帧重画（fullscreen 的 scrollback 一直在同步维护，无需重建会话）。
   * 会话 / 草稿 / 折叠 / 队列 / Esc 状态机等运行时状态跨切换原样保留（G-02 不重启）。
   */
  function enterMinimalBase(): void {
    if (activeScreen !== null) {
      activeScreen.stop();
      activeScreen = null;
    }
    resetMinimalReplay();
    minimalSync();
  }

  function enterFullscreenBase(): void {
    minimalView.erase(); // minimal prompt 块残留清理
    const s = new Screen(deps.out, Math.max(1, viewCols()), Math.max(1, viewRows()));
    s.start({ mouse: env.HARNESS2_MOUSE !== '0' });
    s.setOsc8Enabled(env.HARNESS2_OSC8 !== '0');
    deps.out.write(MOUSE_ALL_MOTION_ON); // minimal 期间未接管鼠标；回全屏补开（幂等）
    activeScreen = s;
    reprojectAll();
  }

  /** 退出时按当前基座还原终端（shutdown.finish 调用；与创建态严格互逆） */
  function leaveRenderBase(): void {
    if (activeScreen !== null) {
      activeScreen.stop(); // 关鼠标上报 + 显示光标 + SGR 复位 + 退 alt-screen（幂等）
      activeScreen = null;
      return;
    }
    minimalView.erase(); // minimal：擦掉底部 prompt 块，原生滚动区内容保持
  }

  function requestRenderModeSwitch(to: RenderMode): 'switched' | 'same-mode' | 'degraded-unavailable' {
    const { state: next, event } = switchRenderMode(renderModeState, to, 'slash-command');
    if (event === null) return 'same-mode';
    renderModeState = next;
    rebuildPaletteEntriesForMode(); // G-31：面板条目的模式 badge / G-03 门控随基座切换刷新
    notifyStatusLineStateChanged(true); // G-46：resize 类 urgent 变更（新基座视口尺寸）
    if (to === 'minimal') enterMinimalBase();
    else enterFullscreenBase();
    return 'switched';
  }

  // —— 输入装配（parser → dispatcher（approval > palette > queue > … > composer）→ 兜底）——
  // 审批卡键位（P3-B grok permission prompt 契约 × P3-E G-25 卡内焦点环）：Tab/Shift+Tab
  // 经 reduceCardFocus 环走（不泄漏全局）、↑↓ 保留、1-3 数字直选、Enter 确认高亮项、
  // Esc 寄放（不回答不关闭，G-20）、Ctrl+C 取消、Ctrl+O always-approve。
  // 差异登记：Ctrl+F 展开全文随 B 棒卡片呈现契约移除（askApproval 契约仅携带文案，
  // 卡片无参数全文可展开——P3-B「参数级展开待 gate 契约扩展」延续，keymap 文档同步）。
  // 寄放态（approvalParked）本层全放行：键盘回 composer，Tab 由 extraKeyHandler 显式回卡。
  const approvalLayer: InputLayer = {
    name: 'approval',
    handle: (event: InputEvent): boolean => {
      if (gate.pending() === null || approvalParked) return false;
      if (event.type !== 'key') return false;
      const ev = event;
      const card = activeApprovalCard();
      if (card === null) return false;
      const move = (delta: 1 | -1): void => {
        // G-25：Tab/↑↓ 喂卡内焦点环（reduceCardFocus），全局环（reduceFocus）不参与
        cardFocus = reduceCardFocus(cardFocus, delta === 1 ? { type: 'next' } : { type: 'prev' });
        syncApprovalOverlay();
        invalidate();
      };
      if (ev.key === 'up' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        move(-1);
        return true;
      }
      if (ev.key === 'down' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        move(1);
        return true;
      }
      // Tab/Shift+Tab 在选项间循环走行（grok：never move focus out of the card）——
      // 经 B 棒 cardFocusActionFromKey（G-25 只认 Tab/Shift+Tab，其余键返回 null）
      if (ev.key === 'tab' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        const action = cardFocusActionFromKey('tab', ev.modifiers);
        if (action !== null) {
          cardFocus = reduceCardFocus(cardFocus, action);
          syncApprovalOverlay();
          invalidate();
        }
        return true;
      }
      if (ev.key === 'enter' && !ev.modifiers.ctrl && !ev.modifiers.alt && !ev.modifiers.shift) {
        chooseApproval(cardFocus.index);
        return true;
      }
      if (!ev.modifiers.ctrl && !ev.modifiers.alt) {
        const idx = ['1', '2', '3'].indexOf(ev.key);
        if (idx >= 0) {
          chooseApproval(idx);
          return true;
        }
      }
      // Esc（G-20，P2-C）：经 reduceEsc 逐级退出裁决——本壳卡片恒 1 层，退完即 park 到
      // scrollback + 提示（不回答不关闭；取消只走 Ctrl+C / cancelApproval）
      if (ev.key === 'escape' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        handleEscPress();
        return true;
      }
      if (ev.modifiers.ctrl && ev.key === 'c') {
        gate.cancel();
        return true;
      }
      // Ctrl+O 在审批卡上切换 always-approve（grok 卡片键位）：只动开关，**不代答当次**
      if (ev.modifiers.ctrl && ev.key === 'o') {
        toggleAlwaysApprove();
        return true;
      }
      return false;
    },
  };

  // —— P3-E 接线1：命令面板键盘层（G-31；位于审批与队列之间——审批最优先不变式）——
  // 打开时接管全部按键：可打印字符/退格 = 查询编辑（palette-model reducer）、↑↓ 走行、
  // Enter 执行、Esc 走 esc-machine（exit-card 关面板）、Ctrl+P 再按 = 关闭（toggle）。
  // Ctrl+C 永远放行（guard 协议，安全键不被浮层拦截）。查询与草稿相互独立（draft-preserving）。
  const paletteLayer: InputLayer = {
    name: 'palette',
    handle: (event: InputEvent): boolean => {
      if (!paletteState.open) return false;
      if (event.type === 'mouse') return true; // 接管期鼠标事件不透传
      if (event.type !== 'key') return false; // focus 等系统事件放行
      const ev = event;
      if (ev.modifiers.ctrl && ev.key === 'c') return false; // Ctrl+C 永远放行（guard 协议）
      if (ev.modifiers.ctrl && !ev.modifiers.alt && ev.key === 'p') {
        closePalette(); // Ctrl+P toggle（G-31 开关键）
        return true;
      }
      const rows = paletteRows();
      if (ev.key === 'up' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        paletteState = paletteMove(paletteState, rows, -1); // 端点钳制不回绕（上游 handle_picker_input）
        invalidate();
        return true;
      }
      if (ev.key === 'down' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        paletteState = paletteMove(paletteState, rows, 1);
        invalidate();
        return true;
      }
      if (ev.key === 'backspace' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        paletteState = paletteBackspace(paletteState, rows);
        invalidate();
        return true;
      }
      if (ev.key === 'enter' && !ev.modifiers.ctrl && !ev.modifiers.alt && !ev.modifiers.shift) {
        const result = paletteEnter(paletteState, rows);
        paletteState = result.state; // 命中命令 → 关面板；组头/空表 no-op（面板不关）
        if (result.effect !== null) executePaletteCommand(result.effect.name); // 缝 #5：宿主命令分发
        invalidate();
        return true;
      }
      if (ev.key === 'escape' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        handleEscPress(); // esc-machine：cardDepth 含面板 → exit-card → closePalette（缝 #3）
        return true;
      }
      if (ev.text !== undefined && ev.text.length > 0 && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        const query = paletteState.query + ev.text;
        paletteState = paletteSetQuery(paletteState, query, filterPaletteRows(query, paletteEntries));
        invalidate();
        return true;
      }
      return true; // 接管期未识别键一律消费（不透传 composer）
    },
  };

  const controller: ChatController = createChatController(state, {
    onSubmit: (text) => submit(text),
    onInterrupt: () => interrupt(),
    extraKeyHandler: (ev) => {
      // Ctrl+C 有选择时优先复制（P4-1：OSC52 + 清选择 + hint），无选择走 guard 协议
      if (ev.modifiers.ctrl && ev.key === 'c') {
        if (copySelectionToClipboard()) return 'consumed';
        return 'ignored'; // 让内置 onInterrupt（guard 协议）处理
      }
      // 其余任意按键重置退出协议（对齐 Composer：非 Ctrl+C 按键清窗口与提示）
      ctrlCGuard.reset();
      clearHint();
      // Ctrl+D 不在此拦截：keymap 裁决 = 半页下滚，由 chat-controller 内置消费（半页滚动
      // 与退出语义不冲突——退出只走 Ctrl+C 双击与 /exit，见文件头裁决说明）
      if (ev.key === 'escape' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        // P4-1：有选择先清选择（Esc 清除选择语义，先于 Esc 状态机；不停止 turn、不清草稿）
        if (selectEnabled && state.scrollback.hasSelection) {
          state.scrollback.clearSelection();
          invalidate();
          return 'consumed';
        }
        // P2-C：G-14～G-20 新规格——reduceEsc 裁决（回合中提示不取消 / 双击清稿+stash /
        // rewind picker / 宽限吞掉），旧的「忙时 Esc 停止、空闲单击清稿」废止
        handleEscPress();
        return 'consumed';
      }
      // Ctrl+O = always-approve 切换（keymap 裁决；旧折叠语义迁移 e/E/h/l，见文件头）
      if (ev.modifiers.ctrl && ev.key === 'o') {
        toggleAlwaysApprove();
        return 'consumed';
      }
      // P3-E 接线1（G-31）：Ctrl+P 恒触发 palette；`?` 仅空草稿触发（打字中的 `?` 进草稿——
      // 上游 prompt_focused_question_mark_with_shift_still_goes_to_textarea 钉死语义）。
      // 打开后由 paletteLayer 接管键盘（查询/↑↓/Enter/Esc）。
      if (ev.modifiers.ctrl && !ev.modifiers.alt && ev.key === 'p') {
        togglePalette();
        return 'consumed';
      }
      if (ev.key === '?' && !ev.modifiers.ctrl && !ev.modifiers.alt && (state.draft ?? '').length === 0) {
        openPalette();
        return 'consumed';
      }
      // P3-E 接线3（G-29）：Ctrl+;（含 Ctrl+' / Ctrl+4 变体）= 队列面板开关。
      // P3-F 冲突修复：早批的壳侧附加别名 Ctrl+X **废止**——该和弦按 G-39 归快捷键帮助
      // （见 keymaps.AGENT_CHORD_TABLE；Ctrl+X 曾同时是面板入口与帮助键 = 撞键）。
      if (matchesQueuePanelOpenKey(ev) !== null) {
        openQueuePanel();
        return 'consumed';
      }
      // P3-F（G-39）：Ctrl+. 主键 / Ctrl+X 备用 = 快捷键帮助浮层（toggle）。
      if (matchesShortcutsHelp(ev)) {
        toggleShortcutsHelp();
        return 'consumed';
      }
      // P3-F（G-34）：Ctrl+R = 会话选择器（列表接管键盘；Enter 经 /resume 切换）。
      if (matchesSessionPicker(ev)) {
        openSessionPicker();
        return 'consumed';
      }
      // P3-E 接线3（G-28）：send-now 和弦（default 族 = Ctrl+Enter / Ctrl+I，kitty 编码）
      // = cancel-and-send；空闲态由状态机裁决 no-op（不提交新回合）。
      if (matchesSendNow(ev, SEND_NOW_FAMILY)) {
        applyFollowUpReduction(reduceFollowUpInput(followUpQueue, followUpContext(), { type: 'send-now' }));
        return 'consumed';
      }
      // 寄放态 Tab = 显式回卡（grok：card parked → Tab hands keyboard back to the card；
      // Shift+Tab 保持模式循环，见下方差异登记）
      if (ev.key === 'tab' && !ev.modifiers.ctrl && !ev.modifiers.alt && !ev.modifiers.shift) {
        // G-25 接缝：卡片活动期（globalFocusSuspended）全局环挂起——Tab 喂卡内环语义，
        // 绝不进 reduceFocus。寄放态 = 显式回卡（P3-B 取舍：卡片待答须先回卡）；接管态
        // 常规路径由 approvalLayer 在先消费，本分支为缝一致性防御（不破坏焦点环状态）。
        if (globalFocusSuspended(activeApprovalCard())) {
          if (approvalParked) {
            retakeApproval();
            return 'consumed';
          }
          cardFocus = reduceCardFocus(cardFocus, { type: 'next' });
          syncApprovalOverlay();
          invalidate();
          return 'consumed';
        }
      }
      // 候选可见时 Tab / Enter = 接受高亮候选（P3-C）：草稿写回 `/cmd `（含尾随空格即退出
      // 候选态，再 Enter 才发送；grok 选中即执行、ink Enter 提交原草稿，差异登记见文件头）。
      // extraKeyHandler 先于 controller 内置候选裁决调用，本层拦截后 controller 的
      // 「Enter 提交高亮候选」不会触发。
      if (
        state.candidates !== null &&
        state.candidates.items.length > 0 &&
        !ev.modifiers.ctrl &&
        !ev.modifiers.alt &&
        ((ev.key === 'tab' && !ev.modifiers.shift) || (ev.key === 'enter' && !ev.modifiers.shift))
      ) {
        acceptCandidate();
        return 'consumed';
      }
      // Shift+Tab = 模式循环（composer 焦点语义；审批卡接管时 dispatcher 卡片层优先消费
      // 为反向走行，到不了这里；候选可见时模式循环仍生效——全局 chord 优先级高于候选）
      if (ev.key === 'tab' && ev.modifiers.shift && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        cycleMode();
        showHint(`模式：${uiMode}${uiMode === 'plan' || uiMode === 'auto' ? '（声明态）' : ''}`);
        return 'consumed';
      }
      // —— P3-E 接线3（G-26/G-27/G-30）：composer 焦点下普通 Enter 全量路由经 C 状态机 ——
      // 空闲非空草稿 = submit-normal → 'ignored' 落回 controller 内置提交（历史+清稿+onSubmit
      // 全语义保持）；其余效果（入队/转向/发队首/直送/边界 no-op）由本层消费执行。
      // scrollback 焦点的 Enter = G-06 块查看器（下方既有分支）；候选 Enter 已在上方分支接受。
      if (
        !scrollbackFocus &&
        ev.key === 'enter' &&
        !ev.modifiers.ctrl &&
        !ev.modifiers.alt &&
        !ev.modifiers.shift &&
        state.candidates === null
      ) {
        const reduction = reduceFollowUpInput(followUpQueue, followUpContext(), { type: 'enter' });
        if (reduction.effect.kind === 'submit-normal') return 'ignored'; // 空闲普通提交：内置路径全语义
        applyFollowUpReduction(reduction);
        return 'consumed';
      }
      // —— P3-E 接线3（G-29）：prompt 焦点 + 空草稿 ↑ = 焦点转队列面板（末行高亮）；无排队
      // 条目不拦截（历史面板本壳无对应物——↑ 保持 controller 内置草稿移动/历史回溯，登记差异）。
      if (
        !scrollbackFocus &&
        ev.key === 'up' &&
        !ev.modifiers.ctrl &&
        !ev.modifiers.alt &&
        !ev.modifiers.shift &&
        (state.draft ?? '').length === 0 &&
        !queuePanelState.open
      ) {
        const target = focusTargetForUp({
          draftEmpty: true,
          panelOpen: false,
          queueCount: followUpQueue.entries.length,
        });
        if (target === 'queue') {
          openQueuePanel(); // toggleQueuePanel 打开即末行高亮（G-29「with the last row highlighted」）
          return 'consumed';
        }
        // target === 'history'：本壳无历史面板，落回 controller 内置 ↑（不做假入口）
      }
      // Tab = 输入框/滚动区双态焦点（G-08 焦点环；P2-C 改经 focus.ts reduceFocus 落地）。
      // 候选可见时不在本层切换：条件短路返回 'ignored'，Tab 落到 controller 内置裁决 =
      // 接受候选（优先级保持）
      if (
        ev.key === 'tab' &&
        !ev.modifiers.ctrl &&
        !ev.modifiers.alt &&
        !ev.modifiers.shift &&
        state.candidates === null
      ) {
        applyFocus(focusActionFromKey(inputMode, ev.key, ev.modifiers) ?? { type: 'toggle' }); // G-08 toggle
        invalidate();
        return 'consumed';
      }
      // —— P2-C 键位表接线（keymaps.ts 表驱动，G-09/G-10/G-17；P3-D 补 G-09 turn 粒度）——
      // 经 resolveKeyAction 匹配（pane 过滤 from 限定）；只接线本壳有真实落点的动作：
      const binding = resolveKeyAction(inputMode, ev, scrollbackFocus ? 'scrollback' : 'prompt');
      if (binding?.action === 'draft.stash-toggle') {
        stashToggle(); // G-17：stash/pop 切换（非空=暂存并清空、空=恢复；两窗格皆可）
        return 'consumed';
      }
      if (binding?.action === 'scroll.line-up') {
        state.scrollback.scrollBy(-1); // G-10 行粒度（Ctrl+K，本壳新增）
        invalidate();
        return 'consumed';
      }
      if (binding?.action === 'scroll.line-down') {
        state.scrollback.scrollBy(1); // G-10 行粒度（Ctrl+J，本壳新增）
        invalidate();
        return 'consumed';
      }
      if (binding?.action === 'paste.image') {
        // G-12：真机透传/剪贴板读取下放 P7（image-paste.ts 登记）——如实提示，不做假入口
        showHint('图片粘贴通道未接入（G-12 🟡：终端透传下放 P7）');
        return 'consumed';
      }
      // G-09 导航（仅 scrollback 窗格；prompt 侧 ↑↓ 是草稿移动/历史，保持 controller 内置）。
      // P3-D：turn 粒度动作接线（Scrollback.turnAnchors/jumpTurn 已就位，P2-C 的
      // 「无 API 不接线」登记废止）——Shift+H/L 按 turn 前后、Shift+J/K 视口顶上/下方
      // turn（与 timeline 箭头同目标）；minimal 下如实提示终端原生滚动。
      if (scrollbackFocus) {
        const turnAction =
          binding?.action === 'nav.turn-next'
            ? ('next' as const)
            : binding?.action === 'nav.turn-prev'
              ? ('prev' as const)
              : binding?.action === 'nav.viewport-turn-above'
                ? ('above' as const)
                : binding?.action === 'nav.viewport-turn-below'
                  ? ('below' as const)
                  : null;
        if (turnAction !== null) {
          if (renderModeState.mode === 'minimal') {
            showHint('minimal：转录在终端原生滚动区（turn 跳转仅 fullscreen 提供）');
            return 'consumed';
          }
          const layout = layoutChat(viewRows(), viewCols(), state);
          const moved = state.scrollback.jumpTurn(turnAction, layout.scrollback.height);
          invalidate();
          if (!moved) showHint('（已是边界回合）');
          return 'consumed';
        }
        if (binding?.action === 'nav.down') {
          state.scrollback.scrollBy(1);
          invalidate();
          return 'consumed';
        }
        if (binding?.action === 'nav.up') {
          state.scrollback.scrollBy(-1);
          invalidate();
          return 'consumed';
        }
        if (binding?.action === 'nav.first') {
          state.scrollback.goToTop();
          invalidate();
          return 'consumed';
        }
        if (binding?.action === 'nav.last') {
          state.scrollback.goToBottom();
          invalidate();
          return 'consumed';
        }
        if (binding?.action === 'focus.to-prompt') {
          // G-08：simple 下 Space 回输入框——焦点环切换后字符照常走内置插入（'ignored'）
          applyFocus({ type: 'to-prompt' });
          invalidate();
          return 'ignored';
        }
      }
      // G-05：Ctrl+E = thinking 块开合（规格键位；Ctrl 组在无修饰分支之外单独判）
      if (scrollbackFocus && ev.modifiers.ctrl && !ev.modifiers.alt && ev.key === 'e') {
        applyFoldKey('Ctrl+E');
        return 'consumed';
      }
      // G-06：Ctrl+F = 打开最近块全屏查看器（与 Enter 双入口；Ctrl 组单独判）
      if (scrollbackFocus && ev.modifiers.ctrl && !ev.modifiers.alt && ev.key === 'f') {
        dispatchBlockOpOnLastBlock('Ctrl+F');
        return 'consumed';
      }
      // 滚动区焦点下的折叠/视图键族（G-05 规格机：folds.ts reduceFoldKey；P3-A 旧裁决
      // 「e=全展/E=全收」按规格迁移——e=toggle 聚焦块、Shift+E=全展、Ctrl+E=thinking、
      // r=原始视图；h/l/←/→=折叠/展开聚焦块。←/→ 在滚动区焦点改服务折叠（规格键位），
      // 原落入 controller 的草稿光标移动语义随迁移废止；聚焦块 = 最近可折叠 item）。
      if (scrollbackFocus && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        const foldKey =
          ev.key === 'h' && !ev.modifiers.shift
            ? ('h' as const)
            : ev.key === 'l' && !ev.modifiers.shift
              ? ('l' as const)
              : ev.key === 'left'
                ? ('ArrowLeft' as const)
                : ev.key === 'right'
                  ? ('ArrowRight' as const)
                  : ev.key === 'e' && !ev.modifiers.shift
                    ? ('e' as const)
                    : ev.key === 'E' || (ev.key === 'e' && ev.modifiers.shift)
                      ? ('Shift+E' as const)
                      : ev.key === 'r' && !ev.modifiers.shift
                        ? ('r' as const)
                        : null;
        if (foldKey !== null) {
          applyFoldKey(foldKey);
          return 'consumed';
        }
        // P3-D 键位裁决：v = 打开子代理全屏视图（0 提示 / 1 直开 / 多选列表；差异登记 keymap）
        if (ev.key === SUBAGENT_VIEW_KEY) {
          openSubagentPicker();
          return 'consumed';
        }
        // P4-1/G-06：y = 复制选中文本（有选择优先复制选择）；无选择 = G-06 复制最近块正文
        if (ev.key === 'y' && !ev.modifiers.shift) {
          if (copySelectionToClipboard()) return 'consumed';
          dispatchBlockOpOnLastBlock('y');
          return 'consumed';
        }
        // G-06：Shift+Y = 复制最近块正文+元数据（legacy 终端大写字符 / kitty shift 位）
        if (ev.key === 'Y' || (ev.key === 'y' && ev.modifiers.shift)) {
          dispatchBlockOpOnLastBlock('Shift+Y');
          return 'consumed';
        }
        // G-06：Enter = 打开最近块全屏查看器（Enter 的滚动区焦点语义按规格迁移——
        // P3-D 键位裁决中「Enter 保留提交」的登记废止，提交走 prompt 焦点）
        if (ev.key === 'enter' && !ev.modifiers.shift) {
          dispatchBlockOpOnLastBlock('Enter');
          return 'consumed';
        }
        if (ev.text !== undefined && ev.text.length > 0) {
          // 其余字母键自动回到输入框（grok simple 模式语义），字符照常走内置插入
          // （P2-C：经焦点环 to-prompt 落地，保持环状态一致）
          applyFocus({ type: 'to-prompt' });
          invalidate();
          return 'ignored';
        }
      }
      return 'ignored';
    },
  });

  // —— 候选鼠标层（P3-C 悬停/滚轮改选，grok panes.rs:958；位于 approval 与 composer 之间）——
  // 候选画在 composer 层顶部（chat-screen layoutChat：composer.top 起的候选行），命中测试
  // 用 composer.candidateItemAt（含滚动窗口映射）。move 命中候选行改选；滚轮在候选行上
  // ±1 循环；候选区外的滚轮/移动不消费（composer 层照常滚动转录）。controller blur 期
  // （审批卡接管）不抢事件（composer 层同 guard）。
  const candidateMouseLayer: InputLayer = {
    name: 'candidate-mouse',
    handle: (event: InputEvent): boolean => {
      if (event.type !== 'mouse' || !controller.isFocused()) return false;
      if (activeScreen === null) return false; // G-01：minimal 不接管鼠标（防御，DECSET 已关）
      const cands = state.candidates;
      if (cands === null || cands.items.length === 0) return false;
      const layout = layoutChat(viewRows(), viewCols(), state);
      if (layout.candidateRows <= 0) return false;
      const relRow = event.row - layout.composer.top;
      if (relRow < 0 || relRow >= layout.candidateRows) return false;
      if (event.kind === 'move') {
        const idx = candidateItemAt(cands.items.length, cands.activeIndex, relRow);
        if (idx !== null && idx !== cands.activeIndex) {
          cands.activeIndex = idx;
          invalidate();
        }
        return true;
      }
      if (event.kind === 'scroll') {
        const n = cands.items.length;
        cands.activeIndex = (cands.activeIndex + (event.button === 0 ? -1 : 1) + n) % n;
        invalidate();
        return true;
      }
      return false;
    },
  };

  // —— P4-1 选择鼠标层（拖选转录文本；位于候选层之后、composer 层之前）——
  // 优先级契约（不破坏既有点击语义）：approval/queue/subagent 层在先（接管期本层自然
  // 收不到/让位）；候选区 move/scroll 由 candidateMouseLayer 在先消费；本层只消费滚动区
  // 矩形内的 down/move/up（拖选），滚轮放行（composer 层照常滚转录）；滚动区外的
  // down（候选区/状态行/快捷键条/composer）一律不消费——既有点击语义零变化。
  // 焦点无关（scrollback 焦点或非焦点均可拖选，keymap 裁决）。滚轮拖选中的滚动不更新
  // 选择（wheel 不经本层，已知简化）。
  const selectionMouseLayer: InputLayer = {
    name: 'selection-mouse',
    handle: (event: InputEvent): boolean => {
      if (!selectEnabled || event.type !== 'mouse') return false;
      if (activeScreen === null) return false; // G-01：minimal 不接管鼠标（防御，DECSET 已关）
      if (approvalActive()) return false; // 审批卡接管期让位（寄放态也不拖选，避免误触）
      if (event.kind === 'scroll') return false; // 滚轮照常（composer 层滚转录）
      const rect = layoutChat(viewRows(), viewCols(), state).scrollback;
      const relRow = event.row - rect.top;
      const inContent =
        rect.height > 0 && relRow >= 0 && relRow < rect.height && event.col >= 0 && event.col < contentCols();
      if (event.kind === 'down') {
        if (event.button !== 0 || !inContent) return false; // 右/中键与非滚动区不启动选择
        selDragging = true;
        selMoved = false;
        selDownPt = selectionPointFromMouse(event.col, event.row);
        state.scrollback.beginSelection(selDownPt);
        invalidate();
        return true;
      }
      if (event.kind === 'move') {
        if (!selDragging || selDownPt === null) return false;
        if (inContent) {
          const p = selectionPointFromMouse(event.col, event.row);
          if (p.row !== selDownPt.row || p.col !== selDownPt.col) selMoved = true;
          state.scrollback.extendSelection(p);
          invalidate();
        }
        return true; // 拖出滚动区：维持拖动态不更新（up 结束）
      }
      // up：拖选结束。无移动（单击）= 清除选择；有移动 = 保留选择
      if (!selDragging) return false;
      selDragging = false;
      if (!selMoved) {
        state.scrollback.clearSelection();
        invalidate();
      }
      return true;
    },
  };

  // —— P3-F 接线：快捷键帮助 / 会话选择器键盘层（G-39 / G-34）——
  // 位于 palette 与 queue 之间；两层互斥（帮助打开前必先收队列面板，见 queueLayer）。
  // 接管期 Ctrl+C 一律放行（guard 协议），其余未识别键一律消费（P1-1 防御：不透传草稿）。
  //  - 帮助（G-39）：↑↓/j/k 滚动、PgUp/PgDn 翻页、g/G 顶底；Ctrl+X/Ctrl+. / Esc / q 关闭。
  //  - 会话选择器（G-34）：↑↓/j/k 走行（回绕，与 subPicker 同口径）、数字直选、Enter 切换、
  //    Esc/q 取消。
  // Ctrl+C 例外（G-38 修复）：浮层接管期 composer 已 blur，若只 return false 会落到「blur 的
  // controller → ignored」= Ctrl+C 全哑。此处显式转交 interrupt()（取消/双击退出 guard 协议），
  // 保证「Ctrl+C 是唯一取消键」在任意模态下都成立。
  const helpAndSessionLayer: InputLayer = {
    name: 'agent-help-session',
    handle: (event: InputEvent): boolean => {
      if (!helpState.open && sessionPicker === null) return false;
      if (event.type === 'mouse') return true; // 接管期鼠标事件不透传
      if (event.type !== 'key') return false; // focus 等系统事件放行
      const ev = event;
      if (ev.modifiers.ctrl && ev.key === 'c') {
        interrupt(); // G-38：唯一取消键（guard 协议）在模态内同样生效
        return true;
      }

      if (helpState.open) {
        const items = helpLines();
        const n = Math.max(1, items.length);
        const move = (delta: number): void => {
          helpState = { open: true, activeIndex: (helpState.activeIndex + delta + n) % n };
          syncHelpOverlay();
          invalidate();
        };
        if (ev.key === 'up' || (ev.key === 'k' && !ev.modifiers.ctrl && !ev.modifiers.alt)) {
          move(-1);
          return true;
        }
        if (ev.key === 'down' || (ev.key === 'j' && !ev.modifiers.ctrl && !ev.modifiers.alt)) {
          move(1);
          return true;
        }
        if (ev.key === 'pageup' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
          move(-10);
          return true;
        }
        if (ev.key === 'pagedown' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
          move(10);
          return true;
        }
        if ((ev.key === 'g' && !ev.modifiers.shift) || ev.key === 'home') {
          helpState = { open: true, activeIndex: 0 };
          syncHelpOverlay();
          invalidate();
          return true;
        }
        if (ev.key === 'G' || (ev.key === 'g' && ev.modifiers.shift) || ev.key === 'end') {
          helpState = { open: true, activeIndex: Math.max(0, items.length - 1) };
          syncHelpOverlay();
          invalidate();
          return true;
        }
        if (matchesShortcutsHelp(ev)) {
          closeShortcutsHelp(); // toggle：再按同键关闭（G-39 开合对称）
          return true;
        }
        if ((ev.key === 'escape' || ev.key === 'q') && !ev.modifiers.ctrl && !ev.modifiers.alt) {
          closeShortcutsHelp();
          return true;
        }
        return true; // 接管期未识别键一律消费（不透传 composer）
      }

      const picker = sessionPicker!; // 上方已保证非 null（helpState.open 为 false）
      const n = picker.items.length;
      const move = (delta: number): void => {
        picker.activeIndex = (picker.activeIndex + delta + n) % n;
        sessionPicker = picker;
        syncSessionPickerOverlay();
        invalidate();
      };
      if (ev.key === 'up' || (ev.key === 'k' && !ev.modifiers.ctrl && !ev.modifiers.alt)) {
        move(-1);
        return true;
      }
      if (ev.key === 'down' || (ev.key === 'j' && !ev.modifiers.ctrl && !ev.modifiers.alt)) {
        move(1);
        return true;
      }
      if (!ev.modifiers.ctrl && !ev.modifiers.alt && /^[1-9]$/.test(ev.key)) {
        const idx = Number(ev.key) - 1;
        if (idx < n) {
          picker.activeIndex = idx;
          confirmSessionPicker();
          return true;
        }
      }
      if (ev.key === 'enter' && !ev.modifiers.ctrl && !ev.modifiers.alt && !ev.modifiers.shift) {
        confirmSessionPicker();
        return true;
      }
      if ((ev.key === 'escape' || ev.key === 'q') && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        closeSessionPicker();
        return true;
      }
      return true; // P1-1 防御：接管期未识别键一律消费（不透传 composer）
    },
  };

  // —— P3-E 接线3：队列面板键盘层（G-29；位于 approval/palette 与 subagent 之间：审批最优先）——
  // 打开时接管全部按键（P1-1 同款防御：字母不透传 composer）；Ctrl+C 放行走 guard 协议
  // （busy 取消 / 双击退出，浮层不拦截安全键）。未打开时全放行（composer 正常编辑）。
  // 面板键位（G-29 表）：↑↓/j/k 走行（钳制不回绕）、Enter = 立即发送高亮行
  // （G-28 cancel-and-send）、e = 编辑高亮行（落回 composer）、Ctrl+; = 关闭（toggle 对称）、
  // 裸 `x` = 取消高亮行（壳侧附加能力）、q/Esc 关闭。
  // P3-F 冲突修复（登记）：取消高亮行**不再接受 Ctrl+X**——Ctrl+X 按 G-39 归快捷键帮助，
  // 在面板打开期 = 关面板并开帮助（全局帮助键优先于模态内的壳侧附加键；见 keymaps 归属表）。
  const queueLayer: InputLayer = {
    name: 'queue-panel',
    handle: (event: InputEvent): boolean => {
      if (!queuePanelState.open) return false;
      if (event.type === 'mouse') return true; // 接管期鼠标事件不透传
      if (event.type !== 'key') return false; // focus 等系统事件放行
      const ev = event;
      // Ctrl+C（G-38 修复）：浮层接管期 composer 已 blur，纯 return false 会让 Ctrl+C 变哑
      // （落回 blurred controller = ignored）——显式转交 interrupt()，取消/退出键在模态内同样有效
      if (ev.modifiers.ctrl && ev.key === 'c') {
        interrupt();
        return true;
      }
      const env = { queueCount: followUpQueue.entries.length };
      if (matchesQueuePanelOpenKey(ev)) {
        closeQueuePanel(); // G-29 toggle：Ctrl+; 在面板打开期 = 关闭（开合对称）
        return true;
      }
      // P3-F：Ctrl+X / Ctrl+. = 快捷键帮助（先收面板再开帮助，模态不叠加）
      if (matchesShortcutsHelp(ev)) {
        closeQueuePanel();
        openShortcutsHelp();
        return true;
      }
      if (ev.key === 'up' || (ev.key === 'k' && !ev.modifiers.ctrl && !ev.modifiers.alt)) {
        queuePanelState = moveQueuePanelSelection(queuePanelState, -1, env);
        syncQueueOverlay();
        invalidate();
        return true;
      }
      if (ev.key === 'down' || (ev.key === 'j' && !ev.modifiers.ctrl && !ev.modifiers.alt)) {
        queuePanelState = moveQueuePanelSelection(queuePanelState, 1, env);
        syncQueueOverlay();
        invalidate();
        return true;
      }
      // Enter / e：经 C 状态机折叠为语义输入（面板内 Enter = send-now-selected、e = edit-selected）
      const followInput = resolveFollowUpInput(ev, {
        family: SEND_NOW_FAMILY,
        panel: { open: true, focus: 'queue', activeIndex: queuePanelState.activeIndex },
        queueCount: env.queueCount,
      });
      if (followInput !== null) {
        applyFollowUpReduction(reduceFollowUpInput(followUpQueue, followUpContext(), followInput));
        return true;
      }
      // 裸 x = 取消高亮行（壳侧附加能力；无修饰、忽略 shift 变体。Ctrl+X 已归帮助键）
      if (ev.key === 'x' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        cancelQueuedAt(queuePanelState.activeIndex);
        return true;
      }
      if ((ev.key === 'escape' || ev.key === 'q') && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        closeQueuePanel();
        return true;
      }
      return true; // 接管期未识别键一律消费（不透传 composer）
    },
  };

  // —— P3-D 子视图/选择列表键盘层（位于 approval 与 composer 之间：审批仍最优先）——
  // 列表浮层：↑↓/j/k 走行、数字直选、Enter 打开、Esc/q 取消。
  // 视图态（controller 已 blur，composer 层不消费）：q/Esc 返回、↑↓ 单行、PgUp/PgDn 翻页、
  // 滚轮 ±3；**其余键一律消费**（P1-1 防御：视图打开时键盘完全被视图层接管——即使 composer
  // 被异常复位焦点，输入也进不了不绘制的草稿）。
  // 审批卡接管期（挂起且未寄放）本层整体让位：杜绝浮层/视图在审批卡下被隐形改选/关闭
  // （如 j 隐形改选不可见 picker、q 隐形关视图）；结算后由 closeApproval 恢复相应状态。
  const approvalActive = (): boolean => gate.pending() !== null && !approvalParked;
  const subagentLayer: InputLayer = {
    name: 'subagent-view',
    handle: (event: InputEvent): boolean => {
      if (approvalActive()) return false;
      if (subPicker !== null) {
        const picker = subPicker; // 局部快照（闭包内 TS 收窄；closeSubPicker 会置空外层变量）
        if (event.type !== 'key') return false;
        const ev = event;
        const n = picker.items.length;
        const move = (delta: number): void => {
          picker.activeIndex = (picker.activeIndex + delta + n) % n;
          subPicker = picker;
          syncPickerOverlay();
          invalidate();
        };
        if (ev.key === 'up' || (ev.key === 'k' && !ev.modifiers.ctrl && !ev.modifiers.alt)) {
          move(-1);
          return true;
        }
        if (ev.key === 'down' || (ev.key === 'j' && !ev.modifiers.ctrl && !ev.modifiers.alt)) {
          move(1);
          return true;
        }
        if (!ev.modifiers.ctrl && !ev.modifiers.alt && /^[1-9]$/.test(ev.key)) {
          const idx = Number(ev.key) - 1;
          if (idx < n) {
            picker.activeIndex = idx;
            closeSubPicker(false);
            return true;
          }
        }
        if (ev.key === 'enter' && !ev.modifiers.ctrl && !ev.modifiers.alt && !ev.modifiers.shift) {
          closeSubPicker(false);
          return true;
        }
        if (ev.key === 'escape' || ev.key === 'q') {
          closeSubPicker(true);
          return true;
        }
        return true; // P1-1 防御：picker 接管期未识别键一律消费（不透传 composer）
      }
      if (subView === null) return false;
      if (event.type === 'mouse') {
        if (event.kind !== 'scroll') return true; // P1-1 防御：视图接管期鼠标事件不透传（滚轮除外，下方处理）
        const sb = state.subagentView?.scrollback;
        if (sb === undefined) return false;
        if (event.button === 0) sb.wheelUp();
        else sb.wheelDown();
        invalidate();
        return true;
      }
      if (event.type !== 'key') return false; // focus 等系统事件放行（兜底 focused 标记需要）
      const ev = event;
      const sb = state.subagentView?.scrollback;
      if (sb === undefined) return false;
      if ((ev.key === 'q' || ev.key === 'escape') && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        closeSubagentView();
        return true;
      }
      if (ev.key === 'up') {
        sb.scrollBy(-1);
        invalidate();
        return true;
      }
      if (ev.key === 'down') {
        sb.scrollBy(1);
        invalidate();
        return true;
      }
      if (ev.key === 'pageup') {
        sb.pageUp();
        invalidate();
        return true;
      }
      if (ev.key === 'pagedown') {
        sb.pageDown();
        invalidate();
        return true;
      }
      return true; // P1-1 防御：未识别键一律消费（杜绝「隐形输入进不绘制的草稿」）
    },
  };

  // —— P2-C rewind picker 键盘层（G-18；位于 queue 与 subagent 之间，审批仍最优先）——
  // 打开时接管全部按键（P1-1 防御同款）：↑↓/j/k 走行、Enter 撤销（/undo n）、Esc/q 取消、
  // 数字直选；Ctrl+C 放行 guard 协议。未打开时全放行。
  const rewindLayer: InputLayer = {
    name: 'rewind-picker',
    handle: (event: InputEvent): boolean => {
      if (rewindPicker === null) return false;
      if (event.type === 'mouse') return true; // 接管期鼠标事件不透传
      if (event.type !== 'key') return false; // focus 等系统事件放行
      const ev = event;
      if (ev.modifiers.ctrl && ev.key === 'c') return false; // Ctrl+C 永远放行（guard 协议）
      const picker = rewindPicker;
      const n = picker.items.length;
      const move = (delta: number): void => {
        if (rewindPicker === null || n === 0) return;
        rewindPicker.activeIndex = (rewindPicker.activeIndex + delta + n) % n;
        syncRewindOverlay();
        invalidate();
      };
      if (ev.key === 'up' || (ev.key === 'k' && !ev.modifiers.ctrl && !ev.modifiers.alt)) {
        move(-1);
        return true;
      }
      if (ev.key === 'down' || (ev.key === 'j' && !ev.modifiers.ctrl && !ev.modifiers.alt)) {
        move(1);
        return true;
      }
      if (!ev.modifiers.ctrl && !ev.modifiers.alt && /^[1-9]$/.test(ev.key)) {
        const idx = Number(ev.key) - 1;
        if (idx < n) {
          rewindPicker.activeIndex = idx;
          confirmRewindPicker();
          return true;
        }
      }
      if (ev.key === 'enter' && !ev.modifiers.ctrl && !ev.modifiers.alt && !ev.modifiers.shift) {
        confirmRewindPicker();
        return true;
      }
      if ((ev.key === 'escape' || ev.key === 'q') && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        closeRewindPicker();
        return true;
      }
      return true; // 接管期未识别键一律消费（不透传 composer）
    },
  };

  // —— P3-D G-06 块查看器键盘层（位于 rewind 与 subagent 之间，审批仍最优先）——
  // 打开时接管全部按键（P1-1 防御同款）：Esc/q/Enter/Ctrl+F 关闭；未打开时全放行。
  // 查看器无滚动（体量局限，openBlockViewer 登记）——方向键等一并消费不透传。
  const blockViewerLayer: InputLayer = {
    name: 'block-viewer',
    handle: (event: InputEvent): boolean => {
      if (blockViewer === null) return false;
      if (event.type === 'mouse') return true; // 接管期鼠标事件不透传
      if (event.type !== 'key') return false; // focus 等系统事件放行
      const ev = event;
      if (ev.modifiers.ctrl && ev.key === 'c') return false; // Ctrl+C 永远放行（guard 协议）
      if ((ev.key === 'escape' || ev.key === 'q' || ev.key === 'enter') && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        closeBlockViewer();
        return true;
      }
      if (ev.modifiers.ctrl && ev.key === 'f') {
        closeBlockViewer(); // Ctrl+F 再按 = 关闭（与打开同键，grok 双入口的对称收口）
        return true;
      }
      return true; // 接管期未识别键一律消费（不透传 composer）
    },
  };

  const dispatcher: InputDispatcher = createInputDispatcher({
    layers: [
      approvalLayer,
      paletteLayer,
      helpAndSessionLayer, // P3-F：G-39 帮助 / G-34 会话选择器（palette 之后、queue 之前）
      queueLayer,
      rewindLayer,
      subagentLayer,
      blockViewerLayer,
      candidateMouseLayer,
      selectionMouseLayer,
      createComposerLayer(controller),
    ],
    fallback: (event) => {
      if (event.type === 'focus') {
        focused = event.direction === 'in';
        invalidate();
      }
    },
  });

  const parser: InputParser = createInputParser();
  const attached: AttachedInput = attachInput(parser, controller, dispatcher);

  function feed(bytes: Uint8Array | string): number {
    const n = attached.feed(bytes);
    if (n > 0) invalidate();
    return n;
  }

  function flushIdle(now?: number): number {
    const n = attached.flushIdle(now);
    if (n > 0) invalidate();
    return n;
  }

  // 空闲冲刷定时器（孤立 ESC → Esc 键、断流 paste 兜底；见 chat-controller 文件头）
  const idleTimer = setInterval(() => {
    flushIdle();
  }, IDLE_FLUSH_MS);

  function clearTimers(): void {
    clearInterval(idleTimer);
    scheduler.dispose();
    bridge.dispose();
    clearStatusTimers(); // P3-E 接线4：状态行防抖/定时器一并清（不留活口）
    if (spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    if (hintTimer !== null) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
  }

  // —— steer 观察（T5：回帧 → 转录报告，对齐 InkShell）——
  // P3-E 接线3：steer 行为队列展示行的回帧同步——accepted = 注入已发生 → 移除展示行
  // （防 turn 收尾 drain 重复执行）；stale/rejected = 未注入 → 行保留（转入下一回合，
  // 对齐 wiring-contract「stale = 草稿保留 = 行留在队列」）。
  runtime.observeSteer((result) => {
    steerSeq += 1;
    const { line } = describeSteerResult(result);
    sysSeq += 1;
    dispatch({ type: 'system', id: `steer:${steerSeq}`, text: line });
    const rowId = steerRowByCoreId.get(result.id);
    if (rowId !== undefined) {
      steerRowByCoreId.delete(result.id);
      if (result.state === 'accepted') {
        followUpQueue = removeFollowUpById(followUpQueue, rowId).state;
        if (queuePanelState.open) {
          queuePanelState = clampQueuePanelSelection(queuePanelState, { queueCount: followUpQueue.entries.length });
          syncQueueOverlay();
        }
      }
    }
    flushUi();
  });

  // —— notifier（T4：回合结束提醒；sink 注入便于测试）——
  const notifier: Notifier = createNotifier(env, deps.notifyWrite ?? stderrSink());

  // 初始帧
  syncProjection();
  invalidate();
  // P3-E 接线4 修复（G-46 自举）：先武装 refresh_interval 的首个定时器（无该配置则零指令），
  // 再拉首绘 state run——否则 command 型状态行的周期刷新型配置在真实 harness 中不生效。
  bootstrapStatusLineTimers();
  // P3-E 接线4：command 型状态行首绘（装配层无事件也先拉一次——G-46 纯事件驱动 + 首次 state）
  notifyStatusLineStateChanged(false);

  return {
    state,
    feed,
    flushIdle,
    flushUi,
    resize(cols, rows) {
      // G-01：全屏 = Screen resize + 契约同步；minimal = 无屏幕对象，prompt 按新宽重画
      // （已写出的原生滚动行由终端自行 reflow，本层不重放——如实取舍）
      // P3-E 接线4：resize = urgent 变更（G-46：100ms 防抖）——两种基座都通知
      notifyStatusLineStateChanged(true);
      if (activeScreen === null) {
        invalidate();
        return;
      }
      const prevCols = activeScreen.cols;
      resizeChat(activeScreen, state, cols, rows);
      if (Math.max(1, cols) !== prevCols) {
        // 宽度变化：截断/摘要行按新宽度重投影（强制全量重投影；只调 rows 不重投影）
        reprojectAll();
        // 审批卡展开态的全文折行按新宽度重排（收起态标题裁剪由 drawOverlay 逐帧处理，免重建）
        syncApprovalOverlay();
      } else {
        invalidate();
      }
    },
    submit,
    interrupt,
    requestExit,
    approve(answer) {
      gate.choose(answer);
    },
    cancelApproval() {
      gate.cancel();
    },
    pendingApproval: () => gate.pending(),
    logicalLines() {
      const sb = state.scrollback;
      const out: string[] = [];
      for (let i = 0; i < sb.lineCount; i += 1) out.push(sb.rowOf(i).join(''));
      return out;
    },
    logicalLineFg(index) {
      return state.scrollback.lineAt(index)?.fg;
    },
    selectedText: () => state.scrollback.getSelectedText(),
    hasSelection: () => state.scrollback.hasSelection,
    subagentViewLines() {
      const sv = state.subagentView;
      if (!sv) return null;
      const out: string[] = [];
      for (let i = 0; i < sv.scrollback.lineCount; i += 1) out.push(sv.scrollback.rowOf(i).join(''));
      return out;
    },
    isBusy: () => busy,
    queueSnapshot: () => queueTexts(),
    renderMode: () => renderModeState.mode,
    foldSnapshot() {
      const collapsed: string[] = [];
      const manual: string[] = [];
      for (const [id, st] of foldsState.blocks) {
        if (st.collapsed) collapsed.push(id);
        if (st.manual) manual.push(id);
      }
      return {
        rawMarkdown: foldsState.rawMarkdown,
        respectManualFolds: foldsState.respectManualFolds,
        collapsed,
        manual,
      };
    },
    turnAnchors: () => state.scrollback.turnAnchors(),
    minimalPrintedLines: () => [...minimalPrinted],
    awaitDone: () => shutdown.awaitDone(),
    dispose() {
      clearTimers();
    },
  };
}

// —— 真机装配（HARNESS2_RENDERER=next 分支入口；由 runInkChat.tsx 调用）——

/**
 * 进程退出兜底还原（审查 P1）：同步写出关鼠标上报 + 显示光标 + 退 alt-screen 到 stdout，
 * 并尝试复位 stdin raw mode。序列天然幂等——正常退出路径 screen.stop 已还原过，重复写无害。
 * 只能在 process 'exit' 回调内同步调用（异步操作不执行）；流已销毁时吞错，绝不阻塞退出。
 */
export function emergencyTerminalRestore(
  out: Pick<WriteTarget, 'write'>,
  stdin: { setRawMode?: (mode: boolean) => void } | undefined,
): void {
  try {
    out.write(MOUSE_OFF + SHOW_CURSOR + ALT_SCREEN_EXIT);
  } catch {
    // 流已销毁：兜底写出失败不阻塞退出
  }
  try {
    stdin?.setRawMode?.(false);
  } catch {
    // 流已销毁：还原失败不阻塞退出
  }
}

/**
 * 挂 process 'exit' 监听兜底还原终端：异常退出（未捕获异常、异步还原路径被跳过等）下，
 * 进程退出前同步恢复终端状态。返回解绑函数（shutdown 收敛后调用；proc 可注入供
 * headless 测试验证注册/解绑与兜底写出序列）。
 */
export function bindEmergencyExitRestore(
  out: Pick<WriteTarget, 'write'>,
  stdin: { setRawMode?: (mode: boolean) => void } | undefined,
  proc: Pick<NodeJS.Process, 'on' | 'off'> = process,
): () => void {
  const onExit = (): void => emergencyTerminalRestore(out, stdin);
  proc.on('exit', onExit);
  return () => {
    proc.off('exit', onExit);
  };
}

/**
 * next 渲染层的 chat 入口：setupChatSession（与 legacy/ink 共用）→ Screen 全屏帧循环。
 * 终端生命周期：进 alt-screen（Screen.start，含鼠标上报）→ DECSET 1004 焦点上报 →
 * bracketed paste 开启 → stdin raw mode；退出经 createShutdown.finish 统一还原（拆屏 /
 * 焦点上报关闭 / paste 关闭 / raw mode 还原 / runtime.finish），SIGTERM/SIGHUP 走
 * bindShutdownSignals 同一幂等路径；process 'exit' 另有同步兜底（bindEmergencyExitRestore）。
 */
export async function runNextChat(options: ChatOptions = {}): Promise<void> {
  const bootLines: string[] = [];
  const gate = createApprovalGate();
  // P3-D：SubagentHooks 接线缝（装配期先于 harness 创建 → 可变 sink 延迟转发）。
  // core 的 SubagentHooks 为导出契约，此处仅装配层传参（core/冻结区零改动）。
  const childEventSink: { handler: ((sessionId: string, event: AnySessionEvent) => void) | null } = { handler: null };
  const runtime = await setupChatSession(options, {
    line: (t) => bootLines.push(t),
    // 审批弹窗：经 gate 打开 overlay，选择后 resolve；挤占/取消 resolve 为 ASK_CANCELLED
    askApproval: (query) => gate.ask(query),
    subagentHooks: {
      onChildEvent: (sessionId, event) => childEventSink.handler?.(sessionId, event),
    },
  });

  const stdout = process.stdout as NodeJS.WriteStream & { columns?: number; rows?: number };
  const stdin = process.stdin;
  const env = process.env;
  const canRaw = stdin.isTTY === true && typeof stdin.setRawMode === 'function';

  // P2-C/P3-D：渲染模式初值（G-02）——config [ui] screen_mode（core schema 加性段）。
  // loadConfig 与 setupChatSession 同源（core loadConfig）；此处二次读取只为解析壳渲染初值，
  // 解析失败静默回退 fullscreen（致命配置错误已由 setupChatSession 的报错通道拦截退出）。
  // P3-D 起 minimal 初值如实生效（以 minimal 基座启动，不进 alt-screen）——P2-C 的
  // 「强制回 fullscreen + 降级声明」废止；Screen 的创建/启动移交 harness 按初值裁决
  // （Screen 一次性实例：初值 minimal 时不建，/fullscreen 回切时再建）。
  let initialRenderMode: RenderMode = DEFAULT_RENDER_MODE;
  let respectManualFolds: boolean | null = null; // null = 配置未提供（harness 用缺省 true）
  let followUpBehavior: FollowUpBehavior | undefined; // P3-E 接线3：[ui].follow_up_behavior（G-26）
  let statusLineSettings: ResolvedStatusLineSettings | undefined; // P3-E 接线4：[ui.status_line]（G-42~G-46）
  const bootNotes: string[] = [];
  try {
    const loaded = loadConfig({ root: runtime.root });
    if (loaded.config !== null) {
      const resolved = resolveInitialRenderMode(loaded.config);
      initialRenderMode = resolved.mode;
      if (resolved.warning !== null) bootNotes.push(`warning: ${resolved.warning}`);
      // G-05：[scrollback.scroll] respect_manual_folds（P2-C 已加性落地 scrollback 段；
      // 严格布尔解析，非法值回退缺省 true——schema 层校验的兜底）
      const rawRespect = (loaded.config as { scrollback?: { scroll?: { respect_manual_folds?: unknown } } }).scrollback
        ?.scroll?.respect_manual_folds;
      const respect = parseRespectManualFolds(rawRespect);
      if (respect !== null) respectManualFolds = respect;
      // P3-E 接线3（G-26）：follow_up_behavior（schema 已校验域；壳侧再解析一次回收告警）
      const followUp = resolveFollowUpBehavior(loaded.config as Parameters<typeof resolveFollowUpBehavior>[0]);
      if (followUp.warning !== null) bootNotes.push(`warning: ${followUp.warning}`);
      followUpBehavior = followUp.behavior;
      // P3-E 接线4（G-42~G-46）：status_line（~/ 展开与 tolerant 解析归壳层；告警如实回收）
      const statusParsed = parseStatusLineSettings(loaded.config as Parameters<typeof parseStatusLineSettings>[0]);
      statusLineSettings = statusParsed.settings;
      for (const w of statusParsed.warnings) bootNotes.push(`warning: ${w}`);
    }
  } catch {
    initialRenderMode = DEFAULT_RENDER_MODE;
  }
  if (initialRenderMode === 'minimal') {
    bootNotes.push('minimal 渲染模式（原生滚动区，不接管屏幕；/fullscreen 可切回）');
  }

  const screen =
    initialRenderMode === 'fullscreen'
      ? new Screen(stdout, Math.max(1, stdout.columns ?? 80), Math.max(1, stdout.rows ?? 24))
      : undefined;
  if (screen !== undefined) screen.start({ mouse: env.HARNESS2_MOUSE !== '0' });
  stdout.write(BRACKETED_PASTE_ON); // ink usePaste 由 ink 自动开启；next 路径自行开关（parser 只负责解析）
  if (canRaw) stdin.setRawMode(true);

  // 审查 P1：进程退出兜底（'exit' 回调内同步还原终端；正常路径已还原，序列幂等无副作用）
  const detachExitRestore = bindEmergencyExitRestore(stdout, canRaw ? stdin : undefined);

  const harness = createNextChatHarness(runtime, {
    out: stdout,
    bootLines: [...bootLines, ...bootNotes],
    env,
    gate,
    ...(screen !== undefined ? { screen } : {}),
    subagentEventSink: {
      set: (fn) => {
        childEventSink.handler = fn;
      },
    },
    initialRenderMode,
    ...(respectManualFolds !== null ? { respectManualFolds } : {}),
    ...(followUpBehavior !== undefined ? { followUpBehavior } : {}),
    ...(statusLineSettings !== undefined ? { statusLine: statusLineSettings } : {}),
    cleanup: async () => {
      // G-01：屏幕基座的还原已移交 harness（leaveRenderBase：全屏退 alt-screen / minimal
      // 擦 prompt——按退出时的实际基座裁决）；此处只还原进程级输入/上报通道。
      stdout.write(MOUSE_ALL_MOTION_OFF); // 关全 motion 鼠标上报（与 1003h 成对；重复写无害）
      stdout.write(FOCUS_REPORT_OFF); // 关焦点上报（与 1004h 成对；重复写无害）
      stdout.write(BRACKETED_PASTE_OFF);
      if (canRaw) {
        try {
          stdin.setRawMode(false);
        } catch {
          // 流已销毁：还原失败不阻塞退出
        }
      }
      await runtime.finish({ destroyInput: () => stdin.destroy() });
    },
    exit: (code) => {
      process.exitCode = code; // 不 abrupt process.exit，让拆屏与锁释放完成（对齐 runInkChat）
    },
  });

  const onResize = (): void => {
    harness.resize(Math.max(1, stdout.columns ?? 80), Math.max(1, stdout.rows ?? 24));
  };
  stdout.on('resize', onResize);
  const onData = (chunk: string | Buffer): void => {
    harness.feed(chunk); // Buffer 是 Uint8Array，parser 直接消化
  };
  stdin.on('data', onData);

  // 审查 P2 同口径：SIGTERM（kill）/SIGHUP（终端关闭）复用幂等退出路径，收敛后解绑
  const detachSignals = bindShutdownSignals((reason) => harness.requestExit(reason));

  await harness.awaitDone();
  detachSignals();
  detachExitRestore(); // 正常收敛后解绑 exit 兜底监听（无残留监听；异常路径由兜底已覆盖）
  stdout.off('resize', onResize);
  stdin.off('data', onData);
}
