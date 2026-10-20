# Denia 项目 UI 分析（设计输入）

> 取证方式：Explore 子代理全量调查 + 编排者对关键行号抽查核实（`main.rs:194-213`、`native_folder_picker.rs:1-9`、`App.tsx:1446-1463`、`transcript.tsx:219-239`、`SessionsPage.tsx:478`、`console.rs:1-8` 均实核吻合）。
> 仓库：`D:/AI_Projects/Denia/Denia`，已 `git pull` 至最新 `0c4aef5`（origin = github.com/VerSonetto/Denia）。本文只读分析，未改 Denia 任何文件。

## 技术形态

**壳 = Tauri 2 + 进程内 axum HTTP 服务（单 exe）**；前端 = React 18 + TS + Vite + pnpm，**纯手写 CSS token（无 Tailwind/组件库）**。workspace 14 个 crate（core/llm/tools/mcp/session/agent-loop/server/desktop…，`Cargo.toml:3-18`）。桌面壳在进程内起与纯 CLI 完全相同的服务，再把窗口 `navigate()` 到 `http://127.0.0.1:<port>`——不套自定义协议、不重复实现 IPC，桌面与 Web 是同一服务的两个入口（`crates/desktop/src/main.rs:14-19,122-141,216-222`）。**这一点与 harness2 架构（desktop spawn serve 子进程）同构，其桌面质感做法可直接对照吸收。**

`0c4aef5`（"unify warm UI surfaces + Windows taskbar icon"）内容：①Windows 下 `builder.icon(include_image!("icons/128x128@2x.png"))`——默认只解码 ICO 首帧 16px，任务栏缩放需高分辨率源图（`main.rs:196-198`）；②「warm surfaces」= 亮色主题从纯白 `#ffffff` 统一成暖白 `#fdfcf9`、侧栏 `#f6f5f2`，并把 composer/diff 卡/队列面板/侧栏按钮/标题栏五处表面底色收拢成语义 token（`--composer-surface` 等 5 个，`foundation.css`）。

## 五痛点对照

### ① 空态窗控 → Denia 用「常驻自绘标题栏」根治

- `decorations(false)` 全关原生装饰，前端自绘 `DesktopTitleBar`（`main.rs:201-202`；`web/src/components/DesktopTitleBar.tsx`）——**标题栏独立于会话内容，永远在**，从结构上排除「空态没按钮」。
- 三键走 `getCurrentWindow()` IPC，各自 `.catch(()=>{})` 静默兜底（`DesktopTitleBar.tsx:86,94,104`）；最大化态 `isMaximized()`+`onResized` 订阅带 disposed 竞态保护（`:32-61`）。
- **Tauri 专属坑**（对 harness2 是「drag 区与按钮命中区分」的类比知识）：`data-tauri-drag-region="deep"` 让整棵子树可拖（`:72-75`）；双击最大化刻意**不**挂 onDoubleClick——drag.js 自己响应 detail===2，双挂净效果为零（`:76-78`）。窗口 navigate 到 http origin 后须在 capabilities 写 `"remote": {"urls": ["http://127.0.0.1:*/*"]}` 显式授权，否则窗控 IPC 全被拒、「按钮画出来但没反应」（`crates/desktop/capabilities/default.json:4-8,12-18` description 整段就是事故报告）。
- 几何：标题栏高 38px、按钮宽 46px、close hover Windows 式红 `#c93c3c`（`styles/shell.css:11-96`）；有 285 行纯几何回归脚本 `web/scripts/check-desktop-titlebar.mjs`。标题栏只占主列宽不通栏（避免与侧栏品牌重复，`DesktopTitleBar.tsx:12-27` 注释）。
- 启动兜底：窗口先建在**内嵌占位页**（「正在启动…」，`crates/desktop/placeholder/index.html`），服务失败直接 `fail()` 注入窗口内容（`main.rs:230-249`，注释：不用 data:URL 因 WebView2 不渲染）——「双击没反应」类空态被消灭。
- ⚠️ 反例：其标题栏 CSS 只在 `min-width:821px` 显示，窄窗口无窗控（`shell.css:15`）——harness2 做窄窗适配时别抄漏。

### ② 托盘 → **Denia 未实现**（搜过 tray/TrayIcon/minimize-to-tray/globalShortcut/single-instance，含 Rust/web/conf/capabilities；`tauri` features=[]，`Cargo.lock` 的 tray-icon 仅传递依赖）。替代做法两个：
- `ExitGate`（`main.rs:251-295`）：拦 `ExitRequested`，先发停机信号等 serve 收尾（杀隧道、关 listener）才真退出——关窗=退出，但退得干净。
- **隐藏控制台消黑框**（`crates/desktop/src/console.rs:1-34`）：GUI 子系统程序没有控制台，子进程（git/bash/MCP）默认各新建一个=每次 spawn 闪黑框；解法是启动时 AttachConsole/AllocConsole+立即隐藏，让**所有子进程继承这个隐藏控制台**，不必逐处补 CREATE_NO_WINDOW。⚠️ harness2 桌面 spawn serve/终端时大概率同病，值得单独立项验证。

