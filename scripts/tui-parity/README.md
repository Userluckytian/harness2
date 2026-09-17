# TUI 抓屏对照台（`scripts/tui-parity/`）

用 **ConPTY** 驱动两个终端 TUI（我方 next 壳 / 参考实现 grok），跑**同一份按键剧本**，
把屏幕网格重绘成 PNG，供人眼或主模型逐场景比对渲染差异。

> **⚠️ 诚实边界（务必先读）**
> 产出的 PNG 是「**ConPTY 抓屏 + 本地重绘**」，**不是系统级窗口截图**。
> 字体度量、字距、抗锯齿、光标绘制、配色都与 Windows Terminal 真机存在差异。
> 因此：**结论以 `.txt`（屏幕网格纯文本，逐格保真）为准，PNG 只用于快速人眼比对**。
> 鼠标拖拽/选择复制/IME/系统字体等真机观感，本工具**覆盖不到**，仍须真机验收。

---

## 1. 安装（隔离 venv，不进 packages 依赖）

Windows / Git Bash：

```bash
python -m venv scripts/tui-parity/.venv
scripts/tui-parity/.venv/Scripts/python.exe -m pip install -r scripts/tui-parity/requirements.txt
```

依赖（见 `requirements.txt`）：`pywinpty`（ConPTY）/ `pyte`（终端仿真）/ `Pillow`（重绘）。

`.venv/` 与 `out/` 均已在根 `.gitignore` 忽略，**不入库**；本目录的 Python 依赖
**不进入 `packages/` 任何包**。

## 2. 用法

### 2.1 单会话抓屏（`ptycap.py`）

```bash
scripts/tui-parity/.venv/Scripts/python.exe scripts/tui-parity/ptycap.py \
  --cmd "node packages/cli/dist/index.js chat --provider mock" \
  --steps '[{"keys":"hi\r","shot":"01-hi"},{"keys":"/exit\r","shot":"99-exit"}]' \
  --outdir scripts/tui-parity/out/manual
```

常用参数：`--argv`（JSON 数组，路径含空格时用）、`--cwd`、`--cols/--rows`（默认 110×30）、
`--timeout`（整体超时强杀，默认 120s）、`--settle-timeout`、`--stable-seconds`、`--fontsize/--scale`、
`--exit-wait`（步骤跑完后等子进程自行退出的秒数，默认 5s，用于取真实退出码）。

### 2.2 场景矩阵（`run.py`）

```bash
# 列出全部场景（含 defined_only 标注）
scripts/tui-parity/.venv/Scripts/python.exe scripts/tui-parity/run.py --list

# 跑我方全部可执行场景（mock，零成本）
scripts/tui-parity/.venv/Scripts/python.exe scripts/tui-parity/run.py --side ours

# 跑指定场景
scripts/tui-parity/.venv/Scripts/python.exe scripts/tui-parity/run.py \
  scripts/tui-parity/scenarios/D1-tool-cards.json --side ours

# grok 侧：必须显式授权，且默认单次最多 1 个场景
scripts/tui-parity/.venv/Scripts/python.exe scripts/tui-parity/run.py \
  scripts/tui-parity/scenarios/A1-cold-start.json --side grok --allow-grok
```

产物布局：

```
scripts/tui-parity/out/
  <场景 id>/
    ours/  { 01-*.png, 01-*.txt, log.json }
    grok/  { 01-*.png, 01-*.txt, log.json }
  _tmp-home/   # 每场景独立临时 HOME/工作目录
```

`out/` 不入库；对照报告需要的图由编排者挑选后拷进 `docs/tui-parity/images/`。

## 3. 额度约束（**重要**）

| 规则                | 说明                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------- |
| 我方一律 mock       | `--provider mock`：零成本、可复现；`--home/--root` 指向场景独立临时目录，冷启动确定    |
| grok 侧默认禁止     | 不带 `--allow-grok` 直接拒绝执行；带授权后单次运行最多 `--grok-budget 1`（默认）       |
| 本轮 grok 只跑 1 个 | A 组冷启动抓一帧即杀（步骤 `"kill": true`）；**其余 grok 场景只定义、不执行**          |
| mock 复现不了的场景 | 标 `"defined_only": true`（审批弹窗、模型报错），默认跳过，需 `--include-defined-only` |

## 4. 步骤字段（`steps[]`）

| 字段              | 类型  | 说明                                                                          |
| ----------------- | ----- | ----------------------------------------------------------------------------- |
| `keys`            | str   | 发送按键；`\r` 回车、`\u001b` Esc、`\t` Tab、`\u0003` Ctrl+C、`\u0004` Ctrl+D |
| `wait`            | float | 固定等待秒数，**不做稳定判定**（专门用于「流式中截图」）                      |
| `settle`          | bool  | 是否等屏幕稳定；给了 `wait` 时默认 `false`，否则默认 `true`                   |
| `timeout`         | float | 本步等稳定的上限秒数（超时不报错，按现状抓屏并记 `settled:false`）            |
| `stable_seconds`  | float | 本步要求的静默窗口（覆盖全局默认 1.2s；**冷启动首帧宜调大到 3.0**)            |
| `stable_ticks`    | int   | 本步要求的连续不变次数（覆盖全局默认 3）                                      |
| `require_content` | bool  | 等稳定时是否拒绝「全空白屏」，默认 `true`（防冷启动误判，见 §5）              |
| `shot`            | str   | 截图名（落 `<outdir>/<shot>.png` + `.txt`，并追加进 `log.json`）              |
| `kill`            | bool  | 截图后立刻强杀并结束剧本（额度受限场景用）                                    |

