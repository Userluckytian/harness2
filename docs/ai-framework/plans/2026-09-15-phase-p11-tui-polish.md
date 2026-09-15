# 阶段 P11：终端界面拉齐（修 P0 + P1 对照发现项）

> **状态：** 计划已就绪 · 实施中
> **For agentic workers:** 严格按 Task 顺序执行，每 Task 通过验证并 commit 后再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范：** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 把 `next` 终端壳的**页面展示**拉齐到参考实现水准——修掉对照报告里的 **1 项 P0 + 6 项 P1**，每项都有**抓屏前/后证据**与**回归断言**。

**Architecture:** 只动 `packages/cli/src/tui/next/**`（渲染层）与其测试；不改 `packages/core` / `gateway` 行为；不改命令语义（只改呈现）。对照验证复用 `scripts/tui-parity/`。

**Tech Stack:** TypeScript / Node ≥22 / vitest；抓屏对照台 Python（ConPTY + pyte + Pillow，隔离 venv）。

**实施档位：** 全能 · **子代理：** 启用（实现/测试由子代理执行，编排者只做计划、分发、验收、文档）

**依据：** `docs/tui-parity/matrix.md`（改进清单 #1~#7）+ `docs/tui-parity/README.md`

---

## 前置阅读（必须）

| 优先级 | 文件                                                                           |
| ------ | ------------------------------------------------------------------------------ |
| P0     | `docs/tui-parity/matrix.md`（问题清单与证据）                                  |
| P0     | `docs/tui-parity/README.md`（抓屏方法与边界）                                  |
| P0     | `docs/ai-framework/plans/2026-09-15-phase-next-only-and-grok-parity.md`（P10） |
| P1     | `AGENTS.md`、`CODE_REVIEW.md`、`docs/ai-framework/phased-plan-driven.md`       |

**仓库路径：** `D:/AI_Projects/harness2`
**基线分支：** 从 `feat/phase-p10-next-only`（P10 已完成的单轨化）拉 `feat/phase-p11-tui-polish`
**说明：** P10 尚未合入 main（等 CI 授权）；本阶段**叠在 P10 上**，避免与旧壳删除冲突。

---

## Global Constraints（冲突时以本节为准）

1. **只改呈现，不改语义**：不新增/删除命令，不改 core 命令注册表与 `describeCapabilities()`；不改会话/事件/投影逻辑。
2. **不碰冻结区**：`packages/core`、`packages/gateway` 行为零改动；`packages/ui-shared` 的 `--ink` CSS token 不得误伤。
3. **每个 P1 项必须带"前/后"证据**：用 `scripts/tui-parity/` 抓同一场景的前后帧（`.png` + `.txt`），放 `docs/tui-parity/images/p11/`。
4. **必须补回归断言**：P0 必须有**版面级**断言（不是"文本包含"这种弱断言）——对照报告的教训就是"文字对、版面错"逃过了测试。断言须做**变异验证**（故意改坏 → 用例必红）。
5. **不做**：不重写渲染器架构；不改键盘协议；不新增第三方依赖；不动真机才可验的鼠标/IME。
6. **Git**：小步 commit（`<gitmoji><type>(scope): 中文描述`）；不 push；历史归档（issue-log 按天文件、diary、已完成 plans、research、spike）不改。
7. **每条 UI 变更都要可关闭/可回退**（如引导卡走配置开关），避免强加偏好。

---

## 阶段开头：上阶段遗留

| 上阶段遗留项                            | 来源              | 未通过原因      | 状态                           |
| --------------------------------------- | ----------------- | --------------- | ------------------------------ |
| P10 段 C4「P0/P1 写入 OPEN 并另立计划」 | P10 计划验收表    | 本阶段即其落地  | ✅ 本阶段承接                  |
| P10 未合入 main（等 CI 授权）           | 编排者            | 需人类授权 push | ⬜ 等用户拍板                  |
| 对照台剩余未覆盖（A2/E/L2/L1、K 逐格）  | `docs/tui-parity` | 剧本/真机限制   | ⬜ 非本阶段（T8 只做重抓对照） |

---

## 与前后阶段

| 阶段           | 状态 | 交付                                                           |
| -------------- | ---- | -------------------------------------------------------------- |
| P10 单轨化     | ✅   | 旧壳零残留 + 对照台 + 差异报告（未合 main）                    |
| **P11 本阶段** | ⬜   | P0 修复 + 6 项 P1 拉齐 + 前后抓屏证据 + 回归断言               |
| P12（待定）    |      | P2 清单（/rewind 别名、模型名/分支、会话 id 降档等）与真机验收 |

