# P11 前后对照（终端界面拉齐）

> 图：`before-*.png` = P10 阶段（改动前）抓帧；`after-*.png` = P11 收口后抓帧。
> 均为 `scripts/tui-parity/ptycap.py`（ConPTY 抓屏 + 本地重绘，**非系统截图**）；结论以同名 `.txt` 屏幕网格为准。
> 场景与判据：`docs/tui-parity/matrix.md` 改进清单。

| 改进项                         | 场景         | 前（P10）                                                                         | 后（P11）                                                                                                          | 结论                                                         |
| ------------------------------ | ------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **#1 P0** `/help` 面板错位     | `/help`      | [`before-C2-help.png`](before-C2-help.png)（文字互相覆盖、碎片 `essio s`）        | [`after-C2-help.png`](after-C2-help.png)（两列对齐、说明逐行独立）                                                 | ✅ 修复（根因：多行文本被投影成一条逻辑行、`\n` 写进单元格） |
| **#2 P1** 输入区不可见         | 空态/草稿    | [`before-A1-coldstart.png`](before-A1-coldstart.png)（无输入区痕迹）              | [`after-A1-coldstart.png`](after-A1-coldstart.png)（` 输入消息，/ 查看命令` 占位 + 锚点）                          | ✅ 修复                                                      |
| **#3 P1** 候选单列无说明       | 敲 `/`       | [`before-C1-slash.png`](before-C1-slash.png)（单列命令名）                        | [`after-C1-slash.png`](after-C1-slash.png)（两列：命令 + 灰说明，选中高亮）                                        | ✅ 修复（窄屏退化见 `T3-narrow/verynarrow`）                 |
| **#4 P1** 无时间戳/耗时/用量   | 一轮对话     | [`before-B1-turn.png`](before-B1-turn.png)（仅 `[end_turn · steps · toolCalls]`） | [`after-B1-turn.png`](after-B1-turn.png)（行尾 `01:32` 时间戳、`[end_turn · 12.3s · …]`、状态行 `ctx 15.3k/128k`） | ✅ 修复（token 无来源时如实降级 `ctx —`）                    |
| **#5 P1** 工具行暴露 JSON 参数 | 工具卡       | [`before-D1-tool.png`](before-D1-tool.png)（` write({"file_path":…})`）           | [`after-D1-tool.png`](after-D1-tool.png)（`⏺ 写入 harness2-demo.txt`；展开态保留原始参数）                         | ✅ 修复                                                      |
| **#6 P1** 忙碌态无耗时/消耗    | 长回答回合中 | [`T6-busy-before.png`](T6-busy-before.png)（`⠦ 运行中…` + `Ctrl+C 取消`）         | [`T6-busy-after.png`](T6-busy-after.png)（`⠦ 运行中… 已用 2s` + `Ctrl+C 取消 · Ctrl+Enter 立即发送`）              | ✅ 修复（`↓N` 取真实 usage，无则不显示）                     |
| **#7 P1** 冷启动无引导         | 冷启动       | [`T7-coldstart-before.png`](T7-coldstart-before.png)（空白转录）                  | [`T7-coldstart-after.png`](T7-coldstart-after.png)（欢迎卡：版本 + 5 条已接线键位 + `/help` 指引）                 | ✅ 修复（`HARNESS2_NO_WELCOME` 可关；任意键收起）            |

## 说明与边界

1. **J1 队列场景**我方 `01-queued` 帧仍为**空帧**（抓帧时机早于首帧渲染，非缺陷）——忙碌态对照改用 `T6-busy-*` 这一对（同为真实忙碌帧）。
2. 全部判据来自 `.txt` 屏幕网格；PNG 仅供人眼快速比对（字体度量与真机有差异）。
3. 未覆盖：`/help` 的**真机**观感、鼠标/IME/选择复制 —— 仍归 `docs/issue-log/OPEN.md` 真机清单。
4. 复现命令见 `docs/tui-parity/README.md`（`run.py --side ours` 可重跑全部我方场景）。
