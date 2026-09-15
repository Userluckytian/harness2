# 阶段 P10：next 单轨化清场 + 与 grok 的终端逐场景抓屏对照

> **状态：** 实施中（计划已就绪）
> **For agentic workers:** 按 Task 顺序执行；每 Task 验证通过再进下一 Task，每 Task 一次 commit。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** ① 彻底删除 CLI 旧终端渲染路径（下文称「旧壳」，库名 `ink`），做到**代码 / 测试 / 依赖 / 现行文档零残留**；② 建立可复跑的「双 TUI 抓屏对照台」，产出 next 壳 与 grok 的逐场景差异报告与改进清单。

**Architecture:** CLI 收敛为两条路径——**next TUI**（TTY，唯一交互壳）与 **piped readline**（非 TTY/CI 回退，保留）；对照台用 ConPTY 驱动两个 TUI 的**同一个剧本**，抓「屏幕网格」渲染成 PNG，供主模型读图对比。

**Tech Stack:** TypeScript / Node ≥22 / pnpm；对照台 Python 3.12 + pywinpty + pyte + Pillow（隔离 venv，**不进 packages/ 依赖**）

**实施档位：** 全能（默认） · **子代理：** 启用

---

## 前置阅读（必须）

| 优先级 | 文件                                             |
| ------ | ------------------------------------------------ |
| P0     | `docs/ai-framework/phased-plan-driven.md`        |
| P0     | 本文件                                           |
| P0     | `docs/HANDOFF.md`、`docs/issue-log/OPEN.md`      |
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

| 上阶段遗留项                                                                  | 来源              | 未通过原因 | 状态                                |
| ----------------------------------------------------------------------------- | ----------------- | ---------- | ----------------------------------- |
| 「终端 grok 复刻 P0～P4 真机验收」+「P2 双渲染模式真机验收（`HARNESS2_RENDERER`）」 | OPEN.md 2026-09-13 | 需真机     | 🔄 本阶段**改变形态**：双渲染不复存在，该两项合并为「next 壳真机验收」，A8 后更新 OPEN.md |

其余 OPEN.md 未关闭项（真机/key/发布动作/技术尾巴）与本阶段无交集，不动。

---

## 跳过项（因档位未做，非缺陷）

| 跳过项                             | 原因                                        | 待补做            |
| ---------------------------------- | ------------------------------------------- | ----------------- |
| 真机（Windows Terminal）观感与 IME | ConPTY 抓屏无法覆盖鼠标/IME/系统字体度量    | ⬜ 待用户真机一轮 |
| 旧壳测试断言的**全量**迁移         | 删旧壳后部分断言已无对应实现，只保留迁移评估 | ⬜ 见 A4 缺口清单 |

---

## 与前后阶段

| 阶段          | 状态 | 交付                                                              |
| ------------- | ---- | ----------------------------------------------------------------- |
| P9 收口       | ✅   | 归存补齐 / 上层文档 / 冒烟用例（`83f2e9b`）                       |
| **本阶段 P10** | ⬜   | 旧壳零残留 + 双 TUI 抓屏对照台 + 差异报告与改进清单               |
| 下阶段        |      | 按 C4 产出的改进清单另立计划（本阶段不顺手改 next 功能）          |

---

## File Structure（预期变更）

| 文件 / 目录                                                                  | 动作 | 职责                                                     |
| ---------------------------------------------------------------------------- | ---- | -------------------------------------------------------- |
| `packages/cli/src/tui/*.tsx`（14 个，见 A1 清单）                             | 删   | 旧壳 React 组件                                          |
| `packages/cli/src/tui/panels/*.tsx`（3 个）                                   | 删   | 旧壳面板                                                 |
| `packages/cli/src/tui/runInkChat.tsx`                                        | 删   | 旧壳入口 + `shouldUseInk` 门控（门控迁往 A3）             |
| `packages/cli/test/tui/**`（7 个含旧壳依赖的文件，见 A1）                      | 删/迁 | 旧壳测试                                                 |
| `packages/cli/src/chat.ts`、`index.ts`、`tui/terminal-capabilities.ts`         | 改   | 装配收敛为「next / piped」二选一；门控函数改名            |
| `packages/cli/src/tui/ink-commands.ts`                                        | 改名 | → `tui/command-impls.ts`（内容零改动）                    |
| `packages/cli/package.json` + `pnpm-lock.yaml`                                | 改   | 移除 `ink` / `react` / `@types/react`                     |
| `packages/core/src/commands/types.ts`、`src/session/capabilities.ts`           | 改   | 仅注释去痕（导出面零变化）                                |
| 现行文档（README / HANDOFF / SMOKE-TEST / ROADMAP / MASTER-PLAN / refs / …）   | 改   | 去痕 + 更新「单轨」事实                                   |
| `scripts/tui-parity/`                                                         | 新建 | 抓屏对照台（ptycap.py + scenarios/ + README）             |
| `docs/tui-parity/`                                                            | 新建 | 对照报告（README + matrix.md + images/）                  |

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