---

## File Structure（预期变更，实施者须先定位确认）

| 文件 / 目录                                      | 动作  | 职责                                         |
| ------------------------------------------------ | ----- | -------------------------------------------- |
| `packages/cli/src/tui/next/chat-screen.ts`       | 改    | 版面分区（转录/ composer / 状态行 / 提示行） |
| `packages/cli/src/tui/next/composer.ts`          | 改    | 草稿行、候选列表、提示行                     |
| `packages/cli/src/tui/next/next-shell.ts`        | 改    | 装配、忙碌态、启动引导                       |
| `packages/cli/src/tui/next/chat-controller.ts`   | 改    | 状态（忙碌/耗时/用量）来源                   |
| `packages/cli/src/tui/commands/palette-view.ts`  | 改    | `/help` 面板列布局（P0 主战场）              |
| `packages/cli/src/tui/cards/render.ts`（或等价） | 改    | 工具卡主行文案                               |
| `packages/cli/test/tui/next/**`                  | 增/改 | 版面回归断言 + 各 P1 用例                    |
| `docs/tui-parity/images/p11/**`                  | 新增  | 前/后证据图                                  |
| `docs/tui-parity/matrix.md`、`OPEN.md`           | 改    | 状态回填                                     |

---

## Task T0：定位盘点（只读，先于一切改动）

**目标：** 把 7 个问题逐一钉到**代码位置 + 现有测试 + 复现命令**，特别是 **P0 的根因**。

**Steps:**

1. 对每个问题给出：症状 → 复现命令（含抓屏）→ 代码位置（`文件:行`）→ 现有测试 → 根因判断。
2. **P0 必做根因定性**：`/help` 面板错位到底是 (a) 多列拼装用错宽度函数（如 `.length`/`padEnd` 当显示宽度）、(b) 超宽行折行时切断了宽字符、(c) 面板行写入 CellBuffer 时列推进错。必须用代码证据指明其一，不许"可能是"。
3. 产出写入本计划附录「T0 定位结果」。
4. Commit：`📝docs(cli): P11-T0 对照问题定位盘点`

**验收：** 附录三列表齐全；P0 根因是**确定结论**且附最小复现路径。

---

## Task T1：修 P0 —— `/help` 面板渲染错位（**本阶段最高优先**）

**Steps:**

1. 按 T0 结论修复（改宽度计算/折行/列推进三者之一或组合）。
2. **版面回归断言**（必须有）：
   - 新增用例：渲染 `/help` 面板到固定画布（如 110×30），对**每一行**断言"显示宽度 ≤ 画布宽"且"同行不出现两个已知文案片段交叉"；
   - 更稳的做法：对渲染结果做**逐格快照**（现有 `packages/cli/test/tui/next/**` 已有帧断言先例，优先复用其风格）；
   - **变异验证**：临时把宽度函数改成"按字符数"或把列宽减 1，用例必须变红；随后回退，工作树无残留。
3. 抓屏前后证据：`scripts/tui-parity/ptycap.py` 跑 `/help`，图存 `docs/tui-parity/images/p11/C2-help-after.png`（前后各一张）。
4. Commit：`🐛fix(cli): P11-T1 修复 /help 面板错位并补版面回归断言`

**验收：** 抓屏图 `/help` 各行对齐无交叉；用例存在且变异必红；`pnpm --filter harness2 test` 全绿。

---

## Task T2：P1 —— 输入区可见性（草稿行提示符 + 空态占位）

**Steps:**

1. 草稿行加视觉锚点（`❯` 或 `>` 前缀，与转录里已提交消息的 `❯` 呼应）；空态显示弱化的占位提示（如 `输入消息，/ 查看命令`）。
2. 光标位置保持不变（光标仍在草稿处）。
3. 用例：空态帧含占位文案；有草稿帧含提示符 + 草稿原文；提示符不得进入提交内容。
4. 抓屏前后证据：空态 / 有草稿两张（`images/p11/T2-idle-*.png`、`T2-draft-*.png`）。
5. Commit：`✨feat(cli): P11-T2 输入区加提示符与空态占位`

**验收：** 空态下用户能一眼看出"在哪打字"。

---

## Task T3：P1 —— 命令候选列表两列化（命令 + 说明）

**Steps:**

