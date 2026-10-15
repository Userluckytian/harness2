# 新会话启动提示词（U1 收尾续接 · jam 严格口径活口）

> **状态刷新（2026-10-15 09:0x）**：二轮四片复审已完成（gp 执行，留痕如实）、其 P1×2 已修、**P2 已按极小派法修 5 登 3**（`ac0df60`/`1c7c71d`/`b09e4ca`，总结 `u1-rereview-summary.md`）；交付物终版 **08:56**（端到端复验绿）。原分支 `feat/phase-u1-desktop-parity-fixes` HEAD 以 `git log -1` 为准（≥ `cb92abb`，51 提交未 push）。
> 本文档剩下的用途：①若用户选「坚持 jam-only 字面口径」，新会话按此续跑 **3 条登记项复核 + （可选）对已修 5 项做 jam 复认**；②发版动作（push→合 main→tag v1.0.2→CI 三平台）仍待用户授权后由编排者执行。
> 用途：cat-jam 派发通道受「会话启动快照」限制（本会话绑死了被上游拒绝的旧模型），须**新开 ZCode 会话**激活 `~/.zcode/agents/cat-jam.md`（定义已指向健康模型 `qwork-advanced`，原值备份 `.bak-2026-10-14`）。把下面整段粘进新会话即可无缝续接。

---

接续 harness2 阶段 U1（你是编排者角色，只计划+验收，不写功能码）。工作区 `D:\AI_Projects\harness2`，分支 `feat/phase-u1-desktop-parity-fixes`（HEAD 以 `git log -1` 为准，≥ `cb92abb`；51+ 提交未 push）。产品已交付待审：`packages/desktop/release/harness2-1.0.2-win-x64.exe`（08:56 版，端到端冒烟绿）。

先派 cat-jam 子代理执行**收尾复核**（用户选定的严格口径活口）：范围 = `docs/ai-framework/plans/u1-rereview-part1.md` §P2 之 P2-4（busy 双 close 重入）、`u1-rereview-part2.md` 末节 P2-②（设置页窗控安全区让位）两条登记项的「复核确认或修复」，以及对已修 P2 五项（`ac0df60`/`1c7c71d`/`b09e4ca` 三 commit）的 jam 复认（读码+跑 `cd packages/ui-shared && ./node_modules/.bin/vitest run --maxWorkers=4` 与 desktop 同法，不重写）。报告续写 `u1-rereview-part3.md`/新文件，逐节落盘。派发前先探活：`curl -s -m 10 http://127.0.0.1:40080/v1/chat/completions -H "Authorization: Bearer sk-unified-local" -H "Content-Type: application/json" -d '{"model":"cat-jam","messages":[{"role":"user","content":"ok"}],"max_tokens":4}'`——注意该路由是**直连仍红但经新会话 cat-jam 代理可用**（定义已换模型），以实际 Agent 派发为准，别被探针误导。

复审跑完后：编排者独立复跑各片闸门（环境注意：本机 `pnpm`/`npx` 坏——`System32\cmd.exe` 缺失，一律直调 `packages/<x>/node_modules/.bin/`；core/cli 共 11 例真子进程测试为环境级红非回归），修掉新 P0/P1，然后向用户申请 push → 合 main → tag `v1.0.2` 发版授权（Release note 素材在 `docs/diary/2026-10-14.md`；M1-M12 真机清单 `docs/ai-framework/plans/2026-10-14-u1-real-machine-checklist.md`）。

上下文细节：`docs/issue-log/2026-10-14.md` §1-§10（当日全记录，含 gen-icon 漏报复核、通道根因 FreeTierError 间歇放行）。