| 组 | 场景                                                                     |
| -- | ------------------------------------------------------------------------ |
| A 启动     | 冷启动 / 恢复上次会话 / 空目录 vs git 仓库                              |
| B 对话     | 流式中截图 / 完成后 / 长回答 / 代码块                                   |
| C 命令     | 敲 `/` 出候选列表 / `/help` / 未知命令                                  |
| D 工具     | 读文件 / 写文件 / 跑命令（卡片形态与折叠）                              |
| E 审批     | ask 弹窗 / 允许 / 拒绝 / 总是允许                                       |
| F 子任务   | 派发子代理 → 运行中 → 完成 → 查看子会话                                 |
| G 状态行   | 模型名 / 模式 / ctx% / token 用量 / 耗时                                |
| H 打断     | 回合中 Esc / Ctrl+C / 双击                                             |
| I 撤销     | `/undo` `/redo` / 分叉                                                  |
| J 队列     | 忙碌时回车排队 / steer                                                  |
| K 外观     | fullscreen vs minimal / 110 列 vs 160 列                                |
| L 失败     | 模型报错 / 工具失败                                                     |

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

| 审查项         | 结论 | 问题清单 |
| -------------- | ---- | -------- |
| 删除完整性     |      | 有无孤儿文件/死代码残留、有无被删断言未登记 |
| 覆盖迁移评估   |      | 评估表是否逐条可核（不得「静默丢覆盖」） |
| 依赖与架构红线 |      | cli 依赖是否真的清了、core/gateway 是否越界 |
| 误伤检查       |      | `--ink` CSS token 是否被误改、link/think 误伤 |
| 文档一致性     |      | 单 TUI 事实是否同步、有无自相矛盾            |
| 零残留         |      | A8 白名单外命中是否为 0                      |

**结论：** ✅ 通过 / ⚠️ 有条件通过（问题进验收表）/ ❌ 不通过（阻塞合入）

---

## 验收标准总表

| # | 标准                     | 通过条件                                                        | 验证责任人 |
| - | ------------------------ | --------------------------------------------------------------- | ---------- |
| 1 | 旧壳代码零残留           | A8 grep 白名单外命中 0                                          | 自动化     |
| 2 | 依赖清理                 | `packages/cli/package.json` 无 `ink`/`react`/`@types/react`      | 自动化     |
| 3 | 覆盖不静默丢失           | 覆盖迁移评估表逐条可核，⚠️ 缺口已登记                            | 独立审查   |
| 4 | 冻结区未越界             | core 仅两处注释改动；`api-surface-baseline.json` diff = 0 行     | 自动化     |
| 5 | 误伤零发生               | `--ink` CSS token 原样；无 link/think 误改                       | 独立审查   |
| 6 | 全量闸门                 | `pnpm -r build` + `pnpm test` + `pnpm -r typecheck` + `pnpm lint` exit 0 | 自动化 |
| 7 | 冒烟                     | next 壳 `/help` → 对话 → `/undo` → `/exit` 正常；piped 模式文本输出正常 | 编排者 |
| 8 | 对照台可用               | `scripts/tui-parity` 单场景冒烟出图（中文/边框无误）            | 编排者     |
| 9 | 对照报告                 | `docs/tui-parity/matrix.md` 覆盖 12 组场景，逐项有差异结论与改进建议 | 编排者 |
| 10| 文档同步                 | OPEN.md 双渲染项已合并；HANDOFF/README/SMOKE 表述与单 TUI 一致  | 编排者     |
| 11| 真机项                   | 人眼确认鼠标/IME/真机观感（**本阶段不做**，留手工清单）         | 用户       |

---

## 风险与降级