1. 候选行渲染为两列：命令名 + 灰色说明；宽度不足时**退化为单列**（不得截断出错）。
2. 高亮选中态保持；CJK 片段宽度用 `displayWidth`（禁用 `.length`）。
3. 用例：候选帧含说明文本；窄画布（如 60 列）不溢出、不重叠；选中态迁移正确。
4. 抓屏前后证据：110×30 与 60×30 各一张。
5. Commit：`✨feat(cli): P11-T3 候选列表两列化（含窄屏退化）`

---

## Task T4：P1 —— 用量三件套（时间戳 / 每轮耗时 / token）

**Steps:**

1. 消息行尾加时间戳（右对齐，弱化色）；每轮结束加 `耗时 12.3s` 行（与既有 `[end_turn · steps · toolCalls]` 合并成一行，避免多占一行）。
2. 状态行补 token 用量（如 `12.3k/128k`）；无用量数据时按"如实降级"显示 `—`（**不得伪造**）。
3. 时间戳格式与本地化：跟随系统 12/24 小时制（或配置），实现里说明取舍。
4. 用例：帧含时间戳与耗时；无用量数据时显示降级符而非假数字。
5. 抓屏前后证据：一轮对话完成帧。
6. Commit：`✨feat(cli): P11-T4 消息时间戳/每轮耗时/token 用量`

**验收：** 用户能看出"这轮花了多久、烧了多少"。

---

## Task T5：P1 —— 工具行文案人类化

**Steps:**

1. 主行改为人类动词短语（如 `写入 harness2-demo.txt`、`读取 …`），**JSON 参数移入展开态**；工具名保留在展开态与轨迹中。
2. 保持既有结构（结果行 `└ ✓` / `└ ✗` 与缩进）与失败态可读性。
3. 用例：主行不含 `{"`；展开态仍能看到原始参数；失败态文案不回归。
4. 抓屏前后证据：工具卡折叠帧 + 展开帧。
5. Commit：`✨feat(cli): P11-T5 工具行改人类可读短语（参数入展开态）`

---

## Task T6：P1 —— 忙碌态反馈（耗时/消耗/取消 + 提示行随状态改写）

**Steps:**

1. 忙碌时状态行右段显示 `已用 12s · ↓3.2k · Ctrl+C 取消`（数据取既有 runtime 事件，**不得伪造**）。
2. 提示行**随状态改写**（空闲 `/ 命令 · Tab 焦点 · Ctrl+C 退出`；忙碌追加取消键说明）。
3. 用例：忙碌帧含耗时与取消提示；空闲帧不含忙碌字段。
4. 抓屏：忙碌帧（可用 mock 的长回答剧本 `scenarios/mock/*.json`）。
5. Commit：`✨feat(cli): P11-T6 忙碌态耗时/消耗/取消反馈与提示行动态化`

---

## Task T7：P1 —— 冷启动引导卡（可关）

**Steps:**

1. 首次启动（或新会话且为空）显示一次性引导卡：版本、最常用 4~6 个键/命令、`/help` 指引。
2. 开关：配置项或环境变量（如 `HARNESS2_NO_WELCOME=1` 与 config `ui.show_welcome`），默认显示一次后不再显示（或本次会话内不重复）。
3. **不得阻塞输入**：任何按键立即收起。
4. 用例：默认帧含引导卡；关闭开关后不含；按键后收起。
5. 抓屏前后证据：冷启动帧。
6. Commit：`✨feat(cli): P11-T7 冷启动引导卡（默认一次性，可关）`

---

## Task T8：收口（编排者 + 子代理）

1. 全量闸门：`pnpm -r build`、`pnpm -r typecheck`、`pnpm lint`、各包测试（desktop 预存 2 红文件按 P10 口径）。
2. **重抓对照**：对 A1 / B1 / C1 / C2 / D1 / G1 / J1 跑我方侧抓屏，产出 `docs/tui-parity/images/p11/before-after.md`（前=P10 帧，后=P11 帧）。
3. 更新 `docs/tui-parity/matrix.md`：改进清单对应行标 ✅ 并附 P11 证据；`OPEN.md` 关闭已完成项、保留 P2 与未覆盖项。
4. 轮次记录写回本计划「编排者验收记录」。

---

## 代码审查（阶段级，验收前）

**审查方：** 独立只读子代理

