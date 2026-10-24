# ZS6-T4 旧壳退役与 web 去留提案（人类拍板材料，2026-10-23）

> 状态：**待人类拍板**。本文件=纯材料，不含任何删除动作。
> 背景：ZS 程序（ZCode 壳 + harness2 内心）自 2026-10-20 起为唯一主线，旧壳全面冻结（OPEN.md 架构转向行）。ZS6 收口时旧壳去留必须有决议，否则冻结=永久债务。

## 1. 现状盘点（grep 实证，禁猜）

### 1.1 包清单与角色

| 包                   | 角色（旧 Z 程序时代）               | 与新壳关系                               | 源码规模（excl node_modules）                                          | 测试资产         |
| -------------------- | ----------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- | ---------------- |
| `packages/core`      | 内心（会话/工具/provider）          | **被 ZS 复用**（adapter esbuild 打包之） | —                                                                      | 1641 测（活跃）  |
| `packages/gateway`   | TUI 的 HTTP/WS 网关                 | 新壳不走（adapter 直连 core）            | 1MB                                                                    | 14 文件（冻结）  |
| `packages/cli`       | harness2 TUI（`harness2` 命令）     | 并存产品面（当前真实可用入口）           | 7MB                                                                    | 94 文件（冻结）  |
| `packages/desktop`   | **旧 Electron 壳**（自研 renderer） | **已被 ZCode 壳整体替代**                | git 跟踪 207 文件（磁盘 852MB 中 845MB=本地 release 构建产物，未跟踪） | 129 文件（冻结） |
| `packages/ui-shared` | 旧壳组件库（CodeViewer/对话区等）   | 被 ZCode 壳 UI 替代                      | 11MB                                                                   | 71 文件（冻结）  |
| `packages/web`       | 旧 Web 壳                           | 被替代且从未达产品级                     | 5MB                                                                    | 13 文件（冻结）  |

### 1.2 依赖图（package.json 实证）

```
cli ──→ core, gateway          gateway ──→ core
desktop(旧) ──→ core, ui-shared      web(旧) ──→ ui-shared
zcode-adapter(新内心) ──→ core       ZCode 壳(scratch) ──→ adapter host bundle（经 ZS1_HOST_MODULE_PATH/out/host 暂存）
```

- **旧壳层三包（desktop/ui-shared/web）零反向依赖**：`grep -rl "@harness2/ui-shared|@harness2/desktop" packages --include=package.json` 命中=包自身+web（互吃）。删除不伤 core/gateway/cli/adapter 任何一方。
- TUI（cli+gateway）与 ZS 壳共享 core，互不依赖。

### 1.3 CI 成本与引用面

- `ci.yml` 现役 job：core/gateway/cli/desktop/ui-shared/web 六包测试 + **旧 desktop 三平台打包 job**（`packages/desktop/release/*.exe|dmg|AppImage`）。每轮 CI 为已冻结包付全量时间。
- 文档引用面：`docs/refs/`（deepseek-harness=旧壳布局蓝本，转历史参考）、HANDOFF/ROADMAP/issue-log 历史记录（不动）、`scripts/u1-acceptance.sh` 等 U1 时代脚本（退役后失效标注即可）。
- `AGENTS.md` 强制条目 7 的「GUI 视觉以 refs-zcode 为准」已取代 deepseek-harness 蓝本地位。

## 2. 两案对比

### 案 A = 全删归档（desktop/ui-shared/web/cli/gateway 五包尽去）

| 维度     | 评估                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 收益     | 仓库极简；CI 只测 core+adapter；零冻结债务                                                                                           |
| 代价     | **砍掉唯一现役 TUI 产品面**。V9 装机验收尚未通过（新壳未经用户终验），此刻无 TUI=两壳皆不可用窗口期；gateway 的 WS 语义仍是 TUI 独占 |
| 迁移注意 | 保留 git 历史即可找回（tag `pre-zs-retirement` 归档点）；ROADMAP 若仍想要 TUI 需另立项                                               |
| 适用前提 | **用户确认弃 TUI**（或新壳已发版可用）                                                                                               |

