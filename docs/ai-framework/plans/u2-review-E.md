# U2 批E 审查报告（只读，设计正确性）

> 审查对象：`docs/ai-framework/plans/u2-e-report.md` 定案与工作树 diff（`ChatView.tsx` / `seat.tsx` / `shell.css` + 新增 `MarkdownBlock.tsx` / `markdown-block.test.tsx`）。
> 审查口径：不跑 vitest，不改任何 `packages/` 文件；`tsc --noEmit` 已按壳口径通过。

## 1. 六项对照结论

### (1) streamdown ESM-only → React.lazy + Suspense（对照 `shiki-loader.ts`）
成立。`ui-shared` 是 `type: commonjs` 双构建（`dist/esm` + `dist/cjs`），streamdown 是 ESM-only；实现采用动态 `import('streamdown')` + `React.lazy` 并包 `Suspense`，与 shiki-loader 的「动态 import + 不静态引类型」同一手法。类型面未静态 import 包名，走 `typeof StreamdownLazy` + 内联 `import()` 类型，CJS 构建安全。`tsc --noEmit` 已通过，论证闭合。

### (2) 历史 / 完成态强制 static：覆盖所有渲染点
已覆盖全部当前渲染点：
- `assistant` 分支：`<MarkdownBlock text=... />` 默认 `streaming=false` → static；
- `streaming` 分支：`streaming={streamIsRunning && item.streaming === true}`；会话不在途或条目非末条 live text 时回落 static；
- `turn-summary` 半截产出：`<MarkdownBlock text={partialText} />` static；
- `assistant` 仅在 turn-end 后出现；partial 仅 turn-end 后出现，与报告注释一致。
补充：`user` 分支仍为纯文本 `<div className="text">{item.text}</div>`，不在本批设计范围（用户消息不进行 Markdown 升级），一致。

### (3) code 组件覆盖
符合证据：streamdown 默认 `pre` 用 `cloneElement` 注入 `data-block="true"`；`MdCode` 以 `'data-block' in rest` 判定块级 → `CodeViewer`（主题/偏好 hooks 走 shell-store 单例，无需 Provider）；行内 → `<code className="md-inline-code">` 自绘并落 `.shell.css`。语言探测为 `CODE_LANGUAGES` 白名单 + `LANG_ALIAS`，未命中 `null`（纯文本，不假装高亮）。

### (4) ErrorBoundary 降级路径
包覆顺序正确：`MarkdownErrorBoundary` 在外、`Suspense` 在内，覆盖懒 chunk 加载失败与渲染异常，降级为 `<pre class="md-raw" data-md-fallback="true">` 且原文保真。加载态（`data-md-loading`）与降级态（`data-md-fallback`）可区分。非阻断加固项：boundary state 不随 `text` 更新自行 reset；当前生产路径靠会话 item 的 `seq` key / remount 收敛，已有组件生命周期下不会「先错后对」场景。建议必要时追加 resetKey，但不列入缺陷。

### (5) CSS 特异性策略
`.markdown-body` 选择器自有完整声明（字号钉 `--text-ui-*` 刻度：h1→lg / h2→base / h3~h6→sm；所有颜色走 `--color-*`/`color-mix`），且 `white-space: normal` 显式抵消 `.bubble` 族的 `pre-wrap`。`shell.css` 未被 Tailwind `@layer` 包裹，非分层规则压制分层 utilities；说明中「同特异性下 (0,1,1) > (0,1,0)」成立。scrim 两处已切 `--color-scrim`，三主题跟随。

### (6) E-c 放弃登记
论证成立。该槽位 float 化三坑（header 高度无测量通道、`@container` 对 absolute 内容宽收缩、展开面板 64dvh 蓄意盖住转录）均未在本轮具备低成本、可验证的收敛方案；「低风险门槛」不满足时登记而非硬做符合 AGENTS 红线（禁止凭想象`). 当前 `status-panel-slot` 保留块流布局 + `@container` 断点，不 introduced 回归面。

## 2. 审计结果汇总

- **设计缺陷计数 = 0**（未发现会阻碍合并的不一致）。
- **不计入缺陷的加固建议**（可单独立项，不阻塞批E结论）：
  1. 向 ZCode 对齐时可追加 `isAnimating={false}`（现仅 `animated={false}`）；
  2. 给 `MarkdownErrorBoundary` 加 resetKey，覆盖「同一条消息先坏后好」；
  3. 运行 E-d 四额外断言（围栏走 CodeViewer、`toCodeLanguage`）确认宿主环境通过。

## 3. 文件落点

- 仅写入 `docs/ai-framework/plans/u2-review-E.md`；未修改 `packages/` 下任何文件，未运行 vitest。

## 4. 结论

批E 定案 `/ 引 wire / CSS / E-c 登记 / partial static` 设计正确，可按报告推进实施与闸门。阻断级纠偏：无。