### ③ 项目/会话组织 → 入口密度与「+」延迟解法都最有参考值

- 侧栏三层结构（`web/src/App.tsx:802-893`）：顶层常驻「新建会话/扩展」钮（rail 收起态有图标版 `:910-918`）；**工作区组头 hover 行内动作 `.row-actions`：「在该项目下新建会话」+「删除工作区」**（`:1446-1463`；默认 `display:none`，`:hover/:focus-within` 显示，`shell.css:538-600`）；**每条会话行 hover 删除钮、`disabled={running}` 运行中禁删**（`SessionRow :1588-1687`，钮 `:1676`）。
- 会话按工作区分组 + 子会话按 `parent_session` 血缘树嵌套缩进（caret 折叠、`+n` 徽标、折叠时运行圆点上顶，`:1622-1667`）；每组默认限 N 条 +「展开其余 N 条」（`:1488-1500`）；「未分组」桶批量清空逐个检查 running（`:1528-1537`）。
- **空白会话治理**：本页新建的空白会话切走时自动删除（离开即删、有草稿豁免，`:583-598`）——防「新建一堆没内容」的列表垃圾。
- 删除全走自定义 ConfirmDialog（`setConfirmReq`，`:679-727`），**不用 window.confirm**（桌面壳原生 confirm 观感差且阻塞）；删除成功/失败都有 toast；删工作区级联清面板桶+终端进程（`:695-700`）。无重命名/归档（API 路由 `crates/server/src/api/sessions.rs:39-73` 无端点；标题由首条 prompt 摘要自动生成）。
- **「+」弹文件框慢**——根因与解法完整写在 `crates/server/src/native_folder_picker.rs:1-9`：Windows 前台锁使长驻进程弹 `IFileOpenDialog` 只落到任务栏；**解法 = 以 `--pick-folder` 参数 spawn 自身短命子进程，让对话框成为那个进程的第一个窗口** + allow_set_foreground（`:24-37,67-110`）。对应前端：pickDirectory 传 `timeoutMs=0` 不设超时，否则「用户还没选完就 abort、后端杀掉弹窗进程」（`web/src/api.ts:46-50,743-745`）。添加工作区按服务端 `/api/fs/capability` 探测分流：native 走系统框、browse 走应用内 DirPicker（`App.tsx:396,643-667`）。
- 上下文「+」**根本不弹系统框优先**：应用内搜索式文件挑选 popover（`api.searchMentions` + 150ms debounce + AbortController，`ComposerContextMenu.tsx:101-126`）；「上传文件」走隐藏 `<input type=file>`，注释强调**点击处理器里 await 前先取 file picker，保用户手势**（`:175`，浏览器会吃掉失手势的弹框）。

### ④ 发送失败反馈

- 失败路径：`catch → notify('err', message) + 输入框内容保留待重试`（`SessionsPage.tsx:1534-1536`）；草稿同时按会话 scope 持久化 IndexedDB（`composerMemory`，`:1537-1552` finally），刷新/切换不丢。**请求本身 15s 超时**（`api.ts:44`）——不存在「点了石沉大海」。错误来自服务端结构化 `{code,message}`（`api.ts:57-64`）。
- **乐观上屏 + 回执去重**：202 即 `pushPending` 注入乐观用户行置 running（`:1522-1528`），服务端 `user-message` 事件到达后替换，`confirmedRef` 防事件先至重复注入（`:1290-1301`）；发送成功才清空 composer。
- 禁用反馈分层：`inert`（无工作区）时输入区**整体可点、点击直接打开目录流**（`:1566-1568,1841-1843`）——禁用不是死灰而是引导下一步；placeholder 随状态三变（`:1917-1922`）；Enter 被 `composerReady`+`sendingRef` 双闸拦（`:1565`）。
- 运行中发送=入队 +「已排队」toast（`:1571-1575`），轮次结束自动发队首（`:1594-1613`）；队列面板「立即发送(先打断)/编辑/删除」，打断 5s 超时失败明确 toast 且**消息保留在队列**（`:1624-1660`）。
- 连接层：`connLost` 常驻角标「与服务器的连接断开,正在重试…」（`App.tsx:100,1083`；`controls.css:670-682`）。渲染崩溃：分层 ErrorBoundary（根+transcript+轨迹+markdown 各一层），降级视图带 Retry/Reload + `<details>` 详情（`components/ErrorBoundary.tsx:47-73`）。
- toast 基设：`appStore.ts:233-237` notify('ok'|'err') 单例 3.5s；样式 `controls.css:640-668`（底部居中、0.16s 上移淡入；黑白体系中 err 用灰阶，纯危险才 `--danger` 粉）。