### 案 B = 保留 cli/gateway，删旧桌面壳层（desktop/ui-shared/web）——**推荐**

| 维度     | 评估                                                                                                                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 收益     | 砍掉 537 个 git 跟踪文件（源码 ~23MB+本地产物 845MB）/213 个冻结测试文件/CI 三 test job+旧 desktop 三平台打包 job；产品面=ZS 新壳（桌面）+ TUI（终端）并存，无空窗期                                                                                           |
| 代价     | 仍养 cli/gateway 的 CI 时间与依赖树（可接受：core 复用了同样的安装）；「Z 程序终结」文档口径需补一句「TUI 维持冻结维护态」                                                                                                                                     |
| 迁移注意 | ①ci.yml 删 desktop/ui-shared/web 三 test job + desktop 打包 job；②`pnpm-workspace.yaml` 去三包；③AGENTS 条目 7 的 deepseek-harness 行标注「历史」；④HANDOFF/ROADMAP 指针更新；⑤根 package.json scripts 中旧壳入口清理；⑥删除=git 历史保留，反悔走 `git revert` |
| 风险     | 低——零反向依赖实证；唯一软风险=未来某日想考古旧壳交互，git 历史+`docs/refs/refs-deepseek-harness.md` 均在                                                                                                                                                      |

### web 去留单独论

- 旧 `packages/web` 是「桌面壳的 web 版」半成品（13 测试文件，无产品化记录）。
- ZCode 上游本身带 `packages/web`（scratch 树 `dev:web` 脚本实证）=**未来 Web 面应经 ZCode 壳装配（ZS 模式复刻）**，而非旧 web 包续命。
- **结论倾向**：随案 B 删除；Web 需求将来立 ZS7 类阶段（ZCode web build + adapter 内心），不复活旧代码。

## 3. 红线⑩自查（现状=合规）

冻结≠假入口：旧壳包不在新壳分发物内（安装包=out/scratch 装配，release/zs6 产物 asar 实证无 packages/\* 引用），用户不可达。退役动作本身无红线约束；不退役也无违规——这是**维护债**决策而非合规决策。

## 4. 给拍板的建议

1. **即刻采案 B**：V9 装机验收通过、tag/Release 发出后执行（一个独立 chore commit + CI 修剪，预计半天含回归）。
2. TUI 去留=单独小拍板：若「终端形态弃」确认，案 A 追加一步删 cli/gateway（同法归档）。
3. 无论何案：先打归档 tag（发版动作，人类执行，与 V9 同批），保证可复原。

---

**证据附录**：`git ls-files packages/desktop packages/ui-shared packages/web | wc -l`=537（207/296/34）；ci.yml test 步骤 L74-96（六包）+ desktop 打包 job L102+；§1.2 grep 命令原文可复跑。本文件成文于 9452ed4 基线。

---

## 执行记录（2026-10-24，用户拍板「按你推荐的来做吧」→ 案 B）

- 归档 tag `pre-zs-retirement`@`5c01d9b`（三包最后状态，可复原）；`git rm` 537 文件（与 §1 实证数字精确一致）。
- ci.yml：删三 test 步 + desktop 三平台打包 job；新增 zcode-adapter test 步（活跃开发面同口径）→ 现行=test（四包×三平台）+ pages。
- release.yml：删三 test 步 + desktop 产物 job + release-assets job；桌面产物改人类 V9 手动附加（`zs6-release-draft.md`）。
- lockfile 重生成；AGENTS §7 / README / architecture 活文档更新（历史节加注记不抹历史）；反向引用复扫零命中。
- 全门：四包 build/typecheck exit=0；test 1641/40/1575/159 全绿；eslint 0 error；prettier 0。
- 退役前最后一张全绿 CI 存照：run `40047614218`（`5c01d9b`，7 job 含旧六包）success。
