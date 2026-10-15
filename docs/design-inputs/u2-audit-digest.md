# U2 设计优化 · 审计台账（定稿）

> 三路并行视觉审计已完成（对话区 15 条 / 侧栏 14 条 / 壳层与 token 11 条）。基准纪律=ZCode 规格优先（复刻权威），规格留白处才引竞品/frontend-design 原则；两处「待用户拍板」不入批次。原始逐条全文见本文件各批任务书引用；此处为定稿台账与切批。

## 待用户拍板（不在本波做）

- 侧栏「搜索会话…」输入框去留（ZCode 无此框，OPEN.md 2026-10-13 ⑦已登记）
- 项目组头计数徽标去留（ZCode 无计数；Denia 有「+n」，⑧已登记）
- 侧栏宽度持久化（Z7②「需经主进程」未决）
- 助手正文 Markdown 渲染引入（对话区审 ②；ZCode 基线推断项，正在由 jam 源码定案；引入=新依赖，默认做，用户可一票否）

## 切批（区域互斥防写冲突；每批一个执行者）

| 批 | 域 | 条目 | 触及文件（独占） |
| --|----|------|------------------|
| A 壳层 | D3①②③④⑥ + D1①桌面接线 | focus-visible 组规则；窗控图标 16px/圆角 6；闲置色满前景；win 最大化归零圆角；启动壳 index.html drag 条+防闪底；会话头 48px 整带基线；桌面启动自动草稿会话（App.tsx） | desktop-window.css / app-frame.css / WindowControls.tsx / platform.ts / index.html / App.tsx |
| B token | D3⑦⑧⑩ | styles.css：@theme/light 双块收拢、补 --color-scrim/--color-background-alt/animated-gradient 族、.tool/.reasoning shimmer 降级合并 | styles.css |
| C 对话区 | D1①(seat 兜底)③④⑤⑥⑦⑧⑨⑩⑪⑫⑭⑮ | 空态兜底复用 EmptyState+Spinner；2xs×24→xs；shell.css 对话域字号归刻度；状态面板浮层化 z-20；耗时双行收口+中断归因拆分；turn-work 运行态扫光；ResumeBar 轻底+XIcon；错误横幅文案指向下一步；ref-report 折叠；scrollbar-gutter；工具 pending 行同皮+中文状态；死码清理（ChatEmptyState/旧类）；queue dock shadow-xs | shell.css / seat.tsx / ChatView.tsx / turn-work / chat-model / ResumeBar / ChatErrorBanner / QueuePanel / tool-model / ToolCard / TimelineMarkerRow / status-panel / Composer(左簇图标化) |
| D 侧栏 | D2①②③④⑤⑦⑧⑨⑪⑫⑬⑭ | sidebar.css 字号刻度；底色 --color-sidebar/hover surface-hover/选中去左条加粗；unread 蓝点+running LoaderIcon+attention 绿底；行钮 JS-mount 24px；移出项目收进 ⋯ 菜单；空侧栏保骨架分区头；projects 失败行内 Alert；⚙→SettingsIcon；折叠 Collapsible 300ms；滚动条 Z-69；圆角统一；轨道死 CSS 删 | sidebar.css / SessionBrowser / SidebarRoot / task-view / labels / shell-seat-contents |
| E Markdown（后置） | D1② | ChatView 正文 markdown 渲染（依赖引入+增量块冻结）——待 jam 基线定案后第二波 | package.json / ChatView / markdown/ |

## 执行登记口径

jam 窗口 10:39:30 开启（watcher 命中）。本波：D3/D1/D2 审计与基线定案=jam（读类）；实施 A/C=jam 试派、B/D=gp（窗口间歇关闭会中途死，混合派降低整批团灭风险；执行者如实登记）。每批纪律：只落盘不 commit（编排者验收后统一提交）；跑 tsc+自身文件 eslint/prettier；样式类「不引新视觉、只对齐规格」。

## 进度

- [x] 审计三件套（对话区/侧栏/壳层）
- [ ] jam 复核 U1 登记项×3 + 已修 P2 复认（kickoff 卡范围）
- [ ] jam ZCode 正文 Markdown 基线定案
- [ ] 实施 A/B/C/D → 编排者闸门+提交 → E 波 → 重建打包+截图对比