## 5. 稳定性机制（相对原型的硬化点）

原型（`.tmp-cap/ptycap.py`）用固定 `sleep` + 固定按键时序，实测有两个真实问题，本工具已修：

1. **等屏幕稳定替代固定 sleep**：轮询屏幕哈希，要求连续 `stable-ticks`（默认 3）次不变，
   且静默时长 ≥ `stable-seconds`（默认 1.2s），到点才抓；上限 `settle-timeout`。
2. **拒绝「空白屏即稳定」**（`require-content`，默认开）：实测 node 冷启动约 4s 才首帧，
   固定 sleep 版会在这之前判「稳定」抓到空屏——这是最主要的 flaky 来源。开启后冷启动
   会一直等到首帧出现（超时上限内），实测 3 个场景零空屏。
   另：冷启动存在「会话行先落、其余稍后补」的中间态，故冷启动首帧建议显式调大静默窗口
   （`stable_seconds: 3.0`，已在 `A1/K1/K2/G1` 的首步采用）。
3. **三件套**：每次抓屏同时产出 `.png` + `.txt`（屏幕网格）+ 追加 `log.json`
   （含 argv/canvas/字体链/是否 settled/静默时长/字节数/文本预览），且每步即时落盘，
   异常中断也有据可查。
4. **超时强杀**：整体 `--timeout` 到点强杀子进程；退出码 `0`=成功、`2`=超时强杀、`1`=异常。
5. **字体链**：等宽主字体（Cascadia Mono → Consolas → DejaVu Sans Mono）
   → **CJK 回退（微软雅黑 msyh.ttc 等，已修好，勿改顺序）** → 符号回退（Segoe UI Symbol / Segoe UI Emoji / Arial）。
   - 宽字符（East Asian W/F）走 CJK 字体 → 中文不会变方框；
   - 主字体缺字形（如 `⏺` `✓`）时回退符号字体 → 不再是豆腐块。
     判定方式：把该字形蒙版与私用区码点 `U+E000` 的 `.notdef` 蒙版对比，相同即视为缺失。

## 6. 场景 schema

```json
{
  "id": "D1-tool-cards",
  "group": "D 工具",
  "watch": "看点：这一帧要对比什么",
  "canvas": { "cols": 110, "rows": 30 },
  "timeout": 60,
  "defined_only": false,
  "note": "（可选）为什么 defined_only / 注意事项",
  "sides": {
    "ours": {
      "argv": [
        "node",
        "${REPO}/packages/cli/dist/index.js",
        "chat",
        "--provider",
        "mock",
        "--home",
        "${TMP_HOME}/home",
        "--root",
        "${TMP_HOME}/work"
      ],
      "isolate_home": true
    },
    "grok": { "argv": ["${GROK}", "--cwd", "${TMP_HOME}/work"] }
  },
  "steps": [{ "keys": "hi\r", "shot": "01-tool-cards", "timeout": 30 }, { "keys": "/exit\r" }]
}
```

**占位符**（由运行器注入）：

| 占位符        | 含义                                                                        |
| ------------- | --------------------------------------------------------------------------- |
| `${REPO}`     | 仓库根绝对路径                                                              |
| `${TMP_HOME}` | 该场景独立临时目录（运行器预建 `home/`、`work/`），保证冷启动确定、互不污染 |
| `${GROK}`     | grok 可执行文件（`shutil.which` / `~/.grok/bin/grok.exe`）                  |

> grok 侧**不隔离 HOME**（需要 `~/.grok` 里的登录凭据），只通过 `--cwd` 隔离工作目录。

## 7. 场景矩阵（12 组，18 个场景）

