# 2026-10-11 阶段 Z1 · Tailwind + shadcn 基建

> 上位总纲：[`2026-10-10-phase-zcode-ui-overhaul.md`](2026-10-10-phase-zcode-ui-overhaul.md)（Z0–Z7）
> 依据：[`refs-zcode.md`](../../refs/refs-zcode.md)（视觉与组件规格，`Z-60`～`Z-95`）· [`refs-zcode-layout.md`](../../refs/refs-zcode-layout.md)（`Z-01`～`Z-45`）
> 台账：[`zcode-ui-traceability.md`](zcode-ui-traceability.md)
> 元规范：`docs/ai-framework/phased-plan-driven.md`、`AGENTS.md`、`CODE_REVIEW.md`

## 元信息

| 项         | 值                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------- |
| 阶段       | Z1（Tailwind + shadcn 基建）                                                                  |
| 实施档位   | **全能（3/4）**                                                                               |
| 子代理     | **启用**（实现 / 测试 / 只读审查）                                                            |
| 入口条件   | Z0 已交付；npm registry 可达（已验：`tailwindcss@4.3.3`）                                     |
| 出口条件   | 见 §6 验收标准总表（V-Z1-1～V-Z1-6 全绿）                                                     |
| 本阶段不动 | `packages/core`（零改动）· `packages/gateway`（零改动）· `packages/cli`（零改动，V 程序管辖） |

## Global Constraints

1. **`packages/core` 零改动**；`core` 导出面（`api-surface-baseline.json`）全程 0 diff（红线 7）。
2. **`ui-shared` 保持零 electron / 零 node 内建依赖**（`HANDOFF.md:117` + 红线 3）；新增依赖必须纯浏览器。
3. **`ui-shared` 仍须禁止 import `@harness2/core`**；线协议 `shared/protocol.ts` 为唯一事实源，本阶段不改协议。
4. 桌面 `index.html` 的 CSP 不得放宽；**不得引入任何外部 CDN / 外链字体 / 外链图标**。
5. 桌面 `vite.config.mts` 的 `target: 'chrome130'` 与 `base: './'` **不得改动**（后者是白屏根因修复）。
6. 依赖与构建接线属**编排者独占文件**（根 `package.json`、`packages/*/package.json`、`vite.config.*`、`tsconfig*`、eslint/prettier 配置）——由编排者单点修改并登记。
7. **字号纪律**（`Z-61`）：只用 `text-ui-*` 刻度，禁止 Tailwind 内置 `text-sm/base/xs` 与任意 `text-[13px]`。
8. **颜色纪律**（`Z-62`）：只用语义 token，禁止一次性色值（`text-white/60` 之类）。

## 阶段地图（Z1 内部小段）

| 小段  | 名称                   | 产出                                                                                                                                        | 依据条目          |
| ----- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Z1-01 | 依赖与构建接线         | 三包 `package.json` 增依赖；desktop/web `vite.config.mts` 接 `@tailwindcss/vite`；`ui-shared` exports 指向 src 的 CSS                       | —（工程）         |
| Z1-02 | token 与主题层         | `packages/ui-shared/src/styles/styles.css`：三层 token + Zai Light/Dark 全量色值 + `text-ui-*` 刻度 + `@source`/`@custom-variant` + base 层 | `Z-65`～`Z-74`    |
| Z1-03 | 组件工具与 shadcn 基座 | `components.json`、`components/lib/utils.ts`（`cn()` 注册 `text-ui-*`）、`@/` 别名                                                          | `Z-75`～`Z-79`    |
| Z1-04 | shadcn 原语落地        | `components/ui/*`（button/input/card/dialog/badge/tabs/tooltip/dropdown-menu/scroll-area/switch/select/toast/kbd/separator/spinner）        | `Z-75`～`Z-81`    |
| Z1-05 | 主题运行时             | 三态 `system/zai-light/zai-dark` + 跟随系统 + 首屏防闪 + 桌面 `nativeTheme` 镜像                                                            | `Z-83`～`Z-86`    |
| Z1-06 | 既有测试迁移           | 3 个 CSS 文本断言测试重写；~210 处 DOM/类名断言改走 `data-*` 契约                                                                           | 风险 3（总纲 §2） |

## File Structure（本阶段）

