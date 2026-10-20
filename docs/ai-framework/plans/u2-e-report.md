# U2 批E 实施进度报告（助手正文 Markdown 渲染）

> 基线 = 56ded3c，分支 feat/phase-u1-desktop-parity-fixes。
> 本文件由批E 实施代理**边做边追加**，每完成一项更新一次。状态标记：
> `未动` / `进行中` / `✅ 已落盘` / `⛔ 放弃登记`。

## 总览（当前时刻）

| 项                                          | 状态                     | 说明                            |
| ------------------------------------------- | ------------------------ | ------------------------------- |
| E-a MarkdownBlock + ChatView 接线           | 未动（设计已定案，见下） | 探索 100% 完成，即刻开工        |
| E-b shell.css .markdown-body + scrim + 死类 | 未动（侦查完成）         | 死类零引用已核实                |
| E-c seat.tsx 状态面板浮层化                 | 进行中→倾向 ⛔ 放弃登记  | 详见 §E-c 评估（20 分钟预算制） |
| E-d markdown-block.test.tsx + perf B1       | 未动                     | 依赖 E-a                        |
| 闸门（tsc/vitest/dist/desktop/web/lint）    | 未动                     |                                 |

## 卡点报告（回应编排者质询）

上一轮为**纯探索轮**：全部工具调用用于侦察（streamdown 2.7.0 实际 API、CJS 双构建约束、
ChatView/streaming 数据面、CSS token 面、seat 状态面板容器查询结构、死类引用核实、
既有测试断言面），未写功能代码属计划内（探索先行），非卡死。无遗留临时文件
（探索期 .tmp-inspect.cjs 已删除）。

**工作区非我改动登记**（保持原样不碰）：`ReasoningRow.tsx`、`tool/FilePreview.tsx`、
`test/conversation-font-scale.test.ts` 三处 working-tree diff 为并行「U2 扫尾」会话的
2xs→xs 修正，与本批无冲突，我不回滚不再改。

## 探索定案（写码依据）

1. **E-a 真实接线点**：ChatView.tsx 现无「assistantText」变量；:189 是 turn-summary
   partial `<pre>`。但「助手正文」实际渲染点有两处：
   - `case 'assistant'`（:86）`<div className="text">{item.text}</div>` → 完成态：
     `MarkdownBlock streaming=false`（static）。
   - `case 'streaming'`（:157-161）同 `.text` + `.cursor` ▌ → 流式态：
     `MarkdownBlock streaming=true`（mode=streaming + parseIncompleteMarkdown，光标保留在块外）。
   - :189 partial `<pre>` → MarkdownBlock **static**（半截产出=终态冻结，`turnIsRunning &&
isLastTextItem` 恒 false：partial 只在 turn-end 后出现；直接保守 static 正确，报告注明）。
2. **streaming 判定可得性**：ChatView 已有 `store.peekStream(sessionId)?.running`
   （:80 现算 `running`）→ turnIsRunning 可得；`item.streaming===true` 即 isLastTextItem
   （投影层保证在途 live.text 条目恒为末条，chat-model.ts:386-391）。
3. **streamdown@2.7.0 实战约束核实**（读 dist/chunk 源码实证）：
   - 默认 `strong` 渲染成 `<span data-streamdown=strong>`（非 `<strong>`）→ 需 components 覆盖
     （测试①依赖真 `<strong>`）。
   - 默认 `code` 组件行内分支已产出 `rounded bg-muted px-1.5 py-0.5 font-mono`（=规格要求）；
     块级分支走内置 shiki 懒 renderer + CodeBlock 外壳 → **必须覆盖 code 组件**：块级
     （props 含 `data-block`）→ harness2 CodeViewer；行内 → 自绘 `md-inline-code` 类（不赌
     Tailwind 工具类是否被扫描进壳）。
   - 语言探测：默认组件 className 带 `language-xxx`（regex /language-(\S+)/），CodeViewer
     language 需 `CODE_LANGUAGES` 白名单命中，否则 null=纯文本（CodeViewer 原生语义）。
   - **CJS 双构建硬约束**：streamdown 是 ESM-only（exports 无 require 条件），静态 import 会
     触发 TS1479（与 shiki 同因，见 shiki-loader.ts 文件头）。→ MarkdownBlock 必须
     `React.lazy(() => import('streamdown'))` + Suspense（fallback=纯文本 `<pre>`，顺带即降级态）。
4. **CodeViewer 接线成本**：需要 themeId（useActiveCodeThemeId→useShellTheme）+ 偏好
   （useCodePreferences）。若这两 hook 无 Provider 依赖（shell-store 单例口径，待一眼核实）
   → 直连；否则按授权降级=块级 `<pre class=md-code-block>`+mono CSS，报告说明。
5. **E-b 死类零引用已核**：`.queue-bar`（仅组选择器成员+注释提及）、`.tool-pending`（仅注释）、
   `.hint`（全部是 command-palette-hint/runtime-hint 等复合名，独立类零引用）、`.bg-tag` 零引用。
   可删。scrim 两处实际行号=shell.css :1318（.settings-overlay）/:1729（.command-palette-overlay），
   `--color-scrim` 三主题已存在（styles.css :96/:227/:353）→ **无需新增 token**，
   theme-token-parity.test.ts 不动。
6. **CSS 策略**：streamdown 默认组件自带 Tailwind 类（是否被壳 tailwind 扫描不确定）→
   `.markdown-body` 选择器自带完整声明（特异性 (0,1,1) > 工具类 (0,1,0)，赢面无冲突），
   字号全部钉 var(--text-ui-*)：h1→lg / h2→base / h3→sm（Z-61 不越刻度）；
   `.markdown-body{white-space:normal}` 抵消 .bubble 族的 pre-wrap。

## E-c 评估（20 分钟预算制）

槽位（seat.tsx :521-531）浮层化三坑：①锚点：`.conversation-seat` 已 relative，但槽位位于
shell 注入 header **之下**，absolute top 需要 header 高度（无现成测量；composer 有
--composer-inset 先例但 header 无）→ top 值靠猜，违反「禁凭想象」；②容器查询：@container 现挂在
槽位自身，absolute 后槽位宽度=内容宽（收缩）→ 1280 断点判据失真；修法=inset-x-0 全宽包裹层保
@container + pointer-events 手术（浮层会挡转录点击，需 `[&>*]` 逐层放行）；③展开态面板 max-h
64dvh 浮在转录之上会盖正文，属设计变更量级，无像素验证通道。
**结论：不满足「低风险」门槛 → 放弃并登记**（配方已写清，留待专批带像素校准做）。

## 变更记录（追加区）

- (本条 = 建档) 状态：E-a/b/d 未动，设计定案如上；E-c 放弃登记成立。
