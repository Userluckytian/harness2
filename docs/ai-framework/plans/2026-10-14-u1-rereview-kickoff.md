# 新会话启动提示词（U1 jam 复审续派 · B 路径）

> 用途：cat-jam 派发通道受「会话启动快照」限制（本会话绑死了被上游拒绝的旧模型），须**新开 ZCode 会话**激活 `~/.zcode/agents/cat-jam.md`（定义已指向健康模型 `qwork-advanced`，原值备份 `.bak-2026-10-14`）。把下面整段粘进新会话即可无缝续接。

---

接续 harness2 阶段 U1（你是编排者角色，只计划+验收，不写功能码）。工作区 `D:\AI_Projects\harness2`，分支 `feat/phase-u1-desktop-parity-fixes`（HEAD 以 `git log -1` 为准，应为 `a79f9ea` 之后；38+ 提交未 push）。产品已交付待审：`packages/desktop/release/harness2-1.0.2-win-x64.exe`（端到端冒烟绿）。

先派 cat-jam 子代理执行**第二轮全量复审**（用户选定的严格口径）：任务书 `docs/ai-framework/plans/2026-10-14-u1-rereview-brief.md`——**按「单片派发策略」分四次派**（片1 主进程 → 片2 渲染端 → 片4 红线卫生 → 片3 性能终态），每片任务书里自带范围/证据要求/报告落盘路径（`docs/ai-framework/plans/2026-10-14-u1-review-jam-rereview.md`，追加式）。派发前先探活：`curl -s -m 10 http://127.0.0.1:40080/v1/chat/completions -H "Authorization: Bearer sk-unified-local" -H "Content-Type: application/json" -d '{"model":"cat-jam","messages":[{"role":"user","content":"ok"}],"max_tokens":4}'`——注意该路由是**直连仍红但经新会话 cat-jam 代理可用**（定义已换模型），以实际 Agent 派发为准，别被探针误导。

复审跑完后：编排者独立复跑各片闸门（环境注意：本机 `pnpm`/`npx` 坏——`System32\cmd.exe` 缺失，一律直调 `packages/<x>/node_modules/.bin/`；core/cli 共 11 例真子进程测试为环境级红非回归），修掉新 P0/P1，然后向用户申请 push → 合 main → tag `v1.0.2` 发版授权（Release note 素材在 `docs/diary/2026-10-14.md`；M1-M12 真机清单 `docs/ai-framework/plans/2026-10-14-u1-real-machine-checklist.md`）。

上下文细节：`docs/issue-log/2026-10-14.md` §1-§10（当日全记录，含 gen-icon 漏报复核、通道根因 FreeTierError 间歇放行）。
