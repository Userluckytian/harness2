# 阶段 1：事件溯源会话内核 + 轨迹（最小闭环）

> **状态：** ✅ 已完成——2026-09-06 独立审查（pass-with-fixes→3 P1 已修复+15 回归测试）+ 编排者验收通过（33 测试、typecheck 0 错、红线通过）。P2 建议带入 `docs/issue-log/OPEN.md` 由阶段 2 消化。
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 建立会话事件日志（append-only JSONL）与轨迹查看 CLI，使"每一次模型/工具交互可完整重建"成为后续一切功能的地基。
**Architecture:** 会话内核（core 包）是单写者事件记录器；CLI 只是第一个消费者；UI/机器人后续同为观察者。
**Tech Stack:** TypeScript 5 / Node ≥22 / pnpm workspaces / vitest（待 D1 确认）

---

## 前置阅读（必须）

| 优先级 | 文件                                                  |
| ------ | ----------------------------------------------------- |
| P0     | `docs/ai-framework/phased-plan-driven.md`             |
| P0     | 本文件                                                |
| P0     | `docs/ROADMAP.md`（决策 D1–D6）                       |
| P0     | `docs/research/2026-09-06-reference-analysis.md` §2.4 |
| P1     | `AGENTS.md`、`CODE_REVIEW.md`                         |

**仓库路径：** `D:\AI_projects\harness2`
**基线分支：** 从 `main` 拉 `feat/phase-1-session-core`

---

## Global Constraints（冲突时以本节为准）

1. 不变量「Model-visible ⟺ logged」：任何将发往模型的内容必须已可从事件日志重建；违反即测试失败。
2. 事件日志 append-only：不 update、不 delete；撤回/分叉都是追加（标记事件），代际文件不可变。
3. 密钥/凭证不进 git；API key 不落事件日志。
4. **明确不做（本阶段）**
   - ❌ Electron 桌面端、provider 真实调用（agent loop 用 mock provider 驱动）
   - ❌ SQLite 索引（先用纯文件，FTS 是 P0 后期项）
   - ❌ 插件总线公开 API（先内部事件总线）
5. **Git：** 小步 commit；**默认不 push**，除非人类明确要求。
6. **YAGNI：** 事件类型只实现本阶段需要的最小集合，字段命名对齐 dsh `known-event-types.ts` 以便后续迁移。

---

## 与前后阶段

| 阶段                   | 状态 | 交付                                                                |
| ---------------------- | ---- | ------------------------------------------------------------------- |
| 上阶段（Phase 0 调研） | ✅   | `docs/research/2026-09-06-reference-analysis.md`、`docs/ROADMAP.md` |
| **本阶段**             | ⬜   | 可复用的 core 包 + `harness2 traj` CLI + 快照回放测试               |
| 下阶段                 |      | P0-4/5：Agent loop + 工具系统（勿塞进本阶段）                       |

---

## File Structure（预期变更）

