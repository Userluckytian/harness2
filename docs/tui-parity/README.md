# 终端双 TUI 对照（next 壳 vs grok）

> 建立：2026-09-15（阶段 P10）· 工具：`scripts/tui-parity/`（自动可复跑）
> 结论汇总见 [`matrix.md`](matrix.md)；差异清单已登记 `docs/issue-log/OPEN.md`

## 1. 这份报告是干什么的

把**我方终端壳（next）**与**参考实现 grok**（`grok` CLI 1.0.13，本机 `~/.grok/bin/grok`）
放在同一画布上、喂**同一份按键剧本**，逐场景抓屏比对，回答一个问题：

> 用户在同一功能上，看到的画面与交互反馈，两边差在哪？

产出的差异分 P0/P1/P2 进入改进清单，供后续阶段排期。

## 2. 方法（可复跑）

```bash
# 1) 装依赖（隔离 venv，不进 packages 依赖）
python -m venv scripts/tui-parity/.venv
scripts/tui-parity/.venv/Scripts/python.exe -m pip install -r scripts/tui-parity/requirements.txt

# 2) 我方全部场景（mock provider，零成本、可复现）
scripts/tui-parity/.venv/Scripts/python.exe scripts/tui-parity/run.py --side ours

# 3) grok 侧（必须显式授权，消耗额度；单次默认上限 1 个场景）
scripts/tui-parity/.venv/Scripts/python.exe scripts/tui-parity/run.py \
  scripts/tui-parity/scenarios/B1-stream-midshot.json --side grok --allow-grok
```

产物落在 `scripts/tui-parity/out/<场景>/<方>/`：`.png`（重绘截图）+ `.txt`（屏幕网格）+ `log.json`。
本报告引用的图已挑选归档到 [`images/`](images/)（文件名 `<场景>-<方>.png`）。

## 3. 诚实边界（必须先读，别把它当系统截图）

1. **PNG 是「ConPTY 抓屏 + 本地重绘」，不是系统级窗口截图。** 字体度量、字距、抗锯齿、
   光标绘制与 Windows Terminal 真机存在差异；**结论以 `.txt` 屏幕网格为准**，PNG 只用于快速人眼比对。
2. **覆盖不到**：鼠标拖拽/选择复制、IME 中文输入法、系统粘贴、真实字体渲染质感、真机性能手感。
   这些仍走 `docs/issue-log/OPEN.md` 的真机验收清单。
3. **grok 侧时序敏感**：它接真实模型（每轮数秒到数十秒），按 mock 调的等待窗口会抓到空帧；
   报告中引用的 grok 帧均已**重新抓取**（等待 30~75s）。因此 grok 帧的"进行中"状态仅供定性参考。
4. **mock 复现不了的两类场景**（审批弹窗、模型侧报错）在场景矩阵中标记 `defined_only`：
   只定义不执行，待真机或真实 key 阶段补。
5. **成本**：我方全部场景零成本；grok 侧本轮共 9 个场景（1 帧即杀/最小 prompt），
   逐场景登记于 `matrix.md`。

## 4. 场景矩阵（12 组 / 18 场景）

| 组       | 场景                                          | 执行情况                                             |
| -------- | --------------------------------------------- | ---------------------------------------------------- |
| A 启动   | `A1-cold-start`                               | ✅ 双方                                              |
|          | `A2-resume-session`                           | `defined_only`（复现"恢复最近会话"需两轮，留给真机） |
| B 对话   | `B1-stream-midshot` / `B2-long-code-block`    | ✅ 双方（B1 流式帧我方超时 1 次，已单独重抓）        |
| C 命令   | `C1-slash-candidates` / `C2-help-and-unknown` | ✅ 双方                                              |
| D 工具   | `D1-tool-cards` / `D2-tool-expand`            | ✅ 双方（grok 重抓）                                 |
| E 审批   | `E1-approval-card`                            | ⬜ `defined_only`（mock 自动放行，弹窗不出现）       |
| F 子任务 | `F1-subagent-dispatch`                        | ✅ 双方（grok 重抓，等 75s）                         |
| G 状态行 | `G1-status-line`                              | ✅ 双方                                              |
| H 打断   | `H1-esc-mid-turn`                             | ✅ 双方（grok 忙碌帧受时序限制）                     |
| I 撤销   | `I1-undo-redo`                                | 🟡 我方 ✅ / grok 未取到有效帧（额度与配额控制）     |
| J 队列   | `J1-busy-queue`                               | 我方 ✅ / grok 未取到                                |
| K 外观   | `K1-canvas-110x30` / `K2-canvas-160x40`       | ✅ 我方双尺寸 / grok 110×30                          |
| L 失败   | `L1-tool-failure`                             | 我方 ✅（grok 未触发失败路径）                       |
|          | `L2-model-error`                              | ⬜ `defined_only`                                    |

## 5. 本轮最重要的发现（详见 matrix.md）

- **P0：我方 `/help` 面板渲染错位**——空白屏第一次 `/help` 即出现文字相互覆盖与碎片
  （如 `essio s`、重复的 `计；别名 /status /info）`），grok 同类面板对齐良好。
  见 [`images/C2-help-ours-BUG.png`](images/C2-help-ours-BUG.png) 与 grok 对照图。
  已判定为**真实渲染缺陷**（用"空白屏首次渲染"实验排除"未擦除上一帧"解释），非抓屏失真。
- **P1：输入区没有任何视觉提示**——空态下无边框、无 `>` 提示符、无占位符、光标不可见；
  而 P10 之前默认进的是**旧壳**（顶部状态条 + 带边框的输入框），删掉后默认 UI 变成 next，此处相对旧壳是**明显退步**。
- **P1：命令候选列表缺描述**——grok 两列（命令 + 说明），我方仅单列命令名。
- **P1：缺用量与耗时**——grok 每条消息带时间戳、每轮带 `Worked for 9.9s`、右上角 `15K / 1.0M`；
  我方只有一个 `[end_turn · steps · toolCalls]` 汇总行。
- **P1：工具行暴露工具名 + JSON 参数**——grok 用人类可读动词短语 `♦ Listed 1 dir`。
- **P1：忙碌态提示行不跟随状态**——grok 忙碌时切成 `Esc:cancel` + `20s ↓15.6k [stop]`。
- **P1：冷启动无引导**——grok 有欢迎卡与快捷键列表（`ctrl+w` / `f3` / `ctrl+q`）。
- **我方优势项（保持）**：子任务卡片比 grok 更细（`⏺ Subagent "…" 完成`）；有 `ctx 0%` 上下文占用；
  有回合汇总行；状态行在顶部常驻。

## 6. 下一步

1. P0/P1 修复另立阶段计划（本阶段不动 next 功能逻辑，见 `docs/ai-framework/plans/2026-09-15-phase-next-only-and-grok-parity.md` 段 C4）。
2. 补齐本轮未取到的组：I 撤销 / J 队列 / L 失败（grok 侧）、A2 恢复会话、E 审批、L2 模型报错。
3. 真机验收：鼠标/IME/粘贴 + 上述 PNG 与真机观感差异（人眼一轮）。
