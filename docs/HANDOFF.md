# HANDOFF — 交接入口（新维护者/AI 从这里开始）

> 更新：2026-09-06（阶段 2 完成） · 本文件是唯一交接入口，保持与实际状态同步。

## 1. 项目一句话

**harness2**：自研跨端 AI agent harness（CLI / 桌面 / IM 网关多形态），TypeScript monorepo。对标 opencode / hermes / deepseek-harness / grok（调研见 `docs/research/`）。

## 2. 当前状态快照

| 项 | 状态 |
|----|------|
| 默认分支 | `master`（注意：不是 main） |
| 开发分支 | `feat/phase-2-agent-loop-tools`（阶段 2 全部工作在此；阶段 1 在 `feat/phase-1-session-core`） |
| 阶段 1 | ✅ 已完成并验收（事件溯源会话内核 + 轨迹，33 测试） |
| 阶段 2 | ✅ 自验 + 阶段 2 独立审查 P1/P2 全部修复（Agent loop + 工具系统 + MockProvider + CI 骨架）；独立验收 `/accept-phase` 待做 |
| 阶段 3 | ⬜ 未开始：Provider 真实实现 + 配置体系 + 审批细化（ROADMAP P0-7/8/9） |
| 未关闭事项 | 读 `docs/issue-log/OPEN.md`（保持为零上下文第一读） |
| 测试 | `pnpm test`（含 build）—— core 106 passed + 1 skipped（`H2_GEN_LOOP_DEMO` 门控的 fixture 生成器，非用例失败）+ cli 3 passed = 109 passed + 1 skipped（2026-09-06，审查修复后；此前文档误记为「98 全绿」） |
| 远程 | 无（未配置 origin；push 需人类授权） |

## 3. 文档地图（按阅读顺序）

1. `AGENTS.md` —— 协作规范入口：工作模式（编排者/子代理分工）、强制遵循、提交规范
2. `docs/ai-framework/workflow-delegation.md` —— 角色/流程细则（每阶段标准流程、验收规则、交接要求）
3. `docs/MASTER-PLAN.md` —— **总控计划**（里程碑 M1–M4、阶段 Ph2–Ph12、横切线）——批准后为全局实施依据
4. `docs/ROADMAP.md` —— 26 项功能清单 + 架构决策 D1–D6 + 明确不做
5. `architecture.md` —— 技术栈与核心不变量（阶段 2 起：含 Provider 缝 / Agent loop / 工具系统小节）
6. `docs/ai-framework/plans/` —— 阶段计划（每份含零上下文交接提示词）
7. `docs/diary/YYYY-MM-DD.md` —— 每日日志（发版 release note 素材）
8. `docs/issue-log/` —— 问题日志（README 约定 + OPEN.md 未关闭索引）
9. `docs/research/2026-09-06-reference-analysis.md` —— 四参考项目实证调研

## 4. 如何继续开发（标准循环）

```
读 AGENTS.md + workflow-delegation.md
→ 读 OPEN.md 掌握未关闭项
→ 读下一阶段计划（docs/ai-framework/plans/）
→ 编排者派实现代理（用计划文末的交接提示词）
→ 编排者派只读审查代理 → P0/P1 修复 → 编排者验收（重跑证据）
→ 更新：计划状态 / ROADMAP / diary / issue-log / 本文件快照
```

## 5. 关键决策（详见 ROADMAP D1–D6）

- TS/Node ≥22 + pnpm monorepo；Electron+React 桌面（P1）
- 会话 = append-only JSONL 事件日志（唯一事实源，Model-visible ⟺ logged）；SQLite 只做索引（后期）
- 撤回/分叉 = 同一日志上的投影操作（undo 为主、fork 为辅、grok 三模式为增强）
- 自研轻量插件总线，不引 Cordis；文件快照不依赖 git
- QQ 机器人走官方 Bot API v2（用户已注册）；不做个人号逆向

## 6. 环境与命令

- Node ≥22（实测 v22.23.0）、pnpm 11（实测 11.13.0）、Windows + Git Bash
- `pnpm install` → `pnpm test`（= build + test）→ `pnpm -r typecheck`
- 试轨迹：`node packages/cli/dist/index.js traj packages/core/fixtures/demo-session`（阶段 1 手写样例）；`node packages/cli/dist/index.js traj packages/core/fixtures/loop-demo`（阶段 2 agent loop 实跑生成的会话）
- 注意：`pnpm --filter @harness2/cli test` 在干净检出需先 build（根脚本已串 build）
- 跑一次 loop 演示：任意 node 脚本 `runTurn(dir, { provider: new MockProvider(script), tools, cwd, userText })`（见 `packages/core/test/loop.test.ts`）

## 7. 已知坑

- Windows 下 tsc/commit 有 CRLF warning，无害
- 会话日志写入依赖「换行即提交」语义（未以 \n 结尾的尾行视为未提交丢弃），改 writer 前先读其测试
- 外部脚手架（.opencode/、ai-framework 文档）由项目负责人维护，更新时注意与 `workflow-delegation.md` 的角色约定保持一致
- CI（.github/workflows/ci.yml）本地只做过 YAML 语法校验，Actions 真实运行待远程仓库与 push 授权（见 `docs/issue-log/OPEN.md`）
- grep 工具优先 spawn ripgrep，CI 镜像若未装 rg 会自动回退纯 JS 扫描（行为一致但大目录更慢）
