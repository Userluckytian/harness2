# P11 第三批（T4 / T5 / T6）抓屏前/后证据

> 抓屏工具：`scripts/tui-parity/ptycap.py`（ConPTY + pyte，隔离 venv）· 画布 110×30 · mock provider
> 结论以 `.txt` 屏幕网格为准，`.png` 供快速人眼比对（诚实边界见 `docs/tui-parity/README.md` §3）。
> 本批只回填**第三批**（用量三件套 / 工具行人类化 / 忙碌态反馈）；完整 before-after 矩阵归 T8。

## T4 用量三件套（时间戳 / 每轮耗时 / token）

| 场景                                  | 前                         | 后                        | 差异要点                                                                                                   |
| ------------------------------------- | -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 一轮对话完成（默认 mock，write+read） | `T4-turn-before.png/.txt`  | `T4-turn-after.png/.txt`  | 后：消息行尾右对齐本地时间戳（`01:31`，弱化灰）；`[end_turn · 0.0s · steps 3 · toolCalls 2]`（前无耗时段） |
| 带 provider usage 的一轮              | `T4-usage-before.png/.txt` | `T4-usage-after.png/.txt` | 后：状态行 `ctx 15.3k/128k`（`assistant/message.usage` = 15000+700）；前仅 `ctx 0%`（壳层未转发 usage）    |

- **时间戳来源**：磁盘重放 = 会话事件 `ts`（`SessionEvent.ts`，writer 落盘时生成）；live = 落帧时刻墙上时钟（core `onStream` 不产出 ts，见 `next-shell.ts` `dispatch()` 注释）。**不会拿当前时间顶替缺失 ts**（`formatClock` 不可解析即不显示）。
- **耗时来源**：`TurnResult.durationMs`（core loop `performance.now()` 差值，真实计时）。
- **token 来源**：`assistant/message.payload.usage`（每 step 末落盘）经 `chat-setup.ts` 写入口观察缝转发（核心零改动）；无 usage = `ctx —`/比例降级，不编数字。分母 `DEFAULT_CONTEXT_WINDOW`（与 core `getContextUsage` 同一兜底常量，CLI 尚不传模型声明窗口 → 登记为已知近似）。

## T5 工具行人类化（动词短语 + 参数入展开态）

| 场景                           | 前                                 | 后                                | 差异要点                                                                                                                               |
| ------------------------------ | ---------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 工具卡折叠态                   | `T5-tool-folded-before.png/.txt`   | `T5-tool-folded-after.png/.txt`   | 前 `⏺ write(harness2-demo.txt)`；后 `⏺ 写入 harness2-demo.txt`（主行不含 JSON，工具名不在折叠主行）                                    |
| 工具卡展开态（Tab 焦点 + `E`） | `T5-tool-expanded-before.png/.txt` | `T5-tool-expanded-after.png/.txt` | 后新增 `  ⚙ write({"file_path":"…","content":"…"})` 明细行（工具名 + 原始参数 JSON 移入展开态）；结果行 `└ ✓`、diff 卡与失败态结构不变 |

- 动词注册表与未知工具回退见 `packages/cli/src/tui/next/projection.ts` 的 `TOOL_ACTIONS` / `toolActionPhrase`：逐条覆盖内置工具；**未知工具/args 非 JSON/必需参数缺失 → 回退现状 `工具名(摘要)`**，绝不硬编码失败。原始视图（`r`）保留 `工具名(args 原文)`（轨迹不回退）。

## T6 忙碌态反馈（真实耗时 + 取消键）

| 场景                             | 前                        | 后                       | 差异要点                                                                                                                                                                                     |
| -------------------------------- | ------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 忙碌帧（长回答 mock，等待 2.5s） | `T6-busy-before.png/.txt` | `T6-busy-after.png/.txt` | 后：状态行 `… · ⠦ 运行中… 已用 2s`（真实计时 `Date.now()-turnStartedAt`）；提示行 `Ctrl+C 取消 · Ctrl+Enter 立即发送`（G-28 已接线的 send-now 如实呈现）。前：`⠦ 运行中…` + 仅 `Ctrl+C 取消` |

- 忙碌消耗 `↓N` 只在**本回合**收到真实 usage 时才追加（`usageThisTurn`），且 `↓` 取 `outputTokens`；无数据省略，不猜。空闲帧不含任何忙碌字段（见 `p11-usage-tools-busy.test.ts`）。
- 未写 `Enter:queue`：忙碌 Enter 的语义随 `[ui].follow_up_behavior`（queue/steer）而变，`shortcutsFor` 拿不到该配置，故不写单一含义（队列状态由 `Ctrl+; 队列(N)` 段体现）。