| 审查项              | 结论 | 问题清单                                            |
| ------------------- | ---- | --------------------------------------------------- |
| 断言强度            |      | 是否"文字对版面错"仍能逃过（P0 教训）；有无变异验证 |
| 只改呈现不改语义    |      | 有无顺手改命令语义/核心逻辑                         |
| 冻结区与误伤        |      | core/gateway/`--ink` 是否被碰                       |
| 数据真实性          |      | 耗时/token/占位文案是否伪造                         |
| 回归（窄屏/非 TTY） |      | 60 列、piped 路径是否被破坏                         |

---

## 验收标准总表

| #   | 标准       | 通过条件                                                            | 责任人              |
| --- | ---------- | ------------------------------------------------------------------- | ------------------- |
| 1   | P0 修复    | `/help` 抓屏各行对齐无交叉；**版面回归断言存在且变异必红**          | 子代理 + 编排者复验 |
| 2   | P1 六项    | 每项有前后抓屏证据 + 用例；行为符合 matrix.md 的"建议"              | 子代理 + 编排者     |
| 3   | 数据不伪造 | 耗时/token 无数据时如实降级（`—`），引导文案无虚构                  | 独立审查            |
| 4   | 只改呈现   | `git diff` 无 core/gateway 行为改动；无命令增删                     | 独立审查            |
| 5   | 全量闸门   | `pnpm -r build`/`typecheck`/`lint` 0；测试按 P10 口径全绿           | 编排者              |
| 6   | 对照闭环   | `docs/tui-parity/images/p11/before-after.md` 覆盖 1 项 P0 + 6 项 P1 | 编排者              |
| 7   | 真机项     | 鼠标/IME/观感仍待用户（不在本阶段）                                 | 用户                |

---

## 风险与降级

| 风险                             | 缓解                                            |
| -------------------------------- | ----------------------------------------------- |
| 断言太弱，P0 类问题再次逃过      | 强制"版面级断言 + 变异验证"；审查专项           |
| 改动渲染层引入新错位（CJK 宽度） | 所有宽度计算必须走 `displayWidth`；窄屏用例覆盖 |
| 忙碌态数据源不存在 → 被迫伪造    | 允许如实降级并在文档登记，禁止假数据            |
| 引导卡打扰老用户                 | 默认一次性 + 开关 + 任意键收起                  |
| 与 P10 未合 main 叠加冲突        | 本阶段基于 P10 分支；P10 合并顺序由编排者控制   |

---

## 给接手 AI 的完整提示词

---

你是负责 **harness2** 的实现代理。请**完整执行本阶段分配给你的 Task**，不要只写方案。

### 基线

- 目录：`D:/AI_Projects/harness2`
- 分支：从 `feat/phase-p10-next-only` 创建 `feat/phase-p11-tui-polish`（若已存在则切换过去）
- 唯一实施计划：`docs/ai-framework/plans/2026-09-15-phase-p11-tui-polish.md`
- 必读：`docs/tui-parity/matrix.md`、`docs/tui-parity/README.md`、`AGENTS.md`、`docs/ai-framework/phased-plan-driven.md`
- 抓屏工具：`scripts/tui-parity/`（venv 见其 README；grok 侧模型为本地 40080 的 `big-pickle`，单轮约 3~4s）

### 做

**Task T0 定位盘点 → T1 修 P0（含版面回归断言）**（本批只做这两个；T2 及以后由后续批次执行）

### 铁律

1. 只改呈现，不改命令语义；`packages/core` / `packages/gateway` 行为零改动；`ui-shared` 的 `--ink` token 禁改。
2. P0 必须有**版面级断言**（不是文本包含）+ **变异验证**（改坏必红），否则视为未完成。
3. 所有宽度计算用 `displayWidth`/`charWidth`，禁止 `.length` 当显示宽度。
4. 禁止伪造数据（耗时/token 无来源时如实降级并登记）。
5. 历史归档目录不改；不 push；不新增依赖。

### 工作方式

1. 先跑基线：`pnpm --filter harness2 test`（应 90 files / 1520 passed 全绿）确认干净。
2. 严格按 Task 顺序；每 Task 跑验证命令并**贴真实输出**，再 commit（`<gitmoji><type>(scope): 中文描述`）。
3. 用简体中文回复；卡住就停下报告，不扩大范围。

### 交卷

分支名、提交列表、T0 定位结论（尤其 P0 根因）、T1 的修复说明与**变异验证证据**、前后抓屏文件名、验证命令输出、残留风险。

---

## 附录 A：T0 定位结果（2026-09-15，只读盘点）

