# 阶段 V0：基线补账与止血 —— 把账做平，把缺帧补齐

> **状态：** 计划已就绪
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词** 见文末。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`
> **所属总纲:** `docs/ai-framework/plans/2026-09-17-visual-parity-program.md`

**Goal:** 在动任何视觉代码之前，把管理欠账（日志断更、OPEN.md 混乱）和数据欠账（grok 侧缺 2 个场景基准帧）补齐，并建立记分卡骨架。
**Architecture:** 本阶段 **不改任何 TypeScript 生产代码**，只改文档与抓屏产物。
**Tech Stack:** Markdown、git log、Python（tui-parity 抓屏台）
**实施档位：** 全能
**子代理：** 不启用（无代码改动，代码审查闸门按「不适用」登记）

---

## 前置阅读（必须，按顺序）

| 优先级 | 文件                                                          | 为什么要读                            |
| ------ | ------------------------------------------------------------- | ------------------------------------- |
| P0     | `docs/ai-framework/plans/2026-09-17-visual-parity-program.md` | 总纲，含铁律与闸门定义                |
| P0     | 本文件                                                        | ——                                    |
| P0     | `docs/issue-log/OPEN.md`                                      | 开放事项索引，开工强制                |
| P0     | `docs/issue-log/README.md`                                    | 日志格式约定                          |
| P0     | `scripts/tui-parity/README.md`                                | 抓屏台用法、额度约束、诚实边界        |
| P1     | `AGENTS.md`                                                   | 协作规范                              |
| P1     | `docs/refs/refs-grok-build.md`                                | 95 条 G-* 规格，Task 5 要改它的状态列 |

**仓库路径：** `D:/AI_Projects/harness2`
**基线分支：** 从 `main` 拉 `chore/v0-baseline`

---

## Global Constraints（冲突时以本节为准）

1. **本阶段禁止修改 `packages/**` 下任何文件。** 一行都不许动。这是纯补账阶段。
2. `packages/core/**`、`packages/gateway/**` 处于契约冻结状态（冻结 commit `3c9b31f`）。
3. 密钥/凭证不进 git。`scripts/tui-parity/out/`、`.venv/` 不入库（已在 gitignore，确认一下）。
4. **Git：** 小步 commit；**默认不 push**。
5. **明确不做（本阶段）**
   - 不写视觉规格条目（那是 V1-B 的事）
   - 不改主题、布局、卡片任何渲染代码
   - 不重跑已有的 grok 基准帧（浪费额度）

---

## 阶段开头：上阶段遗留

无（本阶段是本总纲第一个阶段）。

但从 `docs/issue-log/OPEN.md` 带入的既有开放项中，**与本总纲相关**的先登记在册，不在本阶段修复：

| 既有开放项                                                               | 来源               | 处理                   |
| ------------------------------------------------------------------------ | ------------------ | ---------------------- |
| README 三张真机截图未补（不得用 AI 生成或占位图冒充）                    | OPEN.md            | 下放 V4-G2             |
| next 壳真机验收（鼠标/选择复制/IME/主题/fullscreen 往返/Esc 新语义五项） | OPEN.md            | 下放 V4                |
| G-01 `/fullscreen`、G-02 `/minimal` 仍为 🟡                              | refs-grok-build.md | 下放 V4-G3             |
| hermes-agent 参考仓未拉取（fetch 三次 early EOF）                        | OPEN.md            | 与本总纲无关，保持开放 |

---

## 跳过项（因档位未做，非缺陷）

| 跳过项             | 原因                                               | 待补做   |
| ------------------ | -------------------------------------------------- | -------- |
| 代码审查（闸门 4） | 本阶段无代码改动，不适用                           | 不需补做 |
| 单元测试（闸门 2） | 本阶段无代码改动，不适用；但仍须跑一次确认基线干净 | 不需补做 |

---

## 与前后阶段

| 阶段          | 状态 | 交付                                                                    |
| ------------- | ---- | ----------------------------------------------------------------------- |
| （无上阶段）  | ——   | ——                                                                      |
| **V0 本阶段** | ⬜   | diary 补记 7 篇、OPEN.md 归整、grok 缺帧补齐、记分卡骨架、G-8x 冻结标注 |
| V1            |      | 抓屏台增强 + V-* 视觉规格 + 声音提醒（依赖本阶段的缺帧与记分卡骨架）    |

---

## File Structure（预期变更）

| 文件                                                | 动作      | 职责                                                 |
| --------------------------------------------------- | --------- | ---------------------------------------------------- |
| `docs/diary/2026-09-10.md` ~ `2026-09-16.md`        | 新建 7 个 | 补记断更期的每日进展                                 |
| `docs/issue-log/OPEN.md`                            | 修改      | 归整：视觉相关项前置，无关项折叠归档                 |
| `docs/issue-log/2026-09-17.md`                      | 新建      | 本阶段当日问题日志                                   |
| `docs/tui-parity/PARITY-SCORECARD.md`               | 新建      | 复刻吻合度记分卡（骨架 + 肉眼估值 baseline）         |
| `docs/refs/refs-grok-build.md`                      | 修改      | G-8x 剩余 25 条 🟡 标注「本轮冻结」                  |
| `scripts/tui-parity/out/B2-long-code-block/grok/**` | 新建产物  | grok 侧基准帧（不入库）                              |
| `scripts/tui-parity/out/D2-tool-expand/grok/**`     | 新建产物  | grok 侧基准帧（不入库）                              |
| `docs/tui-parity/images/`                           | 新建目录  | 报告用图存放处（从 out/ 手工挑选拷入，**这些入库**） |

---

## Task 1：确认基线干净（**不许跳过**）

**Files:** 无改动

**行为:** 在补账之前先证明仓库当前是干净可构建的，否则后面分不清问题是谁引入的。

**Steps:**

1. 确认工作区干净：

   ```
   cd D:/AI_Projects/harness2
   git status --porcelain
   ```

   期望：**输出为空**。若不为空，先问编排者，不要自行 stash 或丢弃。

2. 创建分支：

   ```
   git checkout -b chore/v0-baseline
   ```

3. 跑类型检查：

   ```
   pnpm -r typecheck
   ```

   期望：exit 0。

4. 跑全量测试并**把统计行完整抄下来**：

   ```
   pnpm test
   ```

   期望：不低于 **1120 passed + 2 skipped**。
   若 cli 包出现 `crash-drill` / `export` / `memory` 三类 spawn 型用例超时，这是**已知限制非缺陷**，用 `--testTimeout=30000` 复跑确认全绿即可，并在日志里如实标注。

5. 记录基线 commit：

   ```
   git rev-parse --short HEAD
   ```

   把这个短 hash 写进本文件的「验收标准总表」第 0 行。

6. 不 commit（本 Task 无文件改动）。

---

## Task 2：补记 `docs/diary/` 2026-09-10 ~ 09-16（共 7 篇）

**Files:** `docs/diary/2026-09-10.md` ~ `docs/diary/2026-09-16.md`

**背景（必须理解，否则会写成废话）：** `docs/diary/` 最后一篇是 `2026-09-09.md`，但代码提交一路到 09-16（最后一次提交 `📝docs(p12): 登记 C6——背景色与逐字符匹配高亮`）。**日志断了整整 7 天，而领导 init 需求第 6 条明确要求「每日日志要写清楚」。** 这 7 天的空白极可能就是领导「看不见进展 / 感觉一塌糊涂」的情绪起点。这个 Task 的价值不是形式主义，是**止血**。

**行为:** 从 git log 反推每天实际做了什么，逐日补写。

**Steps:**

1. 先看已有 diary 的格式，**照抄它的结构，不要自创**：

   ```
   cat docs/diary/2026-09-09.md
   ```

2. 按天导出提交记录：

   ```
   git log --since=2026-09-10 --until=2026-09-17 --date=short --pretty=format:"%ad %h %s" --reverse
   ```

3. 对每一天，额外拉出改动文件范围帮助判断性质：

   ```
   git log --since=2026-09-10 --until=2026-09-11 --name-only --pretty=format:"=== %h %s"
   ```

   （逐日调整 since/until）

4. 每篇 diary 至少包含四段（沿用已有格式）：
   - **当日做了什么**（从 commit 主题归纳，不要逐条罗列 commit）
   - **遇到的问题与怎么解的**（从 `docs/issue-log/` 对应日期文件交叉参考；若该日无 issue-log，写「当日无登记问题」）
   - **验证情况**（当日是否跑过测试/CI，能查到就写，查不到写「当日未留验证记录」）
   - **遗留**（结转到次日的事）

5. **诚实红线：** 反推不出来的细节**写「无记录」**，严禁编造。这份日志是给领导看的，编造一处就全盘失信。若某天没有任何提交，就写「当日无提交」，并注明是休息日还是空转。

6. 每篇写完自查：这篇如果领导直接拿去写 release note，够用吗？不够用就补。

7. Commit：
   ```
   git add docs/diary
   git commit -m "📝docs(diary): 补记 09-10 至 09-16 断更日志"
   ```

---

## Task 3：归整 `docs/issue-log/OPEN.md`

**Files:** `docs/issue-log/OPEN.md`

**行为:** OPEN.md 现在是一份混杂了「发布准备」「真机验收」「解冻窗口」「参考仓拉取」的长清单，开工的人读完不知道该干什么。归整成「本总纲相关 / 其他开放项」两大块。

**Steps:**

1. 通读 OPEN.md 全文，逐项打标签：
   - `[V-相关]`：与视觉复刻总纲相关（真机验收、截图、G-1x、主题、布局）
   - `[其他]`：与本总纲无关（v1.0.0 发布、QQ/飞书联调、云端 key、hermes 参考仓、subagent_continue 等）

2. 重排结构为：

   ```
   ## 一、视觉复刻总纲（V0–V6）相关开放项
   （逐项，每项注明「归属阶段」，如 → V4-G2）

   ## 二、其他开放项（本总纲期间保持挂账，不推进）
   （原文保留，不删）

   ## 三、已关闭（本轮）
   ```

3. **只重排和加标注，不删任何开放项。** 删条目需人类授权。

4. 在文件顶部加一句导航：

   ```
   > 当前主推进方向：视觉复刻总纲 V0–V6，见 docs/ai-framework/plans/2026-09-17-visual-parity-program.md
   > 第二节「其他开放项」在本总纲期间挂账，勿自行开工。
   ```

5. Commit：
   ```
   git add docs/issue-log/OPEN.md
   git commit -m "📝docs(issue-log): 按视觉复刻总纲归整开放事项索引"
   ```

---

## Task 4：补抓 grok 侧缺失基准帧（B2、D2）

**Files:** 产物落 `scripts/tui-parity/out/`（不入库）

**背景：** `out/` 下 grok 侧基准帧已有 13 个场景，**只缺两个**：

```
B2-long-code-block   ours=1  grok=0   ← 缺
D2-tool-expand       ours=3  grok=0   ← 缺
```

没有 grok 侧基准帧，这两个场景就永远无法算吻合度。**这是后续所有阶段的数据前提，必须现在补。**

**Steps:**

1. 先读抓屏台 README 的额度约束章节，**理解为什么 grok 侧默认禁止**：

   ```
   cd D:/AI_Projects/harness2/scripts/tui-parity
   ```

   要点：我方一律 `--provider mock`（零成本）；grok 侧要花真实额度，须显式 `--allow-grok`，`--grok-budget` 默认 1。

2. 确认 grok 可执行文件存在（占位符 `${GROK}` 解析来源）：

   ```
   where grok
   ```

   找不到则检查 `~/.grok/bin/grok.exe`。**grok 侧不隔离 HOME**（需要 `~/.grok` 下的登录凭据），只用 `--cwd` 隔离工作目录 —— 不要试图改这一点。

3. 列出场景确认 id 拼写：

   ```
   .venv/Scripts/python.exe run.py --list
   ```

4. 抓 B2：

   ```
   .venv/Scripts/python.exe run.py scenarios/B2-long-code-block.json --side grok --allow-grok --grok-budget 1
   ```

5. 抓 D2：

   ```
   .venv/Scripts/python.exe run.py scenarios/D2-tool-expand.json --side grok --allow-grok --grok-budget 1
   ```

6. **逐项校验产物质量**（这一步最容易被偷懒跳过，别跳）：
   - `out/<场景>/grok/` 下每帧都有 `.png` + `.txt` + `log.json` 三件套
   - 打开 `log.json`，确认 `settled: true`（不是超时强杀）
   - 打开 `.txt`，确认**不是空白屏**。抓屏台有个已知坑：node 冷启动约 4s 才出首帧，容易把空白屏误判为「稳定」。若抓到空白，加参数重抓：
     ```
     --require-content --stable-seconds 3.0
     ```
   - 退出码含义：`0` 成功 / `2` 超时强杀 / `1` 异常

7. 若 grok 侧连抓失败（登录过期、额度用尽、上游行为变化）：
   - **不要反复重试烧额度**，最多 2 次
   - 如实登记进 `docs/issue-log/2026-09-17.md` 与 OPEN.md，标注「需领导授权放开 `--grok-budget`」
   - 该场景在记分卡里标 **「缺基准帧，无法评分」**，不要填估值糊过去

8. 从产物里挑 2 张最有代表性的 PNG 拷进 `docs/tui-parity/images/`（这些入库，供报告引用）。

9. Commit（只提交拷入 images 的图与日志，out/ 不入库）：
   ```
   git add docs/tui-parity/images docs/issue-log/2026-09-17.md
   git commit -m "🔧chore(tui-parity): 补齐 B2/D2 场景 grok 侧基准帧"
   ```

---

## Task 5：建立 `PARITY-SCORECARD.md` 骨架

**Files:** `docs/tui-parity/PARITY-SCORECARD.md`（新建）

**行为:** 这份文件是**给领导看的唯一验收界面**。V0 阶段只建骨架 + 填肉眼估值作为 baseline，真实数字要等 V1-A 的 `diff.py` 出来才能自动算。

**Steps:**

1. 新建文件，结构如下（**表格列不许改，后续阶段要往同一张表里填**）：

   ```markdown
   # grok TUI 复刻吻合度记分卡

   > 数据来源：scripts/tui-parity 抓屏台的 .txt 屏幕网格逐格比对。
   > 诚实边界：PNG 为 ConPTY 抓屏 + 本地重绘，非系统级窗口截图；
   > 字体度量/字距/抗锯齿/光标/配色与真机有差异。**结论以 .txt 为准。**
   > 鼠标拖拽、选择复制、IME、系统字体不在抓屏覆盖范围，须真机验收（V4）。

   ## 当前总分

   | 指标         | V0 基线      | V1  | V2  | V3  | V4  | V5  | 目标  |
   | ------------ | ------------ | --- | --- | --- | --- | --- | ----- |
   | 字符吻合度   | （肉眼估值） |     |     |     |     |     | ≥ 93% |
   | 配色吻合度   | （肉眼估值） |     |     |     |     |     | ≥ 90% |
   | 已评分场景数 | /15          |     |     |     |     |     | 15/15 |

   ## 逐场景明细

   | 场景 id              | 我方帧数 | grok 帧数 | 字符吻合度 | 配色吻合度 | 主要差异      | 状态            |
   | -------------------- | -------- | --------- | ---------- | ---------- | ------------- | --------------- |
   | A1-cold-start        | 1        | 1         |            |            |               |                 |
   | A2-resume-session    | 0        | 0         | ——         | ——         | mock 无法复现 | 🚫 defined_only |
   | B1-stream-midshot    | 3        | 3         |            |            |               |                 |
   | B2-long-code-block   | 1        | （V0 补） |            |            |               |                 |
   | C1-slash-candidates  | 2        | 2         |            |            |               |                 |
   | C2-help-and-unknown  | 2        | 2         |            |            |               |                 |
   | D1-tool-cards        | 1        | 2         |            |            |               |                 |
   | D2-tool-expand       | 3        | （V0 补） |            |            |               |                 |
   | E1-approval-card     | 0        | 0         | ——         | ——         | mock 自动放行 | 🚫 defined_only |
   | F1-subagent-dispatch | 1        | 2         |            |            |               |                 |
   | G1-status-line       | 2        | 2         |            |            |               |                 |
   | I1-undo-redo         | 3        | 3         |            |            |               |                 |
   | J1-busy-queue        | 2        | 2         |            |            |               |                 |
   | K1-canvas-110x30     | 2        | 2         |            |            |               |                 |
   | K2-canvas-160x40     | 2        | 2         |            |            |               |                 |
   | L1-tool-failure      | 1        | 1         |            |            |               |                 |

   ## 豁免格清单（合理差异，不计入分母）

   | 场景 | 位置 | 差异内容 | 豁免理由 |
   | ---- | ---- | -------- | -------- |
   |      |      |          |          |

   ## 真机遗留（抓屏覆盖不到）

   | 项                  | 状态 | 归属阶段 |
   | ------------------- | ---- | -------- |
   | 鼠标拖拽 / 选择复制 | ⬜   | V4       |
   | IME 输入            | ⬜   | V4       |
   | 系统字体观感        | ⬜   | V4       |
   | alt-screen 切换     | ⬜   | V4       |
   ```

2. 打开每个场景两侧的 `.txt`，**肉眼过一遍**，在 V0 基线列填一个粗估值（写成 `~70%` 这种形式，明确标注是估值）。这个 baseline 的意义是让后续阶段能显示「涨了多少」。

3. 「主要差异」列用一句话写清最刺眼的不同（例如「边框用直角，grok 用圆角」「状态行字段顺序不同」）。这些一句话**就是 V1-B 写 V-\* 条目的原始素材**，写得越具体，V1 越省力。

4. Commit：
   ```
   git add docs/tui-parity/PARITY-SCORECARD.md
   git commit -m "📝docs(tui-parity): 建立复刻吻合度记分卡骨架"
   ```

---

## Task 6：冻结 G-8x 剩余斜杠命令条目

**Files:** `docs/refs/refs-grok-build.md`

**行为:** G-8x 分组 41 条斜杠命令里还有 25 条 🟡。这些是**领导看不见的无底洞**，本总纲期间不投人力。要在文档里明确标注，避免同事顺手去做。

**Steps:**

1. 定位 G-50 ~ G-90 区间的矩阵表。

2. 对其中状态为 🟡 的条目，在备注列追加：

   ```
   （2026-09-17 本轮冻结：视觉复刻总纲 V0–V6 期间不排期，收口后重评）
   ```

   **不要改状态图标**——它们确实是 🟡，改成 ➖ 会失真。只加备注。

3. 在文件的分组索引表 G-8x 行加一句：

   ```
   > 本轮冻结，见 docs/ai-framework/plans/2026-09-17-visual-parity-program.md §1.2 非目标
   ```

4. Commit：
   ```
   git add docs/refs/refs-grok-build.md
   git commit -m "📝docs(refs): 标注 G-8x 剩余条目本轮冻结"
   ```

---

## Task 7：写当日 issue-log 与 diary

**Files:** `docs/issue-log/2026-09-17.md`、`docs/diary/2026-09-17.md`

**Steps:**

1. `docs/issue-log/2026-09-17.md` 按四段格式（描述 / 分析 / 修改结果 / 状态）记录本阶段每个 Task 的执行情况，特别是 Task 4 若有抓屏失败必须如实登记。

2. `docs/diary/2026-09-17.md` 记录本阶段整体。

3. Commit：
   ```
   git add docs/issue-log docs/diary
   git commit -m "📝docs(log): 登记 V0 阶段执行记录"
   ```

---

## 代码审查（阶段级环节）

**本阶段无生产代码改动，代码审查标注「不适用」。**

但需做一次**文档自查**（执行者自己做，编排者复核）：

| 自查项                       | 结论 | 说明                                        |
| ---------------------------- | ---- | ------------------------------------------- |
| diary 7 篇是否有编造内容     |      | 反推不出的必须写「无记录」                  |
| OPEN.md 是否删了任何开放项   |      | 只许重排加标注，不许删                      |
| 记分卡估值是否明确标注为估值 |      | 不许让估值看起来像实测                      |
| 是否误改了 `packages/**`     |      | `git diff --stat main -- packages` 必须为空 |
| 抓屏产物是否被误入库         |      | `git status` 里不应出现 `out/`、`.venv/`    |

---

## 验收标准总表

| #   | 标准           | 通过条件                                                                                                                                      | 验证责任人                  |
| --- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 0   | 基线记录       | Task 1 的基线 commit 短 hash 已回填本文件                                                                                                     | 执行方                      |
| 1   | 构建 + 类型    | `pnpm -r typecheck` exit 0                                                                                                                    | 执行方                      |
| 2   | 测试基线未退化 | `pnpm test` 不低于 1120 passed + 2 skipped                                                                                                    | 执行方                      |
| 2b  | 代码审查       | **不适用**（无代码改动），文档自查表已填                                                                                                      | 执行方 + 编排者复核         |
| 3   | diary 补齐     | `docs/diary/` 存在 2026-09-10 ~ 09-17 共 8 篇，无编造                                                                                         | **编排者亲自抽查 3 篇**     |
| 4   | OPEN.md 归整   | 两大块结构成立；开放项条数不减少                                                                                                              | 编排者                      |
| 5   | grok 缺帧补齐  | `out/B2-long-code-block/grok/`、`out/D2-tool-expand/grok/` 各有完整三件套且 `settled:true`；**或**失败已如实登记并在记分卡标「缺基准帧」      | **编排者亲自核对 log.json** |
| 6   | 记分卡骨架     | `docs/tui-parity/PARITY-SCORECARD.md` 存在，15 场景行齐全，估值列已填且标注为估值                                                             | 编排者                      |
| 7   | G-8x 冻结标注  | 25 条 🟡 均有冻结备注，状态图标未被篡改                                                                                                       | 编排者                      |
| 8   | 红线核查       | `git diff --stat main -- packages/core packages/gateway` 为空；`api-surface-baseline.json` 0 行 diff；`git diff --stat main -- packages` 为空 | 编排者                      |
| 9   | 密钥           | `git ls-files` 无敏感文件；`out/`、`.venv/` 未入库                                                                                            | 执行方                      |

---

## 风险与降级

| 风险                                 | 缓解                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| grok 登录凭据过期，Task 4 抓不到     | 最多重试 2 次；失败即如实登记并请领导授权，**不要伪造帧或跳过记分**               |
| diary 反推困难，同事倾向于编造凑字数 | 明确告知：编造一处全盘失信。`无记录` 是合法答案，且比编造好一百倍                 |
| 同事觉得「纯写文档没意义」而草率完成 | 在交接提示词里说明：这 7 天日志空白是领导不满的情绪起点，是本总纲最高性价比的一步 |
| 误改 packages 导致后续分不清责任     | 验收标准 8 强制 `git diff --stat main -- packages` 为空                           |

---

## 给接手 AI / 同事的完整提示词

将下面整段粘贴给执行者即可开工：

---

你是负责 **harness2** 阶段 V0 的执行代理。请**完整执行本阶段**，不要只写方案。

### 基线

- 目录：`D:/AI_Projects/harness2`
- 从 `main` 创建并切换：`chore/v0-baseline`
- 唯一实施计划：`docs/ai-framework/plans/2026-09-17-phase-V0-baseline.md`
- 总纲（含铁律）：`docs/ai-framework/plans/2026-09-17-visual-parity-program.md`
- 必读：`docs/issue-log/OPEN.md`、`docs/issue-log/README.md`、`scripts/tui-parity/README.md`、`AGENTS.md`

### 本阶段性质（重要，先理解再动手）

这是**纯补账阶段，不写一行生产代码**。目的有两个：

1. 补上断更 7 天的 `docs/diary/`。领导 init 需求第 6 条明确要求每日日志，而日志停在 09-09、提交却到了 09-16。这 7 天空白很可能就是领导「看不见进展、感觉一塌糊涂」的情绪起点。这是整个总纲里**性价比最高的一步**，不是形式主义。
2. 补齐 grok 侧缺失的 2 个场景基准帧（`B2-long-code-block`、`D2-tool-expand`）。没有基准帧，这两个场景永远算不出吻合度，后面所有阶段都少两块拼图。

### 做

1. Task 1：确认基线干净（`git status` 空、`pnpm -r typecheck` 过、`pnpm test` 不低于 1120 passed + 2 skipped），记下基线 commit 短 hash 回填计划文件。
2. Task 2：从 `git log` 反推，补写 `docs/diary/2026-09-10.md` ~ `2026-09-16.md` 共 7 篇。照抄 `2026-09-09.md` 的既有格式。
3. Task 3：归整 `docs/issue-log/OPEN.md` 为「视觉总纲相关 / 其他开放项 / 已关闭」三块，只重排加标注。
4. Task 4：用抓屏台补抓 B2、D2 两个场景的 grok 侧基准帧，逐项校验产物质量。
5. Task 5：新建 `docs/tui-parity/PARITY-SCORECARD.md`，按计划里给定的表格结构建骨架并填肉眼估值 baseline。
6. Task 6：在 `docs/refs/refs-grok-build.md` 给 G-8x 剩余 25 条 🟡 加「本轮冻结」备注，**不改状态图标**。
7. Task 7：写 `docs/issue-log/2026-09-17.md` 与 `docs/diary/2026-09-17.md`。

### 不做

- ❌ **不修改 `packages/**` 下任何文件**，一行都不行
- ❌ 不删 OPEN.md 里任何开放项（只许重排、加标注）
- ❌ 不重跑已有的 13 个场景 grok 侧基准帧（浪费额度）
- ❌ 不反复重试 grok 抓屏（最多 2 次，失败就如实登记）
- ❌ 不写 V-* 视觉规格条目（那是 V1-B 的任务）
- ❌ 不提交密钥；不做未授权的 `git push`

### 三条诚实红线（违反即整阶段作废）

1. diary 反推不出来的细节**写「无记录」**，严禁编造。这份日志领导会直接看。
2. 记分卡的肉眼估值必须**显式标注为估值**（写成 `~70%`），不许让它看起来像实测数据。
3. 抓屏失败就是失败，标「缺基准帧，无法评分」，不许填估值糊过去，更不许用 AI 生成图或占位图冒充。

### 工作方式

1. 先跑基线测试确认干净，再动手。
2. **严格按 Task 1→7 顺序**；每个 Task 完成后按计划里给出的 commit 信息提交。
3. 证据优先：交卷前必须重跑验收标准总表里的所有命令，**贴出真实输出**。禁止「应该能过」。
4. 用简体中文回复进度；代码标识符、文件路径保持原样。

### 交卷

全部完成后给出：

- 分支名与提交列表（`git log --oneline main..HEAD`）
- 验收标准总表逐项自评（含真实命令输出）
- Task 4 抓屏产物的 `log.json` 里 `settled` 字段实际值
- `git diff --stat main -- packages` 输出（必须为空）
- 残留风险与遗留项（要进 OPEN.md 的）

现在开始：读完本阶段计划与总纲，从 Task 1 执行到 Task 7。

---

## 残留手工验收清单

1. 编排者抽查 3 篇 diary，确认无编造、可直接用于写 release note。
2. 编排者亲自打开 `out/B2-long-code-block/grok/*.txt` 与 `out/D2-tool-expand/grok/*.txt`，确认不是空白屏。
3. 编排者确认记分卡的 15 个场景行与 `scripts/tui-parity/scenarios/` 实际文件一一对应（场景总数以实际目录为准，若不是 15 个，以实际为准并修正记分卡）。
