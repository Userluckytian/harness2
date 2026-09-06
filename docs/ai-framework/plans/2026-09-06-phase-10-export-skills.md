# 阶段 10：轨迹导出/回放 + Skills → M3 v0.6 发布

> **状态：** 计划已就绪（总控计划 Ph10 / 里程碑 M3，2026-09-06 批准；基线 = 阶段 9 验收线，测试 540 passed + 1 skipped；Ph9 复审待补不阻塞本阶段）
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 打通"轨迹作为资产"的最后一环——会话导出（ZIP，含子代理）与回放校验（轨迹即测试夹具）；引入项目级 Skills（dsh/hermes 式按需注入）；完成 M3 v0.6 发布物料。
**Architecture:** 导出 = 只读打包（会话目录 + 子代理目录快照）；回放 = 导入→逐事件 parse→投影→黄金断言（CI 零 key 可跑）；Skills = markdown + frontmatter，名称/描述注入 system，全文经 `skill` 工具按需加载（对齐 dsh skill 思想的最小子集）。
**Tech Stack:** 现有栈；新增运行时依赖 `fflate`（纯 JS zip，dsh 同款选型）。

---

## 前置阅读（必须）

| 优先级 | 文件 |
|--------|------|
| P0 | 本文件、`packages/core/src/session/{types,reader}.ts`（事件/投影）、`packages/core/src/agent/subagent.ts`（子会话血缘：parentSession） |
| P0 | `packages/core/src/agent/loop.ts`（system 注入缝——Skills 注入复用）、`config/schema.ts`（契约扩展先例） |
| P1 | `docs/research/2026-09-06-reference-analysis.md` §2.4（dsh 轨迹导出/快照回放实证）、`AGENTS.md` |

**仓库路径：** `D:\AI_projects\harness2`（默认分支 `master`）
**基线分支：** 从 `master` 拉 `feat/phase-10-export-skills`

---

## Global Constraints（冲突时以本节为准）

1. **契约扩展仅两处（均加性）**：①`ChatRequest.system` 已有缝——Skills 注入只追加 system 内容段（格式 `[Skills 可用] name: description` 列表），不改结构；②新增事件类型 **不加**（skill 加载经 tool/call+tool/result 自然落盘，零契约变更）。
2. **导出只读**：export 不修改会话目录任何文件；zip 内路径固定结构（见 Task 1）。
3. **密钥/隐私**：导出内容含用户代码与对话（属用户资产），不自动上传；测试用临时目录。
4. **Skills 边界**：只做文本指令型 skill（无可执行脚本）；项目级 `.harness2/skills/` 优先于全局 `~/.harness2/skills/`（同名覆盖 + 告警）；上限 50 个。
5. **明确不做（本阶段）**：远程同步、加密导出、skill 市场、可执行 skill。
6. **Git：** 每 Task 一提交；禁止 push。

---

## File Structure（预期变更）

| 文件 | 动作 | 职责 |
|------|------|------|
| `packages/core/src/session/export.ts` | 新建 | exportSession(dir, out)：fflate zip（session.v1.jsonl + rewind_points.jsonl + snapshots/ + subagents/<id>/ 递归）+ importSession(zip)：校验解析+投影摘要 |
| `packages/cli/src/index.ts` | 修改 | `harness2 export <sessionDir> -o <file>`、`harness2 replay <zip>`（校验+投影报告）、`harness2 skill list` |
| `packages/core/src/skills/{store,tool}.ts` | 新建 | Skills 扫描（frontmatter: name/description）、`skill` 工具（按名加载全文）、system 注入列表 |
| `packages/core/src/agent/loop.ts` | 修改 | system 组装追加 Skills 列表（复用 memory/snapshot 同款冻结语义：skill 列表经新的 memory/snapshot？——**不**：skills 列表随每次 turn 从磁盘读（项目文件可中途新增），仅名称+描述进 system，全文走工具） |
| `packages/core/test/{export,skills}.test.ts` | 新建 | 见各 Task |
| `CHANGELOG.md`、`README.md`、版本号 | 修改 | v0.6.0 物料 |

### 导出 zip 结构（冻结）

```
<session>.zip
├── session.v1.jsonl
├── rewind_points.jsonl        # 存在时
├── snapshots/                  # 存在时
└── subagents/<sessionId>/…    # 递归（header.parentSession = 本会话的子会话）
```

---

## Task 1：轨迹导出与回放

**Files:** `session/export.ts`、`test/export.test.ts`

**行为:**
- `exportSession(sessionDir, outFile)`：fflate zipSync——主日志必含；rewind_points/snapshots 存在则含；扫描全部会话（含全局库）找 `parentSession === 本会话 id` 的子会话目录递归打包进 `subagents/<id>/`；幂等（同目录同内容 → 同 zip 字节）。
- `importReplay(zipPath)`：解包 → 每个 session.v1.jsonl 逐行 parseEventLine（坏行计数）→ computeProjection → 返回 `{sessions: [{id, events, warnings, messageCount, lastSeq}]}`。
- CLI：`harness2 export <dir> -o <file>`（默认输出到 cwd，文件名 `<sessionId>.zip`）；`harness2 replay <zip>`（打印各会话投影摘要；坏行/解析失败列出；exit 1 on 空包）。
- 测试：含子会话的目录导出→导入→投影与原库一致（黄金断言）；坏行容错报告；幂等；空目录拒绝。