**盘点方式：** 逐项走「症状 → 复现 → 代码位置（`文件:行`）→ 现有测试 → 根因判断」。
基线：`packages/cli` 已 build（`pnpm --filter harness2 build`），抓屏画布固定 110×30，
mock provider，临时 `--home/--root`。

**通用抓屏命令模板**（`<KEYS>` / `<SHOT>` 按项替换；临时目录用系统 TEMP，避免污染工作树）：

```bash
mkdir -p "C:/Users/ASUS/AppData/Local/Temp/p11cap/home" "C:/Users/ASUS/AppData/Local/Temp/p11cap/work"
scripts/tui-parity/.venv/Scripts/python.exe scripts/tui-parity/ptycap.py \
  --cmd "node packages/cli/dist/index.js chat --provider mock --home C:/Users/ASUS/AppData/Local/Temp/p11cap/home --root C:/Users/ASUS/AppData/Local/Temp/p11cap/work" \
  --cols 110 --rows 30 \
  --steps '[{"keys":"<KEYS>","settle":true,"timeout":25,"shot":"<SHOT>"}]' \
  --outdir docs/tui-parity/images/p11
```

### A.1 七项定位表

| #   | 症状（matrix.md 口径）                                      | 复现 keys              | 代码位置（`文件:行`）                                                                                                                                                                                                                                                                                                                                                                                                                                  | 现有测试                                                                                                       | 根因判断                                                                                                                                                                                                |
| --- | ----------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **P0**：`/help` 面板文字互相覆盖、碎片（`essio s`）、重复行 | `/help\r`              | `projection.ts:424-426`（system/status 整段不拆行）→ `scrollback.ts:166-199`（`wrapLine` 把 `\n` 当 1 列可打印字符）→ `diff-presenter.ts:119`（逐格原样 `out.push(ch)`）→ 打印入口 `command-impls.ts:90` + `next-shell.ts:1712/3000`；文本源 `core/commands/help.ts:29-35`（core 冻结不改）                                                                                                                                                            | `next-shell.test.ts:852`（只 `.toContain('命令：')`）、`projection.test.ts:216`（system 单行用例，未覆盖多行） | **确定**：多行文本被当**一条**逻辑行，`\n` 落成 CellBuffer 单元格，presenter 把控制字符写进终端 → 行内换行，后续格错位（详见 A.2）                                                                      |
| 2   | 输入区无边框/无提示符；空态光标与占位都不可见               | 直接看首帧（无需按键） | `composer.ts:346-351`（草稿逐段 `writeRowAt(buf, top+i, 0, seg.text, …)`，无前缀无占位）；`chat-screen.ts:401-424`（drawComposerLayer）；无 placeholder 概念（全仓无实现）                                                                                                                                                                                                                                                                             | `composer.test.ts:32`（空草稿=1 行）、`:119`（空草稿只有光标格）、`chat-screen.test.ts` 帧快照                 | 功能缺失：草稿原样画在 x=0；空草稿段为空串 → 整行只有光标高亮格（默认色近似反色，视觉不可辨）                                                                                                           |
| 3   | `/` 候选列表单列纯命令名（grok 为命令+灰色说明两列）        | `/`                    | `composer.ts:352-362`（`writeRowAt(buf, y, 0, item, width, …)` 单列）；`next-shell.ts:1662-1685`（syncCandidates）+ `:671-687`（`filterCommands` 返回 `string[]` 仅名字）；说明文案已有源：`NEXT_COMMANDS` 的 `summary`/`note` 与 core `describeCapabilities()`                                                                                                                                                                                        | `composer.test.ts:245-…`（候选位置/高亮/滚动/截断）、`p2-coverage-gaps.test.ts:275`（过滤与钳位）              | 功能缺失 + 数据窄化：候选数据面只有名字，渲染面无第二列                                                                                                                                                 |
| 4   | 缺时间戳 / 每轮耗时 / token 用量                            | `hi\r` 看一帧          | 投影：`projection.ts`（无时间字段）；数据模型 `transcript.ts:17-31`（`TranscriptItem` 无 timestamp）；状态行 `chat-screen.ts:302-308`（`statusLineFor` 仅 cwd·model·ctx%·mode·retry·busy）+ `:274-276`（`formatContextUsage` 只出百分比）；可用数据：`TurnResult.durationMs`（core `agent/types.ts:155+`）、`turnStartedAt`（`next-shell.ts:2610`）、usage 事件落 `assistant/message`（`core/agent/loop.ts:537`）但壳层 `chat-setup.ts:529-543` 未转发 | `p3e-chrome.test.ts`（状态行四态断言，均无耗时/用量字段）                                                      | 功能缺失（数据部分可得）：耗时可直接用既有 `durationMs`；token 需从会话事件 `assistant/message.usage` 取，mock 剧本不写时**必须降级 `—`**                                                               |
| 5   | 工具行暴露 `⏺ write({"file_path":…})`                       | `hi\r` 后看工具卡      | `projection.ts:283`（`toolSummaryOf` 提炼摘要）+ `:308`（主行模板 `⏺ ${item.tool}(${callSummary})`）；展开态 `:270-350`（diff/输出）                                                                                                                                                                                                                                                                                                                   | `projection.test.ts` 工具段（断言含工具名 + `(` 参数；**正因如此才锁死了现状**）、`d1-*` 抓屏                  | 模板耦合：主行同时含工具名与参数；参数另有 `rawMarkdown` 原始视图通道可承载                                                                                                                             |
| 6   | 忙碌态无耗时/消耗；matrix 称「提示行恒定」                  | `hi\r`                 | 状态行 `chat-screen.ts:306`（busy 只加 `⏺ 运行中…`，无秒数/消耗）；提示行 `chat-screen.ts:171-176`（`shortcutsFor` **已有** busy 分支 → `Ctrl+C 取消`）；装配 `next-shell.ts:1585-1625`（refreshChrome 传入 busy）                                                                                                                                                                                                                                     | `p3f-agent-keys.test.ts:282+`（shortcutsFor 各态）、`p3e-chrome.test.ts`                                       | **部分缺失 + 一处报告口径修正**：提示行其实随状态改写（代码有 busy 分支）；matrix 的「恒定」是被 mock 回合太快导致的抓屏时序假象（见 A.6）。真实缺口 = 状态行无耗时/消耗（grok 的 `20s ↓15.6k [stop]`） |
| 7   | 冷启动无引导卡                                              | 冷启动首帧             | `next-shell.ts:1042-1045`（bootLines → system item）、`:4492-4498` / `:4563`（runNextChat 组装 bootLines = 装配行 + bootNotes）；无 `show_welcome` / `HARNESS2_NO_WELCOME`（全仓无实现）                                                                                                                                                                                                                                                               | `next-shell.test.ts:156`（bootLines 进 scrollback）                                                            | 功能缺失：boot 只有 `会话: …（新建）` + 告警/模式提示，无引导内容与开关                                                                                                                                 |

