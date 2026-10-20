BC审: P0=0 P1=2 P2=3

# U2 批B/批C 只读审查（提交 7bad054 / f2ea8dc）

## 批B（token 卫生）

### theme-token-parity.test.ts（防漂移是否咬人）

- 目的达成：去注释后用正则切块，`@theme` ↔ `Zai Light` ↔ `Zai Dark` 的 `--color-*` 键集与值进行断言，重复声明失败；暗块只锁键集（值允许语义不同）。
- 幻数 114 与 U2-B2 新增 token（`--color-scrim` / `--color-background-alt`）一并登记，新增 token 漏一处即红；集合相等规则阻止“只改一边”。
- 覆盖限制：仅 `--color-*`，不校验非颜色 token、未使用 token 的生成器行为或 prose 数值；结构性重复仍依赖人工同步，测试是合同守门而非生成源。

### 值出处核验（ZCode refs）

- `--color-background-alt` 可核：`docs/refs/refs-zcode.md` Z-67 明确 `color-mix(background 70%, transparent)` / `color-mix(background-win-alt 60%, transparent)`，实现“逐字”一致（A 级）。
- `--color-scrim` 不可核：Z-67 语义 token 表无 scrim 条目；ZCode 覆盖层实际常见 `bg-black/60`，本仓 `.45 / .6` 是沿用既有裸值与观感推定，注释已标“待像素校准”，应补 refs 来源或登记口径。

### shimmer 降级合并

- 将 `.reasoning-shimmer-text` 加入 reduce 块，补其此前缺失的 `color: inherit`；块内 `color:inherit` 满足 CSS 测试。
- 选择器顺序满足 `/\.tool-running-shimmer\s*\{/` 的断言；`.reasoning-shimmer-text` 仍保留自身 keyframes，未互相污染。

## 批C（对话区设计对齐）

### stopReason 拆分口径（turn-work.tsx）

- `cancelled` → “已停止”、合成 `interrupted` → “已停止（无响应超时）”、非合成 `interrupted` → “已被新消息中断”，其余 → “已工作”。
- 本仓 core 不产出非合成 `interrupted`（interrupted 仅 UI 合成态），新 label 的文案归因（“上游以新消息抢占回合”）缺乏生产者/协议证据，属于前向兼容推断；建议明确等价前提或移除，避免误导。
- 测试已固化该推断（turn-work-duration），后续若来源出现，至少需先补语义登记。

### pending 同皮与空态

- `streaming` 工具行改为直接渲染 `ToolCard`，`toolCardFromItem` 不臆造字段，运行态由 `toolStatusOf` 产出 “运行中…”；无结果区不摆箭头，符合无假状态口径。
- `toolStatusLabel` 成功态改为空串；组件保留空文本节点，三态颜色 token 负责语义，已同步桌面与 ui-shared 测试。
- 连带风险：成功态 status 节点为空，若后续版本再引入“ok”文本可能造成重复。

### ChatErrorBanner 兜底

- message 空白时兜底 “发送失败，请稍后重试。”，并追加“内容已保留，可直接重发”；建议确认所有触发路径均包含 composer 草稿保留（D-34）后再把“已保留”设为事实文案。

### 2xs 执法（conversation-font-scale.test.ts）

- 指定 10 个 TSX 文件与 19 个 shell.css 选择器；已把对话域裸 `px/em` 基础字号改为 `var(--text-ui-*)`。
- 豁免 `ChatEmptyState.tsx` 与 `tool/FilePreview.tsx`，留下明确 loophole；如批C 目标是“对话域最小档 text-ui-xs”，空态也应在范围（或明确登记为后续阶段）。
- shell.css 选择器以白名单逐个断言，未列出的对话相关选择器仍可混用裸字号；执法强度弱于文件名单。

## 测试同步评价

- chat-view-p01 从“持续 N 秒”双行改为 WorkIndicator 唯一源，turn-summary 只保留 error/warning/partial/empty；去掉 `formatTurnDuration` 消费但保留函数，向后兼容。
- tool-card 测试中文化更新与 desktop 断言一致；未运行 vitest（按审查要求）。

## 结论

- 无 P0 阻塞。
- P1： scrim 值无法回溯 ZCode refs；执法 exemption 留 loophole。
- P2： interrupted 文案语义无生产者；banner “内容已保留”事实未全覆盖核验；shell 选择器白名单不完整。