| 文件                                   | 动作 | 职责                                                                                                          |
| -------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| `package.json` / `pnpm-workspace.yaml` | 新建 | monorepo 根                                                                                                   |
| `packages/core/src/session/types.ts`   | 新建 | 事件类型 v1（session/header、user/message、assistant/message、step/*、tool/call、tool/result、rewind/marker） |
| `packages/core/src/session/writer.ts`  | 新建 | 单写者 JSONL 追加器（fsync + 原子 rename + 跨进程文件锁）                                                     |
| `packages/core/src/session/reader.ts`  | 新建 | 代际文件读取 + 内存投影（重建会话）                                                                           |
| `packages/core/src/trajectory/view.ts` | 新建 | 事件 → 时间线渲染（turn/step/tool 树）                                                                        |
| `packages/cli/src/index.ts`            | 新建 | `harness2 traj <session-dir>` 命令                                                                            |
| `packages/core/test/replay.test.ts`    | 新建 | 快照回放测试：录制事件序列 → 重建 → 断言一致                                                                  |

---

## Task 1：monorepo 骨架

**Files:** `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`packages/*/{package.json,tsconfig.json}`、`.gitignore`

**行为:** pnpm workspaces + vitest + tsc 严格模式；空测试跑通。

**Steps:**

1. 初始化四包位形：`@harness2/core`、`@harness2/cli`、`@harness2/desktop`（占位空目录）、`@harness2/gateway`（占位空目录）
2. 跑：`pnpm install && pnpm -r test` 期望：exit 0（无测试也应通过空跑）
3. Commit：`✨feat(core): 初始化 monorepo 骨架`

---

## Task 2：事件类型 v1 与写入器

**Files:** `packages/core/src/session/types.ts`、`writer.ts`、`writer.test.ts`

**行为:** 定义最小事件集与 `SessionWriter`：单写者、每事件一行 JSON、行尾 `\n`、写入即 fsync（可配置批量窗口）、目录锁防双写。

**Steps:**

1. 写 `types.ts`（对齐 dsh 命名：`session/header`、`user/message`、`assistant/message`、`step/start`、`step/end`、`tool/call`、`tool/result`、`rewind/marker`）
2. 写 `writer.test.ts`：并发追加不交错、崩溃模拟（截断行）后 reader 可跳过残行并告警
3. 跑：`pnpm --filter @harness2/core test` 期望：exit 0
4. Commit：`✨feat(core): 会话事件类型 v1 与单写者 JSONL 写入器`

---

## Task 3：读取器与投影

**Files:** `packages/core/src/session/reader.ts`、`reader.test.ts`

**行为:** 从日志重建会话（消息序列 + 步骤树 + rewind 截断语义）；`rewind/marker` 之后的"影子事件"保留在日志但标记为非活动投影。

**Steps:**

1. 实现 `reader.ts`（含 zstd 可选跳过——本阶段不压缩）
2. 测试：写入 10 事件 → rewind 到第 3 → 投影只剩前 3；原 10 事件仍可全量导出
3. 跑：`pnpm --filter @harness2/core test` 期望：exit 0
4. Commit：`✨feat(core): 事件日志读取与会话投影（rewind 截断语义）`

---

## Task 4：轨迹查看器 CLI

**Files:** `packages/core/src/trajectory/view.ts`、`packages/cli/src/index.ts`、`packages/cli/test/traj.test.ts`

**行为:** `harness2 traj <session-dir>` 输出时间线：turn 分组、step 计时、tool 调用树（含失败重试标记）、token 统计（如有）。

**Steps:**

1. 实现 view 渲染（纯函数：events → 渲染行数组，便于桌面端复用）
2. CLI 挂接 commander；提供 `--json` 输出
3. 跑：`pnpm --filter @harness2/cli build && node packages/cli/dist/index.js traj fixtures/demo-session` 期望：渲染出含 tool 树的时间线
4. Commit：`✨feat(cli): harness2 traj 轨迹查看器`

---

## Task 5：快照回放测试（轨迹即夹具）

**Files:** `packages/core/test/replay.test.ts`、`packages/core/fixtures/`

**行为:** 录制一段固定事件序列作为 fixture；断言：reader 投影 == fixture 期望投影；writer 幂等重放不产生分叉。

**Steps:**

1. 生成 fixture（手工构造，不用真实 API）
2. 跑：`pnpm -r test` 期望：exit 0
3. Commit：`✅test(core): 快照回放测试与示例会话 fixture`

---

## 验收标准总表

| #   | 标准                                                   | 通过条件                                             |
| --- | ------------------------------------------------------ | ---------------------------------------------------- |
| 1   | 事件日志可完整重建会话（含 rewind 后的影子事件可导出） | Task 3/5 测试通过                                    |
| 2   | `harness2 traj` 能渲染 fixture 时间线                  | Task 4 命令 exit 0 且输出含 tool 树                  |
| 3   | 单测/构建                                              | `pnpm -r test && pnpm -r build` exit 0               |
| 4   | 红线                                                   | 日志文件无 update/delete 路径；无 API key 入 fixture |
| 5   | 密钥                                                   | `git ls-files` 无 `.env`、`auth.json` 等敏感文件     |

---

## 风险与降级

| 风险                           | 缓解                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Windows NTFS 无目录 fsync      | 学习 grok persistence.rs 的语义：文件 fsync + 父目录尽力刷新，测试覆盖崩溃模拟 |
| pnpm 在 Windows 的符号链接问题 | 备选 npm workspaces（D1 确认时一并定）                                         |
| 事件类型 v1 设计缺陷           | 字段命名对齐 dsh，留 `v` 字段，后续按代际迁移链升级                            |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给执行 AI 即可开工：

---

你是负责 **harness2** 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线

- 目录：`D:\AI_projects\harness2`
- 从 `main` 创建并切换：`feat/phase-1-session-core`
- 已完成：参考调研（docs/research/）、ROADMAP、monorepo 技术栈已确认（TypeScript/Node ≥22/pnpm）
- 唯一实施计划：`docs/ai-framework/plans/2026-09-06-phase-1-session-core-trajectory.md`
- 必读：`docs/ai-framework/phased-plan-driven.md`、`AGENTS.md`、`docs/ROADMAP.md`

### 做

1. Task 1–5 依次执行：monorepo 骨架 → 事件类型+写入器 → 读取投影 → 轨迹 CLI → 回放测试
2. 每 Task 跑指定验证命令，exit 0 后按规范 commit（gitmoji + 中文描述）
3. 遵守 Global Constraints：append-only、Model-visible ⟺ logged、密钥不进 git

### 不做

- Electron、真实 provider 调用、SQLite、插件公开 API
- 提交密钥；未授权的 `git push`

### 工作方式

1. 先跑基线构建确认干净。
2. **严格按计划 Task 顺序**；每 Task 测试后 commit。
3. 证据优先：完成前必须重跑计划中的验证命令。
4. 用简体中文回复进度；代码标识符保持原样。

### 交卷

全部完成后给出：分支名、提交列表、验收表自评、测试/构建结果、残留风险。

现在开始：读完本阶段计划，从 Task 1 执行到最后。

---

## 残留手工验收清单

（自动化之外的 GUI / 真机项）

1. 在真实 Windows 终端（Windows Terminal / PowerShell / Git Bash）各跑一次 `harness2 traj`，确认渲染无乱码
2. 人为 kill -9 写入进程后，reader 能打开日志且给出残行告警
