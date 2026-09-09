# 阶段 15 质量收口 — 执行者任务书（单人顺序执行）

> **用途：** 本文件是把「阶段 15 单人顺序执行」的全部指令整理成的一份**执行者任务书**，与 `2026-09-09-phase-quality-closeout.md`（总纲 + 12 任务完整任务书）配套。执行者（或执行子代理）**两者都要读**。
> **角色：** 主会话 = 全局编排者（逐步派子代理实施/测试/审查、独立验收）；执行者按本任务书顺序执行。
> **状态：** 待启动（2026-09-09）。
> **元规范：** `docs/ai-framework/phased-plan-driven.md`；`AGENTS.md`、`coding-standards.md`、`CODE_REVIEW.md`。

---

## 一、方式与定位

- **方式：** 一个人顺序执行，**12 个任务，约 12 个工作日**。不并行穿插。
- **代码位置：** `D:\AI_Projects\harness2`（文档已提交，当前 main tip `b1a7651`，领先远程 30 commit，**未 push**）。

## 二、必读文档（先看这三份 + 四份规范）

1. `docs/ai-framework/plans/2026-09-09-phase-quality-closeout.md`
   —— **唯一计划文件**。总纲 + 12 个任务的完整任务书都在这一份里，已按执行顺序排好（原 track-a/b 两份已删除）。
2. `docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md`
   —— 验收表。每做完一项回来改对应行状态（⬜未开始 / 🟡进行中 / ✅通过 / ❌不通过 / ➖不适用），并写一句证据（命令、输出、文件路径）。**证据空着不算完成。**
3. `docs/ai-framework/plans/2026-09-09-phase-quality-closeout-review-brief.md`
   —— 给代码审查同事看的（§5 有审查窗口表：A1 / A3 / A4 三个节点有权要求返工）。执行者只需提前备好证据。

另外必读（仓库内）：`AGENTS.md`、`coding-standards.md`、`CODE_REVIEW.md`、`docs/ai-framework/phased-plan-driven.md`。

## 三、分支

从 main 切换：`git checkout -b chore/phase15-quality-closeout`。
12 个任务全在这一条分支上**顺序**做，最后合回 main。
（更习惯直接在 main 小步提交也行，但**二选一，不要中途换**。）

## 四、执行顺序（不要自己重排，尤其第 3 步）

| # | 任务 | 内容 | 时间 |
|---|------|------|------|
| 1 | **A0** | 仓库卫生与基线（删临时目录、根版本号 `0.1.0→1.0.0`、跑通 typecheck+test 记基线） | Day1 上午 |
| 2 | **B1** | OPEN.md 拆分（只留待办，决策与已关闭项迁入 `DECISIONS.md`，只搬不删） | Day1 上午 |
| 3 | **B2** | ESLint(flat) + Prettier + `pnpm lint` 接入 CI，并做全量格式化 | Day1 下午–Day2 |
| 4 | **A1** | Windows 可用性 P0（shell 探测、UTF-8 解码、工具连续失败熔断、参数报错、browser 提示） | Day2–4 |
| 5 | **A2** | 真机验证（本地网关双协议八项 + 云端可选） | Day5 |
| 6 | **A3** | serve 安全加固（Origin/Host 白名单+一次性 token、WS 帧上限 1MiB、playwright 改 optional） | Day6–7 |
| 7 | **A4** | 拆分 `packages/core/src/server/sessions.ts`（73KB → 每个文件 <25KB） | Day7–8 |
| 8 | **B3** | 拆分 `cli/src/index.ts`（39KB）与 `desktop/src/renderer/App.tsx`（31KB），各 <20KB | Day8–9 |
| 9 | **B4** | 规范文档补齐（coding-standards 项目专属约定、CODE_REVIEW 六条红线、插件非隔离声明） | Day10 |
| 10 | **A5** | 阶段 9 IM 网关独立复审（生命周期、断线重订阅、msg_seq 递增） | Day10 半天 |
| 11 | **B5** | 文档与验收欠账（补阶段 5/6/8 形式验收、README 三图、HANDOFF 快照） | Day11 |
| 12 | **B6** | v1.0.0 发布准备（npm 只读检查、tag、RELEASE-CHECKLIST 打勾） | Day12 |

## 五、五条硬规则

1. **第 3 步 B2 的全量格式化必须在任何逻辑改动之前跑完**，并且单独一个 `🎨style` 提交，那个提交里**不许夹带一行逻辑改动**。顺序调换会让后面每个 diff 都混着格式噪音，审查直接打回。
2. **`.prettierignore` 必须排除 `packages/core/test/fixtures/**`**，否则格式化会改到 api-surface 基线快照，`api-surface.test.ts` 立刻失败。
3. **只用显式 `git add <具体文件>`，禁止 `git add -A`。** 小步提交，每个任务至少一个独立 commit。格式：`<gitmoji><type>(<scope>): <中文描述>（任务号）`（例：`🔧chore(repo): 清理临时目录并对齐根版本号至 1.0.0（A0）`）。计划里每个任务都写了建议 commit 标题，照抄即可。
4. **默认不 push。** main 目前刻意领先远端 30 个提交，需要 push 先问。
5. **测试不许加 `--passWithNoTests`，新增测试必须真实命中**（跑起来用例数 >0）。基线：core `789 passed + 1 skipped`，API 导出面 372 个导出。跑完要对得上，有变化必须书面说明原因。

## 六、A2 用的本地网关（已在跑，不用搭）

- **Base URL：** `http://127.0.0.1:40080/v1`
- **API key：** `sk-unified-local`
- **模型：** `big-pickle`（上下文 200K，纯文本模型，不支持图片/附件）

两个坑（计划有详细说明，务必先看）：
- `protocol=openai` 时，`baseUrl` 写 `http://127.0.0.1:40080/v1`（带 `/v1`）
- `protocol=anthropic` 时，`baseUrl` 写 `http://127.0.0.1:40080`（不带 `/v1`，代码自己拼 `/v1/messages`）

两个渠道都要验：`local-oai` 和 `local-ant`。
验证用隔离目录 `--home D:/tmp/h2-a2-home`，不要污染自己的 `~/.harness2`。
云端三家（DeepSeek / 智谱 GLM / Anthropic 官方）属 **A2-2**，key 未给——**先在验收表记 `➖`，不要用本地网关结果顶替云端结论。**

## 七、这些不要自己决定，来找我

- A0 里**是否 push 到远端**
- 云端三家的 API key（A2-2）
- NPM_TOKEN，以及打 v1.0.0 的 **tag**（B6 逐项等我授权）
- README 三张截图，出图后给我确认

## 八、每一项「做完」的统一定义

代码改完 + 相关测试通过 + 验收表对应行填了状态和证据 + 已独立提交 + 涉及行为变化的，在 `docs/issue-log/` 当日文件按**四要素**记一笔（需求描述 / 处理过程 / 修改结果 / 遗留风险）。

## 九、代码审查

做审查的同事和你在同一台机器，用只读工作树取码，你不用管。
**请不要在主工作树上随意切分支，会打断他。**
他在 **A1、A3、A4** 三个节点有权要求返工，尽量在这三步做完后**主动叫他**。

## 十、遇到判断不了的

计划里每个任务都写了「落点文件」和「不许动的边界」（例：A1 只改 loop.ts，不许改 interaction/ 的对外契约）。
如果觉得实现方式和计划冲突，**先按计划做，把不同意见写进 issue-log 的「遗留风险」**，不要自行改方案。