### A.2 P0 根因（确定结论，非「可能」）

> **根因：多行文本（内嵌 `\n`）被投影成「一条」逻辑行；`wrapLine` 不把 `\n` 当硬换行，
> 而是按 `charWidth('\n')=1` 当作可打印字符计入折行；该 `\n` 随后被写入 CellBuffer 单元格，
> `DiffPresenter` 逐格原样写出 → 终端在行中执行换行（LF），该行剩余单元格全部落到下一行
> 同一列起点，与下一物理行叠加 → 抓屏所见「文字互相覆盖 / 碎片 / 重复行」。**

**证据链（三条，均可复跑）：**

1. **端到端复现（最小、无需 TUI）：**

   ```bash
   cd packages/cli && node --input-type=module -e "
   import { HELP_TEXT } from '@harness2/core';
   import { projectTranscript } from './dist/tui/next/projection.js';
   import { Scrollback, drawScrollback } from './dist/tui/next/scrollback.js';
   import { CellBuffer } from './dist/tui/renderer/cell-buffer.js';
   const lines = projectTranscript([{ kind:'system', id:'s1', text: HELP_TEXT }], { cols: 109 });
   console.log('projected lines:', lines.length, 'embedded \\n:', (lines[0].text.match(/\\n/g)||[]).length);
   const sb = new Scrollback(lines.map((l) => l.text), 109);
   const buf = new CellBuffer(110, 30);
   drawScrollback(buf, sb, { top: 0, height: 28, width: 110, scrollbar: true });
   console.log('control chars in cells:', buf.chars.filter((c) => c === '\\n' || c === '\\r').length);
   console.log(buf.rowText(0));
   "
   ```

   实测输出：`projected lines: 1` / `embedded \n: 42` / `control chars in cells: 42`；
   `rowText(0)` 起首即 `命令：\n  /new …` —— 与抓屏 `C2-help-before.txt` 第 2 行逐字一致。