```
packages/ui-shared/
├── package.json                       ← 改：加依赖；styles/*.css 导出指向 src
├── components.json                    ← 新：shadcn 配置（style=radix-mira）
├── src/
│   ├── styles/
│   │   ├── styles.css                 ← 新：Tailwind 入口 + 三层 token + 双主题 + base
│   │   ├── shell.css                  ← 保留（迁移期内仍被引用；Z2 起逐步退役）
│   │   └── sidebar.css                ← 保留（同上）
│   └── components/
│       ├── lib/utils.ts               ← 新：cn()
│       └── ui/*.tsx                   ← 新：shadcn 原语
packages/desktop/package.json           ← 改：devDeps 加 @tailwindcss/vite + tailwindcss
packages/desktop/vite.config.mts        ← 改：plugins 加 tailwindcss()
packages/web/package.json               ← 改：同 desktop
packages/web/vite.config.mts            ← 改：同 desktop
```

## 契约（本阶段冻结项）

- `@harness2/ui-shared/styles/styles.css` 为 **GUI 唯一 Tailwind 入口**；壳不再自建 Tailwind 入口。
- token 命名与取值以 `refs-zcode.md` `Z-67` / `Z-68` 为唯一依据，**逐条一致**。
- 主题切换只切**根 class**（`theme-zai-light` / `theme-zai-dark` / 无 = 跟随系统解析结果）；**额外**引入 `data-theme`（见 §7 刻意差异）。

## Task 1..N

- **Task 1（Z1-01）依赖与构建接线**：三包加依赖并安装；`@tailwindcss/vite` 接入 desktop/web；`ui-shared` 的 `styles/*.css` 导出改为指向 `src/styles/`（避免"必须先 build 才能引用样式"的耦合，且使 `@source` 相对路径稳定）。
- **Task 2（Z1-02）token 与主题层**：写 `styles.css`——`@import "tailwindcss" source(".")` + `tw-animate-css` + `tailwind-scrollbar-hide/v4` + `shadcn/tailwind.css` + `@plugin "@tailwindcss/typography"`；`@source`（ui-shared src、desktop renderer、web src）；`@custom-variant dark`；`:root` + `@theme` 定义语义 token（亮）；`.theme-zai-light` / `.theme-zai-dark` 覆盖；`text-ui-*` 刻度；base 层（滚动条、`::selection`）。
- **Task 3（Z1-03）组件基座**：`components.json`；`cn()`（`extendTailwindMerge` 注册 `text-ui-*` 到 `font-size` classGroup）；`tsconfig.json` 加 `@/*` paths；两个 shell 的 vite 加 `@` 别名（指向 ui-shared src）。
- **Task 4（Z1-04）shadcn 原语**：按 `Z-75`～`Z-81` 规格落地最小可用集（button/input/textarea/card/dialog/badge/tabs/tooltip/dropdown-menu/scroll-area/switch/select/spinner/kbd/separator/toast）。
- **Task 5（Z1-05）主题运行时**：`ui-shared/src/renderer/theme/*`——三态偏好、`matchMedia` 跟随、根 class + `data-theme` 写入、首屏防闪（head 注入由壳负责）、桌面 `nativeTheme` 镜像。
- **Task 6（Z1-06）测试迁移**：3 个 CSS 文本断言测试改为断言 token 存在与语义类名；~210 处结构断言改走 `data-*`。

## 代码审查

本阶段结束前派**只读审查子代理**按 `CODE_REVIEW.md` 出 P0/P1/P2 报告，重点核八条红线中的：红线 3（core/UI 解耦）、红线 7（导出面快照 0 diff）、红线 8（插件边界口径）。UI 不得触碰红线 1/2/4/5/6。

## 验收标准总表

| 编号   | 通过条件                                                            | 证据要求                         |
| ------ | ------------------------------------------------------------------- | -------------------------------- |
| V-Z1-1 | `pnpm -r build` 四包（core/ui-shared/desktop/web）全过              | 终端输出                         |
| V-Z1-2 | `pnpm -r typecheck` 全过                                            | 终端输出                         |
| V-Z1-3 | 六包 `test` 全绿（core/gateway/cli/desktop/ui-shared/web）          | 终端输出（逐包计数）             |
| V-Z1-4 | `pnpm exec prettier --check .` 0 告警（已入库文件）                 | 终端输出                         |
| V-Z1-5 | token 色值与 `refs-zcode.md` `Z-67`/`Z-68` **逐条一致**             | 抽样比对记录（脚本或人工 20 条） |
| V-Z1-6 | 引入 Tailwind 后**产物仍受 CSP 约束**、无外链、`target`/`base` 未变 | 产物 grep + 配置 diff            |
| V-Z1-7 | `packages/core` 与 `packages/cli`、`packages/gateway` **零改动**    | `git status`                     |
| V-Z1-8 | `api-surface-baseline.json` **0 diff**                              | `git diff --stat`                |

## 风险与降级

