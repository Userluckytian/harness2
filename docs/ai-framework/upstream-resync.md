# 上游 re-sync 流程（ZS 程序实操沉淀，2026-10-23）

> 适用：ZCode 壳（scratch 装配区 `D:/AI_Projects/harness2-zs1-build/ZCode`，锚点 `3c5b2276` v3.16.2）与
> 参考仓四件（grok-build / deepseek-harness / hermes-agent / ZCode，位于 `D:/AI_Projects/refs/`）的上游跟进。
> 本文件是 `docs/refs/README.md` §2 六步流程的**操作化版本**：每一步给出本程序真实用过的命令、判据与坑。

## 0. 何时触发

- 阶段开工前置（强制，AGENTS 第 7 条）：动 `packages/{cli,desktop,web}` 或壳交互前，**先走完 §1–§4**；
- 硬规则过期（refs/README §4）：上游 HEAD ≠ 文档「分析 commit」，或分析日期 >30 天，或实施中撞见文档与上游矛盾；
- 发版前（ZS6 类节点）：全仓重走一遍，判活记录入 issue-log。

## 1. 拉取（四仓全拉，无网络≠跳过）

```powershell
foreach ($p in @('D:\AI_Projects\refs\grok-build','D:\AI_Projects\refs\deepseek-harness','D:\AI_Projects\refs\hermes-agent','D:\AI_Projects\refs\ZCode')) {
  git -C $p fetch --all --prune
  git -C $p pull --ff-only
  git -C $p rev-parse --short HEAD
  git -C $p log -1 --format='%cI'
}
```

- **失败如实登记**（实证 2026-09-13：fetch 三式全败 `early EOF`，当时在文档里写「本轮未拉取，沿用 commit X」——正确做法，不得假称已更新）。
- 大仓（hermes-agent 单日到 150+ commits）fetch 可能超 5 分钟：后台跑或加 `timeout`，别把 shell 卡死。

## 2. 判活（对照各 `refs-<项目>.md` 头部「分析基线」表）

逐文档问三句：HEAD 变了吗？分析日期超 30 天吗？本阶段工作面触到的条目行号可能漂吗？
输出登记格式（issue-log 当日条）：`<仓> <旧基线>→<新 HEAD>（增量 N commits）→ 重析/沿用+理由`。

## 3. 定向增量重析（体量控制——本程序最大教训区）

- **禁止全量读 diff**（实证：hermes 一次 25663 commits/194 万行）。方法=
  `git log --oneline <旧>..<新> -- <目录>` + `git diff --stat <旧>..<新> -- <目录>` 按**工作面目录**定向。
- 条目维护三规（refs/README §5）：删除留痕；修改指到文件:行；**新增条目依据路径先 `ls` 验证再写**——
  编造条目=红线，宁写「未核实」。
- ZCode 专属：scratch 树同步=替换文件后**必须**过 `zs1-guard` 编译门与 `smokeBundle` 装载门（ZS 惯例）；
  patch 重放清单见 §5。

## 4. 文档落账 + 闸门

刷新「分析基线」表 + 「本轮更新记录」追加一行（日期/执行者/上游 commit/变更摘要）。
**格式闸门必跑**（历史 CI 事故：文档挂 prettier）：

```bash
# pnpm 无 cmd.exe 包装时的直调（本机实况）
node "D:/.pnpm-store/v11/links/@/pnpm/11.13.0/<hash>/node_modules/pnpm/bin/pnpm.mjs" exec prettier --write docs/refs/
node "..." exec prettier --check .   # 根目录全仓
```

- 管道吃退出码坑：`prettier --check ... | tail` 会让 `$?` 变成 tail 的码——CI 门前先单独跑不带管道，或 `; echo EXIT=$?`。

## 5. ZCode 上游前进时（patch 重放清单，当前基线=11 处，载体提交 scratch `247b4c0e`）

**唯一事实源=本仓 `docs/patches/zs-shell-patches.patch`（自锚点 `3c5b2276` 的完整 diff，18 文件）+ `docs/ai-framework/plans/2026-10-20-phase-ZS1-shell-skeleton.md` patch 表（P1–P11 逐条理由）**。上游前进时先 `git -C refs/ZCode log <锚>..<新>` 判触及面，再按文件逐组重放：

| 组                   | 文件与要点                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1（内心）           | `desktopRuntimeEnv.ts` hostModulePath env 注入——上游重构 desktop main 时锚行逐核对                                                                                                                                         |
| P2（交互）           | `ProviderCardSections.tsx` 获取模型按钮+勾选面板——上游改版该卡片先读旧 diff；勿丢 testid（e2e 探针依赖）；契约在本仓 adapter                                                                                               |
| P3–P6（隐藏）        | settingsNavigation 隐藏集 / 预设卡表置空 / Navigation 空组标题 / Help 外链常量门——**纯「不渲染」语义**，上游若给这些区块加 feature-gate 数据驱动则弃重放改走数据形状并登记降级                                             |
| P7–P11（品牌）       | packaged 应用名 / about 窗+版权 / shared 菜单标签×6 / UI i18n about×2 / index.html 壳标题——上游若自带品牌替换机制（u1 曾有 `intl-brand-product` 传闻，实证 scratch 树**不存在**该包，勿凭记忆假设存在）则弃 patch 改走机制 |
| 构建配置（不占编号） | `desktop-product-identity.mjs` production identity + builder `extraMetadata`（`zs6-brand-checklist.md` §2 列表）                                                                                                           |
| 打包暂存（非 patch） | `zs6-pack.ps1` 把 adapter bundle 写成 `out/host/index.js`(ESM 桥)+`harness2-host.cjs`——上游若改 host 产物布局（fork 路径/格式）此步必查                                                                                    |

重放后必跑门：adapter `buildAll`（含 smokeBundle）→ desktop `tsup`+vite renderer 重建 → `run-e2e.ps1` 全矩阵（含 `-Crash`）→ `zs6/t1-verify.cjs`+`zs6/t2-brand-verify.cjs`（隐藏+品牌回归门）→ `zs6/audit-sweep.cjs` 复跑（红线⑩）。已知既有障碍（勿误判新坑）：tsup plugin-sandbox gen-ui vendor 哈希本机永红（产物已全出，脚本按产物存在性判）；winCodeSign 归档本机无符号链接特权永解败（打包走 `signAndEditExecutable=false`）。

## 6. 执行纪律（本程序血泪两条）

1. **§14 核验**：派子代理重析时，交付报告必粘 `git diff --stat <文件>` 原文；编排者**独立** `git diff`/`wc -l` 复核——
   2026-10-22 起实证谎报 2 例（报「已写入+prettier 绿」而文件一字节未改）+ provider 阵亡 4 例（token 计数 0 为旁证）。
2. **flaky 定性法**：判据失败先原样复跑排除瞬时负载再定性（实证：macos cli 性能预算假红、soak `WorkingSet64` 采集缺陷各一例）；
   Windows CIM 内存字段用 `WorkingSetSize`（`Get-CimInstance`），`WorkingSet64` 属 `Get-Process`。

## 附：本程序历次 re-sync 台账指针

- 2026-10-22 ZS5 前置：三仓重析（grok→`2bdd1d6a` / deepseek→`687f282e86` / hermes→`8237c7f8ec`+`bf0203a794` 日更），commit `8195d81`/`076fa9e`
- 2026-10-23 ZS6 前置：四仓拉取，唯 hermes 动（日更零失真），ZCode 锚点未动（`3c5b2276`）
- 各条变更摘要以对应 `refs-<项目>.md`「本轮更新记录」为唯一事实源，本文件不复述。