2. **宽度表交叉验证的反向印证**：把 `HELP_TEXT` 全部 316 个唯一字符逐字符比对
   `charWidth()`（我方）与 `string-width`（独立实现），**唯一不一致就是 `\n`**
   （charWidth 1 / string-width 0）。`\n` 正是被当宽度 1 写入网格的那个字符。

3. **presenter 无屏障**：`diff-presenter.ts:117-131` 对单元格 `ch` 不做控制字符过滤，
   直接 `out.push(ch)`；`CellBuffer.setCell`（`cell-buffer.ts:157-168`）同样不校验。

**排除的替代假设（已证伪）：**

| 假设                                                      | 结论         | 证伪证据                                                                                                                                                             |
| --------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) 多列拼装用错宽度函数（`.length`/`padEnd` 当显示宽度） | **不是本因** | `/help` 文本由 core `buildHelpText` 生成，`padEnd(16)` 只作用于**纯 ASCII** 命令名（`help.ts:35`），全部行 `displayWidth` ≤ 89 < 109，无列拼装参与                   |
| (b) 超宽行折行时切断宽字符                                | **不是本因** | `writeRowClipped`/`wrapLine` 均「整字丢弃/整体移行」，且 `HELP_TEXT` 最长行 89 列 < 内容区 109 列，**根本不触发折行**（43 逻辑行应 = 43 物理行，实测却被压成 24 行） |
| (c) 写入 CellBuffer 时列推进错                            | **不是本因** | 列推进 `x += w` 在 `writeRowClipped`/`setCell`/presenter 三处一致；错位来自**行维度**（`\n` 触发的终端换行），不是列推进                                             |

> 即：P0 是**第 4 类**根因（行拆分缺失 + 控制字符无过滤），不属于计划预设的 (a)(b)(c)；
> 三条假设均已用证据排除，结论唯一确定。

### A.3 修复方向（T1 范围，均落在 `packages/cli/src/tui/next/**`，core 零改动）

1. **主修（数据模型）**：`projection.ts` 的 `system`/`status` 分支按 `splitLines(item.text)` 逐行 push
   （与既有 `user`/`assistant` 分支同构）——`ProjectionLine` 契约本就是「一条逻辑行」。
2. **加固（渲染库边界）**：`scrollback.ts` 的 `wrapLine` 把 `\n`/`\r\n` 当**硬换行**、控制字符永不进格
   （与 `composer.ts:141-160` 的 `splitLogicalLines` 语义对齐），使任何直接 `new Scrollback([...多行文本])`
   的调用方也不再污染网格。
3. **回归断言**：新增 `packages/cli/test/tui/next/help-panel-layout.test.ts`，走真实装配路径
   （`/help` → transcript → projection → Scrollback → `renderChat` 帧），做**逐格版面断言**
   （无控制字符 / 行归属与顺序 / 每格宽度与独立宽度表 `string-width` 一致）+ 变异验证。

### A.4 latent 风险（登记，不在 T1 改）

- `chat-screen.ts:254`（`shortcutsHelpLines`）用 `text.length <= SHORTCUTS_HELP_MAX_COLS` 截断——
  对 CJK 是**按字符数当显示宽度**，`Ctrl+.` 快捷键面板可能超宽（未被本次 P0 暴露，因该面板走
  overlay 裁剪）。属铁律 2 的违规点，建议 T2+ 顺手改 `displayWidth`。
- `chat-screen.ts:316`（`queueEntryPreview`）同样用 `.length` 截断（仅展示用，风险低）。

### A.5 与 matrix.md 的一处口径修正（诚实登记）

matrix.md「H/G 组」称我方**提示行恒定不随状态改写**。T0 代码走查 + 抓屏复核后确认：
`shortcutsFor`（`chat-screen.ts:171-176`）**已有** busy/approval/subview/modal 四态分支，
G1 的 `02-busy-status.txt` 之所以仍是空闲提示，是因为该步骤未用 `wait` 而用「等屏幕稳定」，
mock 回合在稳定前已结束（帧内显示的是回合结束后的空闲态）。**这是抓屏时序假象，不是渲染缺口**；
改进清单 #6 的真实缺口收窄为「状态行无耗时/消耗」。

---

## 编排者验收记录

（每批完成后回填：复核命令、结论、裁定）

---

## 残留手工验收清单

1. 真机 Windows Terminal：鼠标/选择复制/IME/粘贴/alt-screen 进出。
2. 引导卡与时间戳在真机字体下的观感。
3. 与 grok 的 P2 项（`/rewind` 别名等）另立阶段。