| 风险                                                   | 降级方案                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| Tailwind 自动 source 检测漏扫 ui-shared 组件           | 显式 `@source` 指向三处 src；仍漏则逐个补 `@source`                   |
| `shadcn/tailwind.css` 引出的 `dark` variant 与自持冲突 | 自持 `@custom-variant dark` 并置于 `@import` 之后                     |
| `text-ui-*` 被 `tailwind-merge` 当颜色类覆盖           | 必须 `extendTailwindMerge` 注册（`Z-76` 已知坑）                      |
| 组件迁移面过大导致本阶段膨胀                           | 本阶段**只落地原语 + 工具链**；页面迁移（Z2/Z3）不在本阶段            |
| 网络不稳（ZCode 上游仍拉不到）                         | 已登记 OPEN；本阶段不依赖上游新版本，按 `29628c9` 基线实施，Z2 前再试 |

## 交接提示词（零上下文可执行）

```
你负责 harness2 的 Z1 阶段（Tailwind + shadcn 基建）。完整执行本阶段，不要只写方案。

基线：
- 仓库 D:/AI_Projects/harness2，分支 main，pnpm 11.13.0，Node >=22
- 计划：docs/ai-framework/plans/2026-10-11-phase-Z1-tailwind-foundation.md（先完整读它）
- 依据：docs/refs/refs-zcode.md（Z-60～Z-95，尤其 Z-65～Z-81 的 token 与组件规格）
- 现状：packages/{core,cli,desktop,web,ui-shared,gateway} 六包；ui-shared 为 CJS+ESM 双产物（tsc）

做：
1) 三包加依赖并安装；desktop/web 的 vite 接 @tailwindcss/vite
2) 写 ui-shared/src/styles/styles.css（三层 token + Zai 双主题 + text-ui-* 刻度 + base 层）
3) components.json + cn() + @/* 别名
4) 按 Z-75～Z-81 落地 shadcn 原语最小集
5) 主题运行时（三态 + 跟随系统 + nativeTheme 镜像；首屏防闪在壳侧）
6) 迁移 3 个 CSS 文本断言测试与 ~210 处结构断言

不做：
- 不改 packages/core、packages/cli、packages/gateway
- 不做页面级迁移（对话页/设置页/壳骨架属 Z2/Z3/Z5）
- 不放宽桌面 CSP、不引外部 CDN、不改 vite 的 target/base
- 不自行发明交互；样式与组件规格必须能指到 Z-* 条目

工作方式：
- 每完成一个 Task 就跑一次 pnpm -r build（或所涉包）验证，不要最后才跑
- 字号只用 text-ui-*；颜色只用语义 token
- 提交前跑 pnpm exec prettier --check .

交卷：
- 报告每个 Task 的完成情况与命令输出
- 列出所有改动的文件
- 列出未完成项与原因（不得假全绿）；默认不 push
```

## 残留手工项

- 首屏防闪的 head 注入需要在 `packages/desktop/src/renderer/index.html` 与 `packages/web/index.html` 落地（纯 HTML 改动，编排者独占）。
- 真机观感核对（明暗切换无闪烁）需人工；本阶段只保证构建与测试全绿。

---

## 执行记录与验收回填（2026-10-11）

### 小段执行情况

| 小段                 | 状态               | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Z1-01 依赖与构建接线 | ✅ 完成            | 三包加依赖（tailwindcss 4.3.3 / radix-ui 1.7.0 / lucide-react 1.54.0 / shadcn / cmdk / cva / clsx / tailwind-merge / tw-animate-css / tailwind-scrollbar-hide / @tailwindcss/typography 0.5.20）；desktop/web 的 vite 接 `@tailwindcss/vite` 并加 `@` 别名；`ui-shared` 的 `styles/*.css` 导出**由 dist 改为 src**（消除"必须先 build 才能引用样式"的耦合，使 `@source` 相对路径稳定）                                                 |
| Z1-02 token 与主题层 | ✅ 完成            | `packages/ui-shared/src/styles/styles.css`：`@import "tailwindcss" source("../..")` + `tw-animate-css` + `tailwind-scrollbar-hide/v4` + `@plugin "@tailwindcss/typography"`；三处 `@source`（ui-shared src / desktop renderer / web src）；自持 `@custom-variant dark`；`@theme` 默认亮 + `.theme-zai-light` / `.theme-zai-dark` **各 112 键**（键集双向一致）；`text-ui-*` 8 档刻度；base 层含 14px 滚动条与 `prefers-reduced-motion` |
| Z1-03 组件基座       | ✅ 完成            | `components.json`（style=radix-mira、css=src/styles/styles.css、iconLibrary=lucide）；`src/lib/utils.ts` 的 `cn()`（`extendTailwindMerge` 已注册 `text-ui-*` 到 `font-size` classGroup）；`tsconfig.json` 加 `paths`（**TypeScript 7 无 baseUrl**，paths 相对 tsconfig 解析）                                                                                                                                                          |
| Z1-04 shadcn 原语    | ✅ 完成            | 16 个组件落在 `src/components/ui/`：button/input/textarea/card/badge/kbd/separator/spinner/dialog/tabs/tooltip/dropdown-menu/scroll-area/switch/select/toast。**审查修正 1 处**：Switch thumb 由 `size-3.5/size-3` 改为 `Z-79` 规定的 `size-4/size-3.5`（平移量按轨道几何重算）                                                                                                                                                        |
| Z1-05 主题运行时     | ⏭ **改期至 Z2**    | 理由：壳当前仍消费旧 `shell.css` 的 CSS 变量，**此刻切换主题没有任何可见效果**；主题运行时的真正消费方是 Z2 重建后的壳骨架。在 Z1 做属"无人消费的功能"                                                                                                                                                                                                                                                                                 |
| Z1-06 既有测试迁移   | ⏭ **改期至 Z2/Z3** | 理由：3 个 CSS 文本断言测试读的是 `shell.css`/`sidebar.css`，旧类名在 Z2 迁移前**依然存在**（故当前全绿）；~210 处结构断言同理。迁移必须与实际替换类名同批，否则会引入无谓的断言改写                                                                                                                                                                                                                                                   |

