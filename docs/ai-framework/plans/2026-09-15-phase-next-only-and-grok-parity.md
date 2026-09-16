# 阶段 P10：next 单轨化清场 + 与 grok 的终端逐场景抓屏对照

> **状态：** ✅ 已完成（2026-09-15，本地分支 `feat/phase-p10-next-only`，未合 main；段 C 的对照报告见 `docs/tui-parity/`）
> **For agentic workers:** 按 Task 顺序执行；每 Task 验证通过再进下一 Task，每 Task 一次 commit。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** ① 彻底删除 CLI 旧终端渲染路径（下文称「旧壳」，库名 `ink`），做到**代码 / 测试 / 依赖 / 现行文档零残留**；② 建立可复跑的「双 TUI 抓屏对照台」，产出 next 壳 与 grok 的逐场景差异报告与改进清单。

**Architecture:** CLI 收敛为两条路径——**next TUI**（TTY，唯一交互壳）与 **piped readline**（非 TTY/CI 回退，保留）；对照台用 ConPTY 驱动两个 TUI 的**同一个剧本**，抓「屏幕网格」渲染成 PNG，供主模型读图对比。

**Tech Stack:** TypeScript / Node ≥22 / pnpm；对照台 Python 3.12 + pywinpty + pyte + Pillow（隔离 venv，**不进 packages/ 依赖**）

**实施档位：** 全能（默认） · **子代理：** 启用

---

## 前置阅读（必须）

| 优先级 | 文件                                                 |
| ------ | ---------------------------------------------------- |
| P0     | `docs/ai-framework/phased-plan-driven.md`            |
| P0     | 本文件                                               |
| P0     | `docs/HANDOFF.md`、`docs/issue-log/OPEN.md`          |
| P1     | `AGENTS.md`、`CODE_REVIEW.md`、`coding-standards.md` |

**仓库路径：** `D:/AI_Projects/harness2`
**基线分支：** 从 `main`（`83f2e9b`）拉 `feat/phase-p10-next-only`

---

## Global Constraints（冲突时以本节为准）

1. **冻结区**：不得改 `packages/core` / `packages/gateway` 的**任何行为**。core 仅授权 **两处注释去痕**（`src/commands/types.ts`、`src/session/capabilities.ts`），**导出面基线必须零变化**（`packages/core/test/fixtures/api-surface-baseline.json` diff = 0 行）。
2. **误伤红线**：`packages/ui-shared/src/styles/*.css` 里的 `--ink` 是**配色 token（颜色名 ink = 墨色）**，与旧壳库无关，**禁止改动**。同类：任何 `link`/`think`/`blink` 子串。
3. **禁止盲替换**：每一个被删文件必须给出「零引用证明」（`grep -rn` 输出）；禁止 `sed -i` 全仓批量改词。
4. **历史归档保留原文**：`docs/issue-log/*.md`（除 `OPEN.md`）、`docs/diary/*.md`、已完成阶段的 `docs/ai-framework/plans/2026-09-0*` ~ `2026-09-14*`、`docs/research/*`、`spike/` 一律**不改不删**（审计轨迹）。本阶段的「零残留」只约束**代码 / 测试 / 依赖 / 现行入口文档**（README、HANDOFF、SMOKE-TEST、ROADMAP、MASTER-PLAN、refs、coding-standards、CODE_REVIEW、AGENTS.md）。
5. **Git**：小步 commit（`<gitmoji><type>(scope): 中文描述`）；**不 push**；分支合入按项目惯例待 CI 绿后由编排者 `--no-ff` 合入。
6. **YAGNI**：本阶段只做「删旧壳 + 建对照台 + 出报告」。**不重写 next 渲染逻辑**、不改 core 命令注册表、不给 `packages/cli` 增加任何运行时依赖。
7. **对照台产物诚实标注**：PNG 是「ConPTY 抓屏 + 本地重绘」而非系统级窗口截图，报告中必须写明（字体度量与真机存在差异）。

---

## 阶段开头：上阶段遗留（必填小节）

| 上阶段遗留项                                                                        | 来源               | 未通过原因 | 状态                                                                                      |
| ----------------------------------------------------------------------------------- | ------------------ | ---------- | ----------------------------------------------------------------------------------------- |
| 「终端 grok 复刻 P0～P4 真机验收」+「P2 双渲染模式真机验收（`HARNESS2_RENDERER`）」 | OPEN.md 2026-09-13 | 需真机     | 🔄 本阶段**改变形态**：双渲染不复存在，该两项合并为「next 壳真机验收」，A8 后更新 OPEN.md |

其余 OPEN.md 未关闭项（真机/key/发布动作/技术尾巴）与本阶段无交集，不动。

---

## 跳过项（因档位未做，非缺陷）

| 跳过项                             | 原因                                         | 待补做            |
| ---------------------------------- | -------------------------------------------- | ----------------- |
| 真机（Windows Terminal）观感与 IME | ConPTY 抓屏无法覆盖鼠标/IME/系统字体度量     | ⬜ 待用户真机一轮 |
| 旧壳测试断言的**全量**迁移         | 删旧壳后部分断言已无对应实现，只保留迁移评估 | ⬜ 见 A4 缺口清单 |

---

## 与前后阶段

| 阶段           | 状态 | 交付                                                     |
| -------------- | ---- | -------------------------------------------------------- |
| P9 收口        | ✅   | 归存补齐 / 上层文档 / 冒烟用例（`83f2e9b`）              |
| **本阶段 P10** | ⬜   | 旧壳零残留 + 双 TUI 抓屏对照台 + 差异报告与改进清单      |
| 下阶段         |      | 按 C4 产出的改进清单另立计划（本阶段不顺手改 next 功能） |

---

## File Structure（预期变更）

| 文件 / 目录                                                                  | 动作  | 职责                                           |
| ---------------------------------------------------------------------------- | ----- | ---------------------------------------------- |
| `packages/cli/src/tui/*.tsx`（14 个，见 A1 清单）                            | 删    | 旧壳 React 组件                                |
| `packages/cli/src/tui/panels/*.tsx`（3 个）                                  | 删    | 旧壳面板                                       |
| `packages/cli/src/tui/runInkChat.tsx`                                        | 删    | 旧壳入口 + `shouldUseInk` 门控（门控迁往 A3）  |
| `packages/cli/test/tui/**`（7 个含旧壳依赖的文件，见 A1）                    | 删/迁 | 旧壳测试                                       |
| `packages/cli/src/chat.ts`、`index.ts`、`tui/terminal-capabilities.ts`       | 改    | 装配收敛为「next / piped」二选一；门控函数改名 |
| `packages/cli/src/tui/ink-commands.ts`                                       | 改名  | → `tui/command-impls.ts`（内容零改动）         |
| `packages/cli/package.json` + `pnpm-lock.yaml`                               | 改    | 移除 `ink` / `react` / `@types/react`          |
| `packages/core/src/commands/types.ts`、`src/session/capabilities.ts`         | 改    | 仅注释去痕（导出面零变化）                     |
| 现行文档（README / HANDOFF / SMOKE-TEST / ROADMAP / MASTER-PLAN / refs / …） | 改    | 去痕 + 更新「单轨」事实                        |
| `scripts/tui-parity/`                                                        | 新建  | 抓屏对照台（ptycap.py + scenarios/ + README）  |
| `docs/tui-parity/`                                                           | 新建  | 对照报告（README + matrix.md + images/）       |

---

## Task A1：零引用盘点（只读，产出删除/保留清单）

**Files:** 产物写入本计划附录「A1 盘点结果」节。

**Steps:**

1. 列出旧壳真实依赖集：
   `grep -rln "from 'ink'\|from \"ink\"" packages/cli/src packages/cli/test`
2. 列出 next 壳从父目录引用的**共享件**（必须保留）：
   `grep -rhoE "from '\.\./[^']*'" packages/cli/src/tui/next | sort -u`
3. 逐个判定 `packages/cli/src/tui/` 下每个文件：**删 / 留 / 改**，留改的必须给出「被谁引用」证据。
4. 反向校验：`grep -rn "<待删文件>" packages/cli/src packages/cli/test` 必须为空才允许删。
5. 产出「删除清单 / 保留清单 / 门控与命名去痕清单」三张表写入附录。
6. Commit：`📝docs(cli): P10-A1 旧壳零引用盘点`

**期望：** 清单与证据齐全，可据此逐条删除。

---

## Task A2：删除旧壳渲染路径

**Files:** A1 清单中的「删除」项。

**行为:** 删除后 `packages/cli/src/tui/` 只保留 next 壳与其共享件。

**Steps:**

1. 逐文件 `git rm`（不批量 `rm -rf` 目录，避免误删共享件）。
2. 跑：`pnpm --filter harness2 typecheck`  
   期望：**预期报错**——`chat.ts` 仍引用已删模块；把报错清单记录下来作为 A3 的输入。
3. Commit：`♻️refactor(cli): P10-A2 删除旧终端渲染路径`

---

## Task A3：装配层收敛（只剩 next 与 piped 两条路）

**Files:** `src/chat.ts`、`src/index.ts`、`src/tui/terminal-capabilities.ts`（如需）

**行为:**

- `chat.ts`：TTY → next 壳；非 TTY → piped readline。删除 `runInkChat` 分支。
- 门控函数 `shouldUseInk` → `shouldUseTui`（语义不变：`HARNESS2_NO_TUI=1` / `--no-tui` / `HARNESS2_TUI=1` / 非 TTY 四场景）。
- `decideTuiMode()` 的返回值 `'ink'` → `'tui'`（同步全部引用点）。
- **删除 `HARNESS2_RENDERER` 开关**（next 已是唯一渲染器，开关无意义）。

**Steps:**

1. 改装配与门控。
2. 跑：`pnpm --filter harness2 typecheck` 期望 0 error。
3. 跑：`node packages/cli/dist/index.js chat --provider mock`（TTY）与 `printf 'hi\n/exit\n' | node … chat --provider mock`（piped）
   期望：前者进 next 壳、后者走 readline 文本输出，均无 `ink` 报错。
4. Commit：`♻️refactor(cli): P10-A3 终端装配收敛为 next/piped 双路`

---

## Task A4：测试清理与覆盖迁移评估（**不得静默丢覆盖**）

**Files:** 旧壳测试文件、`packages/cli/test/tui/next/**`

**Steps:**

1. 删除仅覆盖旧壳的测试。
2. 对**每个被删测试文件**逐条登记其断言，产出「覆盖迁移评估表」（写入附录），三分类：
   - ✅ next 侧等价测试（给出文件:行）
   - ➖ 已过时（对应功能/交互已不存在，说明理由）
   - ⚠️ **缺口**（next 侧无等价覆盖）→ 列入 C4 改进清单，**本阶段不补**（避免顺手改功能）
3. 跑：`pnpm --filter harness2 test`  
   期望：全绿；**用例数变化必须与评估表可对账**（删了多少、迁移了多少）。
4. Commit：`✅test(cli): P10-A4 清理旧壳测试并登记覆盖迁移评估`

---

## Task A5：依赖清理

**Steps:**