| 风险                                          | 缓解                                                          |
| --------------------------------------------- | ------------------------------------------------------------- |
| 删除时误伤共享件（next 依赖父目录多个模块）    | A1 反向依赖证明 + 逐文件 `git rm` + typecheck 报错清单驱动     |
| 删测试导致覆盖静默下降                        | A4 强制「覆盖迁移评估表」，⚠️ 缺口登记为下阶段改进项           |
| core 冻结区被误改                              | 仅授权两处注释；用导出面基线 diff 断言                          |
| `--ink` CSS token 被全局替换误伤               | 明确红线 + 独立审查专项 + 禁止 `sed` 批量替换                   |
| grok 侧对照消耗额度 / 时序 flaky               | 我方 mock 零成本；grok 用最小 prompt；抓屏改「等屏幕稳定」      |
| ConPTY 抓屏与真机观感有差异                    | 报告首页如实声明；真机项留在手工清单                            |

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

| # | 文件 | 生产侧引用者 | 依据 |
| - | ---- | ------------ | ---- |
| 1 | `src/tui/runInkChat.tsx` | `src/chat.ts:4`（A3 收敛点） | 旧壳入口 + `shouldUseInk` 门控 + `HARNESS2_RENDERER` 改道分支 |
| 2 | `src/tui/Composer.tsx` | runInkChat | 旧壳输入框 |
| 3 | `src/tui/ConfirmDialog.tsx` | runInkChat | 旧壳审批卡 |
| 4 | `src/tui/DiffCard.tsx` | TranscriptView | 旧壳 diff 卡 |
| 5 | `src/tui/Modal.tsx` | ConfirmDialog / runInkChat | 旧壳浮层外框 |
| 6 | `src/tui/OverlayHost.tsx` | runInkChat | 旧壳浮层宿主 |
| 7 | `src/tui/ReasoningBlock.tsx` | TranscriptView | 旧壳推理块 |
| 8 | `src/tui/SelectList.tsx` | runInkChat | 旧壳选择列表 |
| 9 | `src/tui/StatusBar.tsx` | runInkChat | 旧壳状态栏 |
| 10 | `src/tui/SubagentView.tsx` | runInkChat | 旧壳子会话浮层 |
| 11 | `src/tui/TranscriptView.tsx` | SubagentView / runInkChat | 旧壳转录区 |
| 12 | `src/tui/panels/queue-panel.tsx` | runInkChat | 旧壳队列面板 |
| 13 | `src/tui/panels/retry-panel.tsx` | runInkChat | 旧壳重试面板 |
| 14 | `src/tui/panels/task-panel.tsx` | runInkChat | 旧壳任务面板 |

**B. 旧壳专供的邻接模块（3 个，非 tsx；删掉旧壳后生产零引用，且文件头即 ink 行为契约）**

| # | 文件 | 生产侧引用者（全部在删除清单内） | 旧壳证据 |
| - | ---- | -------------------------------- | -------- |
| 15 | `src/tui/terminal-events.ts` | `runInkChat.tsx`、`input-bridge.ts` | 文件头：拦截 stdin 再回注给 **ink**（mouse/focus SGR）；ink 之后无消费者 |
| 16 | `src/tui/input-bridge.ts` | `terminal-events.ts` | 文件头：统一解析器 → **ink** stdin 逐字节回注适配层 |
| 17 | `src/tui/paste.ts` | `Composer.tsx` | 文件头：**ink 7** `usePaste` 的 CRLF 归一/短长分流内核；next 壳自持 paste 解析（`next-shell.ts` bracketed paste + chat-controller 空闲冲刷） |

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

| 文件 | 现状 | 备注 |
| ---- | ---- | ---- |
| `src/tui/commands/index.ts` | `src` 内 0 引用、`test` 内 0 引用 | 命令面板接线缝文档 + barrel 再导出；保留以免动 next 接线 |
| `src/tui/input/capability.ts` | `src` 内 0 引用，仅 `test/tui/input/capability.test.ts` | kitty 键盘和弦差异数据表，与 TUI 闸门分工不同 |
| `src/tui/input/image-paste.ts` | `src` 内 0 引用，仅 `test/tui/input/{capability,image-paste}.test.ts` | G-12 图片粘贴键位契约，**已登记下放 P7**；next 壳以注释引用（`next-shell.ts:3739`） |