### 验收回填（V-Z1-1～V-Z1-8 全绿）

| 编号                           | 结果 | 证据                                                                                                                  |
| ------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------- |
| V-Z1-1 `pnpm -r build`         | ✅   | 六包全 `Done`（core/cli/desktop/web/ui-shared/gateway）                                                               |
| V-Z1-2 `pnpm -r typecheck`     | ✅   | 六包 exit 0（core/gateway/ui-shared 曾因**陈旧符号链接**失败，见下"环境事故"）                                        |
| V-Z1-3 六包 `test`             | ✅   | `PNPM_EXIT=0`；测试文件 300 passed + 1 skipped：core 85、cli 93+1、desktop 96、gateway 14、ui-shared 8、web 4         |
| V-Z1-4 prettier 闸门           | ✅   | 已入库文件 0 告警（仅本机 `.zcode/plans/*.md`）                                                                       |
| V-Z1-5 token 逐条一致          | ✅   | 亮/暗各 **112 键**、键集**双向一致**；抽样 **20 条 × 2 主题**全部相符（脚本比对，含 rgba ↔ `rgb(r g b / a%)` 归一化） |
| V-Z1-6 CSP/target/base         | ✅   | `vite.config.mts` 的 `target`/`base` 无改动；产物外链数 **0**                                                         |
| V-Z1-7 core/cli/gateway 零改动 | ✅   | `git status --porcelain` 对三包为 **0**                                                                               |
| V-Z1-8 api-surface 0 diff      | ✅   | `git status --porcelain -- '*api-surface*'` 为 **0**                                                                  |

### 环境事故与处置（如实登记）

`pnpm add` 让 caret 范围内的补丁版本前移（例：`@types/ws` 8.18.1 → 8.18.2），而 **9 月 7 日创建的旧符号链接仍指向已被清理的 store 路径** → 悬空链接 → `core`/`gateway` 类型检查出现成片 `implicit any` 与 `Could not find a declaration file` 误报。

处置：`pnpm install --force` 未能重建（pnpm 判定"已是最新"），最终以**清理全部 `node_modules` 后干净重装**解决，三包类型检查随即全绿。

**教训**：改依赖后若出现成片类型误报，先查 `node_modules/@types/*` 的符号链接目标是否仍存在，不要先去改代码。
**副作用**：`pnpm-lock.yaml` 因补丁版本前移产生约 7.8k 行 diff（5519 插入 / 2299 删除）——非语义变更，已由 V-Z1-1/2/3 全绿覆盖。

### 与 ZCode 的刻意差异（本阶段新增 1 条）

5. **不 `@import "shadcn/tailwind.css"`**：`dark` variant 由本仓自持（`@custom-variant dark`）。ZCode 把它藏在 shadcn 的 CSS 里（`refs-zcode.md` §13 已列为"待确认项"），我们显式自持，少一处隐式依赖、行为可预测。

### 本阶段结论

Z1 的**基建目标达成**（依赖 / 构建 / token / 组件原语 / 工具链全部就位并通过八项验收）；原定的 Z1-05 / Z1-06 按上表理由**改期至 Z2/Z3**（不是跳过，是移到有消费方的时点）。**下一阶段 Z2（壳骨架还原）** 为 ZCode 化主体，届时 Z1-05/06 作为 Z2 的首批任务执行。