### 第一批（T0 + T1）✅ 通过 —— `14c5ffa` / `d6b0d16`

**编排者独立复核（命令与结论）**

| 复核项   | 命令                                                                                             | 结论                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 越界检查 | `git diff feat/phase-p10-next-only --name-only -- packages/{core,gateway,ui-shared,desktop,web}` | **0 文件** ✅                                                                              |
| 根因复现 | 直接跑 `projectTranscript(HELP_TEXT)`                                                            | 改前 1 条逻辑行内嵌 **42 个 `\n`**；改后 **43 条逻辑行 / 0 内嵌** ✅（根因成立、修复生效） |
| 测试     | `pnpm --filter harness2 test`                                                                    | **91 files / 1526 passed + 2 skipped**（P10 基线 1520 → +6 条版面断言） ✅                 |
| 类型     | `pnpm --filter harness2 typecheck`                                                               | 0 error ✅                                                                                 |
| 修复效果 | 读 `docs/tui-parity/images/p11/C2-help-after.png`                                                | `/help` 两列对齐、说明段逐行独立，**无重叠无碎片** ✅                                      |
| 工作树   | `git status --short`                                                                             | 干净 ✅                                                                                    |

**P0 根因（确定结论，非推测）**：多行文本（内嵌 `\n`）被投影成**一条**逻辑行 → `wrapLine` 不把 `\n` 当硬换行、按 `charWidth('\n')=1` 计入折行 → `\n` 写进 CellBuffer 单元格 → 逐格发射后终端在行中执行 LF，该行剩余格落到下一行同列 → **与下一物理行叠加**。修复为两层防御（`projection.ts` 逐行 push + `scrollback.ts` 硬换行优先），并补 6 条**版面级**断言（变异验证：撤销修复或把宽字符宽度改成 1 → 用例必红）。

**编排者裁定 1（报告口径修正，已提交 `fb99b52`）**：`matrix.md` 原写「我方提示行恒定不变」**有误**——`chat-screen.ts` 的 `shortcutsFor()` 确有 busy 分支。初版结论源于 G1 抓帧时 mock 回合已结束（时序假象）。已修正报告：真实差距为「忙碌态无耗时/无消耗、提示行信息密度低于 grok」。

**编排者裁定 2（转入本阶段后续批次）**：T0 登记的三类残留一并纳入——① `chat-screen.ts:254/316` 用 `text.length` 当显示宽度；② `CellBuffer` 对 C0 控制字符（`\t`/`\x1b`）零过滤（P0 同类隐患）；③ 宽度表双轨（`displayWidth` vs `charWidth`）暂不合并，登记为长期项。

### 第二批（T2 + T3 + T7 + 两项同类残留）✅ 通过 —— `0f7657c` / `71eb550` / `d879700` / `5abe7c1`

**编排者独立复核（命令与结论）**

| 复核项   | 命令                                                                                             | 结论                                                                             |
| -------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 越界检查 | `git diff feat/phase-p10-next-only --name-only -- packages/{core,gateway,ui-shared,desktop,web}` | **0 文件** ✅                                                                    |
| 测试     | `pnpm --filter harness2 test`                                                                    | **91 files / 1553 passed + 2 skipped**（T1 后 1526 → +27） ✅                    |
| 效果图   | 读 `images/p11/T7-coldstart-after.png`                                                           | 引导卡（版本 + 5 条已接线键位 + `/help` 指引）+ `❯ 输入消息，/ 查看命令` 占位 ✅ |
| 效果图   | 读 `images/p11/T3-wide-after.png`                                                                | 候选两列（命令 + 灰说明）对齐、选中高亮、草稿带 `❯` 锚点 ✅                      |
| 工作树   | `git status --short`                                                                             | 干净 ✅                                                                          |

**裁定 1（残留 1，已并入 T3 完成）**：`chat-screen.ts:284/369` 的 `.length` 截断改 `displayWidth` + 宽字符不切半，变异验证两处均红过。
**裁定 2（残留 2，已独立提交）**：`CellBuffer.setCell` 统一降级 C0 控制字符，`\t` 取舍为**转空格（不按 tab stop 推进）**，理由与幂等契约说明已写入代码注释；`\x1b` 不再逐格发射（P0 同类隐患）。
**裁定 3（接受）**：引导卡"一次性"为**进程内**（不落盘）——计划允许"本会话内不重复"，跨进程重复属既定取舍；多行草稿每物理行带锚点亦属纯呈现取舍，登记供后续评估。