### 三、门控与命名去痕清单（A3 本批 / A5–A7 后续批）

| # | 对象 | 处理 | 批次 |
| - | ---- | ---- | ---- |
| 1 | `shouldUseInk` → `shouldUseTui`（`runInkChat.tsx` 删除后迁入 `tui/terminal-capabilities.ts`） | 改名 + 迁址，语义不变（`HARNESS2_NO_TUI=1` / `--no-tui` / `HARNESS2_TUI=1` / 非 TTY 四场景） | A3 |
| 2 | `TuiMode = 'ink' \| 'legacy'` → `'tui' \| 'legacy'`，`decideTuiMode` / `decideWindowsTuiMode` 返回字面量与注释 | 同步全部引用点 | A3 |
| 3 | `HARNESS2_RENDERER` 开关（`shouldUseNextRenderer`，`next/next-shell.ts:428`） | **删除**（next 已是唯一渲染器） | A3 |
| 4 | `isModernTerminal`（`runInkChat.tsx:55`，`src` 内 0 引用） | 随文件删除 | A2 |
| 5 | 测试侧：`test/tui/tui-gate.test.ts`（`shouldUseInk`）、`test/tui/terminal-capabilities.test.ts`（`.mode === 'ink'`）、`test/tui/next/next-shell.test.ts:149-157`（`shouldUseNextRenderer`）、`test/command-routing.test.ts:435`（`HARNESS2_RENDERER=next`） | 改/删 + 覆盖登记 | A4 |
| 6 | `src/tui/ink-commands.ts` → `src/tui/command-impls.ts`（内容零改动）+ `test/tui/ink-commands.test.ts` 同名跟随；`test/tui/p3f-ink-session-picker.test.tsx` 文件名去痕 | `git mv` + 引用点更新 | A6 |
| 7 | 保留件注释去痕（`grep -ciE "\bink\b\|ink-\|HARNESS2_RENDERER"` 命中行数）：`next/next-shell.ts` 66、`terminal-capabilities.ts` 10、`input/keymaps.ts` 9、`next/chat-controller.ts` 6、`input/parser.ts` 6、`next/projection.ts` 5、`chat.ts` 5、`chat-setup.ts` 5、`shell-commands.ts` 11、`input.ts` 3、`next/minimal-view.ts` 2、`serve-entry.ts` 2、`legacy-chat.ts` 2，以及 `useTurnStream/transcript/shutdown/scheduler/notify`、`render/{regions,mode,folds}`、`queue/{queue,panel}`、`next/{composer,chat-screen}`、`input/{capability,image-paste}`、`commands/{index,shell-command-impls}`、`command-registry`、`input/{types,dispatcher}` 各 1 | 注释改中性表述，**不删「为什么这么设计」的信息** | A6 |
| 8 | 依赖 `ink` / `react` / `@types/react`（`packages/cli/package.json`）+ `tsconfig*.json` 的 `jsx`/`types:["react"]` + `vitest` 的 `.tsx` include | 移除/按需清理 | A5 |
| 9 | 现行文档（`grep -ciE` 命中行数）：`docs/SMOKE-TEST.md` 3（含 `HARNESS2_RENDERER=next` 两处、F 节入口）、`docs/refs/refs-grok-build.md` 1、`docs/refs/refs-hermes-agent.md` 3、`coding-standards.md` 2、`CODE_REVIEW.md` 2、`docs/HANDOFF.md`（「CLI 双渲染模式」×3 处语义）、`docs/ROADMAP.md`（双渲染 ×4）、`README.md` 0 命中（但渲染模式表述待同步） | 去痕 + 同步「CLI 只有一个 TUI」新事实 | A7 |

### 四、A2/A3 的已知后果（预先登记，避免误判为回归）

1. A2 删完后 `src/chat.ts` 仍 import `runInkChat`/`shouldUseInk` → **预期 typecheck 红**，报错清单即 A3 输入。
2. A3 完成后 `src`（`tsconfig.build.json`）应 0 error；但 `tsconfig.json` 含 `test`，而「引用已删模块的 21 个旧壳测试」
   属 A4 处理 → **全量 `pnpm --filter harness2 typecheck` 在 A4 之前仍会红**，红点应全部落在 `test/**`。
3. `pnpm --filter harness2 test` 同理：A4 之前会有旧壳测试收集失败，**本批不做「全绿」承诺**。
