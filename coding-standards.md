# harness2 编码规范

> 本文件为**通用工程约定**，适用于任意语言/技术栈。各语言/框架的**项目专属约定**（如前端组件命名、后端分层规则、特定 Lint 配置）请在「项目专属约定」一章补充，由项目自行维护。

## 核心原则

- **可读性优先**：代码是写给后来者（包括未来的自己）读的。
- **职责单一**：一个函数/类/模块只做一件事；过大时拆解。
- **一致优先**：以项目现有代码的主流写法为主；有约定先遵守约定。
- **最小修改**：改动只动必要部分，不做顺手重构，避免放大 diff。

## 命名规范

- 文件、类、函数、变量的命名必须**表达意图**，避免 `tmp`、`data`、`obj` 这类无意义命名。
- 遵循项目所在**语言/社区的通行命名风格**，并以项目现有代码为准。
- 缩写仅在项目内通用时使用；跨模块命名保持一致。

## 代码结构与组织

- 按**功能/模块**组织文件，而非按文件类型堆叠。
- 单个文件/函数保持合理长度，超出阈值就拆分。
- 公共逻辑抽取复用，避免复制粘贴（DRY）。

## 代码风格

- **格式化交给工具**：优先使用项目配置的 formatter（如 prettier/black/gofmt）与 linter，不靠人工对齐。
- 避免无意义的冗余；注释表达「为什么」而不是「做了什么」。
- 魔法数字/字符串抽成命名常量。

## 错误处理

- 明确错误边界在哪里；不要用空 `catch`/`except` 吞掉异常。
- 关键路径的错误必须记录日志并给出可读提示。
- 对外部输入（用户输入、API 返回值、文件内容）做校验与兜底。

## 安全

- **密钥、token、密码、凭证绝不进 git**；使用环境变量/密钥管理。
- 不硬编码密钥与真实地址。
- 对敏感操作（push 远程、删除、改动生产）需人类明确授权。

## Git 提交规范

> 下列为默认约定，仅供**无既有约定**时使用；若项目已有自己的提交规范，以项目现有规范为准（可直接覆写本节）。

### 格式

```
<gitmoji><type>(<scope>): <中文描述>
```

### type 与 gitmoji

| type     | gitmoji | 说明                   |
| -------- | ------- | ---------------------- |
| feat     | ✨      | 新功能                 |
| fix      | 🐛      | 修复 bug               |
| docs     | 📝      | 文档更新               |
| style    | 🎨      | 代码格式（不影响功能） |
| refactor | ♻️      | 重构（非修复或新增）   |
| test     | ✅      | 添加或修改测试         |
| chore    | 🔧      | 构建/工具变动          |
| perf     | ⚡      | 性能优化               |
| ci       | 🐳      | CI/CD 配置             |
| revert   | ⏪      | 回滚                   |

### 规则

- 描述使用**中文**，祈使语气，首字母不大写，结尾不加句号
- 首行尽量不超过 50 字符
- 正文每行不超过 72 字符

## 模块/组件开发约定

- 公共可复用模块放入统一目录（如 `src/components/`、`lib/`、`common/`），保持职责单一。
- 对外接口支持统一的输入/输出约定，必要时提供默认值。
- 样式若使用 CSS 变量，统一使用 `--app-*` 前缀（适配主题/暗色切换）。

## 项目专属约定

> 本节为**本仓库（harness2）实际配置**，2026-09-09 按阶段 15 B2 落地配置填实（`eslint.config.js` / `.prettierrc` / `.prettierignore` / 根与各包 `package.json`）。**所写命令均已在本机实测可用**（Node v22.23.2 / pnpm 11.13.0 / Windows）。写进文档的命令一律以实测为准，不照搬计划书中的占位名（如 cli 包名是 `harness2` 而非 `@harness2/cli`，见下）。

### 技术栈

- 语言/框架：**TypeScript**（ESM；各包 `"type": "module"`，desktop 主进程为 CommonJS）+ **Node.js >= 22**（根与各包 `engines`）；React 19（desktop renderer 与 cli ink TUI）；Electron 44（desktop）
- 仓库形态：**pnpm workspace monorepo**（`pnpm-workspace.yaml` 声明 `packages/*`；workspace 协议 `workspace:*` / `workspace:^`，禁止混用 npm/yarn）
- 构建/运行命令：
  - `pnpm build` —— 全仓构建（=`pnpm -r build`：各包 `tsc -p tsconfig.build.json`；desktop 额外 `vite build`）
  - `pnpm --filter @harness2/desktop dev` / `smoke` —— 桌面端开发 / 冒烟（Electron 窗口）
  - `node packages/cli/dist/index.js chat --provider mock` —— 本地零 key 冒烟
  - `pnpm --filter harness2 bundle` —— CLI 发布 bundle（esbuild 产出 `dist-bundle/harness2-cli.cjs`）