**Steps:** 1. 实现+测试（≥8 例）。2. Commit：`✨feat(core,cli): 轨迹导出与回放校验（ZIP 含子代理）`

## Task 2：Skills

**Files:** `skills/{store,tool}.ts`、loop 修改、`test/skills.test.ts`

**行为:**
- store：扫描两级目录（项目 `.harness2/skills/` > 全局 `~/.harness2/skills/`，同名项目覆盖+告警）；frontmatter 解析（`name`/`description` 必填，YAML 简表）；上限 50；坏文件跳过+告警。
- system 注入：turn 开始时扫描 → system 追加区块 `[Skills 可用]\n- name: description`（换行分隔）——**仅列表**；冻结语义与 memory 相同（本轮请求内不变）。
- `skill` 工具（safe）：`{name}` → 返回该 skill 全文（含 frontmatter）——模型按需取用；未知名 → error。
- 测试：扫描两级/覆盖告警/上限/坏文件/工具加载/空 skills 零注入（≥10 例）。

**Steps:** 1. 实现+测试。2. Commit：`✨feat(core): 项目级 Skills（扫描/system 列表注入/按需加载工具）`

## Task 3：M3 发布物料（不执行发布）

CHANGELOG v0.6.0（M3：轨迹导出回放/Skills/M3 里程碑说明——含 M1/M2 能力累积概述）、README 增 export/replay/skill 章节、三包版本 0.6.0、OPEN 登记 v0.6 发布待授权清单。

**Steps:** 1. 物料。2. Commit：`🔧chore(release): M3 v0.6.0 发布物料`

## Task 4：整备与交接

architecture（导出/Skills 小节）、ROADMAP（P2-23/26 → ✅、M3 达成标注）、HANDOFF、diary、OPEN（真实长会话导出体积评估、skill 真机体验待用户）。

---

## 验收标准总表

| # | 标准 | 通过条件 |
|---|------|----------|
| 1 | 导出 | 含子代理递归/幂等/只读红线测试通过 |
| 2 | 回放 | 导入→投影黄金断言通过；坏行报告正确 |
| 3 | Skills | 两级扫描/覆盖/上限/工具加载/零注入测试通过 |
| 4 | CLI | export/replay/skill 命令集成测试通过 |
| 5 | 红线 | 零新增事件类型；export 只读；密钥三不 |
| 6 | 单测/构建 | `pnpm test && pnpm -r typecheck` exit 0 |

---

## 风险与降级

| 风险 | 缓解 |
|------|------|
| 子会话扫描需全库遍历（会话多时慢） | 只扫当前库 root 下 header 匹配；性能留档（P2-4 大日志同口径） |
| Skills system 注入影响 prefix cache | 仅名称列表（小且稳定）；全文按需走工具（不进 system） |
| fflate zip 兼容性 | 纯 JS 无原生依赖；dsh 同款选型已验证 |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给实现 AI 即可开工：

---

你是 **harness2** 阶段 10 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线
- 目录：`D:\AI_projects\harness2`（默认分支 `master`）；从 master 创建并切换 `feat/phase-10-export-skills`
- 已完成（勿重做）：阶段 1-9 均验收/闭环（……QQ/飞书网关），当前 540 passed + 1 skipped
- 唯一实施计划：`docs/ai-framework/plans/2026-09-06-phase-10-export-skills.md`
- 必读：本计划、`session/{types,reader}.ts`、`agent/loop.ts`（system 注入缝）、`agent/subagent.ts`（血缘）、`AGENTS.md`

### 做
1. 严格按 Task 1→4 顺序执行；每 Task 测试通过后规范 commit（gitmoji 中文，禁止 push）
2. 遵守 Global Constraints：导出只读；零新增事件类型；Skills 只文本型、上限 50；密钥三不
3. Task 4 更新 architecture/ROADMAP（P2-23/26 → ✅、M3 标注）/HANDOFF/diary/OPEN

### 不做
- 远程同步、加密导出、skill 市场、可执行 skill
- 提交密钥；任何 `git push`

### 工作方式
1. 先跑基线 `pnpm test` 确认全绿再动工
2. 证据优先：交卷前重跑 `pnpm test && pnpm -r typecheck`，粘贴真实输出
3. 简体中文回复；代码标识符原样

### 交卷
分支名、提交列表、验收表逐项自评（带命令与真实结果）、新增测试数、残留风险与未关闭项。

现在开始：读完本阶段计划，从 Task 1 执行到 Task 4。

---

## 残留手工验收清单

1. （用户环境）真实长会话导出体积与 replay 报告可用性
2. skill 真机体验：模型按需加载全文的行为质量