1. 从 `packages/cli/package.json` 移除 `ink`、`react`、`@types/react`（三者已无引用；`react` 在 `desktop`/`ui-shared` 仍保留，不受影响）。
2. `tsconfig.build.json` / `vitest.config` 若只为 `.tsx` 而设的开关，按需清理；确认 `packages/cli/src` 已无 `.tsx`。
3. 跑：`pnpm install` → `pnpm --filter harness2 build` → `pnpm --filter harness2 test`
   期望：全绿；`pnpm-lock.yaml` 仅删减相关条目。
4. 跑：`grep -rn "ink\|react" packages/cli/package.json` 期望无命中。
5. Commit：`🔧chore(cli): P10-A5 移除旧壳运行时依赖`

---

## Task A6：去痕命名与注释清理

**Files:** `src/tui/ink-commands.ts` → `src/tui/command-impls.ts`、next 壳与共享件中提及旧壳的注释

**Steps:**

1. `git mv src/tui/ink-commands.ts src/tui/command-impls.ts`，更新引用点，**内容逻辑零改动**。
2. 清理注释中的旧壳措辞（`packages/cli/src/tui/next/**` 等处），改为中性表述（如「旧壳」→ 删除、或写「参考实现」并指向本阶段计划）。**不删历史决策信息**：涉及「为什么这么设计」的说明保留，只去掉库名/旧壳名。
3. 跑：`pnpm --filter harness2 typecheck && pnpm --filter harness2 test` 期望全绿。
4. Commit：`🎨style(cli): P10-A6 去痕命名与注释清理`

---

## Task A7：现行文档清场

**Files:** `README.md`、`docs/HANDOFF.md`、`docs/SMOKE-TEST.md`、`docs/ROADMAP.md`、`docs/MASTER-PLAN.md`、`docs/refs/refs-grok-build.md`、`docs/refs/refs-hermes-agent.md`、`coding-standards.md`、`CODE_REVIEW.md`、`packages/core/src/**`（仅两处注释）

**Steps:**

1. 按 Global Constraints 4 划定范围，逐个文件清理旧壳措辞，并同步「**CLI 只有一个 TUI**」这一新事实（README 的渲染模式说明、SMOKE-TEST 的 F 节入口、HANDOFF 状态表）。
2. core 两处注释去痕（**导出面零变化**），跑 `pnpm -r build && pnpm --filter @harness2/core test`，并断言 `git diff --stat packages/core/test/fixtures/api-surface-baseline.json` 为空。
3. 跑：`npx prettier --write <改动文件>`；`pnpm lint` 期望 0 error。
4. Commit：`📝docs: P10-A7 现行文档清场（单 TUI 事实同步）`

---

## Task A8：零残留验证 + OPEN.md 同步

**Steps:**

1. 零残留证明（**白名单外的命中必须为 0**）：
   ```bash
   grep -rniE "\bink\b|ink-|from 'ink'|runInkChat|shouldUseInk|HARNESS2_RENDERER" \
     packages/cli/src packages/cli/test packages/cli/package.json \
     README.md docs/HANDOFF.md docs/SMOKE-TEST.md docs/ROADMAP.md docs/MASTER-PLAN.md \
     docs/refs coding-standards.md CODE_REVIEW.md AGENTS.md
   ```
   白名单（允许保留）：无（若确有必要，逐条写入计划并由编排者批准）。
2. 全量闸门：`pnpm -r build` + `pnpm test` + `pnpm -r typecheck` + `pnpm lint` 全绿。
3. 冒烟：`node packages/cli/dist/index.js chat --provider mock` 走一遍 `/help` → 一轮对话 → `/undo` → `/exit`。
4. 更新 `docs/issue-log/OPEN.md`：合并 2026-09-13 两条「双渲染真机」项为「next 壳真机验收」；登记 C4 改进清单。
5. Commit：`✅test(cli): P10-A8 零残留验证与 OPEN 同步`

---

## Task B1：抓屏对照台落地 `scripts/tui-parity/`

**Files:** `scripts/tui-parity/ptycap.py`、`scripts/tui-parity/capture.mjs`（可选）、`scripts/tui-parity/README.md`、`.gitignore`（若需）

**行为:** 把本阶段已跑通的原型（`.tmp-cap/ptycap.py`，**编排者原型，已实证可用**）硬化为可复跑工具。

**Steps:**

1. 迁入原型并硬化：
   - **等待屏幕稳定**（轮询屏幕哈希不变 N 次）替代固定 `sleep`，降低 flaky；
   - 每次抓屏同时产出 `.png` + `.txt`（屏幕网格纯文本）+ 结构化 `log.json`；
   - 固定画布（默认 110×30，可配 160×40）与 CJK 字体回退（已修，勿回退）；
   - 超时/子进程强杀；退出码语义：0 成功。
2. 写 `README.md`：依赖安装（venv + pywinpty/pyte/Pillow）、用法、**诚实边界**（抓屏重绘非系统截图）。
3. 冒烟：对 `harness2 chat --provider mock` 抓一张，人眼确认中文与边框正常。
4. Commit：`🔧chore(scripts): P10-B1 落地 TUI 抓屏对照台`

---

## Task B2：场景矩阵定义

**Files:** `scripts/tui-parity/scenarios/*.json`

**行为:** 每个场景 = 双方各自的启动命令 + **同一份按键剧本** + 截图点 + 看点。

**场景组（至少覆盖）：**

| 组       | 场景                                       |
| -------- | ------------------------------------------ |
| A 启动   | 冷启动 / 恢复上次会话 / 空目录 vs git 仓库 |
| B 对话   | 流式中截图 / 完成后 / 长回答 / 代码块      |
| C 命令   | 敲 `/` 出候选列表 / `/help` / 未知命令     |
| D 工具   | 读文件 / 写文件 / 跑命令（卡片形态与折叠） |
| E 审批   | ask 弹窗 / 允许 / 拒绝 / 总是允许          |
| F 子任务 | 派发子代理 → 运行中 → 完成 → 查看子会话    |
| G 状态行 | 模型名 / 模式 / ctx% / token 用量 / 耗时   |
| H 打断   | 回合中 Esc / Ctrl+C / 双击                 |
| I 撤销   | `/undo` `/redo` / 分叉                     |
| J 队列   | 忙碌时回车排队 / steer                     |
| K 外观   | fullscreen vs minimal / 110 列 vs 160 列   |
| L 失败   | 模型报错 / 工具失败                        |

**Steps:**

1. 场景 JSON 就位；我方用 `--provider mock`（零成本可复现），grok 侧用最小真 prompt（**消耗额度，逐场景登记**）。
2. Commit：`🔧chore(scripts): P10-B2 定义双 TUI 对照场景矩阵`

---

## Task C1～C4：批量抓屏 → 差异报告 → 改进清单（编排者主导）

1. **C1** 批量跑全部场景，产物落 `docs/tui-parity/images/<组>/<场景>-<方>.png`。
2. **C2** 编排者逐项读图（主模型已实证具备视觉能力，见 2026-09-15 日志第 1 条），写差异结论。
3. **C3** 产出 `docs/tui-parity/README.md`（方法与边界）+ `matrix.md`（逐项：场景 / 我方图 / grok 图 / 差异 / 严重度 P0-P2 / 改进建议 / 状态），提交。
4. **C4** P0/P1 差异写入 `docs/issue-log/OPEN.md`，并起草下一阶段计划骨架。

---

## 代码审查（阶段级环节，验收前）

**审查方：** 独立只读子代理（非本阶段实现者）

| 审查项         | 结论 | 问题清单                                      |
| -------------- | ---- | --------------------------------------------- |
| 删除完整性     |      | 有无孤儿文件/死代码残留、有无被删断言未登记   |
| 覆盖迁移评估   |      | 评估表是否逐条可核（不得「静默丢覆盖」）      |
| 依赖与架构红线 |      | cli 依赖是否真的清了、core/gateway 是否越界   |
| 误伤检查       |      | `--ink` CSS token 是否被误改、link/think 误伤 |
| 文档一致性     |      | 单 TUI 事实是否同步、有无自相矛盾             |
| 零残留         |      | A8 白名单外命中是否为 0                       |

**结论：** ✅ 通过 / ⚠️ 有条件通过（问题进验收表）/ ❌ 不通过（阻塞合入）

---

## 验收标准总表

| #   | 标准           | 通过条件                                                                 | 验证责任人 |
| --- | -------------- | ------------------------------------------------------------------------ | ---------- |
| 1   | 旧壳代码零残留 | A8 grep 白名单外命中 0                                                   | 自动化     |
| 2   | 依赖清理       | `packages/cli/package.json` 无 `ink`/`react`/`@types/react`              | 自动化     |
| 3   | 覆盖不静默丢失 | 覆盖迁移评估表逐条可核，⚠️ 缺口已登记                                    | 独立审查   |
| 4   | 冻结区未越界   | core 仅两处注释改动；`api-surface-baseline.json` diff = 0 行             | 自动化     |
| 5   | 误伤零发生     | `--ink` CSS token 原样；无 link/think 误改                               | 独立审查   |
| 6   | 全量闸门       | `pnpm -r build` + `pnpm test` + `pnpm -r typecheck` + `pnpm lint` exit 0 | 自动化     |
| 7   | 冒烟           | next 壳 `/help` → 对话 → `/undo` → `/exit` 正常；piped 模式文本输出正常  | 编排者     |
| 8   | 对照台可用     | `scripts/tui-parity` 单场景冒烟出图（中文/边框无误）                     | 编排者     |
| 9   | 对照报告       | `docs/tui-parity/matrix.md` 覆盖 12 组场景，逐项有差异结论与改进建议     | 编排者     |
| 10  | 文档同步       | OPEN.md 双渲染项已合并；HANDOFF/README/SMOKE 表述与单 TUI 一致           | 编排者     |
| 11  | 真机项         | 人眼确认鼠标/IME/真机观感（**本阶段不做**，留手工清单）                  | 用户       |

---

## 风险与降级

| 风险                                        | 缓解                                                       |
| ------------------------------------------- | ---------------------------------------------------------- |
| 删除时误伤共享件（next 依赖父目录多个模块） | A1 反向依赖证明 + 逐文件 `git rm` + typecheck 报错清单驱动 |
| 删测试导致覆盖静默下降                      | A4 强制「覆盖迁移评估表」，⚠️ 缺口登记为下阶段改进项       |
| core 冻结区被误改                           | 仅授权两处注释；用导出面基线 diff 断言                     |
| `--ink` CSS token 被全局替换误伤            | 明确红线 + 独立审查专项 + 禁止 `sed` 批量替换              |
| grok 侧对照消耗额度 / 时序 flaky            | 我方 mock 零成本；grok 用最小 prompt；抓屏改「等屏幕稳定」 |
| ConPTY 抓屏与真机观感有差异                 | 报告首页如实声明；真机项留在手工清单                       |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给执行 AI 即可开工：

---

你是负责 **harness2** 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线