### ⑤ 流式与长工具调用（耗时/进度/取消/终态四要素齐备）

- 回合级 `WorkIndicator`：「工作中 + 三点波浪 + 实时计时」挂消息流末尾（`transcript.tsx:219-239`）。三个工程点：memo 叶子**自持 4Hz(250ms) tick** 不牵动其他行；起点取后端 `turn-start` 事件携带的 epoch ms（`fold.ts:107`）→ **切会话往返计时不重置**；`role="status"`。点阵动画只用 `transform:translateY` 不触发布局；计时 `tabular-nums` 防抖（`conversation.css:516-533`）。
- 工具行 `ToolRow` 状态机（`transcript.tsx:821-1044`）：`running=!node.result`；运行中 = 行首 pulse 圆点 + **整行 2.4s 循环扫光 ::after gradient**（转圈被「可动的行」替代，`conversation.css:1038-1079`）；bash 运行中有 **live stdout/stderr 增量**（`fold.ts:91-98`，结束即弃防滞留）；退出码徽标 + **`end_reason` 徽标补「没有退出码的失败」**（timeout/cancelled/spawn_failed，`transcript.tsx:755-781`；BashCard 注释：不能只从 exitCode 推 `:30-38`）。
- **历史回合折叠** `TurnOverview`：闭合步骤折成「已工作 {duration} · {n} 次工具调用」一行，点开看明细（`transcript.tsx:241-265`；`fold.ts:1294-1358` groupTranscript，运行中的步保持逐行）。直接回答「长工具链刷屏+无终感」。
- 取消：`primaryStops = running && promptEmpty` → 发送钮原地变 stop 钮、Enter 同键复用（`SessionsPage.tsx:478,1762-1764,2163-2172`）；`POST /api/sessions/{id}/cancel` → CancellationToken，**顺带结算挂起的 plan 审批与 ask 提问（模型不必等超时）**（`crates/server/src/api/sessions.rs:370-408`）。
- 无进度长任务（压缩）：`CompactingRow` spinner + **「已经等了多久」；注释金句：「不画假进度条——不知道百分比就不该装作知道」「点了只会让人以为卡住了」→ 刻意不可点**（`transcript.tsx:337-364`）。
- 回合终态 `TurnChrome`：ok/err/warn 色点 + 六态原因（completed/aborted/max-tokens/interrupted/loop-detected/error 带 failure.code；`:1047-1123`）；loop-detected 行内「继续」自动发续跑（`:1085-1096`）；**reason 缺失运行时兜底 interrupted，防整块崩**（`:1058-1064`）。ask 等待期常驻不折叠 + 倒计时（`AskCard.tsx:284`）。全局累计耗时/TTFT/吞吐在输入框下 `StatsBar` 胶囊，进行中按秒跳（`useLiveClock`，`StatsBar.tsx:22,33-41`）。

## 性能手法（「不卡」的机制清单）

渲染侧：① **增量 fold**：流式帧只改尾部节点；连续 tool-output-chunk 按 callId 索引、首次写入才 copy-on-write，数组复制从每帧 m 次降为 1（`fold.ts:720-740` 注释）；② **打字机与流解耦**：显示位置对目标**指数收敛跟随**（λ=8/帧），快模型不积压慢模型有逐字感，rAF 驱动、代理对安全、落后>2000 码元跳底（`typewriter.ts:1-33`）；③ **增量 markdown 块冻结**：只重解析最后 2 个不稳定块，全文 O(1)/段，杜绝每 chunk 全文重析的平方开销（`markdown/incremental.ts:1-30`）；④ 代码高亮三重限流：流式增量 tokenize 只动追加行（`CodeBlock.tsx:14-19,57-81`）+ 硬预算 64k 字符/1000 行/单行 2000 字符超限保持纯文本（`highlightBudget.ts`）+ 语言包懒加载定点重渲；⑤ **虚拟化**：IntersectionObserver 共享实例窗口化（rootMargin 800px，离屏卸载内容**保留测量高度** ResizeObserver 记账 fallback 96px；展开/选区/焦点行强制常驻，`ViewportRow.tsx`；主流最后 12 行 eager，`transcript.tsx:189`）叠加 CSS `content-visibility:auto; contain-intrinsic-size:auto 64px`（`panels.css:119-130`）；用户消息不虚拟化常驻（`:183-187` 注释）；⑥ 行级 memo 全铺（NodeView/SessionRow/StatsBar/WorkIndicator，「流式帧只有引用变化的行重渲染」，`transcript.tsx:267`）；⑦ **吸底不抢滚**：归属只由读者滚动决定、wheel 快路、active 期仅内容真长高才落底、稳定期心跳自停，`hooks/useStickToBottom.ts:1-50` 注释是篇论文，配 `check-stick.mjs` 回归；⑧ SSE 帧每帧批量 flush、resnapshot 300ms 节流自愈 seq 断档（`sessionStreams.ts:283-294`）。
系统侧：⑨ SSE 主 + 长轮询降级：15s 心跳 32s 看门狗（**心跳也算帧，防工具静默执行被误判断线**）、后台退 15-20s 快轮指数退避封顶 10s、无人查看即断连（`sessionStreams.ts:241-251`）；⑩ 构建期预压缩 `.br/.gz` 实体旁挂、按 Accept-Encoding 直发，运行时零压缩 CPU（`precompress.mjs` + `web_assets.rs`）；⑪ 服务端事件日志区分 transient chunk、水位清扫只扫后缀 + resident_bytes 记账 + 冷会话 cool 出内存（`crates/session/src/lib.rs`，5f0ef82）；⑫ 先建窗口(占位页)再等就绪 navigate（`main.rs:123-126`）；`lto="thin"+codegen-units=1`；⑬ 侧栏折叠动画冻结宽内容「滑动途中不重排」（`shell.css:112-116`）；`prefers-reduced-motion` 全链路降级（`App.tsx:287-296`）；相对时间 60s 共享时钟（`:1227,1324-1327`）；10k 会话 Map/Set 索引防 O(n²)（`:1232-1256`）。

