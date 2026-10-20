# 参考仓刷新记录（2026-10-14）

> 六步流程之「拉取 + 过期判定」记录。补条目正文已并入 `docs/refs/refs-zcode.md`（Z-96/Z-97）与 `docs/refs/refs-zcode-layout.md`（Z-46~Z-49、Z-04/Z-10 修订），基线表已同步。

## ZCode（权威：GUI 视觉/组件/布局）

- 拉取：`29628c9`(v3.14.3) → `aac47556`(v3.15.1)，**`git log` 显示区间只有 1 个 squash 版本提交**（上游以 squash 方式发布，无法逐提交看差异；行为差异以源码实核为准，已完成）。
- 旧文档基线登记「未拉取成功沿用本地快照」→ 本次拉取成功后两份文档基线表已改为 `aac47556`。
- 对 harness2 的影响判断（三句话）：①五场景规格在 v3.15.1 全部**复核成立**（Z-04 挂载点、Z-10 右键菜单仅行号勘正，无行为变化）；②新增的 Z-46~Z-49/Z-96~Z-97 均取证于 v3.15.1 当前行号，实施直接引用新编号即可；③ZCode 自身在启动壳/ErrorBoundary 仍无窗控（Z-46 已注明）——harness2 按「复刻+改进」口径补这三处不算偏离。

## grok-build（权威：CLI 交互）

- 拉取：`2bdd1d6a`，本轮 fetch 无新提交（本地=远端，快照 2026-09-29）。
- 结论：`refs-grok-build.md` 不过期（本期不动 CLI），不重析。

## hermes-agent（权威：功能完整性）

- 拉取：已 pull 至 `a62979dc`（2026-10-10，compression refused-candidate 修复）；新提交与 UI 无关、且本期不动 core（契约冻结区）。
- 结论：`refs-hermes-agent.md` 维持现状；H-47 待拍板项不受影响。

## deepseek-harness（降级：页面布局既有参考）

- 拉取：已 pull 至 `d7432673`（2026-10-09）；本期 GUI 权威是 ZCode 双文档，不展开重析。
- 结论：`refs-deepseek-harness.md` 维持现状。

## 执行者备注

- 本轮拉取与 ZCode 五场景源码取证由 Explore 子代理完成（只读），编排者对 Z-46/Z-47/Z-96/Z-97 引用的 12 处关键行号做了 sed 抽查核实（全部命中，个别行号在落盘时按实核结果微调，如 `AnimatedSidePanePanel.tsx:811→:839`、`WorkspaceHeader.tsx:120→:128`）。
- Denia 仓取证（非 refs 四仓，属用户点名的额外参考）见同目录 `denia-ui-analysis.md`；其仓已 `git pull` 至 `0c4aef5` 并保持只读。
