# evidence —— Notion-AI 006 交互复刻（激进-共享底座 S0-S7）专属证据目录

> 目录约定（阶段计划 `docs/ai-framework/plans/2026-09-08-phase-aggressive-core-foundation.md` 与
> `docs/research/notion-ai-20260908-0056/04-implementation-plan.md` §8「验证命令与测试族」）。
> 验收认证据：每条命令必须**实际跑过**并记录命令 + 输出尾部 + `$LASTEXITCODE`，禁止「应该能过」、
> 禁止 `--passWithNoTests` 假绿。命令在 `git worktree` 根（`D:/AI_Projects/wt-harness2/feat-notion-i1-runtime`）执行，
> PowerShell 5.1 分行（不用 `&&`）。

## 文件命名约定

| 前缀                    | 内容                                          | 示例                              |
| ----------------------- | --------------------------------------------- | --------------------------------- |
| `S<uint>-<cmd>.txt`     | 单 Task 基准确认命令输出                      | `S0-baseline.txt`                 |
| `S<uint>-<feature>.txt` | 单 Task 指定测试族输出                        | `S1-executor-cancel.txt`（S1 起） |
| `*checklist*.md`        | 功能/场景对照清单（仅清单，视觉验收归真机轨） | `12-scenarios-checklist.md`       |
| `S<uint>-<case>.md`     | 故障注入/验收专项记录（含前置假设与复现步骤） | ——                                |

每条命令记录块固定格式：命令 → 输出尾部 → `LASTEXITCODE=<n>` → 失败则附根因与是否属于本 Task 范围。

## 本目录当前内容

- `S0-baseline.txt`：S0 基线四命令（install / -r build / -r typecheck / core test）真实输出。
- `12-scenarios-checklist.md`：Grok 终端 12 场景对照清单（仅规格级别，视觉验收待真机签收）。

## Git 策略

- 本目录随仓库跟踪（证据需可审计）；生成文件的每条输出保持原样，不事后改串。
- 后续 Task 各自的命令输出按上表逐一新增文件，commit 时与本 Task 代码一起提交。