- 目录：`D:/AI_Projects/harness2`
- 从 `main`（`83f2e9b`）创建并切换：`feat/phase-p10-next-only`
- 唯一实施计划：`docs/ai-framework/plans/2026-09-15-phase-next-only-and-grok-parity.md`
- 必读：`docs/ai-framework/phased-plan-driven.md`、`AGENTS.md`、`docs/HANDOFF.md`
- 本阶段要干两件事：**(A) 彻底删除 CLI 旧终端渲染路径（库名 ink），代码/测试/依赖/现行文档零残留**；**(B) 落地 `scripts/tui-parity/` 抓屏对照台 + 定义场景矩阵**。C 段（批量抓屏与差异报告）由编排者负责，你不用做。

### 做（按 Task 顺序）

A1 零引用盘点 → A2 删旧壳代码 → A3 装配收敛（只剩 next / piped 两条路）→ A4 测试清理 + 覆盖迁移评估（**不得静默丢覆盖**）→ A5 依赖清理 → A6 去痕命名与注释清理 → A7 现行文档清场 → A8 零残留验证 + OPEN.md 同步 → B1 抓屏工具硬化（原型在 `.tmp-cap/ptycap.py`，已实证可用，迁入并改「等屏幕稳定」）→ B2 场景矩阵 JSON。

### 铁律（违反即失败）

1. `packages/core` / `packages/gateway` 行为**零改动**；core 只允许 `src/commands/types.ts` 与 `src/session/capabilities.ts` 两处**注释**去痕，导出面基线必须 diff = 0 行。
2. `packages/ui-shared/src/styles/*.css` 里的 `--ink` 是**颜色 token**，禁止改动。
3. **禁止 `sed`/脚本批量替换**；每个删除文件先给零引用证明。
4. `docs/issue-log/*.md`（除 OPEN.md）、`docs/diary/*.md`、`docs/ai-framework/plans/2026-09-0*`～`2026-09-14*`、`docs/research/*`、`spike/` **一律不改不删**（历史审计轨迹）。
5. 不 push；不把密钥写进任何文件。

### 工作方式

1. 先跑基线：`pnpm -r build && pnpm -r --no-bail run test`，确认干净。
2. 严格按 Task 顺序；每个 Task 完成后跑该 Task 的验证命令，**证据优先**（禁止「应该能过」），再 commit（`<gitmoji><type>(scope): 中文描述`）。
3. 用简体中文回复进度；代码标识符保持原样。
4. 卡住时（如需改 core 行为、发现共享件被误判）**停下来报告**，不要自行扩大范围。

### 交卷

给出：分支名、提交列表、每个 Task 的验证命令与输出结论、覆盖迁移评估表、零残留 grep 结果、残留风险。

现在开始：读完本阶段计划，从 Task A1 执行到 B2。

---

## 残留手工验收清单（自动化之外）

1. 真机 Windows Terminal：鼠标拖拽/选择复制、IME 中文输入、alt-screen 进出、粘贴多行。
2. 真机观感：与抓屏重绘图对比字体/间距是否一致。
3. grok 侧对照中涉及真实模型的行为（耗时/用量行）在真机下的稳定性。

---

## 附录：A1 盘点结果（2026-09-15 实施，只读盘点）

> 证据命令（全部在 `D:/AI_Projects/harness2`、分支 `feat/phase-p10-next-only` 上实跑）：
>
> 1. `grep -rln "from 'ink'\|from \"ink\"" packages/cli/src packages/cli/test` → 22 个命中（src 14 / test 8）。
> 2. `grep -rhoE "from '\.\./[^']*'" packages/cli/src/tui/next | sort -u` → 45 条共享件（见「保留清单」）。
> 3. 依赖可达性脚本（自 index.ts / serve-entry.ts / tui/next/next-shell.ts 出发，把旧壳 14 个 tsx 视为已删）
>    → 生产不可达仅 7 个文件，其中 `tui/terminal-capabilities.ts` 属 A3 装配目标（保留），其余 6 个见下。
> 4. 反向校验（逐文件 `grep -rn "<模块名>" packages/cli/src`，排除删除清单内部互引）：14 个旧壳 tsx 全部为 0 命中，
>    仅 `runInkChat.tsx` 有 1 处生产引用（`src/chat.ts:4`）——即 A3 要修的那一处。

**计数勘误：** 计划 File Structure 写「`packages/cli/src/tui/*.tsx`（14 个）」；实测根目录 `.tsx` 为 **11 个**
（含 `runInkChat.tsx`），加 `panels/` 下 3 个 = **14 个**。下文按实测口径。

### 一、删除清单（A2 逐文件 `git rm`）

**A. 旧壳 React/ink 组件（14 个，均直接 `from 'ink'` 或被旧壳树独占）**

| #   | 文件                             | 生产侧引用者                 | 依据                                                          |
| --- | -------------------------------- | ---------------------------- | ------------------------------------------------------------- |
| 1   | `src/tui/runInkChat.tsx`         | `src/chat.ts:4`（A3 收敛点） | 旧壳入口 + `shouldUseInk` 门控 + `HARNESS2_RENDERER` 改道分支 |
| 2   | `src/tui/Composer.tsx`           | runInkChat                   | 旧壳输入框                                                    |
| 3   | `src/tui/ConfirmDialog.tsx`      | runInkChat                   | 旧壳审批卡                                                    |
| 4   | `src/tui/DiffCard.tsx`           | TranscriptView               | 旧壳 diff 卡                                                  |
| 5   | `src/tui/Modal.tsx`              | ConfirmDialog / runInkChat   | 旧壳浮层外框                                                  |
| 6   | `src/tui/OverlayHost.tsx`        | runInkChat                   | 旧壳浮层宿主                                                  |
| 7   | `src/tui/ReasoningBlock.tsx`     | TranscriptView               | 旧壳推理块                                                    |
| 8   | `src/tui/SelectList.tsx`         | runInkChat                   | 旧壳选择列表                                                  |
| 9   | `src/tui/StatusBar.tsx`          | runInkChat                   | 旧壳状态栏                                                    |
| 10  | `src/tui/SubagentView.tsx`       | runInkChat                   | 旧壳子会话浮层                                                |
| 11  | `src/tui/TranscriptView.tsx`     | SubagentView / runInkChat    | 旧壳转录区                                                    |
| 12  | `src/tui/panels/queue-panel.tsx` | runInkChat                   | 旧壳队列面板                                                  |
| 13  | `src/tui/panels/retry-panel.tsx` | runInkChat                   | 旧壳重试面板                                                  |
| 14  | `src/tui/panels/task-panel.tsx`  | runInkChat                   | 旧壳任务面板                                                  |

**B. 旧壳专供的邻接模块（3 个，非 tsx；删掉旧壳后生产零引用，且文件头即 ink 行为契约）**

| #   | 文件                         | 生产侧引用者（全部在删除清单内）    | 旧壳证据                                                                                                                                     |
| --- | ---------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 15  | `src/tui/terminal-events.ts` | `runInkChat.tsx`、`input-bridge.ts` | 文件头：拦截 stdin 再回注给 **ink**（mouse/focus SGR）；ink 之后无消费者                                                                     |
| 16  | `src/tui/input-bridge.ts`    | `terminal-events.ts`                | 文件头：统一解析器 → **ink** stdin 逐字节回注适配层                                                                                          |
| 17  | `src/tui/paste.ts`           | `Composer.tsx`                      | 文件头：**ink 7** `usePaste` 的 CRLF 归一/短长分流内核；next 壳自持 paste 解析（`next-shell.ts` bracketed paste + chat-controller 空闲冲刷） |

> 判定口径：三者均为「为 ink 的 stdin/粘贴语义服务」，next 壳已有自持等价路径（`next/next-shell.ts` 自写 SGR mouse：
> `selectionPointFromMouse`/wheel、`BRACKETED_PASTE_ON` + `chat-controller` 空闲冲刷）。留之即死代码，
> 且其注释是 A8 grep 的 ink 命中源。**如编排者认为应改判为「留 + A6 去痕」，A2 跳过 15～17 即可，其余不受影响。**

**删除清单的测试侧引用（21 个文件，**不在 A1/A2 处理**，交 A4 做覆盖迁移评估）：**
`test/tui-render.test.tsx`、`test/tui/{DialogController,approvals,composer,input-bridge,keyboard,notify-shell,overlay-position,p3f-ink-session-picker,panels,paste-integration,paste,shell-lifecycle,steer-composer,task-panel,terminal-events,tui-gate,tui-subagent,tui-terminal-mouse,tui-transcript,undo-redo-shell}.*`。

### 二、保留清单（next 壳及其共享件）

**由 next 壳直接引用的共享件（45 条 import，全部保留）**：`src/{chat-setup,context-ref,legacy-chat,render,shell-commands,steer}.ts`、
`src/input/{dispatcher,parser,types}.ts`、`src/tui/{input,notify,scheduler,shutdown,transcript,useTurnStream,ink-commands}.ts`、
`src/tui/cards/{focus,queue,render,types}.ts`、`src/tui/commands/{palette-model,palette-view}.ts`、`src/tui/input/{esc-machine,focus,keymaps,shell-mode}.ts`、
`src/tui/queue/{panel,queue,wiring-contract}.ts`、`src/tui/render/{block-ops,folds,minimal,mode,regions}.ts`、
`src/tui/renderer/{ansi,cell-buffer,diff-presenter,layout,osc,screen}.ts`、`src/tui/status-line/{config,contract,governor,render,runner}.ts`。

**特别保留（A3 装配目标）**：`src/tui/terminal-capabilities.ts`——当前唯一生产引用是 `runInkChat.tsx`；A3 把门控
`shouldUseTui` 落到此处并由 `src/chat.ts` 引用（`decideTuiMode`/`decideWindowsTuiMode`/`TuiMode` 一并去痕）。

**零引用观察项（本次保留、不动，非 ink，登记供编排者裁决）**：

