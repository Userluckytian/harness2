# U2 批A 提交 4c56dd0 独立审查

## 结论

A审: P0=0 P1=1 P2=2

范围：packages/desktop renderer（WindowControls、index.html、desktop-window.css、platform.ts）+ ui-shared conversation/seat.tsx + app-frame.css。未运行 vitest（按要求，工作树有并行实施改动）。

## ① 规格符合性（refs-zcode-layout.md）

- Z-46：窗控 overlay 仍单实例常驻；空态文案 remains `选择左侧会话开始对话（Ctrl+K 打开命令面板）`；空态按钮 testid `conversation-no-session-new`；启动壳 drag 条 48px 符合 Z-46 "loading 仅 drag 区"；BrowserWindow 背景色 `#161616 / #f8f8f8` 与 main.ts:154 一致。符合。
- Z-46 known gaps：ErrorBoundary fallback 仍挂 `WindowControlsOverlay`；RootStartupLoading 本仓不存在，无缺口接线面。
- Z-61：空态新文案使用 `text-ui-base`、`text-ui-xs`，无裸 px 字号；图标 16px 对齐 Z-81 `size-4` 基线；idle 色从 subtle 升 foreground，与 overlay 常驻口径一致。符合。
- 差异/需登记：新增 win 最大化去圆角（`.desktop-window-frame-win.desktop-window-frame-maximized`）在 refs-zcode-layout Z-02 中未直接规定（Z-02 明确写最大化去圆角的是 Linux）。属于有意补全，需在 refs/计划里登记，避免与复刻口径混淆。

## ② 逻辑缺陷 / 边界

### P1

1. `packages/ui-shared/src/renderer/conversation/seat.tsx:566` 空态「新建会话」直接调用 `controller.newSession()`，未走壳内其它三个新建入口统一的 `backToConversation()` + `newSessionCollapsingRightbar(frameDispatch)`（`shell-seat-contents.tsx:258,262,272`；托盘链路 `shell-seat-contents.tsx:178` 也是如此）。在空态出现同时右侧 Side Pane 仍打开、或主区曾被切换到自动化视图时，新建会话会残留在旧主区/右栏状态，与另外三处入口的"收右栏+回对话"语义不等价。提交注释声称"语义等价"，实际并不等价；建议在桌面壳为席位注入 `onNewSession` 回调，或在空态里允许帧 dispatch，以统一路由。

### P2

1. `packages/desktop/src/renderer/index.html` 的启动壳隐藏规则 `body:has(.desktop-window-frame) #boot-drag { display: none; }` 依赖 Chromium `:has()`（Electron 44 支持）。正常 React 挂载后隐藏；回退场景下（渲染失败、ErrorBoundary 回退后 `.desktop-window-frame` 消失）boot-drag 会重新出现，虽仍可拖动，但 z-index 0 且 48px 区域可能与回退内容重叠。边界需在 ErrorBoundary fallback 或 AppFrame 卸载场景下显式验收。此外 `:has` 仅按类名匹配，若未来 App 根类名调整，启动 drag 条会永远保留。

2. 窗控图标 SVG 仍使用 `viewBox="0 0 12 12"` 而渲染尺寸改为 `width={16} height={16}`；同时 stroke width 从 1.2 降到 0.9。渲染 stroke 实际为 0.9 * 16/12 = 1.2 px，视觉厚度保持，但 viewBox/渲染尺寸比例与 ZCode 16px 基线不完全一致，未来调整渲染尺寸时 stroke 会按比例缩放，需在 specs 中明确。

## ③ 测试断言同步

本提交未修改任何测试文件；现有断言仍与多数变更对齐：
- `desktop-chrome.test.tsx` 仅断言 `windowFrameClass('win32', false)`，未断言 maximized，因此新增 win maximize 类不会直接破坏；但包内平台测试未覆盖新增分支，属于覆盖缺口，不是弱化。
- `frame-styles.test.ts` 匹配 `.window-controls-btn` 的 `width: 28px; height: 28px;` 仍成立；未断言 win-maximized，新增规则不破坏。
- App 集成测试仍以 `选择左侧会话开始对话` 文案识别空态，文案保持；新增 `conversation-no-session-new` 按钮为增量，不影响既有断言。
- 工作树当前存在并行实施改动（seat.tsx 仅注释），与本提交无冲突；未执行测试以防撞中间态。

## 文件证据索引

- `packages/desktop/src/renderer/components/WindowControls.tsx:17-60` 图标尺寸/描边变更
- `packages/desktop/src/renderer/layout/desktop-window.css:30-39,71-88` idle 色/focus-visible/win-maximize
- `packages/desktop/src/renderer/index.html:19-55` 启动壳背景/48px drag/:has
- `packages/desktop/src/renderer/platform.ts:36-40` win maximize 类
- `packages/ui-shared/src/renderer/conversation/seat.tsx:533-566` 空态升级与 newSession 路由
- `packages/ui-shared/src/styles/app-frame.css:258-265` focus-visible