| 组       | 场景 id                | 可执行 | 关键步骤 / 看点                                                  |
| -------- | ---------------------- | ------ | ---------------------------------------------------------------- |
| A 启动   | `A1-cold-start`        | ✅     | 冷启动抓一帧即杀；首屏欢迎/状态行/输入框边框                     |
| A 启动   | `A2-resume-session`    | 🚫     | 恢复上次会话需同一 HOME 跑两轮，单进程无法自证（`defined_only`） |
| B 对话   | `B1-stream-midshot`    | ✅     | `wait 0.6` 抓流式中，再 settle 抓完成后                          |
| B 对话   | `B2-long-code-block`   | ✅     | mock 剧本给长回答+代码块，看折行/缩进                            |
| C 命令   | `C1-slash-candidates`  | ✅     | 敲 `/` 出候选列表；Esc 后是否收起                                |
| C 命令   | `C2-help-and-unknown`  | ✅     | `/help` 形态 + 未知命令报错文案                                  |
| D 工具   | `D1-tool-cards`        | ✅     | write/read 卡片：图标/摘要/`└ ✓`                                 |
| D 工具   | `D2-tool-expand`       | ✅     | 默认折叠 → `e` 展开                                              |
| E 审批   | `E1-approval-card`     | 🚫     | mock 对全部工具自动放行，弹窗无法复现（`defined_only`）          |
| F 子任务 | `F1-subagent-dispatch` | ✅     | mock 剧本派 `subagent_start`，看完成态卡片与子会话入口           |
| G 状态行 | `G1-status-line`       | ✅     | 空闲/忙碌两帧的模型名/模式/ctx%/耗时字段                         |
| H 打断   | `H1-esc-mid-turn`      | ✅     | 回合中 Esc 提示 + Ctrl+C 语义                                    |
| I 撤销   | `I1-undo-redo`         | ✅     | `/undo` 收缩 → `/redo` 恢复                                      |
| J 队列   | `J1-busy-queue`        | ✅     | 忙碌时回车排队 → 排空                                            |
| K 外观   | `K1-canvas-110x30`     | ✅     | 110×30 默认画布                                                  |
| K 外观   | `K2-canvas-160x40`     | ✅     | 160×40 宽画布，长行不折行                                        |
| L 失败   | `L1-tool-failure`      | ✅     | mock 剧本读不存在文件 → `└ ✗` 错误态                             |
| L 失败   | `L2-model-error`       | 🚫     | mock 恒成功，模型报错需真 provider（`defined_only`）             |

`scenarios/mock/*.json` 是给 `--mock-script` 用的 mock 剧本（长回答、工具失败、子任务），
**不是场景文件**，不会被 `run.py` 收集。

**已冒烟验证（我方，见 §8）**：`A1`、`C1`、`D1`、`D2`、`I1`、`L1`（多帧）；
**grok 侧**：仅 `A1`（额度约束）。其余场景已定义但未跑，交编排者 C1 批量执行。

## 8. 冒烟证据（2026-09-15，本机实测）

| 项                  | 命令                                                                            | 结果                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 我方 3 场景         | `run.py A1-cold-start.json D1-tool-cards.json L1-tool-failure.json --side ours` | exit 0，26.4s，3 张 PNG，无空屏 ✅                                                                   |
| 冷启动稳定性        | A1 连跑 3 次，比对 `.txt` 首屏内容                                              | 3/3 均含「会话行 + 状态行 + 提示行」完整首屏（`quiet≈3.0s`）✅                                       |
| 干净退出（/exit）   | `run.py D1-tool-cards.json --side ours`（末步 `/exit`）                         | 子进程自行退出，**exit=0**（非强杀）✅                                                               |
| 扩展验证（6 场景）  | `run.py D2 C1 I1 --side ours` + A1/D1/L1                                        | 6 场景均出图且非空屏；产物共 12 张 PNG ✅                                                            |
| 折叠键实测          | D2：`hi` → Tab → `E`                                                            | 输入框聚焦时折叠键被当普通字符；**Tab 切到 scrollback 后 `Shift+E` 全展生效**（PNG 79483→98070 B）✅ |
| 候选列表实测        | C1：`/` → Esc                                                                   | `/` 出候选列表（`/always-approve`…）；**单击 Esc 不收起**（两帧一致），已写入 watch 作为差异看点 ✅  |
| grok 冷启动（1 个） | `run.py A1-cold-start.json --side grok --allow-grok`                            | exit 0，5.2s，1 张 PNG（53735 B），抓一帧即杀，额度可控 ✅                                           |
| 中文/边框           | 读图 + `.txt` 网格                                                              | 中文正常无方框；`│ ╭ ╮  ╯  └` 边框/树线正常 ✅                                                       |
| 符号回退            | 读图放大局部                                                                    | `⏺ ✓` 已由符号字体补齐（原型为豆腐块）✅                                                             |

产物（`out/`，不入库）：

```
A1-cold-start/ours/01-cold-start.png     32194 B（A1-cold-start/grok/01-cold-start.png 53735 B）
C1-slash-candidates/ours/*.png           46703 B ×2
D1-tool-cards/ours/01-tool-cards.png     77276 B
D2-tool-expand/ours/*.png                77256 / 79483 / 98070 B
I1-undo-redo/ours/*.png                  77037 / 51601 / 111345 B
L1-tool-failure/ours/01-tool-failure.png 77953 B
```

## 9. 已知限制

1. 非系统级截图：字体度量/抗锯齿/光标与真机不同（见 §诚实边界）。
2. mock 无法复现审批弹窗与模型报错 → 相关场景标 `defined_only`，待真 provider 或编排者统一跑。
3. 流式中截图（`wait` 固定秒）天然有时序不确定性，仅用于「有增量」的定性对比。
4. 恢复会话（`A2`）需同一 `--tmp-home` 连跑两次，运行器不自动重跑。
5. **折叠/展开类键位只在滚动区聚焦时生效**（输入框聚焦时 `e`/`E` 会被当普通字符输入），
   场景需先 `Tab` 切焦点；键位单一事实源：`packages/cli/src/tui/render/folds.ts`。