| 文件                           | 现状                                                                  | 备注                                                                                |
| ------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/tui/commands/index.ts`    | `src` 内 0 引用、`test` 内 0 引用                                     | 命令面板接线缝文档 + barrel 再导出；保留以免动 next 接线                            |
| `src/tui/input/capability.ts`  | `src` 内 0 引用，仅 `test/tui/input/capability.test.ts`               | kitty 键盘和弦差异数据表，与 TUI 闸门分工不同                                       |
| `src/tui/input/image-paste.ts` | `src` 内 0 引用，仅 `test/tui/input/{capability,image-paste}.test.ts` | G-12 图片粘贴键位契约，**已登记下放 P7**；next 壳以注释引用（`next-shell.ts:3739`） |

### 三、门控与命名去痕清单（A3 本批 / A5–A7 后续批）

| #   | 对象                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 处理                                                                                         | 批次 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---- |
| 1   | `shouldUseInk` → `shouldUseTui`（`runInkChat.tsx` 删除后迁入 `tui/terminal-capabilities.ts`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 改名 + 迁址，语义不变（`HARNESS2_NO_TUI=1` / `--no-tui` / `HARNESS2_TUI=1` / 非 TTY 四场景） | A3   |
| 2   | `TuiMode = 'ink' \| 'legacy'` → `'tui' \| 'legacy'`，`decideTuiMode` / `decideWindowsTuiMode` 返回字面量与注释                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 同步全部引用点                                                                               | A3   |
| 3   | `HARNESS2_RENDERER` 开关（`shouldUseNextRenderer`，`next/next-shell.ts:428`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **删除**（next 已是唯一渲染器）                                                              | A3   |
| 4   | `isModernTerminal`（`runInkChat.tsx:55`，`src` 内 0 引用）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 随文件删除                                                                                   | A2   |
| 5   | 测试侧：`test/tui/tui-gate.test.ts`（`shouldUseInk`）、`test/tui/terminal-capabilities.test.ts`（`.mode === 'ink'`）、`test/tui/next/next-shell.test.ts:149-157`（`shouldUseNextRenderer`）、`test/command-routing.test.ts:435`（`HARNESS2_RENDERER=next`）                                                                                                                                                                                                                                                                                                                                                                                              | 改/删 + 覆盖登记                                                                             | A4   |
| 6   | `src/tui/ink-commands.ts` → `src/tui/command-impls.ts`（内容零改动）+ `test/tui/ink-commands.test.ts` 同名跟随；`test/tui/p3f-ink-session-picker.test.tsx` 文件名去痕                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `git mv` + 引用点更新                                                                        | A6   |
| 7   | 保留件注释去痕（`grep -ciE "\bink\b\|ink-\|HARNESS2_RENDERER"` 命中行数）：`next/next-shell.ts` 66、`terminal-capabilities.ts` 10、`input/keymaps.ts` 9、`next/chat-controller.ts` 6、`input/parser.ts` 6、`next/projection.ts` 5、`chat.ts` 5、`chat-setup.ts` 5、`shell-commands.ts` 11、`input.ts` 3、`next/minimal-view.ts` 2、`serve-entry.ts` 2、`legacy-chat.ts` 2，以及 `useTurnStream/transcript/shutdown/scheduler/notify`、`render/{regions,mode,folds}`、`queue/{queue,panel}`、`next/{composer,chat-screen}`、`input/{capability,image-paste}`、`commands/{index,shell-command-impls}`、`command-registry`、`input/{types,dispatcher}` 各 1 | 注释改中性表述，**不删「为什么这么设计」的信息**                                             | A6   |
| 8   | 依赖 `ink` / `react` / `@types/react`（`packages/cli/package.json`）+ `tsconfig*.json` 的 `jsx`/`types:["react"]` + `vitest` 的 `.tsx` include                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 移除/按需清理                                                                                | A5   |
| 9   | 现行文档（`grep -ciE` 命中行数）：`docs/SMOKE-TEST.md` 3（含 `HARNESS2_RENDERER=next` 两处、F 节入口）、`docs/refs/refs-grok-build.md` 1、`docs/refs/refs-hermes-agent.md` 3、`coding-standards.md` 2、`CODE_REVIEW.md` 2、`docs/HANDOFF.md`（「CLI 双渲染模式」×3 处语义）、`docs/ROADMAP.md`（双渲染 ×4）、`README.md` 0 命中（但渲染模式表述待同步）                                                                                                                                                                                                                                                                                                  | 去痕 + 同步「CLI 只有一个 TUI」新事实                                                        | A7   |

### 四、A2/A3 的已知后果（预先登记，避免误判为回归）

1. A2 删完后 `src/chat.ts` 仍 import `runInkChat`/`shouldUseInk` → **预期 typecheck 红**，报错清单即 A3 输入。
2. A3 完成后 `src`（`tsconfig.build.json`）应 0 error；但 `tsconfig.json` 含 `test`，而「引用已删模块的 21 个旧壳测试」
   属 A4 处理 → **全量 `pnpm --filter harness2 typecheck` 在 A4 之前仍会红**，红点应全部落在 `test/**`。
3. `pnpm --filter harness2 test` 同理：A4 之前会有旧壳测试收集失败，**本批不做「全绿」承诺**。

### 五、A2 / A3 施工留痕与验证证据（2026-09-15 实跑）

**A2（`a1c7c92`，17 files / −2824 行）**——`pnpm --filter harness2 typecheck` 预期红，实得 **51 error**，
分布：`src/chat.ts` 1 处（`Cannot find module './tui/runInkChat.js'`）+ `test/**` 21 文件 50 处（均为 `TS2307`
找不到已删模块，另有少量因模块缺失而 `implicitly has an 'any' type` 的连锁 `TS7006`）。**src 侧无其他红点。**

**A3（本提交）**：

| 验证                   | 命令                                                                                                | 结果                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| src 编译闸门           | `pnpm --filter harness2 build`（= `tsc -p tsconfig.build.json`）                                    | **0 error** ✅                                                                                                                                                                                                                  |
| 全量 typecheck         | `pnpm --filter harness2 typecheck`（含 `test`）                                                     | `src/**` **0 error**；`test/**` **22 文件 / 51 处**（均为旧壳测试，A4 输入）                                                                                                                                                    |
| 门控语义不变           | `node -e` 直接调 `dist/tui/terminal-capabilities.js` 的 `shouldUseTui` 八场景                       | 非 TTY→false / `HARNESS2_NO_TUI=1`→false / `--no-tui`→false / `HARNESS2_TUI=1`(非TTY)→true / Linux TTY→true / Win TTY+WT_SESSION→true / Win TTY 无标记→false / `TERM=dumb`→false ✅（与改前 `shouldUseInk` 一致）               |
| TTY 路径真机（ConPTY） | `pywinpty` 起 pty 跑 `node packages/cli/dist/index.js chat --provider mock` 并送 `hi\r` → `/exit\r` | 进 **next 壳**（alt-screen、`❯ hi`、`⏺ write(harness2-demo.txt)`、`[end_turn · steps 3 · toolCalls 2]`、状态行 `… · mock · ctx 0%`）；`/exit` 后 0.5s 内进程退出 **exitstatus 0**，拆屏序列（`?1049l`/`?2000…l`/`?25h`）完整 ✅ |
| piped 路径             | `printf 'hi\n/exit\n' \| node packages/cli/dist/index.js chat --provider mock`                      | readline 文本输出，**exit 0**，无 ink 报错 ✅                                                                                                                                                                                   |
| cli 测试（A2/A3 后）   | `pnpm --filter harness2 test`                                                                       | `Test Files 23 failed \| 88 passed \| 1 skipped`、`Tests 7 failed \| 1511 passed \| 14 skipped`；**失败面闭合 = tsc 红的 22 文件 + `terminal-capabilities.test.ts`（仅运行期红），无第三个文件回归** ✅                         |
| 开关删除               | `grep -rn "HARNESS2_RENDERER" packages/cli/src packages/cli/dist`                                   | **0 命中** ✅（`shouldUseNextRenderer` 已删）                                                                                                                                                                                   |
| 构建产物清净           | `rm -rf packages/cli/dist && pnpm --filter harness2 build`                                          | `dist` 无 `from 'ink'`/`runInkChat`/`shouldUseInk`/`HARNESS2_RENDERER` **代码**命中（仅 2 处注释措辞，A6 处理）                                                                                                                 |

> 注：`dist/` 为 `.gitignore` 内产物，先前 `tsc` 不清理 `outDir` 会留旧壳产物，已做一次干净重建（对齐 OPEN.md「禁止对过期 dist 下结论」口径）。

**A2 与 A3 的错误面差异**：A2 时 51 处 = `src/chat.ts` 1 处 + `test/**` 50 处；A3 修掉 src 那处后，
`test/tui/next/next-shell.test.ts` 因 `shouldUseNextRenderer` 删除新增 1 处 → `test/**` 51 处。
另有一处 **tsc 不报但运行必红**：`test/tui/terminal-capabilities.test.ts` 的 `.mode` 断言仍写 `'ink'`
（`toBe('ink')` 类型上合法，运行期与实际 `'tui'` 不等）——A4 必须一并改。

**A4 输入（必须逐条登记覆盖迁移）**：

- **`tsc` 报错的 22 个测试文件（51 处）**：本附录「一」节测试侧引用的 21 个文件 + `test/tui/next/next-shell.test.ts`；
  按 `tsc` 汇总即 `test/tui-render.test.tsx`、`test/tui/next/next-shell.test.ts`、
  `test/tui/{DialogController,approvals,composer,input-bridge,keyboard,notify-shell,overlay-position,p3f-ink-session-picker,panels,paste-integration,paste,shell-lifecycle,steer-composer,task-panel,terminal-events,tui-gate,tui-subagent,tui-terminal-mouse,tui-transcript,undo-redo-shell}`。
- **`tsc` 不报但运行必红**：`test/tui/terminal-capabilities.test.ts`（`.mode` 断言仍写 `'ink'`）。
- **非报错但语义已变**：`test/command-routing.test.ts:435`（`HARNESS2_RENDERER=next` 分支——开关已删，用例前提消失）。

即 A4 目标集合 = **24 个测试文件**（22 + 1 + 1）。

---

## 附录：A4 测试清理与覆盖迁移评估（2026-09-15 实施）

> 证据命令（全部在 `D:/AI_Projects/harness2`、分支 `feat/phase-p10-next-only` 上实跑）：
>
> 1. 删除前基线（stash 回 A3 态）：`npx vitest run --reporter=json` → `numTotalTests 1532 = 1511 passed + 7 failed + 14 pending`；
>    其中「22 个 tsc 报错文件」里 **19 个 import 缺失模块 → 收集失败（assertions=0）**，仅 `keyboard.test.tsx` 因 esbuild 命名导入互操作「部分收集」，12 个用例被计入 pending。
> 2. 删除后：`pnpm --filter harness2 typecheck` → **0 error**；`pnpm --filter harness2 test` → `Test Files 91 passed | 1 skipped (92)`、`Tests 1524 passed | 2 skipped (1526)`。

### 六、处置清单（24 文件逐一，不漏）

| #   | 文件                                       | 处置                                                                          | 依据                                                                          |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | `test/tui-render.test.tsx`                 | 删                                                                            | 仅测已删 `DiffCard.tsx`/`ReasoningBlock.tsx`                                  |
| 2   | `test/tui/DialogController.test.ts`        | 删                                                                            | 仅测已删 `runInkChat.tsx` 内 `createDialogController`                         |
| 3   | `test/tui/approvals.test.tsx`              | 删                                                                            | 仅测已删旧壳 `ConfirmDialog`/`runInkChat` 审批链                              |
| 4   | `test/tui/composer.test.tsx`               | 删                                                                            | 仅测已删旧壳 `Composer.tsx`                                                   |
| 5   | `test/tui/input-bridge.test.ts`            | 删                                                                            | 测已删 `terminal-events.ts`/`input-bridge.ts`（编排者裁决 17）                |
| 6   | `test/tui/keyboard.test.tsx`               | 删                                                                            | 仅测已删旧壳 `Composer.tsx` 键位                                              |
| 7   | `test/tui/notify-shell.test.tsx`           | 删                                                                            | 仅测旧壳接线（`terminal-events` + `runInkChat`）                              |
| 8   | `test/tui/overlay-position.test.tsx`       | 删                                                                            | 仅测旧壳浮层定位（`runInkChat`/`ConfirmDialog`）                              |
| 9   | `test/tui/p3f-ink-session-picker.test.tsx` | 删                                                                            | 仅测旧壳 `runInkChat` 会话选择浮层（文件名去痕随删）                          |
| 10  | `test/tui/panels.test.tsx`                 | 删                                                                            | 仅测已删 `panels/{queue,retry}-panel.tsx`                                     |
| 11  | `test/tui/paste-integration.test.tsx`      | 删                                                                            | 仅测已删旧壳 `Composer.tsx`（chip 路径）                                      |
| 12  | `test/tui/paste.test.ts`                   | 删                                                                            | 测已删 `paste.ts`（编排者裁决 17）                                            |
| 13  | `test/tui/shell-lifecycle.test.tsx`        | 删                                                                            | 仅测旧壳在进程内生命周期（`runInkChat`）；进程级 piped 由 `chat.test.ts` 承接 |
| 14  | `test/tui/steer-composer.test.tsx`         | 删                                                                            | 仅测旧壳 `Composer.tsx` 的 Ctrl+S steer                                       |
| 15  | `test/tui/task-panel.test.tsx`             | 删                                                                            | 仅测已删 `panels/task-panel.tsx`（next 无任务数据源）                         |
| 16  | `test/tui/terminal-events.test.ts`         | 删                                                                            | 测已删 `terminal-events.ts`（编排者裁决 17）                                  |
| 17  | `test/tui/tui-subagent.test.tsx`           | 删                                                                            | 测已删 `TranscriptView`/`SubagentView`/`runInkChat`                           |
| 18  | `test/tui/tui-terminal-mouse.test.tsx`     | 删                                                                            | 测已删 `terminal-events` + 旧壳 `runInkChat` 鼠标链                           |
| 19  | `test/tui/tui-transcript.test.tsx`         | 删                                                                            | 测已删 `TranscriptView.tsx`                                                   |
| 20  | `test/tui/undo-redo-shell.test.tsx`        | 删                                                                            | 测旧壳 `runInkChat` 的 /undo /redo 重投影                                     |
| 21  | `test/tui/tui-gate.test.ts`                | **迁**（`shouldUseInk`→`shouldUseTui`，改从 `terminal-capabilities.js` 导入） | 门控函数 **保留**（A3 迁入 `terminal-capabilities.ts:142`），非旧壳专有       |
| 22  | `test/tui/next/next-shell.test.ts`         | **改**（删 `HARNESS2_RENDERER 开关` describe + import）                       | `shouldUseNextRenderer` 已在 A3 删除，开关无意义                              |
| 23  | `test/tui/terminal-capabilities.test.ts`   | **改**（5 个用例标题 + 7 处 `toBe('ink')` → `'tui'`）                         | A3 已把 `TuiMode` 改为 `'tui' \| 'legacy'`（tsc 不报、运行必红）              |
| 24  | `test/command-routing.test.ts`             | **改**（`describe` 标题去 `HARNESS2_RENDERER=next`）                          | 开关已删，用例前提消失（语义已变）                                            |

### 七、覆盖迁移评估表（三分类，逐条可核）

图例：✅ = next 侧等价测试（给 `文件:行`）；➖ = 已过时（功能/交互不存在，说明理由）；⚠️ = **缺口**（next 侧无等价覆盖，**本阶段不补**，登记于 C4 改进清单）。

#### 1. `test/tui-render.test.tsx`（6 用例：6 ✅ / 0 ➖ / 0 ⚠️）

| 用例                                    | 分类 | 落点                                                                                |
| --------------------------------------- | ---- | ----------------------------------------------------------------------------------- |
| DiffCard edit：删 `-` / 增 `+` / 未变灰 | ✅   | `test/tui/next/projection.test.ts:291`（展开态：`+ `绿 / `- `红 / 上下文灰）        |
| DiffCard write：全为新增行              | ✅   | `test/tui/next/projection.test.ts:337`                                              |
| DiffCard 超出默认最大行数：省略提示     | ✅   | `test/tui/next/projection.test.ts:341`（超 20 行折叠为 `… 还有 N 行`）              |
| ReasoningBlock 折叠态：灰标题 + 预览    | ✅   | `test/tui/next/projection.test.ts:70`；`test/tui/next/p4b-theme-search.test.ts:270` |
| ReasoningBlock 展开态：全文可见         | ✅   | `test/tui/next/projection.test.ts:81`；`test/tui/next/next-shell.test.ts:383,428`   |
| ReasoningBlock 空文本：不渲染           | ✅   | `test/tui/next/projection.test.ts:88`（纯空白 reasoning 不产推理行）                |

#### 2. `test/tui/DialogController.test.ts`（4 用例：4 ✅）

| 用例                                           | 分类 | 落点                                                                                               |
| ---------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| open 挂起 + 通知订阅者 + getPending            | ✅   | `test/tui/cards/cards-queue.test.ts:16,31`（四卡队列 + 插队）；`test/tui/next/overlay.test.ts:373` |
| clear 清空挂起并通知                           | ✅   | `test/tui/cards/cards-queue.test.ts:87`（resolve 收缩）                                            |
| open 新请求前 resolve 旧挂起（同一时刻仅一个） | ✅   | `test/tui/cards/cards-queue.test.ts:47`（依次结算/顶出）                                           |
| clear 后 open 可再次进入（多轮复用）           | ✅   | `test/tui/cards/cards-queue.test.ts:69`（同级 FIFO）                                               |

#### 3. `test/tui/approvals.test.tsx`（3 用例：3 ✅）

| 用例                                      | 分类 | 落点                                                                                                                    |
| ----------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------- |
| 一个 turn 内两次顺序审批各自 resolve      | ✅   | `test/tui/next/next-shell.test.ts:536`（第二次审批自动/手动应答路径）                                                   |
| 第二次审批到来时首个未决挂起 resolve 哨兵 | ✅   | `test/tui/cards/cards-queue.test.ts:31,47,61`（迟到插队 + nextCardAfter 只窥视）                                        |
| 审批卡渲染在输入行上方，Esc 拒绝并关闭    | ✅   | `test/tui/next/overlay.test.ts:58,63`；`test/tui/next/next-shell.test.ts:920`；`test/tui/input/esc-machine.test.ts:284` |

#### 4. `test/tui/composer.test.tsx`（13 用例：9 ✅ / 3 ➖ / 1 ⚠️）

| 用例                                       | 分类 | 落点 / 理由                                                                                                                         |
| ------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| (a) 忙时输入仍编辑草稿                     | ✅   | `test/tui/next/chat-controller.test.ts:89`（可打印字符插入光标处）                                                                  |
| (b) 忙时 Esc 调用 onAbort                  | ➖   | P2-C 改语义：**忙时 Esc 永不取消**（`test/tui/next/next-shell.test.ts:711` G-14），取消改走 Ctrl+C（G-38）                          |
| (c) 忙时 Enter 以草稿 onSend（排队）       | ✅   | `test/tui/queue/wiring-contract.test.ts:33`（G-26 running+Enter → 入队）                                                            |
| (d) 空闲首次 Ctrl+C 只提示、不污染草稿     | ✅   | `test/tui/next/next-shell.test.ts:631`；`test/tui/next/chat-controller.test.ts:103`                                                 |
| (e) 空闲窗口内两次 Ctrl+C onExit           | ✅   | `test/tui/next/next-shell.test.ts:638`（窗口内二按退出码 130）                                                                      |
| 忙时页脚：取消/排队文案与队列长度          | ✅   | `test/tui/next/chat-screen.test.ts:138`（指示行）；`test/tui/next/composer.test.ts:361`；`test/tui/queue/panel.test.ts:146`（计数） |
| 空闲 Esc 仍清空草稿（不触发 onAbort）      | ➖   | P2-C 改语义：**单击 Esc 不清稿**，G-17 双击才清稿+stash（`test/tui/next/next-shell.test.ts:746`）                                   |
| 行尾反斜杠续行不发送                       | ⚠️   | 见下「⚠️ 缺口清单」#4（next 仅 Shift+Enter 硬换行，无 `\` 续行实现）                                                                |
| Shift+Enter（kitty CSI-u）插入换行而不发送 | ✅   | `test/tui/next/chat-controller.test.ts:238`；`test/tui/next/next-shell.test.ts:765`                                                 |
| 空草稿 Ctrl+D 调用 onExit（eof）           | ➖   | next 改语义：**空草稿 Ctrl+D 不退出**，走半页下滚（`test/tui/next/next-shell.test.ts:689`；退出只走 Ctrl+C 双击与 /exit）           |
| T5 `/` 候选列表渲染在输入行上方            | ✅   | `test/tui/next/chat-screen.test.ts:83`；`test/tui/next/composer.test.ts:254`                                                        |
| T5 继续输入过滤候选：仍在输入行上方且收窄  | ✅   | `test/tui/next/slash-commands.test.ts:261`（逐字实时缩小）                                                                          |
| T5 候选出现时结构化高度随之增长            | ✅   | `test/tui/next/chat-screen.test.ts:83`（3 items → candidateRows 3）                                                                 |

> 勘误：上表「行尾反斜杠续行」计入 ⚠️（缺口 #4），故本文件为 **9 ✅ / 3 ➖ / 1 ⚠️**（合计 13）。

#### 5. `test/tui/input-bridge.test.ts`（36 用例：0 ✅ / 0 ➖ / 36 ⚠️）

全部 36 条断言测「统一解析器（`createUnifiedEventParser`）→ ink 可消费字节序列」的**逐字节等价性**，模块已删（编排者裁决 17）。next 壳自持输入链（`input/parser.ts` + `next/chat-controller.ts`）的**行为**有覆盖，但**「与旧统一解析器逐字节等价」这一契约**无 next 等价断言 → 整体登记为 ⚠️ 缺口 #1（见下）。

#### 6. `test/tui/keyboard.test.tsx`（12 用例：9 ✅ / 0 ➖ / 3 ⚠️）

| 用例                                           | 分类 | 落点 / 理由                                                                                                     |
| ---------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| 多字符输入 + 视觉光标（反显）                  | ✅   | `test/tui/next/chat-controller.test.ts:89`；`test/tui/next/composer.test.ts:127`                                |
| 左右键移动光标后插入                           | ✅   | `test/tui/next/chat-controller.test.ts:201,208`                                                                 |
| backspace 一次删除整个 ZWJ emoji（grapheme）   | ✅   | `test/tui/next/chat-controller.test.ts:96,188`                                                                  |
| Home/End 作用于当前逻辑行                      | ✅   | `test/tui/next/chat-controller.test.ts:215,223`                                                                 |
| End 回到当前逻辑行行尾                         | ✅   | `test/tui/next/chat-controller.test.ts:215`                                                                     |
| Ctrl+Left 词移动                               | ✅   | `test/tui/next/chat-controller.test.ts:229`                                                                     |
| Alt+Left（meta）同样词移动                     | ⚠️   | next `chat-controller` 对 `left/right && alt` 不处理（`:234`），无 Alt+Left 词移动 → 缺口 #5                    |
| Shift+Enter 换行不发送 + 替代键提示            | ✅   | `test/tui/next/chat-controller.test.ts:238`；`test/tui/next/next-shell.test.ts:765`                             |
| 行尾反斜杠回车作为替代换行键                   | ⚠️   | 同 #4（next 无 `\` 续行）                                                                                       |
| 历史 up/up/down/down 恢复原 draft 与 selection | ✅   | `test/tui/next/chat-controller.test.ts:287,301`                                                                 |
| Up/Down 跨软折行视觉行移动（就近列）           | ⚠️   | next `chat-controller.ts:15,244` 明确「Infinity 宽 = 仅硬换行逻辑行，软折行视觉行属 W3」→ 无实现/无测 → 缺口 #6 |
| 软折行按显示宽度渲染成多视觉行                 | ✅   | `test/tui/next/composer.test.ts:44,48`                                                                          |

#### 7. `test/tui/notify-shell.test.tsx`（3 用例：3 ✅）

| 用例                                  | 分类 | 落点                                                                 |
| ------------------------------------- | ---- | -------------------------------------------------------------------- |
| always：回合正常结束 → 发 bel         | ✅   | `test/tui/notify.test.ts:75`；`test/tui/next/next-shell.test.ts:892` |
| never：回合结束不发                   | ✅   | `test/tui/notify.test.ts:94`                                         |
| unfocused：聚焦不发；失焦后回合结束发 | ✅   | `test/tui/notify.test.ts:82,115`                                     |

> 附注：该用例依赖的「终端失焦 DECSET 1004 聚焦桥」随 `terminal-events.ts` 删除，桥本身无 next 等价 → 并入 ⚠️ 缺口 #3。

#### 8. `test/tui/overlay-position.test.tsx`（5 用例：4 ✅ / 1 ➖）

| 用例                                              | 分类 | 落点 / 理由                                                                                                                   |
| ------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| T3 /mode 弹层在输入框上方（转录让出等量行）       | ✅   | `test/tui/next/overlay.test.ts:58,63`；`test/tui/next/chat-screen.test.ts:209`                                                |
| T3 Esc 关闭弹层、焦点回 Composer                  | ✅   | `test/tui/input/esc-machine.test.ts:284`；`test/tui/next/p2c-wiring.test.ts:309`                                              |
| T3 Enter 应用选中模式并关闭                       | ✅   | `test/tui/commands/palette-model.test.ts:159`（Enter 直执行）；`test/tui/next/slash-commands.test.ts:462`（/mode 四态）       |
| T3 /sessions 弹层位置且含会话计数                 | ➖   | next 的 `/sessions` 以**转录文本**呈现（`test/tui/next/slash-commands.test.ts:421` 明记「浮层化登记暂缺」）→ 旧浮层形态不存在 |
| T3 审批确认框经 dialog 渲染在输入框上方，Esc 关闭 | ✅   | `test/tui/next/overlay.test.ts:58`；`test/tui/next/next-shell.test.ts:920`；`test/tui/input/esc-machine.test.ts:284`          |

#### 9. `test/tui/p3f-ink-session-picker.test.tsx`（1 用例：1 ✅）

| 用例                                            | 分类 | 落点                                                                                                            |
| ----------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| Ctrl+R 拉起「会话（/sessions）」浮层 + Esc 关闭 | ✅   | `test/tui/next/p3f-agent-keys.test.ts:428`（G-34 Ctrl+R 列表 + Enter 切换）；`:483`（审批优先）；`:232`（键位） |

#### 10. `test/tui/panels.test.tsx`（11 用例：9 ✅ / 1 ➖ / 1 ⚠️）

| 用例                                                      | 分类 | 落点 / 理由                                                                                                                                                                                                   |
| --------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| queuePreview：折单行并截断（不改原文本）                  | ✅   | `test/tui/queue/panel.test.ts:126`（preview 折行合一 + 截断）                                                                                                                                                 |
| cancelQueueItem：无 id 队首 / 有 id 精确移除 / 不改原数组 | ✅   | `test/tui/queue/queue.test.ts:63`（removeFollowUpById）                                                                                                                                                       |
| 渲染排队条数、下一条预览与取消键提示                      | ✅   | `test/tui/queue/panel.test.ts:146`；`test/tui/next/p3e-wiring.test.ts:504`                                                                                                                                    |
| 空队列渲染 null（不占行）                                 | ✅   | `test/tui/queue/panel.test.ts:62,146`                                                                                                                                                                         |
| 虚拟 TTY：Ctrl+X 取消队首回调                             | ⚠️   | 旧 ink 面板 Ctrl+X 键位随面板删除，next 面板无取消键（G-29 仅 `Ctrl+;` 开面板 / Enter 发送 / e 编辑，`test/tui/queue/wiring-contract.test.ts:187`）；数据层 `removeFollowUpById` 有覆盖但无 UI 落点 → 缺口 #7 |
| retry-panel：stopReason 标签引用冻结枚举                  | ✅   | `test/tui/next/p3e-chrome.test.ts:283`（formatRetryBudget）                                                                                                                                                   |
| 预算耗尽快照如实展示停因                                  | ✅   | `test/tui/next/p3e-chrome.test.ts:296`                                                                                                                                                                        |
| 纯倒计时模型：剩余秒数                                    | ✅   | `test/tui/next/p3e-chrome.test.ts:301`                                                                                                                                                                        |
| 无预算且无倒计时：不可见                                  | ✅   | `test/tui/next/p3e-chrome.test.ts:260`（空闲无重试段）                                                                                                                                                        |
| retryBudgetHasActivity：仅重试/明确停因占行               | ✅   | `test/tui/next/p3e-chrome.test.ts:295,297`                                                                                                                                                                    |
| 虚拟 TTY：Esc 触发停止（映射 abortTurn）                  | ➖   | P2-C 改语义：回合中 Esc 永不取消（`test/tui/next/next-shell.test.ts:719`），取消改走 Ctrl+C（`:643,657`）                                                                                                     |

#### 11. `test/tui/paste-integration.test.tsx`（6 用例：0 ✅ / 0 ➖ / 6 ⚠️）

多行 CRLF→单 chip、短单行原子插入、粘贴 `/exit` 不自动执行、两次粘贴 `#1`/`#2`、超 1MB 拒绝——均依赖已删 `Composer.tsx` + `paste.ts` 的 chip 语义。next bracketed paste 只覆盖「CRLF 归一入草稿、绝不提交」（`test/tui/next/chat-controller.test.ts:443`）→ chip/原子插入/1MiB 拒绝无 next 等价 → 缺口 #2。

#### 12. `test/tui/paste.test.ts`（16 用例：0 ✅ / 0 ➖ / 16 ⚠️）

`normalizePaste`（CRLF/CR/LF 归一）、`classifyPaste`（inline/chip/rejected、1MiB 边界、UTF-8 字节计数）、`renderChipLabel`（`#`/行数/字节单位）、chip 全文保真——模块已删，next 无等价 → 缺口 #2。

#### 13. `test/tui/shell-lifecycle.test.tsx`（2 用例：2 ✅）

| 用例                                                               | 分类 | 落点                                                                                                               |
| ------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------ |
| in-process：跑一轮 → /exit，单例 finish/exit、code 0、无残留 timer | ✅   | `test/tui/next/next-shell.test.ts:873`（/exit 退出码 0）；`:995`（process exit 兜底）；`test/tui/shutdown.test.ts` |
| process 级：真实 CLI piped 跑一轮 /exit，退出码 0、无残留子进程    | ✅   | `test/chat.test.ts:170,201,234`（piped /exit 退出码 0）                                                            |

#### 14. `test/tui/steer-composer.test.tsx`（2 用例：0 ✅ / 2 ➖）

| 用例                                              | 分类 | 理由                                                                                                                                                               |
| ------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ctrl+S 调用 onSteer(草稿)，页脚返回文案，草稿保留 | ➖   | 键位迁移：next `Ctrl+S` = G-17 stash 恢复（`test/tui/next/next-shell.test.ts:746`）；「草稿→steer」能力由 G-26 承载（`test/tui/queue/wiring-contract.test.ts:44`） |
| 未提供 onSteer：Ctrl+S 无副作用                   | ➖   | 同上（键位已不存在）                                                                                                                                               |

#### 15. `test/tui/task-panel.test.tsx`（8 用例：2 ✅ / 6 ➖）

| 用例                                        | 分类 | 落点 / 理由                                                                                                                 |
| ------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------- |
| 非法迁移被拒（queued→running / 终态无出边） | ✅   | `packages/core/test/runtime-journal-crash.test.ts:315`（canTaskTransition 写入口拒）；`packages/core/test/flows.test.ts:66` |
| 合法迁移写入 updatedAt，不改原对象          | ✅   | `packages/core/test/flows.test.ts:66`；`packages/core/src/interaction/types.ts:288`                                         |
| formatTaskState：终态显式标注               | ➖   | next 壳无任务面板数据源（已登记 `src/tui/input/keymaps.ts:389`，G-35/G-37 归存 P7）                                         |
| sortTasks：进行中在前、同组按 id 稳定       | ➖   | 同上                                                                                                                        |
| taskPanelCounts：区分进行中/终态            | ➖   | 同上                                                                                                                        |
| 空列表渲染 null                             | ➖   | 同上                                                                                                                        |
| 渲染多个状态（终态/父任务/后台）            | ➖   | 同上                                                                                                                        |
| 超过 maxRows 时提示省略数量                 | ➖   | 同上                                                                                                                        |

#### 16. `test/tui/terminal-events.test.ts`（20 用例：0 ✅ / 0 ➖ / 20 ⚠️）

`parseSgrMouse`（滚轮/点击/释放/畸形）、`TerminalEventParser`（增量解析/回注/挂起超时/焦点 I/O）、`attachTerminalEvents`（写 SGR+焦点 enable 序列、dispose 还原、退订）——模块已删。next 自写 SGR mouse（`next/next-shell.ts` selectionPointFromMouse/wheel）的**行为**有覆盖（`test/tui/next/next-selection.test.ts:100`、`test/tui/next/chat-controller.test.ts:417`），但**「桥接层解析/回注/写序列等价」契约**无 next 等价 → 缺口 #3。

#### 17. `test/tui/tui-subagent.test.tsx`（14 用例：14 ✅）

| 用例                                                        | 分类 | 落点                                                                                  |
| ----------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| reducer：`subagent_start`+JSON → 挂载 childSessionId        | ✅   | `test/tui/next/projection.test.ts:244`（childSessionId → `↳ 子会话` 灰行）            |
| reducer：`subagent_continue`+JSON → 挂载 childSessionId     | ✅   | `test/tui/next/projection.test.ts:253`；`test/tui/next/p3cd-review-fixes.test.ts:411` |
| 非 subagent 工具即使 output 含 childSessionId 也不解析      | ✅   | `test/tui/next/projection.test.ts:244` 段（仅 subagent 工具产入口）                   |
| subagent 工具但 output 非 JSON / 无 childSessionId → 不挂载 | ✅   | 同上                                                                                  |
| 有 childSessionId → 显示「子会话 <id>」入口                 | ✅   | `test/tui/next/projection.test.ts:244`                                                |
| 无 childSessionId → 不显示入口                              | ✅   | 同上                                                                                  |
| SubagentView：正常目录重投影子会话文本                      | ✅   | `test/tui/next/p3d-subagent.test.ts:366`（打开视图，磁盘重放）                        |
| SubagentView：坏目录 → 如实错误文案                         | ✅   | `test/tui/next/p3d-subagent.test.ts:428`                                              |
| SubagentView：dir=undefined → 定位失败原因                  | ✅   | `test/tui/next/p3d-subagent.test.ts:428`；`:528`（磁盘缺失降级）                      |
| SubagentView：空目录（有目录无日志）→ 如实报错              | ✅   | `test/tui/next/p3d-subagent.test.ts:428`                                              |
| InkShell：Ctrl+K 打开子会话转录，Esc 关闭回 Composer        | ✅   | `test/tui/next/p3d-subagent.test.ts:353,366`（键位改为 `v`，见下注）                  |
| kitty CSI-u 的 Ctrl+J 同样打开浮层                          | ✅   | 同上（旧 Ctrl+J 键位迁移，next `Ctrl+J` = G-10 行滚）                                 |
| 无子会话入口时 Ctrl+K 不打开任何浮层（不抛错）              | ✅   | `test/tui/next/p3d-subagent.test.ts:440`（无子会话 v：瞬时提示不开视图）              |
| 坏目录的子会话 → 打开浮层显示如实错误                       | ✅   | `test/tui/next/p3d-subagent.test.ts:428`                                              |

> 键位变更登记：旧壳子会话浮层键为 `Ctrl+K/Ctrl+J`；next 改为**滚动区焦点下 `v`**（`test/tui/next/p3d-subagent.test.ts:353`，G-08 焦点环），`Ctrl+K/J` 改作 G-10 行滚（`test/tui/input/keymaps.test.ts:133`）。能力面等价，键位差异已登记。

#### 18. `test/tui/tui-terminal-mouse.test.tsx`（3 用例：3 ✅）

| 用例                                           | 分类 | 落点                                                                                        |
| ---------------------------------------------- | ---- | ------------------------------------------------------------------------------------------- |
| 滚轮上暂停跟随（锚定横幅）；滚轮下回底恢复跟随 | ✅   | `test/tui/next/chat-controller.test.ts:379,417,424`；`test/tui/next/next-shell.test.ts:793` |
| 鼠标事件后键入普通字符不污染草稿               | ✅   | `test/tui/next/chat-controller.test.ts:434`（非滚轮鼠标事件不消费）                         |
| Ctrl+G 鼠标滚动后仍恢复跟随                    | ✅   | `test/tui/next/chat-controller.test.ts:409`                                                 |

> 附注：用例依赖的「SGR 序列 → 事件桥」本身（写 enable 序列/回注）无 next 等价 → 并入 ⚠️ 缺口 #3。

#### 19. `test/tui/tui-transcript.test.tsx`（9 用例：9 ✅）

| 用例                                                | 分类 | 落点                                                                                                                        |
| --------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------- |
| expandedIds 含 id → 渲染 DiffCard 真实变更          | ✅   | `test/tui/next/projection.test.ts:291`；`test/tui/next/next-shell.test.ts:383`                                              |
| 未展开 → 不渲染 diff，仅工具名与摘要                | ✅   | `test/tui/next/projection.test.ts:275`（默认折叠不产 diff 行）                                                              |
| 展开态显示真实 tool output                          | ✅   | `test/tui/next/projection.test.ts:104`                                                                                      |
| 虚拟 TTY：Ctrl+O 仍可展开已落定卡片                 | ✅   | 键位迁移：next 折叠族 = `e/E/h/l`（`test/tui/next/next-shell.test.ts:383,453`）；`Ctrl+O` 改作 always-approve（`:508,556`） |
| partial：标注「未完成/已中断」+ stopReason/error    | ✅   | `test/tui/next/projection.test.ts:184,198`                                                                                  |
| empty：不渲染空白气泡，只给 stopReason/error 与标签 | ✅   | `test/tui/next/projection.test.ts:206`                                                                                      |
| empty 无 error 时也给出可读占位（禁止静默）         | ✅   | `test/tui/next/projection.test.ts:198`（两者皆缺 → 占位文案）                                                               |
| final：普通正文 + 保留 reasoning 展开行为           | ✅   | `test/tui/next/projection.test.ts:69,81`                                                                                    |
| 会话重投影替换 items（B 会话不含 A 会话文本）       | ✅   | `test/tui/next/p3cd-review-fixes.test.ts:411,442`                                                                           |

#### 20. `test/tui/undo-redo-shell.test.tsx`（3 用例：3 ✅）

| 用例                                                           | 分类 | 落点                                                                                                                                        |
| -------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 跑一轮 → /undo 条目消失 → /redo 恢复；输出经共享 handleCommand | ✅   | `test/chat.test.ts:87,238`（REPL /undo /redo 文件复原）；`test/tui/next/slash-commands.test.ts:394`；`test/tui/next/p2c-wiring.test.ts:276` |
| 重投影清掉冻结的重试面板（/undo 后不残留）                     | ✅   | `test/tui/next/p3e-chrome.test.ts:340`（重试标记随 turn 清除）；`test/tui/next/p3cd-review-fixes.test.ts:442`（重投影）                     |
| 共享 /help 文本与本地浮层同源（含 /undo /redo 说明）           | ✅   | `test/command-routing.test.ts:458`（/help 与 core 同一份输出）；`test/tui/next/slash-commands.test.ts:866`                                  |

### 八、分类总计与用例数对账

| 分类                                  | 用例数  |
| ------------------------------------- | ------- |
| ✅ next 侧等价                        | **81**  |
| ➖ 已过时（含理由）                   | **13**  |
| ⚠️ **缺口**（登记，不补）             | **83**  |
| 合计（20 个被删文件的 `it` 静态计数） | **177** |

**用例数变化对账**（`npx vitest run --reporter=json` 基线 vs 删除后）：

| 项                             | 基线（A3 态）                             | A4 后                                   | 变化 | 解释                                                                                   |
| ------------------------------ | ----------------------------------------- | --------------------------------------- | ---- | -------------------------------------------------------------------------------------- |
| Test Files                     | 23 failed \| 88 passed \| 1 skipped (112) | 0 failed \| 91 passed \| 1 skipped (92) | −20  | 删除 20 个仅测旧壳文件；3 个红文件（next-shell/terminal-capabilities/tui-gate）转绿    |
| Tests（合计）                  | 1532                                      | 1526                                    | −6   | 见下三行分解                                                                           |
| ├ passed                       | 1511                                      | 1524                                    | +13  | tui-gate 迁移后可收集 +8；terminal-capabilities 5 红转绿 +5                            |
| ├ failed                       | 7                                         | 0                                       | −7   | terminal-capabilities 5 + next-shell 2 修复                                            |
| └ pending                      | 14                                        | 2                                       | −12  | `keyboard.test.tsx` 部分收集的 12 条（依赖已删模块）随文件删除；余 2 条为 e2e 环境闸门 |
| 其中：删 `keyboard.test.tsx`   | 12（pending）                             | —                                       | −12  | 该文件因 esbuild 命名导入互操作「部分收集」，12 用例计入 pending                       |
| 其中：删 `next-shell` 开关用例 | 2（failed）                               | —                                       | −2   | `HARNESS2_RENDERER` 开关已于 A3 删除                                                   |
| 其中：迁 `tui-gate.test.ts`    | 0（收集失败）                             | 8                                       | +8   | `shouldUseTui` 门控保留，改导入后 8 用例恢复执行                                       |
| 其余 19 个被删文件             | 0（import 缺失模块 → 收集失败）           | —                                       | 0    | 其 165 条断言**未被执行**，但已全部登记于 §七                                          |

**结论：** 删除动作本身未减少任何**曾被执行**的断言；唯一减少的 2 条来自 A3 已删开关的用例，另有 12 条来自 `keyboard.test.tsx` 的「部分收集」pending。177 条静态断言 100% 登记，无静默丢覆盖。

### 九、⚠️ 缺口清单（C4 改进清单登记，本阶段不补）

| #   | 缺口                                                                | 来源用例                                                        | 数量 | 严重度 | 说明                                                                                                          |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------- | ---- | ------ | ------------------------------------------------------------------------------------------------------------- |
| 1   | `input-bridge.ts` **统一解析器 → ink 字节序列逐字节等价性**         | `input-bridge.test.ts` 全 36 条                                 | 36   | P2     | next 输入链（`input/parser.ts` + `chat-controller.ts`）行为有覆盖，但「与旧统一解析器字节等价」契约无等价测试 |
| 2   | `paste.ts` **归一/分类/1MiB 边界/chip 语义/全文保真**               | `paste.test.ts` 16 条 + `paste-integration.test.tsx` 6 条       | 22   | P2     | next bracketed paste 仅覆盖「CRLF 归一入草稿、绝不提交」；无 chip、无 1MiB 拒绝、无字节计数                   |
| 3   | `terminal-events.ts` **SGR 鼠标/焦点桥 + 写 enable 序列/回注/退订** | `terminal-events.test.ts` 20 条（含 `notify-shell` 焦点桥附注） | 20   | P2     | next 自写 SGR mouse 行为有覆盖（selection/wheel），但桥接层解析/回注/写序列契约无等价                         |
| 4   | 输入：**行尾反斜杠续行**（终端无法区分 Shift+Enter 时的替代键）     | `composer.test.tsx` 1 条 + `keyboard.test.tsx` 1 条             | 2    | P3     | next 仅 kitty `Shift+Enter` 硬换行；无 `\` 续行实现（`chat-controller.ts`/`next-shell.ts` 均无）              |
| 5   | 输入：**Alt+Left 词移动**（ink meta 编码）                          | `keyboard.test.tsx` 1 条                                        | 1    | P3     | next `chat-controller.ts:234` 对 `left/right && alt` 不处理；主键 `Ctrl+←` 有覆盖                             |
| 6   | 输入：**Up/Down 跨软折行视觉行移动**（就近列）                      | `keyboard.test.tsx` 1 条                                        | 1    | P3     | next 明确「Infinity 宽 = 仅硬换行逻辑行，软折行视觉行属 W3」（`chat-controller.ts:15,244`）                   |
| 7   | 交互：**旧 ink 面板 `Ctrl+X` 取消队首键位**                         | `panels.test.tsx` 1 条                                          | 1    | P3     | 键位随旧面板删除；next 面板键位另定（G-29），数据层 `removeFollowUpById` 有覆盖                               |

> 上述 7 项合计 **83** 条（36+22+20+2+1+1+1 = 83），与 §八「⚠️ 83」逐条一致：④ 的 2 条即 `composer` 与 `keyboard` 各 1 行，⑤⑥ 即 `keyboard` 另 2 行，⑦ 即 `panels` 1 行。

### 十、计数口径统一（以本表为准）

§七 的分文件小计与本节汇总如有出入，**以本表为准**（按「文件内 `it`」逐条计）：

| 文件                              | `it` 总数 | ✅     | ➖     | ⚠️     |
| --------------------------------- | --------- | ------ | ------ | ------ |
| `tui-render.test.tsx`             | 6         | 6      | 0      | 0      |
| `DialogController.test.ts`        | 4         | 4      | 0      | 0      |
| `approvals.test.tsx`              | 3         | 3      | 0      | 0      |
| `composer.test.tsx`               | 13        | 9      | 3      | 1      |
| `input-bridge.test.ts`            | 36        | 0      | 0      | 36     |
| `keyboard.test.tsx`               | 12        | 9      | 0      | 3      |
| `notify-shell.test.tsx`           | 3         | 3      | 0      | 0      |
| `overlay-position.test.tsx`       | 5         | 4      | 1      | 0      |
| `p3f-ink-session-picker.test.tsx` | 1         | 1      | 0      | 0      |
| `panels.test.tsx`                 | 11        | 9      | 1      | 1      |
| `paste-integration.test.tsx`      | 6         | 0      | 0      | 6      |
| `paste.test.ts`                   | 16        | 0      | 0      | 16     |
| `shell-lifecycle.test.tsx`        | 2         | 2      | 0      | 0      |
| `steer-composer.test.tsx`         | 2         | 0      | 2      | 0      |
| `task-panel.test.tsx`             | 8         | 2      | 6      | 0      |
| `terminal-events.test.ts`         | 20        | 0      | 0      | 20     |
| `tui-subagent.test.tsx`           | 14        | 14     | 0      | 0      |
| `tui-terminal-mouse.test.tsx`     | 3         | 3      | 0      | 0      |
| `tui-transcript.test.tsx`         | 9         | 9      | 0      | 0      |
| `undo-redo-shell.test.tsx`        | 3         | 3      | 0      | 0      |
| **合计**                          | **177**   | **81** | **13** | **83** |

> 说明：`composer` 的「行尾反斜杠续行」与 `keyboard` 的「行尾反斜杠回车」为**同一缺口 #4 的两个测点**，各计 1 行；`panels` 的「Ctrl+X 取消队首」为缺口 #7（旧面板键位不存在，next 面板无取消键）；`keyboard` 的「Alt+Left 词移动」「Up/Down 跨软折行视觉行移动」为缺口 #5/#6。命中：**✅ 81 / ➖ 13 / ⚠️ 83 = 177**，与 §七 各文件小计及 §九 缺口表逐条相加一致。

### 十一、A4 验证证据（2026-09-15 实跑）

| 验证         | 命令                                                                                                   | 结果                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 类型闸门     | `pnpm --filter harness2 typecheck`                                                                     | **0 error**（`tsc -p tsconfig.json --noEmit` 无输出）✅                                       |
| 全量测试     | `pnpm --filter harness2 test`                                                                          | `Test Files 91 passed \| 1 skipped (92)`；`Tests 1524 passed \| 2 skipped (1526)` **全绿** ✅ |
| 残留开关检索 | `grep -rn "HARNESS2_RENDERER\|shouldUseNextRenderer\|shouldUseInk" packages/cli/test packages/cli/src` | 仅 `tui-gate.test.ts:1` 注释中的历史说明（A6 处理），代码零命中 ✅                            |
| 用例数对账   | 基线 JSON vs A4 后                                                                                     | 1526 = 1532 − 12（keyboard pending）− 2（next-shell 开关）+ 8（tui-gate 迁移）✅              |

### 十二、A5 追加：`step-order.test.ts` 覆盖迁移（第 21 个被删测试文件，2026-09-15）

> A5 解阻塞删除 `useTurnStream.ts`（React hook 死代码）后，测试侧仅剩 `test/tui/step-order.test.ts`
> 与 `test/tui/harness.tsx` 仍引用 `ink`/`react`，随之删除。本节是这两个文件的覆盖迁移登记。
>
> **`test/tui/harness.tsx`（测试辅助件，非 `.test`，不被 vitest 收集）**：虚拟 TTY ink 挂载助手，
> 唯一消费者是 `step-order.test.ts`（`grep -rn "tui/harness" packages/cli` 零命中）。二者同删，
> **无覆盖损失**（其能力无独立断言，仅为旧壳用例提供 mount/flush 手段）。

#### 覆盖迁移表（4 用例：1 ✅ / 0 ➖ / 3 ⚠️）

| 用例                                                                        | 分类 | 落点 / 理由                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text(A) → tool-call → text(B) → turn-final ⇒ assistant(A)→tool→assistant(B) | ⚠️   | 缺口 #8：next 的 `next-shell.ts` turn 流桥有等价 flush-on-tool-boundary 实现（`flushStep`），但无测试在同一回合内先 text-delta 再 tool-call 再 text-delta；`test/tui/transcript.test.ts:67` 只覆盖**磁盘重投影**顺序，非 live 桥                           |
| tool-call 前无文本：不产生空 assistant 气泡                                 | ⚠️   | 缺口 #9：next 的 `emitStep` 有「有正文/推理才发」守卫（`next-shell.ts:786`），但 `test/tui/next/next-shell.test.ts:271`（首事件即 tool-call）只断言工具行存在，未断言无空 assistant item；`projection.test.ts:60` 反而证明空 `assistant/step` 会渲染成空行 |
| 纯 reducer：assistant/step 保留 turnId+step 作用域稳定 id                   | ✅   | `test/tui/next/next-shell.test.ts:249`（同 step 二次增长原地替换，依赖 id 稳定幂等）；`test/tui/next/p3d-wiring.test.ts:428,444`（`f:assistant:t1:step:0` 经折叠块 id 断言，id 格式/作用域可核）                                                           |
| 卸载清理：挂起中的 50ms flush timer 随 unmount 被 clearTimeout              | ⚠️   | 缺口 #10：next 侧等价实现为 `createTurnStreamBridge.dispose()` → `clearTimer()`（`next-shell.ts:876`），但无 `vi.getTimerCount`/clearTimeout 断言；既有定时器用例（`p3d-subagent.test.ts:263`、`p3cd-review-fixes.test.ts:477`）均针对 spinner，不是本桥   |

#### 追加缺口（接续 §九 编号，#8～#10，本批不补）

| #   | 缺口                                                                      | 来源用例                | 数量 | 严重度 | 说明                                                                 |
| --- | ------------------------------------------------------------------------- | ----------------------- | ---- | ------ | -------------------------------------------------------------------- |
| 8   | 流式桥 `解释→工具→解释` **实时交错顺序**（tool 边界 flushStep 先落 step） | `step-order.test.ts` #1 | 1    | P2     | next 有实现无断言；回归（文本攒到末尾塌成一块）可静默复现            |
| 9   | 流式桥 `emitStep` **空内容守卫**（不产空 assistant item）                 | `step-order.test.ts` #2 | 1    | P3     | 守卫在 `next-shell.ts`，无直接断言；仅在投影层有空块渲染行为（反向） |
| 10  | 流式桥 `dispose()` **清挂起 50ms flush timer**                            | `step-order.test.ts` #4 | 1    | P3     | 实现存在（`clearTimer`），无 timer 计数/取消断言                     |

#### 用例数对账（A4 后 → A5 后）

| 项         | A4 后                           | A5 后                           | 变化 | 解释                                                         |
| ---------- | ------------------------------- | ------------------------------- | ---- | ------------------------------------------------------------ |
| Test Files | 91 passed \| 1 skipped (92)     | 90 passed \| 1 skipped (91)     | −1   | 删 `test/tui/step-order.test.ts`（`harness.tsx` 本就不计入） |
| Tests      | 1524 passed \| 2 skipped (1526) | 1520 passed \| 2 skipped (1522) | −4   | 恰为该文件 4 个 `it`（原全部通过），无其它增减               |

---

## 编排者验收记录（2026-09-15，逐批回填）

### 第一批（A1～A3）✅ 通过 —— `6b45ccc` / `a1c7c92` / `0f1bb9e`

- 我方独立复核：`git diff main --name-only -- packages/{core,gateway,ui-shared,desktop,web}` = **0 文件**；`packages/cli/src` 已无 `.tsx`/`panels/`/`runInkChat`；`pnpm --filter harness2 build` = 0 error。
- **批准扩删**：`tui/terminal-events.ts`、`tui/input-bridge.ts`、`tui/paste.ts` 三个桥接模块（超出计划字面清单）。裁决依据：三者在 `packages/cli/src` **零引用**（grep 0），且 next 壳自带等价实现（鼠标 `1000/1002/1003/1006`、bracketed paste `2004`）。
- **附加要求（已转 A4）**：三件原有测试断言必须登记为 ⚠️ 覆盖缺口，不得静默丢失。

### 第二批（A4/A6）✅ 通过；A5 阻塞并已裁决 —— `93bce85` / `aee4881`

- 我方独立复核：`pnpm --filter harness2 typecheck` **0 error**；`pnpm --filter harness2 test` **91 files / 1524 passed + 2 skipped 全绿**；`grep -rniE "\bink\b|ink-|runInkChat|shouldUseInk|HARNESS2_RENDERER" packages/cli/src` = **0**；`packages/ui-shared` diff = **0 行**（`--ink` CSS token 未误伤）。
- A4 覆盖迁移评估：20 文件 / 177 条 `it` → ✅81 / ➖13 / ⚠️83（缺口逐条登记于计划附录）。
- **A5 阻塞裁决**：`react` 仍在生产依赖图（`useTurnStream.ts` 的 hook，经 `next-shell.ts` 间接引入），且 `ink` 被 `test/tui/{harness.tsx,step-order.test.ts}` 引用。**裁决：该 hook 属旧壳死代码 → 拆出纯函数后连同 hook 与两测试文件一并删除，再清依赖。**

### 第三批（A5 解阻塞 + 去痕改名 + A7）✅ 通过（附两项编排者裁定）—— `d73304b` / `edcaf19` / `fb8e5b9`

- 我方独立复核（实跑）：`pnpm --filter harness2 typecheck` 0 error；cli 测试 **90 files / 1520 passed + 2 skipped 全绿**；`pnpm -r build` 六包全绿；`pnpm lint` 0 error / 46 warning；`packages/cli` 零 `.tsx` / 零 `react` / 零 `ink`；core **仅两处注释**且 `api-surface-baseline.json` diff = **0 行**。
- **裁定 1（批准）**：删除 `packages/cli/scripts/tui-spike.tsx` 与 `run-spike.mjs`（P0 遗留的实验脚本，含旧壳依赖；不删则「零 .tsx / 零 react」不成立）。
- **裁定 2（接受）**：`pnpm install` 顺带把 desktop/web 的 **传递 devDependency** `@testing-library/dom` 由 `10.4.1` → `10.4.2`。已核 `pnpm-lock.yaml` 中 **vite / vitest 版本零变化**；属 pnpm 重新解析的 patch 级副作用，非手工编辑，接受并登记。
- **验收口径修正（重要）**：本机 `packages/desktop` 存在**预存环境红灯**，与本次改动无关（已用 `git checkout main` 同环境对照取证，红点完全相同）：
  1. `test/serve-manager.test.ts` 4 例失败 —— 固定端口 `127.0.0.1:46213` 被遗留 `node` 进程占用（OPEN.md 已登记的技术债）。**杀掉占用进程后实测 17/17 全绿**。
  2. `test/settings/models/*.test.tsx` 2 文件失败（`Error: No such built-in module: node:`，jsdom 环境下 `node:fs/os/path` 被 externalize）——`main` 分支同环境同样失败，预存问题。
     → 因此 **A8 的全量闸门口径为**：`pnpm -r build` + `pnpm -r typecheck` + `pnpm lint` 全绿；`cli/core/gateway/ui-shared/web` 测试全绿；`desktop` 除上述 2 个预存红文件外全绿（须贴证据并先释放 46213 端口占用）。