## 视觉 token（`web/src/styles/foundation.css:6-203`，暗 79 行/亮 122 行逐行镜像）

- 本质是**无彩黑白 + 单一红 danger**：暗底 `--bg-base:#090909`、四层灰 layer-1/2/3、标签四级 `#f5f5f5→#525252`、边框三档 alpha 白 .06/.10/.16；accent=白（亮色=黑），发送钮无彩色；状态色刻意降饱和（`--success:#a3a3a3`）另备彩色前景层「底色恒浅，彩字必须给足亮度」（`:43-51` 注释）。
- 亮色「warm」：`#fdfcf9` 基底 / `#f6f5f2` 侧栏（米白代替纯白）+ 0c4aef5 收拢的 5 个表面语义 token。
- 字体栈全系统零下载：`--font-ui: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui`；`--font-mono: 'SF Mono','JetBrains Mono','Cascadia Code',Consolas`（`:65-68`）；body 14px/22px + antialiased。
- 圆角 6/8/12/16/22 五档；侧栏 280px、正文 max 920px；统一缓动 `cubic-bezier(.4,0,.2,1)`；composer「刻意不画边框」暗底 1px 内嵌高光、亮底三层递进阴影（`:59-62,135-138` 注释即设计说明）；scrollbar 7px（`:237-247`）。

## 值得借鉴 Top 5 / 不适合 Top 2

**Top5**（按对本期目标的价值排序）：
1. **常驻自绘标题栏**（结构上杜绝空态无窗控）+ 启动占位页兜底 → harness2 对应 Z-46 overlay 窗控方案的落地佐证。
2. **组头 hover「在此项目新建」+ 行级删除(disabled=running) + 自定义 ConfirmDialog** → 直接补齐痛点③的入口密度；「空白会话离开即删」是列表治理巧招。
3. **原生目录框「spawn 短命子进程夺前台」修 + pickDirectory 0 超时** → 痛点③「+」慢/落任务栏的根因级解法（Electron 下同理可用：主进程弹框失前台时可考虑 `win.setAlwaysOnTop` 短暂提升或 `parent` 绑定修复，先复现定位）。
4. **长任务四要素成套**：WorkIndicator 自持 4Hz tick（不牵动列表）、行扫光代转圈、TurnOverview「已工作 X·N 次调用」折叠、终态六态+缺失兜底 interrupted → 痛点⑤的完整答案，且与 Z-97 相互印证。
5. **性能组合拳**：增量 fold + markdown 块冻结 + IO 窗口化保留高度 + 指数收敛打字机 + 吸底心跳 + prefers-reduced-motion → 「不卡顿」诉求的工程清单模板，多数可在 ui-shared 层实施。

**Top2 不适合**：
1. **黑白无彩 token 体系**：harness2 已承诺「完全还原 ZCode 视觉」（refs-zcode Z-60~Z-67 的 Zai token 族），Denia 的无彩黑白与品牌暖白自成一套，视觉层只吸收其**语义 token 手法**（表面收拢），不吸收色板本身。
2. **Tauri 专属细节**（drag-region=deep、remote ACL、ExitGate）与 **hide 原生 confirm、无归档/重命名**的功能缺口：前者不适用 Electron，后者低于 harness2 既有能力面，不倒退。
