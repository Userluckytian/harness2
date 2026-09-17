# 阶段 V1：视觉真相提取 —— 把「像不像」变成可算的数字

> **状态：** 计划已就绪
> **For agentic workers:** 本阶段有 **三条并行轨道**，每条轨道一个执行者、一个分支。你只执行**分配给你那一条轨道**的 Task。
> **交接提示词** 见文末（三份，各轨一份）。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`
> **所属总纲:** `docs/ai-framework/plans/2026-09-17-visual-parity-program.md`

**Goal:** 建立「视觉复刻」的两个基础设施——可量化的 diff 工具链，以及可执行的 `V-*` 视觉规格；同时用声音提醒先把领导点名的需求落一条地。
**Architecture:** V1-A 只动 `scripts/tui-parity/`（Python）；V1-B 只动 `docs/`；V1-C 只动 `packages/cli/src/tui/notify.ts` 及其测试。**三轨文件交集为 0。**
**Tech Stack:** Python 3 + pyte（抓屏台）、Markdown、TypeScript + vitest
**实施档位：** 全能
**子代理：** 启用（代码审查与阶段验收由独立角色做）

---

## 前置阅读（必须，按轨道取）

| 优先级 | 文件                                                          | 适用轨道 |
| ------ | ------------------------------------------------------------- | -------- |
| P0     | `docs/ai-framework/plans/2026-09-17-visual-parity-program.md` | 全部     |
| P0     | 本文件                                                        | 全部     |
| P0     | `docs/issue-log/OPEN.md`                                      | 全部     |
| P0     | `docs/tui-parity/PARITY-SCORECARD.md`（V0 产出）              | 全部     |
| P0     | `scripts/tui-parity/README.md` 全文                           | A 轨     |
| P0     | `scripts/tui-parity/ptycap.py`、`run.py`                      | A 轨     |
| P0     | `docs/refs/refs-grok-build.md`（重点看格式与 G-01~G-06）      | B 轨     |
| P0     | `docs/refs/README.md` §2 六步流程                             | B 轨     |
| P0     | `packages/cli/src/tui/notify.ts`                              | C 轨     |
| P1     | `AGENTS.md`、`CODE_REVIEW.md`                                 | 全部     |

**仓库路径：** `D:/AI_Projects/harness2`
**基线分支：** 三轨均从 **V0 合入后的 main** 分别拉：

| 轨道 | 分支                     |
| ---- | ------------------------ |
| A    | `feat/v1-a-ptycap-color` |
| B    | `feat/v1-b-visual-spec`  |
| C    | `feat/v1-c-sound-notify` |

---

## Global Constraints（冲突时以本节为准）

1. **不得修改 `packages/core/**`、`packages/gateway/**`**（契约冻结，冻结 commit `3c9b31f`）。越界信号＝`packages/core/test/fixtures/api-surface-baseline.json` 发生变化。
2. **三轨文件交集必须为 0**：
   - A 轨只动 `scripts/tui-parity/**`
   - B 轨只动 `docs/**`
   - C 轨只动 `packages/cli/src/tui/notify.ts`、`packages/cli/src/tui/commands/**`（仅新增命令注册）、`packages/cli/test/**`、配置 schema 相关文件
3. **`packages/cli/src/tui/next/next-shell.ts`（236KB）本阶段三轨均不得修改。** 若 C 轨发现必须改它才能接回合结束事件，**停下来问编排者**，不要自行动手。
4. 密钥不进 git；`scripts/tui-parity/out/`、`.venv/` 不入库。
5. **Git：** 小步 commit；**默认不 push**。
6. **明确不做（本阶段）**
   - ❌ 不实现主题引擎（V2-D）
   - ❌ 不改布局几何（V2-E）
   - ❌ 不改卡片/图标/spinner 渲染（V3）
   - ❌ 不做宠物（V5-F）、不做 codemap（V6）
   - ❌ 不追 G-8x 斜杠命令（已冻结）

---

## 阶段开头：上阶段（V0）遗留

> **规则：** 把 V0 验收表中 ⬜/❌ 项**原文抄入下表**，注明来源与原因。**本阶段开工第一件事是修它们并回归，全部通过后才允许做本阶段新任务。** 若无遗留写「无」。

| 上阶段遗留项               | 来源（测试/验证/审查） | 未通过原因 | 负责轨道 | 状态      |
| -------------------------- | ---------------------- | ---------- | -------- | --------- |
| （编排者在 V0 验收后填入） |                        |            |          | ⬜ 待修复 |

**已预知的高概率遗留项**（若 V0 确实发生，按此处理）：

| 可能的 V0 遗留                                           | 本阶段处理方式                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `B2` / `D2` 的 grok 基准帧抓取失败（登录过期或额度用尽） | A 轨 Task A0 再试一次（仅一次）；仍失败则在记分卡标「缺基准帧」并请领导授权放开 `--grok-budget`，**不阻塞其余任务** |
| diary 补记被编排者抽查出编造内容                         | 本阶段开工前必须改完，这是诚实红线问题，**优先级高于一切新任务**                                                    |
| 记分卡场景行与 `scenarios/` 实际文件不对应               | B 轨 Task B0 校正                                                                                                   |

---

## 跳过项（因档位未做，非缺陷）

| 跳过项             | 原因 | 待补做 |
| ------------------ | ---- | ------ |
| （执行者自行登记） |      |        |

---

## 与前后阶段

| 阶段          | 状态       | 交付                                                                                     |
| ------------- | ---------- | ---------------------------------------------------------------------------------------- |
| V0            | （待验收） | diary 补记、OPEN.md 归整、grok 缺帧补齐、记分卡骨架                                      |
| **V1 本阶段** | ⬜         | `diff.py` 工具链、grok 实测调色板、`refs-grok-visual.md` V-* 规格、声音提醒上线          |
| V2            |            | 主题引擎（用 A 轨的调色板）+ 布局骨架（用 B 轨的 V-1x 条目）。**两者都硬依赖本阶段产出** |

---

# 轨道 A：抓屏台增强（执行者 A）

**分支：** `feat/v1-a-ptycap-color`
**只动：** `scripts/tui-parity/**`

## 轨道 A 背景（先读懂再动手）

我们需要 grok 的真实配色。直觉上应该去 Rust 源码里找，**但已经核实这条路不通**：

```
crates/codegen/xai-grok-pager/src/slash/commands/theme.rs  （26KB）
  → hex 色值：0 个
  → Rgb( ：0 个
```

颜色不硬编码在那里。能从源码确定的只有主题名单：

```
groknight（默认暗色）· grokday · tokyonight · terminal（跟随终端原生）· transparent · auto / system
```

**所以改走另一条路：从抓屏里提取。** 抓屏台用的 `pyte` 终端仿真在解析 ANSI 后，**每个 cell 都带前景色 / 背景色 / 粗体 / 斜体属性**。我们现在只把 char 写进了 `.txt`，**把颜色扇丢了**。把它们导出来，就能得到 grok 的真实调色板，而且是实测的、不靠猜的。

这条轨道的产出是 **V2-D 主题引擎的唯一数据源**。做不出来，V2 就只能靠猫颜色。

---

## Task A0：基线确认 + V0 遗留修复

**Steps:**

1. ```
   cd D:/AI_Projects/harness2
   git status --porcelain
   git checkout -b feat/v1-a-ptycap-color
   ```

   期望：`git status` 输出为空。

2. 确认抓屏台能跑（我方侧，零成本）：

   ```
   cd scripts/tui-parity
   .venv/Scripts/python.exe run.py --list
   .venv/Scripts/python.exe run.py scenarios/A1-cold-start.json --side ours
   ```

   期望：退出码 0；`out/A1-cold-start/ours/` 下产生 `.png` + `.txt` + `log.json`；`log.json` 中 `settled: true`。

3. 若 V0 遗留表里有「B2/D2 grok 基准帧未补齐」，**再试一次（仅一次）**：

   ```
   .venv/Scripts/python.exe run.py scenarios/B2-long-code-block.json --side grok --allow-grok --grok-budget 1 --require-content --stable-seconds 3.0
   ```

   仍失败则登记到 `docs/issue-log/2026-09-18.md`（按实际日期）并继续往下做，**不要卡在这里**。

4. 不 commit。

---

## Task A1：`ptycap.py` 增加 `--dump-cells`，导出每格颜色

**Files:** `scripts/tui-parity/ptycap.py`

**行为:** 每抓一帧，除现有 `.png` / `.txt` / `log.json` 外，额外产出 `<帧名>.cells.json`。

**输出格式（确定下来，B 轨与 V2 都要读它，不要自创）：**

```json
{
  "cols": 110,
  "rows": 30,
  "cells": [
    [
      { "ch": "╭", "fg": "default", "bg": "default", "bold": false, "italic": false, "reverse": false },
      { "ch": "─", "fg": "#7aa2f7", "bg": "default", "bold": false, "italic": false, "reverse": false }
    ]
  ],
  "colorSpace": "truecolor"
}
```

**Steps:**

1. 先在 `ptycap.py` 里找到写 `.txt` 的那段代码（把 pyte screen 网格转纯文本的地方）。**在它旁边加，不要改它** —— `.txt` 是现有验收基准，改了会把 V0 的 baseline 作废。

2. pyte 的 `screen.buffer[y][x]` 是 `Char` 命名元组，字段包含 `data`、`fg`、`bg`、`bold`、`italic`、`reverse` 等。逐格读出写入 JSON。

3. **关键风险点（必读）：** pyte 对颜色的报告可能是三种形式之一：
   - 颜色名（`"red"`、`"brightblue"`）—— 16 色
   - 256 色索引字符串
   - 真彩 hex

   **不要强行统一成 hex**。原样存下，并在同一份 JSON 里用 `colorSpace` 字段如实标注实际拿到的是哪种（`"named16"` / `"indexed256"` / `"truecolor"`）。

   **这一点必须在轨道交卷时明确报告给编排者**：如果 grok 侧拿到的只是索引色，那么「配色吻合度」这个指标的精度边界就是索引级，不是像素级。这是**诚实边界，必须写进 README 与记分卡**，不得隐瞒。

4. 命令行参数：`--dump-cells`（布尔开关，默认 **关**）。默认关是为了不改变现有调用方的行为。

5. 验证：

   ```
   .venv/Scripts/python.exe run.py scenarios/A1-cold-start.json --side ours --dump-cells
   ```

   期望：`out/A1-cold-start/ours/` 下出现 `*.cells.json`；用 `jq` 或 Python 检查：
   - `cols` × `rows` 与 `.txt` 的实际行列数一致
   - `cells` 的行数 ＝ `rows`，每行长度 ＝ `cols`
   - 至少有一个 cell 的 `fg` 不是 `"default"`（否则说明颜色没读到，这是静默失败，必须查）

6. 回归：不带 `--dump-cells` 重跑一次 A1，确认 `.txt` 产物与改动前 **逐字节一致**（用 `fc` 或 `Compare-Object` 比）。

7. Commit：`✨feat(tui-parity): ptycap 支持 --dump-cells 导出逐格颜色`

---

## Task A2：新增 `diff.py`，计算吻合度

**Files:** `scripts/tui-parity/diff.py`（新建）

**行为:** 读两侧 `.cells.json`，输出吻合度与差异图。

**公式（总纲 §6.2 已定，不要自行改）：**

```
字符吻合度 = 同位置 ch 相同的 cell 数 / 有效 cell 数
配色吻合度 = 同位置 fg 与 bg 均相同的 cell 数 / 有效 cell 数
场景吻合度 = 字符吻合度 × 0.6 + 配色吻合度 × 0.4
有效 cell 数 = 总 cell 数 - 豁免格数
```

**CLI：**

```
python diff.py --scenario A1-cold-start [--frame 0] [--exempt exempt.json] [--heatmap]
```

**Steps:**

1. 输入解析：默认从 `out/<scenario>/ours/` 与 `out/<scenario>/grok/` 取同序号帧。

2. **帧数不等的处理（必须处理，现实中很常见）：** 已知 `D1-tool-cards` 是 ours=1 / grok=2，`F1-subagent-dispatch` 是 ours=1 / grok=2。
   规则：**只比对能配对的帧，多出的帧单独列为「未配对帧」并在报告里明列**。不要静默舍弃，也不要报错退出。

3. 画幅尺寸不等时（`cols`/`rows` 不一致）：直接报错退出，提示“请用相同 `--cols/--rows` 重抓”。默认画布 110×30。

4. 豁免格配置 `exempt.json` 格式：

   ```json
   {
     "A1-cold-start": [{ "row": 2, "colStart": 40, "colEnd": 70, "reason": "版本号与工作目录路径，本就不同" }]
   }
   ```

   豁免格**不计入分母**，但必须在报告里逐条列出 reason。

5. 输出两样东西：
   - **stdout 的 Markdown 片段**，可直接粘进 `PARITY-SCORECARD.md`
   - `--heatmap` 时额外输出 `out/<scenario>/diff-<帧号>.png`：绿＝完全一致、黄＝字符同颜色不同、红＝字符不同、灰＝豁免格

6. **最重要的一段输出：「Top 10 差异区块」** —— 把相邻的差异 cell 聚成矩形区块，按面积降序列出，每块给出：行列范围 + 我方字符串 + grok 字符串。
   这段输出是 _*B 轨写 V-* 条目、V2/V3 排修复优先级的直接依据_*。没有它，后面只能靠肉眼找差异，效率差一个数量级。

7. 验证（三步，都要跑）：
   - **自比必须 100%**：同一个 `.cells.json` 跟自己 diff，字符与配色吻合度必须都是 `100.00%`。这是工具正确性的自测，不过则工具有 bug。
   - 对 `A1-cold-start` 跑真实两侧，确认输出合理（不是 0% 也不是 100%）。
   - 构造一个故意改了 3 个 cell 的副本，确认 diff 精准报出这 3 个位置。**这是变异验证，证明断言不是空转。**

8. Commit：`✨feat(tui-parity): 新增 diff.py 计算字符与配色吻合度`

---

## Task A3：从 grok 抓屏聚合出实测调色板

**Files:** `docs/tui-parity/grok-palette-observed.md`（新建）、`scripts/tui-parity/palette.py`（新建）

> 注意：本 Task 会写一个 `docs/` 下的文件。已与 B 轨错开（B 轨不碰 `docs/tui-parity/`，只动 `docs/refs/`），无冲突。

**行为:** 扫所有 `out/*/grok/*.cells.json`，统计颜色出现频次，输出一张排序色表。

**Steps:**

1. `palette.py` 聚合输出：

   | 颜色值 | 作为 fg 出现次数 | 作为 bg 出现次数 | 典型出现位置（场景 + 行列 + 该处字符串） |
   | ------ | ---------------- | ---------------- | ---------------------------------------- |

2. **「典型出现位置」列最重要**：光有色值没用，V2 需要知道「这个蓝色是用在边框还是用在链接还是用在提示文字」。每个颜色至少给 2 个典型位置例子。

3. 人工归类，写成语义 token 草案（这是给 V2-D 的交付物）：

   ```
   待确认 token 草案（V2-D 按此实现）：
   border.default      = <色值>   依据：A1 第 1 行边框字符
   text.primary        = <色值>   依据：B1 流式正文
   text.dim            = <色值>   依据：G1 状态行次要字段
   accent.primary      = <色值>   依据：C1 候选项选中高亮
   status.success      = <色值>   依据：D1 工具卡片 └ ✓
   status.error        = <色值>   依据：L1 工具失败
   bg.base             = <色值>   依据：任意帧空白区
   ```

   推不出来的 token **写「未观测到」**，不要猜。

4. 在文件开头写清精度边界（取自 Task A1 第 3 步的实测结果）：

   ```
   > 色空间：<named16 / indexed256 / truecolor>
   > 若为索引色，则本表色值为终端调色盘索引，非绝对 RGB；
   > “配色吻合度”指标的精度边界相应为索引级。
   ```

5. Commit：`✨feat(tui-parity): 从 grok 抓屏聚合实测调色板`

---

## Task A4：`run.py` 集成 `--diff`

**Files:** `scripts/tui-parity/run.py`、`scripts/tui-parity/README.md`

**Steps:**

1. `run.py` 新增 `--diff`：跑完自动调 `diff.py`，把 Markdown 片段写到 `out/<scenario>/diff.md`。

2. 新增 `--all-ours`：批量重跑所有非 `defined_only` 场景的我方侧（后续每个阶段收尾都要跑这个做回归）。

3. 更新 README，新增一节「吻合度计算」：公式、`--dump-cells` 用法、`diff.py` 用法、豁免格配置、**颜色精度边界的如实声明**。
   沿用 README 现有的诚实口径，它已经写了「PNG 非系统级截图、结论以 .txt 为准」，把颜色边界按同样风格补上。

4. 验证：

   ```
   .venv/Scripts/python.exe run.py --all-ours --dump-cells --diff
   ```

   期望：退出码 0；每个有两侧数据的场景都生成了 `diff.md`；缺 grok 基准帧的场景输出「缺基准帧，跳过」而**不是报错崩掉**。

5. Commit：`✨feat(tui-parity): run.py 集成 --diff 与 --all-ours`

---

## Task A5：回填记分卡真实数据

**Files:** `docs/tui-parity/PARITY-SCORECARD.md`

> 此文件 V0 已建。B 轨不改它（B 轨只动 `docs/refs/`），所以无冲突。

**Steps:**

1. 把 Task A4 跑出的真实数字填进 `V1` 列，把 V0 的肉眼估值保留在 `V0 基线` 列（别删，趋势要看得见）。

2. 「主要差异」列换成 `diff.py` 输出的 Top 1 差异区块描述。

3. 把每个场景的 Top 10 差异区块汇总成一节「**全局 Top 20 差异**」，按面积降序。
   **这节就是 V2/V3 的派工单。** 写得越具体，后续两个阶段越不会跑偏。

4. Commit：`📝docs(tui-parity): 回填 V1 实测吻合度与 Top 20 差异`

---

# 轨道 B：`V-*` 视觉规格起草（执行者 B）

**分支：** `feat/v1-b-visual-spec`
**只动：** `docs/refs/**`

## 轨道 B 背景（先读懂再动手）

`docs/refs/refs-grok-build.md` 已经是一份很认真的复刻规格，95 条 `G-*`，44 条已完成。但它的 95 条里：

- **87 条是行为**：键位、Esc 语义状态表、斜杠命令、焦点环、队列转向
- **只有 8 条是外观**（G-01~G-06 布局渲染、G-84 `/theme`、G-92 终端原生主题），而 G-1x 这 6 条里 **5 条是 🟡**

**这就是领导不满的真正原因：团队在复刻「手感」，领导在看「长相」。** 两边都很卖力，就是对不上。

你这条轨道的任务就是把缺的那一层补上：**新开一套 `V-*` 视觉规格，只管「长什么样」，不管「怎么操作」。**

关键约束：AGENTS.md 第 7 条明确禁止凭想象设计交互。**每一条 `V-*` 必须有抓屏证据，否则不得写入。**

---

## Task B0：基线确认 + 场景清单校正

**Steps:**

1. ```
   cd D:/AI_Projects/harness2
   git checkout -b feat/v1-b-visual-spec
   ```

2. 核对记分卡里的场景行与实际文件：

   ```
   dir scripts\tui-parity\scenarios
   ```

   若不一致，**以实际目录为准**，并登记为 V0 遗留项（但不要改记分卡，那是 A 轨的文件，**告知编排者即可**）。

3. 通读 `docs/refs/refs-grok-build.md` 的矩阵表格式，**把它的列结构记下来**。你要新建的文件必须照这个格式，团队才能无缝切换。

---

## Task B1：新建 `refs-grok-visual.md` 骨架

**Files:** `docs/refs/refs-grok-visual.md`（新建）

**文件头必须包含（照抄 `refs-grok-build.md` 的字段）：**

```markdown
# grok-build 参考规格：CLI 视觉外观复刻

> 本文是 **视觉外观** 的权威规格，与 `refs-grok-build.md`（**交互行为**规格，G-_）并列。
> 本项目 CLI 出现的任何视觉元素，都必须能在本文找到 V-_ 编号。
> 复刻等级：默认「必刻」。
>
> 分析基线：本地 D:/AI_Projects/refs/grok-build
> 分析 commit：37949780（上游提交时间 2026-09-09T19:03:16Z）
> SOURCE_REV：c4ea71cfdbcdb21e32e41bc25a0043d7d4836714
> 分析日期：2026-09-1X
> 证据来源：scripts/tui-parity/out/<场景>/grok/ 抓屏帧

## 重要：本文的证据规则

1. 每条 V-* 必须填「证据帧」列，格式：`<场景 id>/grok/<帧文件名> 第 N 行第 M-K 列`
2. 无证据的观察**不得写入**。宁可条目少，不可条目虚。
3. 从 Rust 源码推断的内容须在备注标「源码推断，未经抓屏验证」

## 状态图例

✅ 已完成 · 🟡 部分待续 · ⬜ 未排期 · ➖ 不采纳 · 待人类决策

## 分组索引

| 分组 | ID 区间   | 主题                                                            |
| ---- | --------- | --------------------------------------------------------------- |
| V-0x | V-01~V-09 | 全局画布与布局骨架                                              |
| V-1x | V-10~V-19 | 区域尺寸与间距                                                  |
| V-2x | V-20~V-29 | 边框与分隔线                                                    |
| V-3x | V-30~V-39 | 状态图标字形                                                    |
| V-4x | V-40~V-49 | 欢迎屏 / banner                                                 |
| V-5x | V-50~V-59 | 配色语义 token（依据 docs/tui-parity/grok-palette-observed.md） |
| V-6x | V-60~V-69 | 卡片样式                                                        |
| V-7x | V-70~V-79 | 状态行排版                                                      |
| V-8x | V-80~V-89 | 动效（spinner / 流式光标）                                      |

## 矩阵

| ID  | 视觉元素 | grok 表现 | 证据帧 | 我方现状 | 差异 | 验收方式 | 状态 |
| --- | -------- | --------- | ------ | -------- | ---- | -------- | ---- |
```

**Steps:** 先只建骨架与空矩阵，Commit：`📝docs(refs): 新建 grok 视觉外观复刻规格骨架`

---

## Task B2：V-0x / V-1x 布局骨架与区域尺寸

**已知起点（G-04 已确认的八区域清单，直接用，不要重新发明）：**

```
scrollback（主区）· prompt（输入）· status line（可选）· shortcuts bar（焦点提示）
· queue pane · todos pane · tasks pane · overlay modal（命令面板/模型/会话/扩展/设置）
```

**Steps:**

1. 以 `K1-canvas-110x30` 与 `K2-canvas-160x40` 两个画布场景的 grok 帧为主证据（这两个场景就是专门为看布局设的）。

2. 对每个区域逐项量（在 `.txt` 里数行数列，这是最笨也最准的办法）：
   - 起始行 / 结束行（从顶数还是从底数？）
   - 左右边距多少列
   - 与相邻区域之间有几行空行
   - 110×30 与 160×40 两种画布下是**固定行数**还是**比例缩放**

3. 每条写成可执行的断言，例：

   ```
   | V-10 | 状态行位置 | 固定在终端倒数第 2 行，左边距 1 列 | K1/grok/frame-00.txt 第 29 行 | 我方在倒数第 1 行且无左边距 | 位置差 1 行、边距差 1 列 | diff.py 该区域字符吻合度 ≥ 95% | ⬜ |
   ```

4. **重要：不要写「布局应该更紧凑」这种主观评价。** 只写可数的事实。V2-E 的人要拿这些数字直接改 `regions.ts`。

5. Commit：`📝docs(refs): 登记 V-0x/V-1x 布局骨架与区域尺寸`

---

## Task B3：V-2x 边框与分隔线

**Steps:**

1. 从各场景 grok 帧里抓出所有绘制类字符，逐个登记码点：

   ```
   圆角：╭ ╮ ╰ ╯      直角：┌ ┐ └ ┘
   直线：─ │          粗线：━ ┃
   双线：═ ║          三通：├ ┤ ┬ ┴
   ```

   **必须写 Unicode 码点**（如 `U+256D`），不要只写字符 —— 字体渲染会骗人，码点不会。

2. 分别登记：输入框边框、卡片边框、overlay 边框、分隔线、树形缩进（`└` `├` `│`）。

3. 每类边框额外记：是否全包围？只上下？只底线？这决定了视觉重量感，是领导一眼能看出的差别。

4. Commit：`📝docs(refs): 登记 V-2x 边框与分隔线字符集`

---

## Task B4：V-3x 状态图标字形

**已知线索：** 抓屏台 README 提到过关注字形 `⏺` `✓` `└`，字体链里专门做了符号回退（Segoe UI Symbol / Segoe UI Emoji），说明这些字形已经是已知难点。

**Steps:**

1. 逐场景抓图标，按语义分类登记：

   | 语义            | grok 字形 | 码点 | 证据帧 | 我方当前 |
   | --------------- | --------- | ---- | ------ | -------- |
   | 用户消息前缀    |           |      |        |          |
   | 助手消息前缀    |           |      |        |          |
   | 工具调用中      |           |      |        |          |
   | 工具成功        |           |      |        |          |
   | 工具失败        |           |      |        |          |
   | 子项连接符      |           |      |        |          |
   | 折叠收起 / 展开 |           |      |        |          |
   | 待审批          |           |      |        |          |

2. 重点证据帧：`D1-tool-cards`（成功）、`L1-tool-failure`（失败）、`D2-tool-expand`（折叠/展开）。

3. 每个字形额外登记**显示宽度**（占 1 列还是 2 列）。这个很关键：宽度错了会把整行排版顶歪，是最容易被忽略的 bug 源。

4. Commit：`📝docs(refs): 登记 V-3x 状态图标字形与宽度`

---

## Task B5：V-4x 欢迎屏 / banner

**为什么单独一个 Task：** 这是领导**每次开机看到的第一屏**。它的视觉权重远高于它的代码量。不要因为它「只是个欢迎语」就随便写。

**Steps:**

1. 以 `A1-cold-start` 的 grok 帧为唯一证据，逐行拄：
   - 第 1~N 行分别是什么（logo？版本号？提示语？快捷键？）
   - logo 是 ASCII art 还是纯文字？占几行？
   - 居中还是左对齐？
   - 有几行空行？
   - 文字内容逐字拄下来（哪些是可复刻的通用文案，哪些是 grok 专属的品牌文字）

2. **品牌边界（必须处理，别装看不见）：** grok 的名称、logo、品牌文字**不得照抄**。在条目里把这部分标为：

   ```
   ➖ 不采纳（品牌资产）：只复刻排版结构与行数，文字内容用 harness2 自有品牌
   ```

   这条要**写进文档并向领导明确汇报**。领导说「1:1 复刻界面」时很可能没想过这一层，而照抄别人的 logo 是真正的法务风险。先摆到桌面上，比事后被问责好。

3. Commit：`📝docs(refs): 登记 V-4x 欢迎屏排版与品牌边界`

---

## Task B6：V-5x 配色 token（**依赖 A 轨 Task A3**）

**前置：** A 轨的 `docs/tui-parity/grok-palette-observed.md` 已合入。

> 若 A 轨未完成，**跳过本 Task，先做 B7**，并登记为本阶段遗留项带入 V2。不要自己去猜颜色。

**Steps:**

1. 把 A 轨的实测调色板转写成 V-5x 条目，每个 token 一条。

2. 每条写清：token 名 / 色值 / 语义用途 / 证据帧 / 我方当前用什么色。

3. 引用 A 轨声明的色空间精度边界，**不要把索引色写成精确 hex 冒充真彩**。

4. Commit：`📝docs(refs): 登记 V-5x 配色语义 token`

---

## Task B7：V-6x/V-7x/V-8x 卡片·状态行·动效

**Steps:**

1. **V-6x 卡片样式**（证据：`D1-tool-cards`、`D2-tool-expand`、`L1-tool-failure`）：
   头部排版、参数显示方式、摘要行格式、收尾行、折叠态与展开态的行数差、嵌套缩进列数。

2. **V-7x 状态行排版**（证据：`G1-status-line`）：
   字段顺序、分隔符、对齐方式、窗口变窄时的折叠优先级。

   > 注意：G-42~G-49 八条状态行**行为**已经全部 ✅。你这里只管**外观**，不要重复登记行为条目。

3. **V-8x 动效**（证据：`B1-stream-midshot` 三帧）：
   spinner 字形序列、流式光标形状、流式时是否有光标。
   **诚实边界：** 静态帧推不出帧率。帧率条目标 `⬜ 需 V3 阶段补抓连续帧才能确定`，**不要拍一个数字上去**。

4. Commit：`📝docs(refs): 登记 V-6x/V-7x/V-8x 卡片状态行与动效`

---

## Task B8：统计与交叉引用

**Steps:**

1. 在 `refs-grok-visual.md` 分组索引表补齐每组条数与状态分布（照 `refs-grok-build.md` 的写法）。

2. 在 `docs/refs/README.md` 的参考文档清单里新增一行，说明：

   ```
   refs-grok-visual.md —— CLI 视觉外观复刻规格（V-*）。
   与 refs-grok-build.md（交互行为，G-*）并列：改外观查 V-*，改行为查 G-*。
   ```

3. 在 `refs-grok-build.md` 头部加一行指向：

   ```
   > 视觉外观（布局/配色/边框/图标/动效）见 refs-grok-visual.md（V-*）。本文只管交互行为。
   ```

4. Commit：`📝docs(refs): V-* 规格统计与与 G-* 的交叉引用`

---

# 轨道 C：声音提醒（执行者 C）

**分支：** `feat/v1-c-sound-notify`
**只动：** `packages/cli/src/tui/notify.ts`、`packages/cli/src/tui/commands/**`（仅新增命令）、`packages/cli/test/**`、配置 schema

## 轨道 C 背景（先读懂再动手）

领导在 `docs/init-question-log.txt` 里追加的四条体感需求中，有一条是「AI 回复完要有声音提醒」。全仓检索结果：

```
git grep -il "sound"  → 0 命中
git grep -il "声音"  → 0 命中
git grep -il "bell"   → 1 命中
```

**完全没做。** 而前面那九条「内核里看不见的」需求基本全做完了。

这条轨道体量最小（半天到一天），但是**整个总纲里领导最快能感知到的一件事**——他下次打开终端发个消息，回复完响一下，他立刻就知道有人在听他说话。所以把它放在 V1 并行，而不是排到后面。

**不要把它做大。** 不要做音效包、不要做音量控制、不要做自定义音频文件。先把「响一下」做对。

---

## Task C0：基线确认与现状摸底

**Steps:**

1. ```
   cd D:/AI_Projects/harness2
   git checkout -b feat/v1-c-sound-notify
   pnpm --filter harness2 test
   ```

   期望：cli 包 **281 passed + 2 skipped**（若 `crash-drill`/`export`/`memory` 超时，用 `--testTimeout=30000` 复跑，这是已知限制）。

2. 读懂现有通知实现：

   ```
   type packages\cli\src\tui\notify.ts
   ```

   弄清三件事：现在支持哪些通知方式？被谁调用？**回合结束事件从哪里来？**

3. 找到回合结束的事件源：

   ```
   git grep -n "turn-events\|turnEnd\|onTurnEnd" packages/cli/src
   ```

   参考点：`packages/cli/src/tui/turn-events.ts`。

4. **关键判断点：** 如果接回合结束事件**必须**修改 `next-shell.ts`（236KB 巨型文件，本阶段三轨均不得动），**立即停下来问编排者**，不要自行动手。编排者会判定是开例外还是改接入点。

5. 不 commit。

---

## Task C1：声音通道实现

**Files:** `packages/cli/src/tui/notify.ts`

**Steps:**

1. 实现 `playNotifySound(reason)`：向 stdout 写终端 BEL 控制符（ASCII 0x07）。用 `String.fromCharCode(7)` 或等价写法。

2. **四个必须的静默条件**（缺一个就会成为扰民功能，领导会更生气）：
   - 非 TTY（`!process.stdout.isTTY`）→ 不发。piped stdin 场景不能向管道写 BEL。
   - 配置关闭 → 不发。
   - 连续触发去重 → 同一 reason 最小间隔 **3000ms**。
   - `reason` 不在配置的 `sound_on` 集合里 → 不发。

3. `reason` 枚举：`"turn-end"` / `"approval"` / `"error"`。

4. **不要引入任何新依赖。** 红线上有一条「依赖变更需审查」，BEL 不需要任何包。系统声音（PowerShell / 音频文件）一律**不做**，登记为后续可选。

5. Commit：`✨feat(cli): 回合结束声音提醒（终端 BEL）`

---

## Task C2：配置项

**Steps:**

1. 新增配置：

   ```
   [ui.notify]
   sound = true            # 默认开（领导点名要的功能，不要默认关）
   sound_on = "turn-end"   # turn-end | approval | error | all
   ```

2. 按仓内现有配置模式实现默认值与校验；`harness2 config check` 能识别新键。

3. 更新配置文档（仓内已有配置参考文档的话同步补上）。

4. **注意：** 如果配置 schema 类型定义在 `packages/core`（冻结区），**停下来问编排者**，不要自行动冻结区。

5. 验证：

   ```
   node packages/cli/dist/index.js config check
   ```

   期望：exit 0，无未知配置键警告。

6. Commit：`✨feat(cli): 新增 [ui.notify] 声音提醒配置`

---

## Task C3：`/notify-test` 命令

**Steps:**

1. 新增斜杠命令 `/notify-test`：立即触发一次提醒，**绕过去重限制**（否则连按两下不响，用户以为坏了）。

2. 输出一行确认文字，告知当前配置状态（开/关、`sound_on` 值、是否 TTY）。
   这行文字很重要：领导试了没声音时，它能直接告诉他为什么（比如终端自己禁了 bell），而不是让他觉得我们又没做好。

3. 在 `/help` 里露出。

4. Commit：`✨feat(cli): 新增 /notify-test 命令`

---

## Task C4：测试

**Files:** `packages/cli/test/tui/notify-sound.test.ts`（新建）

**至少五个用例（缺一不可）：**

| #   | 用例                                         | 期望     |
| --- | -------------------------------------------- | -------- |
| 1   | `sound = true`、TTY、reason 在集合内         | 写出 BEL |
| 2   | `sound = false`                              | 不写     |
| 3   | 非 TTY                                       | 不写     |
| 4   | 3s 内同 reason 连续两次                      | 只写一次 |
| 5   | `sound_on = "error"` 但 reason 是 `turn-end` | 不写     |

**Steps:**

1. 用仓内现有的 stdout mock 手法，**不要真向终端写** —— 否则跑测试会响一片。

2. 去重用例用假时铟（fake timers），不要真 `sleep(3000)`。

3. **变异验证（必做，写进交卷报告）：** 把去重逻辑临时删掉，确认用例 4 必红；把 TTY 判断删掉，确认用例 3 必红。然后恢复。这证明断言不是空转。

4. 验证：

   ```
   pnpm --filter harness2 test
   ```

   期望：不低于 281 passed + 2 skipped，**且新增 ≥ 5 个**。

5. Commit：`✅test(cli): 声音提醒单元测试`

---

## Task C5：真机试听（人工）

**Steps:**

1. ```
   pnpm build
   node packages/cli/dist/index.js chat --provider mock
   ```
2. 在 Windows Terminal 里发一条消息，确认回复完响了。
3. 试 `/notify-test`。
4. 试关闭配置后不响。
5. **如实记录结果**。如果 Windows Terminal 本身禁了 bell（设置里可关），这是**环境限制不是缺陷**，写进文档并在 `/notify-test` 的提示文字里提醒用户检查终端设置。
6. 写进 `docs/issue-log/`。

---

# 阶段级环节（三轨全合入后，编排者执行）

## 代码审查

**审查方：** 独立子代理（非 A/B/C 任何一人），按 `CODE_REVIEW.md` 出 P0/P1/P2。

**每轨分别审，结论分开登记：**

| 审查面                       | A 轨                     | B 轨                  | C 轨                 |
| ---------------------------- | ------------------------ | --------------------- | -------------------- |
| 代码风格                     |                          | ——（纯文档）          |                      |
| 测试完整性                   |                          | ——                    |                      |
| 依赖与架构红线               |                          | ——                    |                      |
| 安全（密钥/注入/越权）       |                          |                       |                      |
| API 契约一致性               | ——                       | ——                    |                      |
| **诚实性审查**（本阶段特有） | 颜色精度边界是否如实声明 | 每条 V-* 是否有证据帧 | 环境限制是否如实记录 |

**B 轨的诚实性审查是硬要求：** 审查者要**随机抽 5 条 V-\***，打开它声称的证据帧文件，数到那一行那一列，确认描述属实。对不上即判 **P0**。

**结论：** ✅ 通过 / ⚠️ 有条件通过（问题进验收表）/ ❌ 不通过（阻塞，下放 V2）

---

## 验收标准总表

| #   | 标准                | 通过条件                                                                                             | 验证责任人         |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------- | ------------------ |
| 1   | 构建 + 类型         | `pnpm -r typecheck` exit 0；`pnpm build` exit 0                                                      | 执行方             |
| 2   | 单元测试            | `pnpm test` 不低于 1120 passed + 2 skipped；cli 包新增 ≥ 5 用例                                      | 执行方             |
| 2b  | 代码审查            | 三轨均 ✅ 或 ⚠️（问题已登记）；无 P0/P1                                                              | 独立子代理         |
| 3   | `--dump-cells` 可用 | 跑 A1 产出 `.cells.json`，行列数与 `.txt` 一致，且至少一个 cell 的 fg 非 default                     | **编排者亲自重跑** |
| 4   | `diff.py` 自比 100% | 同一份 `.cells.json` 自比，字符与配色吻合度均为 `100.00%`                                            | **编排者亲自重跑** |
| 5   | `diff.py` 变异验证  | 故意改 3 个 cell 的副本，diff 精准报出这 3 个位置                                                    | **编排者亲自重跑** |
| 6   | 帧数不等不崩        | `D1-tool-cards`、`F1-subagent-dispatch`（ours/grok 帧数不等）能出结果并列出「未配对帧」              | 编排者             |
| 7   | 实测调色板          | `docs/tui-parity/grok-palette-observed.md` 存在；每色至少 2 个典型位置例子；色空间精度边界已如实声明 | 编排者             |
| 8   | 记分卡回填          | `PARITY-SCORECARD.md` 的 V1 列为实测数字（非估值）；V0 估值列保留；含「全局 Top 20 差异」一节        | 编排者             |
| 9   | V-* 规格条数        | `refs-grok-visual.md` 条目 ≥ 35 条，且 V-0x/V-1x/V-2x/V-3x/V-4x 五组均非空                           | 编排者             |
| 10  | V-* 证据率          | **抽 5 条逐个核对证据帧行列坐标，全部属实**；任一条对不上即整轨打回                                  | **编排者亲自核对** |
| 11  | 品牌边界            | V-4x 中 grok logo/名称/品牌文字已标 ➖ 不采纳，并已向领导汇报                                        | 编排者             |
| 12  | 声音提醒可用        | 真机 `chat --provider mock` 回复完响一次；`/notify-test` 可用并输出配置状态行                        | **编排者亲自试听** |
| 13  | 声音静音条件        | 非 TTY 不响、配置关闭不响、3s 去重生效 —— 三条均有单测覆盖且变异验证通过                             | 执行者 C + 编排者  |
| 14  | 冻结区零改动        | `git diff --stat main -- packages/core packages/gateway` 为空；`api-surface-baseline.json` 0 行 diff | 编排者             |
| 15  | 巨型文件未动        | `git diff --stat main -- packages/cli/src/tui/next/next-shell.ts` 为空                               | 编排者             |
| 16  | 密钥                | `git ls-files` 无敏感文件；`out/`、`.venv/` 未入库                                                   | 执行者方           |
| 17  | 抓屏回归            | `run.py --all-ours` 全场景 exit 0 且 `settled: true`                                                 | 编排者             |
| 18  | 日志双账本          | `docs/issue-log/` 当日文件 + `docs/diary/` 当日文件均已写                                            | 编排者             |

---

## 风险与降级

| 风险                                                       | 概率   | 缓解                                                                                                                                                                               |
| ---------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pyte 只报索引色，拿不到真彩                                | 中     | **不阻塞**。如实声明精度边界为索引级，V2 按索引色实现主题；记分卡同步标注                                                                                                          |
| grok 侧 `.cells.json` 需重抓全部 13 场景（原帧无颜色数据） | **高** | 这是必然的：`--dump-cells` 是新功能，老帧没有 cells。**需领导授权放开 `--grok-budget`**。若不授权，降级为只抓 4 个关键场景（A1/B1/D1/G1），记分卡只评这 4 个，其余标「缺配色数据」 |
| B 轨条目写成主观评价（"应该更紧凑"）                       | 高     | 验收标准 10 强制抽查证据帧；审查方有权整轨打回                                                                                                                                     |
| C 轨发现必须改 `next-shell.ts`                             | 中     | Task C0 第 4 步强制停下问编排者，不许自行动手                                                                                                                                      |
| 三轨合入冲突                                               | 低     | 文件交集为 0（A→scripts/、B→docs/refs/、C→packages/cli/）。A 轨的 `docs/tui-parity/` 与 B 轨的 `docs/refs/` 也已错开                                                               |
| Windows Terminal 自身禁了 bell，试听无声                   | 中     | 环境限制非缺陷。`/notify-test` 输出配置状态行帮助定位；写进文档                                                                                                                    |
| 执行者觉得「写文档不是干活」草率完成 B 轨                  | 中     | 在 B 轨交接提示词里明确：这一轨是整个总纲的地基，V2/V3 全部按它施工，写虚一条后面就错一片                                                                                          |

---

# 给接手 AI / 同事的完整提示词（三份，各轨一份）

## 【A 轨】抓屏台增强

你是 **harness2** 阶段 V1 轨道 A 的执行代理。请**完整执行**，不要只写方案。

### 基线

- 目录：`D:/AI_Projects/harness2`
- 从 `main` 创建并切换：`feat/v1-a-ptycap-color`
- 唯一实施计划：`docs/ai-framework/plans/2026-09-17-phase-V1-truth-extraction.md`（只做**轨道 A** 的 Task A0~A5）
- 总纲（含铁律与吻合度公式）：`docs/ai-framework/plans/2026-09-17-visual-parity-program.md`
- 必读：`scripts/tui-parity/README.md` 全文、`scripts/tui-parity/ptycap.py`、`run.py`、`AGENTS.md`

### 你这条轨道为什么存在

领导要求 1:1 复刻 grok 的 TUI 外观。要复刻配色，先得知道 grok 用的什么色。已经核实过：`crates/codegen/xai-grok-pager/src/slash/commands/theme.rs`（26KB）里 **hex 色值 0 个、`Rgb(` 0 个** —— 颜色不硬编码在那儿，从源码读不出来。

所以改走抓屏路线：抓屏台用的 `pyte` 解析 ANSI 后，**每个 cell 都带 fg/bg/bold/italic 属性**，我们现在只把字符写进了 `.txt`，把颜色扇丢了。把它导出来，就能得到 grok 的真实调色板，而且是实测的、不靠猜的。

**你的产出是 V2 主题引擎的唯一数据源。** 做不出来，V2 只能靠猜颜色。

### 做

1. Task A0：确认基线干净、抓屏台能跑；若 V0 遗留 B2/D2 抓帧失败，再试**一次**（仅一次）。
2. Task A1：`ptycap.py` 加 `--dump-cells`（默认关），产出 `<帧名>.cells.json`，格式严格按计划里给的 JSON 结构。
3. Task A2：新建 `scripts/tui-parity/diff.py`，按总纲 §6.2 公式算字符/配色/场景吻合度，支持豁免格、帧数不等、`--heatmap`，并输出 **Top 10 差异区块**。
4. Task A3：新建 `scripts/tui-parity/palette.py` 聚合出 `docs/tui-parity/grok-palette-observed.md`，含语义 token 草案。
5. Task A4：`run.py` 加 `--diff` 与 `--all-ours`；更新 README 的「吻合度计算」一节。
6. Task A5：把实测数字回填 `docs/tui-parity/PARITY-SCORECARD.md` 的 V1 列，并汇总「全局 Top 20 差异」。

### 不做

- ❌ 不改 `.txt` 的生成逻辑（它是 V0 已定的验收基线，改了就把 baseline 作废）
- ❌ 不改 `packages/**` 任何文件
- ❌ 不碰 `docs/refs/`（那是 B 轨的地盘）
- ❌ 不反复重试 grok 抓屏烧额度（单场景最多 2 次）
- ❌ 不把索引色伪造成精确 hex

### 三条硬要求

1. **自比必须 100%**：同一份 `.cells.json` 跟自己 diff，两个吻合度都必须是 `100.00%`。不是就说明工具有 bug，先修。
2. **变异验证必做**：造一个故意改了 3 个 cell 的副本，确认 diff 精准报出这 3 个位置。这证明断言不是空转。
3. **色空间如实声明**：pyte 实际给的是 `named16` / `indexed256` / 还是 `truecolor`，如实写进 README、调色板文档和交卷报告。如果只是索引色，就明说「配色吻合度的精度边界是索引级」。**不许含糊**。

### 工作方式

- 严格按 A0→A5 顺序；每个 Task 完成后按计划给出的 commit 信息提交。
- 证据优先：交卷前重跑验收标准 3~8 的所有命令，**贴出真实输出**。禁止「应该能过」。
- 用简体中文回复；代码标识符、文件路径保持原样。

### 交卷

- `git log --oneline main..HEAD`
- 验收标准 3~8 逐项自评（含真实命令输出）
- **自比 100% 的实际输出**、**变异验证的实际输出**
- **色空间实测结论**（这条单独一段写清楚）
- `git diff --stat main -- packages` 输出（必须为空）
- 是否需要领导授权放开 `--grok-budget` 重抓 grok 侧全部场景（若需要，说明最少需要几次额度）

现在开始：读完计划与总纲，从 Task A0 执行到 Task A5。

---

## 【B 轨】V-* 视觉规格起草

你是 **harness2** 阶段 V1 轨道 B 的执行代理。请**完整执行**，不要只写方案。

### 基线

- 目录：`D:/AI_Projects/harness2`
- 从 `main` 创建并切换：`feat/v1-b-visual-spec`
- 唯一实施计划：`docs/ai-framework/plans/2026-09-17-phase-V1-truth-extraction.md`（只做**轨道 B** 的 Task B0~B8）
- 总纲：`docs/ai-framework/plans/2026-09-17-visual-parity-program.md`
- 必读：`docs/refs/refs-grok-build.md`（重点看表格格式与 G-01~G-06）、`docs/refs/README.md` §2 六步流程、`AGENTS.md`
- 证据素材：`scripts/tui-parity/out/<场景>/grok/*.txt`（已有 13 个场景的 grok 侧基线帧）

### 你这条轨道为什么存在（务必读懂）

`docs/refs/refs-grok-build.md` 已经是一份很认真的复刻规格，95 条 `G-*`，44 条已完成。但它的 95 条里：

- **87 条是行为**：键位、Esc 语义状态表、斜杠命令、焦点环、队列转向
- **只有 8 条是外观**（G-01~G-06 布局、G-84 `/theme`、G-92 终端原生主题），而 G-1x 这 6 条里 **5 条还是 🟡**

**这就是领导不满的真正原因：团队在复刻「手感」，领导在看「长相」。** 两边都很卖力，就是对不上。

你的任务是把缺的那一层补上：**新开一套 `V-*` 视觉规格，只管「长什么样」，不管「怎么操作」。** V2 改主题和布局、V3 改卡片和动效，全部按你写的条目施工。你写虚一条，后面就错一片。

**这一轨是整个总纲的地基。它是纯文档，但它不是「不干活」。**

### 做

1. Task B0：确认基线；校对记分卡场景行与 `scripts/tui-parity/scenarios/` 实际文件是否一致（不一致以实际目录为准，告知编排者，**不要自己改记分卡**，那是 A 轨的文件）。
2. Task B1：新建 `docs/refs/refs-grok-visual.md` 骨架（文件头字段、证据规则、状态图例、分组索引 V-0x~V-8x、空矩阵）。
3. Task B2：V-0x/V-1x 布局骨架与区域尺寸（主证据 `K1-canvas-110x30`、`K2-canvas-160x40`）。
4. Task B3：V-2x 边框与分隔线（**必须写 Unicode 码点**）。
5. Task B4：V-3x 状态图标字形（含**显示宽度**，1 列还是 2 列）。
6. Task B5：V-4x 欢迎屏/banner（含**品牌边界**处理）。
7. Task B6：V-5x 配色 token —— **依赖 A 轨的 `docs/tui-parity/grok-palette-observed.md`**。若 A 轨未完成，**跳过本 Task 先做 B7**，并登记为遗留项带入 V2。**绝对不要自己猜颜色。**
8. Task B7：V-6x 卡片 / V-7x 状态行 / V-8x 动效。
9. Task B8：统计与交叉引用（`docs/refs/README.md`、`refs-grok-build.md` 头部各加一行指向）。

### 不做

- ❌ 不改 `packages/**` 任何文件（你这轨只动 `docs/refs/`）
- ❌ 不碰 `docs/tui-parity/`（那是 A 轨的地盘）
- ❌ 不重复登记 G-* 已覆盖的**行为**条目（尤其 G-42~G-49 状态行行为已全部 ✅，你只管它的外观）
- ❌ 不追 G-8x 斜杠命令（已冻结）

### 四条硬要求（违反即整轨打回）

1. **每条 V-\* 必须填「证据帧」列**，格式：`<场景 id>/grok/<帧文件名> 第 N 行第 M-K 列`。**无证据的观察不得写入。宁可条目少，不可条目虚。**
2. **只写可数的事实，不写主观评价。** 写「状态行固定在倒数第 2 行，左边距 1 列」，不写「布局应该更紧凑」。V2 的人要拿你的数字直接改 `regions.ts`。
3. **从 Rust 源码推断的内容必须在备注标「源码推断，未经抓屏验证」。** AGENTS.md 第 7 条明确禁止凭想象设计交互。
4. **推不出来的写「未观察到」或「⬜ 需 V3 补抓连续帧才能确定」，不要拍一个数字上去。** 特别是 spinner 帧率 —— 静态帧推不出帧率。

### 验收时会怎么查你

编排者会**随机抽 5 条 V-\***，打开你声称的证据帧文件，数到那一行那一列，确认描述属实。**任一条对不上，整轨打回。**

所以：写的时候就老老实实数行数列，别偷懒。

### 工作方式

- 按 B0→B8 顺序（B6 可能跳过）；每个 Task 完成后按计划给出的 commit 信息提交。
- 格式严格照抄 `refs-grok-build.md` 的表格结构，团队才能无缝切换。
- 用简体中文回复；代码标识符、文件路径、Unicode 码点保持原样。

### 交卷

- `git log --oneline main..HEAD`
- V-* 条目总数与分组分布（V-0x 几条、V-1x 几条……）
- **证据率**：多少条有证据帧、多少条标了「源码推断」、多少条标了「未观察到」
- B6 是否跳过（若跳过，说明 A 轨依赖状态）
- **品牌边界结论**：V-4x 里哪些内容标了 ➖ 不采纳，理由
- 残留风险与需要领导决策的事项

现在开始：读完计划与总纲，从 Task B0 执行到 Task B8。

---

## 【C 轨】声音提醒

你是 **harness2** 阶段 V1 轨道 C 的执行代理。请**完整执行**，不要只写方案。

### 基线

- 目录：`D:/AI_Projects/harness2`
- 从 `main` 创建并切换：`feat/v1-c-sound-notify`
- 唯一实施计划：`docs/ai-framework/plans/2026-09-17-phase-V1-truth-extraction.md`（只做**轨道 C** 的 Task C0~C5）
- 总纲：`docs/ai-framework/plans/2026-09-17-visual-parity-program.md`
- 必读：`packages/cli/src/tui/notify.ts`、`packages/cli/src/tui/turn-events.ts`、`AGENTS.md`、`CODE_REVIEW.md`

### 你这条轨道为什么存在

领导在 `docs/init-question-log.txt` 追加的四条体感需求里，有一条是「AI 回复完要有声音提醒」。全仓检索结果：

```
git grep -il "sound"  → 0 命中
git grep -il "声音"  → 0 命中
git grep -il "bell"   → 1 命中
```

**完全没做。** 而前面那九条「内核里看不见的」需求基本全做完了。

这一轨体量最小（半天到一天），但是整个总纲里**领导最快能感知到的一件事** —— 他下次打开终端发个消息，回复完响一下，他立刻就知道有人在听他说话。所以放在 V1 并行，而不是排到后面。

**不要把它做大。** 不要做音效包、不要做音量控制、不要做自定义音频文件。先把「响一下」做对。

### 做

1. Task C0：确认基线（`pnpm --filter harness2 test` 期望 281 passed + 2 skipped）；读懂 `notify.ts` 现状；找到回合结束事件源。
2. Task C1：实现 `playNotifySound(reason)`，写终端 BEL 控制符（ASCII 0x07，用 `String.fromCharCode(7)`）；实现四个静默条件。
3. Task C2：新增 `[ui.notify]` 的 `sound`（默认 **true**）与 `sound_on`（默认 `"turn-end"`）配置。
4. Task C3：新增 `/notify-test` 命令（绕过去重限制），输出配置状态行。
5. Task C4：`packages/cli/test/tui/notify-sound.test.ts`，≥ 5 个用例（计划里给了表格）。
6. Task C5：真机试听并如实记录。

### 不做

- ❌ **不改 `packages/core/**`、`packages/gateway/**`**（契约冻结区）
- ❌ **不改 `packages/cli/src/tui/next/next-shell.ts`**（236KB 巨型文件，本阶段三轨均不得动）
- ❌ 不引入任何新依赖（BEL 不需要任何包）
- ❌ 不做系统声音 / PowerShell 播音 / 音频文件（登记为后续可选）
- ❌ 不碰 `scripts/tui-parity/`（A 轨）和 `docs/refs/`（B 轨）

### 两个必须停下来问的情况

1. **接回合结束事件必须改 `next-shell.ts`** → 立即停下问编排者。不要自行动手。编排者会判定是开例外还是改接入点。
2. **配置 schema 类型定义在 `packages/core`（冻结区）** → 立即停下问编排者。不要自行动冻结区。

这两条不是形式主义：越界会破坏契约冻结，`api-surface-baseline.json` 一变整轨作废。

### 三条硬要求

1. **四个静默条件一个都不能少**：非 TTY 不响、配置关闭不响、同 reason 3000ms 去重、reason 不在 `sound_on` 集合不响。缺一个就会变成扰民功能，领导会**更**生气。
2. **变异验证必做**：把去重逻辑临时删掉，确认用例 4 必红；把 TTY 判断删掉，确认用例 3 必红。然后恢复。这证明断言不是空转。写进交卷报告。
3. **测试不许真向终端写 BEL**，用仓内现有的 stdout mock 手法；去重用例用假时钟，不要真 `sleep(3000)`。否则跑测试会响一片。

### 工作方式

- 按 C0→C5 顺序；每个 Task 完成后按计划给出的 commit 信息提交。
- 证据优先：交卷前重跑验收标准 1、2、12、13、14、15 的命令，**贴出真实输出**。禁止「应该能过」。
- 用简体中文回复；代码标识符、文件路径、配置键保持原样。

### 交卷

- `git log --oneline main..HEAD`
- `pnpm --filter harness2 test` 真实统计行（含新增用例数）
- **变异验证的实际输出**（删去重→用例 4 红；删 TTY 判断→用例 3 红）
- 真机试听结果（响了/没响；没响时说明是终端禁了 bell 还是代码问题）
- `git diff --stat main -- packages/core packages/gateway` 输出（必须为空）
- `git diff --stat main -- packages/cli/src/tui/next/next-shell.ts` 输出（必须为空）
- 是否触发了「必须停下来问」的两种情况

现在开始：读完计划与总纲，从 Task C0 执行到 Task C5。

---

## 残留手工验收清单（编排者亲自做，不许委托）

1. **抽查 5 条 V-\* 的证据帧**：打开文件，数到那一行那一列，确认描述属实。这是本阶段最容易被糊弄的地方。
2. **亲自试听声音提醒**：`chat --provider mock` 发一条消息，听是否响；试 `/notify-test`；试关闭配置后是否静音。
3. **亲自重跑 `diff.py` 自比与变异验证**，确认两个吻合度自比为 `100.00%`，变异能精准定位。
4. **确认色空间实测结论已写进三处**：`scripts/tui-parity/README.md`、`docs/tui-parity/grok-palette-observed.md`、`PARITY-SCORECARD.md`。
5. **判定是否需要向领导申请 `--grok-budget` 额度**，用于重抓 grok 侧全部场景的带颜色帧。若不批，按降级方案只评 4 个关键场景。
6. **把本阶段所有未通过项原文抄进 V2 计划的「上阶段遗留」表**。这是总纲 §4.1 的硬要求，不许省。