- 包管理器：**pnpm 11.13.0**（根 `package.json` `packageManager` 字段锁定）
- 测试命令/工具：**vitest**（各包 `test` script = `vitest run`；根 `pnpm test` = 先 `pnpm -r build` 再 `pnpm -r test`，零 API key、mock provider）：
  - `pnpm test` —— 全仓 build + 全量测试
  - `pnpm -r test` —— 全仓测试（跳过 build）
  - `pnpm --filter @harness2/core test` —— core 单包测试
  - `pnpm --filter harness2 test` —— **cli 单包测试（包名为 `harness2`；`--filter @harness2/cli` 匹配不到任何包，实测报 `No projects matched the filters`，勿用）**
  - `pnpm --filter @harness2/desktop test` / `pnpm --filter @harness2/gateway test` —— desktop / gateway 单包测试
  - 备注：cli 的 spawn 型用例（crash-drill / export / memory 等）默认 5s 超时，全量并行跑时偶发超时（阶段 15 acceptance B-6 已登记既有 flaky，非回归）；稳定复跑用 `pnpm --filter harness2 exec vitest run --testTimeout=20000`（实测 17 files / 71 passed）

### 分层结构（packages/{core,cli,desktop,gateway}）

- **packages/core**（npm `@harness2/core`，会话内核）：`server/`（HTTP+WS 服务端装配与 `sessions-*.ts` 会话 hub/恢复/任务协调）、`interaction/`（**公共契约**：`runtime-journal` 事件溯源日志、`retry-policy` 有界重试、`approval-queue`、`run-config`、`steer-sink` 等，冻结改动需同步 parser/projector/export/replay/fixture）、`agent/`（loop / compaction / subagent）、`tools/`（工具系统 + `predefined/`）、`provider/`（openai / anthropic / factory）、`plugins/`、`mcp/`、`memory/`、`skills/`、`session/`、`trajectory/`、`config/`、`doctor/`。**导出面由 `packages/core/test/fixtures/api-surface-baseline.json` 快照锁定**——改 `core/src/index.ts` 导出必须在同一提交同步快照：`H2_UPDATE_API_SNAPSHOT=1 pnpm --filter @harness2/core exec vitest run test/api-surface.test.ts`
- **packages/cli**（npm `harness2`）：`index.ts` 只做**命令注册**（program 装配 + parseAsync），各子命令拆在 **`commands/` 模块**（traj / export-replay / config / doctor / chat / memory / skill / serve / browser / cron / plugin / mcp / gateway）；TUI 组件在 `tui/`（ink）
- **packages/desktop**（npm `@harness2/desktop`，Electron）：`main/`（主进程：spawn 本地 serve + 窗口）、`preload/`、`renderer/`（**React 视图，组件在 `renderer/components/`**：ChatView / SessionList / PaneArea / SettingsDialog / CommandPalette 等；渲染进程零 Node）、`shared/`
- **packages/gateway**（npm `@harness2/gateway`，IM 网关）：QQ / 飞书消息桥接到本地 serve，`platforms/`

### 前端约定（desktop renderer / cli TUI）

- 组件命名：**PascalCase 文件 + 默认导出**（`ChatView.tsx`、`SessionList.tsx`）
- 状态管理：renderer `store.ts` / `app-controller.ts` 收口；渲染进程只经 HTTP/WS 与 serve 通信，不直接 import `@harness2/core`
- 样式作用域 / 主题变量：`renderer/styles.css` + `theme.ts`，CSS 变量统一 `--app-*` 前缀（适配暗色切换）；不引 UI 框架
- 路由 / 目录结构：无路由；`renderer/`（视图）+ `renderer/components/`（组件）按职责分文件

### 后端约定（core server / 服务端）

- 分层结构：`server/`（HTTP+WS 装配）→ `session/` + `interaction/`（事件溯源内核与契约）→ `agent/`（loop 控制流）→ `tools/`（执行器）
- 事件契约：永久会话事件 **append-only + 同会话单写者**；`interaction/` 契约（submit / resumeSubscription / approval / cancel / task / steer，`protocolVersion=2`，`runtime.v1.jsonl`）冻结
- 异常/错误定义：关键路径记日志 + 可读提示；工具参数缺失时 error 带 schema 片段与最小调用示例（`tools/executor.ts`）
- 密钥处理：API key 只存 `~/.harness2/auth.json` 与环境变量；config / 日志 / 错误消息出口统一脱敏，`config check` 永不打印明文

### 其他

- Lint/格式化工具与配置：**ESLint flat config**（`eslint.config.js`：首轮只把明显错误——未使用变量 / `any` 泄漏 / floating promise——设 error，其余推荐规则降 warn；测试文件 `no-explicit-any` 放宽为 warn）+ **Prettier**（`.prettierrc`：printWidth 120 / singleQuote / trailingComma all / endOfLine lf；`.prettierignore` 排除 `packages/core/test/fixtures/**` 与 `packages/core/fixtures/**`（api-surface 基线快照）、`dist*`、`release/`、`coverage/`、`docs/issue-log/` 等）：
  - `pnpm lint` —— = `eslint . && prettier --check .`，实测 exit 0（0 error，warn 为存量降级告警）
  - `pnpm lint:fix` —— = `eslint . --fix && prettier --write .`
  - `pnpm format` —— = `prettier --write .`
  - 提交不夹带格式噪音；全量格式化独占 `🎨style` 提交（阶段 15 B2 口径）
- 类型检查：`pnpm -r typecheck`（各包 `tsc -p tsconfig.json --noEmit`，实测 4 包全过 exit 0）
- 特殊工具链 / 版本要求：Node >= 22；pnpm 11.13.0；TypeScript 随包（core/cli/desktop `^7.0.2`、gateway `^5.9.0`、根工具链 `~5.9.3`）；vitest core/cli/desktop `^5.0.0`、gateway `^3.2.0`；`.gitattributes` 统一 LF（`* text=auto eol=lf`）
