# 阶段 S1：会话批量归档与物理删除（右键「归档其他/删除其他」+ 归档区物理清理）

> **状态：** 计划已就绪（待用户审阅后开工）
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 一句话——会话行右键「一键归档其他会话 / 一键删除其他会话（物理）」+ 已归档区物理清理，core 获得加性物理删除能力，解决用户 1465 会话目录堆积与全库扫描压力。
**Architecture:** core `SessionManager` 新增 `deleteSession`（加性导出，api-surface 基线同步）；桌面主进程新增两个批量 IPC（`metadata:patchMany` 批量软归档一次落盘、`sessions:deleteMany` 批量物理删除带结果计数）；ui-shared `SessionBrowser` 行菜单扩展两项 + 强确认对话框 + 结果 toast；desktop renderer 接线，web 壳不接线（菜单项不出现）。
**Tech Stack:** TypeScript / Electron IPC / vitest（jsdom）
**实施档位：** 全能（默认）
**子代理：** 启用（实施/测试/审查按工作模式派发；cat-jam 可用则优先，否则等职能子代理）

**设计依据（refs，已入库）：** `docs/refs/refs-zcode-layout.md` **Z-50**（批量归档其他会话，自主决策）、**Z-51**（会话物理删除，自主决策——物理删除语义经用户 2026-10-20 拍板）；同文档 Z-48/Z-49 已按上游 v3.16.2（`3c5b2276`）勘正。**本阶段每个 UI 改动须引用 Z-50/Z-51/Z-49 条目编号。**

---

## 前置阅读（必须）

| 优先级 | 文件                                                          |
| ------ | ------------------------------------------------------------- |
| P0     | `docs/ai-framework/phased-plan-driven.md`                     |
| P0     | 本文件                                                        |
| P0     | `docs/refs/refs-zcode-layout.md` §Z-48/Z-49/Z-50/Z-51         |
| P1     | `AGENTS.md`、`CODE_REVIEW.md`                                 |
| P1     | `packages/ui-shared/src/shared/metadata.ts`（软标记体系现状） |

**仓库路径：** `D:/AI_Projects/harness2`
**基线分支：** 从 `feat/phase-u1-desktop-parity-fixes`（当前 HEAD `3acd156`）拉 `feat/phase-s1-session-bulk-cleanup`

---

## Global Constraints（冲突时以本节为准）

1. **core 仅加性**：`packages/core` 只允许新增 `deleteSession` 及其导出；`api-surface-baseline.json` 按流程同步（`H2_UPDATE_API_SNAPSHOT=1`），必须 **0 removed / 0 kindChanged**；`packages/gateway` **零改动**。
2. **物理删除安全语义（Z-51，硬线）**：必须强确认（数量 + 不可恢复警示 + destructive 按钮）；**运行中会话与当前会话自动跳过并计入结果**；执行返回「已删除 x，跳过 y，失败 z」计数；取消路径绝不执行任何删除。
3. **批量写单次落盘**：批量归档 = 一次 metadata 文件写（`patchMany`），**禁止** N 次单条 `metadata:set` 循环。
4. **红线⑩（无假入口）**：新菜单项仅在对应回调被接线时出现；web 壳不传新回调 ⇒ web 侧菜单项不出现，web 零回归。
5. **删除后清理覆层**：物理删除成功的会话，其 `desktop-metadata.json` 条目同步移除（防文件膨胀）；归档批量写不动 deleted/pinned 字段。
6. 密钥/凭证不进 git；**默认不 push**。
7. **明确不做（本阶段）**：
   - ❌ serve HTTP/WS delete API（web 壳物理删除——契约变更，归后续阶段评估）
   - ❌ CLI `sessions prune` 命令（挂账 OPEN.md）
   - ❌ 回收站/恢复机制（用户已拍板物理删除语义；软归档本身就是可恢复路径）
   - ❌ ZCode 壳迁移相关工作（另立程序，见「与前后阶段」）

---

## 阶段开头：上阶段遗留（必填小节）

| 上阶段遗留项                                                                                | 来源                             | 未通过原因     | 状态                        |
| ------------------------------------------------------------------------------------------- | -------------------------------- | -------------- | --------------------------- |
| U2 待人类项：v1.0.2 发版授权 / M1-M12 真机点验 / 三项拍板（侧栏搜索框/计数徽标/宽度持久化） | U2 收口（OPEN.md 2026-10-14 行） | 非缺陷，待人类 | ⬜ 非本阶段阻塞，如实挂账   |
| cmd.exe 系统组件缺失（pnpm 通道绕行已建立；打包走 manual-pack）                             | OPEN.md 2026-10-14 §6            | 待人类修系统   | ⬜ 非阻塞（用既定绕行通道） |

---

## 跳过项（因档位未做，**非缺陷**，待补做）

（全能档 + 子代理启用，预计无跳过项；若子代理通道故障降级主会话亲执，如实登记。）

---

## 与前后阶段

| 阶段                 | 状态         | 交付                                                                                                               |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| U2（页面设计优化波） | ✅ 发版就绪  | 双 exe + 终认证（待人类发版授权）                                                                                  |
| **本阶段 S1**        | ⬜ 计划待审  | 批量归档/物理删除；**core 能力（deleteSession）在后续「ZCode 壳迁移」后仍存活**——内心不随壳扔                      |
| 下阶段               | 勿塞进本阶段 | 「ZCode 壳 + harness2 内心」迁移程序（spike 盘点进行中，另立总纲）；观测性（崩溃捕获/运行日志/监控卡片）并入该程序 |

---

## File Structure（预期变更）

| 文件                                                           | 动作         | 职责                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/session/manager.ts`                         | 修改         | `deleteSession(id)`：定位会话目录（跨根扫描同 list 口径）→ `fs.rm` recursive force → 返回布尔；目录不存在 = false 不抛                                                                                                                                        |
| `packages/core/src/index.ts`                                   | 修改（如需） | 导出保持既有口径（若 SessionManager 方法随类导出则零改动）                                                                                                                                                                                                    |
| `packages/core/test/fixtures/api-surface-baseline.json`        | 修改         | 基线同步（预期净增 ≤1）                                                                                                                                                                                                                                       |
| `packages/core/test/manager-delete.test.ts`                    | 新建         | 删除 round-trip / list 不再含 / 不存在 id / 只读保护（若 manager 有只读模式）/ 并发删除幂等                                                                                                                                                                   |
| `packages/desktop/src/main/metadata-file.ts`                   | 修改         | `writeMetadataPatchMany(ids, patch)`：一次读-合-写，原子 temp+rename 同既有单条路径                                                                                                                                                                           |
| `packages/desktop/src/main/bridge.ts`                          | 修改         | `metadata:patchMany`（ids[] + 白名单 patch）与 `sessions:deleteMany`（ids[] → 逐 id `core.deleteSession` + 覆层条目清理，返回 `{deleted, skippedRunning?, failed, errors[]}` 计数；**运行中判定由渲染端传入的排除集负责**，主进程对删除失败逐 id 容错不中断） |
| `packages/desktop/test/bridge-bulk-ops.test.ts`                | 新建         | patchMany 单次落盘断言（注入 fake write 计数）/ deleteMany 计数与容错 / 白名单校验                                                                                                                                                                            |
| `packages/ui-shared/src/renderer/sidebar/SessionBrowser.tsx`   | 修改         | 行菜单（ContextMenu + hover DropdownMenu 同步）新增「归档其他会话」「删除其他会话…」（Z-50/Z-51）；批量确认对话框（数量+不可恢复+destructive）；结果 toast；已归档区单条「彻底删除…」+「清空归档…」                                                           |
| `packages/ui-shared/src/renderer/sidebar/labels.ts`            | 修改         | 新文案（中英）                                                                                                                                                                                                                                                |
| `packages/ui-shared/src/renderer/app-controller.ts`            | 修改         | `archiveOthers(keepId)` / `deleteOthers(keepId)`（组装目标集：当前列表除 keepId，排除 running——`peekStream(id)?.running`——与当前会话）/ `purgeArchived()`                                                                                                     |
| `packages/ui-shared/src/renderer/sidebar/session-items.ts`     | 修改（如需） | 菜单项可用性谓词                                                                                                                                                                                                                                              |
| `packages/desktop/src/renderer/layout/shell-seat-contents.tsx` | 修改         | 接线三个新回调到 IPC                                                                                                                                                                                                                                          |
| `packages/ui-shared/test/**`、`packages/desktop/test/**`       | 新建/扩展    | 见各 Task                                                                                                                                                                                                                                                     |

---

## 配置或 API 契约

```jsonc
// IPC 新增（preload 通道白名单同步 + protocol 一致性测试照既有模式）
// metadata:patchMany
{ "ids": ["<sessionId>..."], "patch": { "archived": true } }
→ { "written": 1400 }  // 一次文件写

// sessions:deleteMany
{ "ids": ["<sessionId>..."] }  // 渲染端已排除 keepId/running/当前会话
→ { "deleted": 1398, "failed": 2, "errors": ["<sessionId>: EBUSY ..."] }
```

---

## Task 1：core `SessionManager.deleteSession`（冻结区加性）

**Files:** `packages/core/src/session/manager.ts`、`packages/core/src/index.ts`（如需）、`packages/core/test/manager-delete.test.ts`、`packages/core/test/fixtures/api-surface-baseline.json`

**行为:** `deleteSession(sessionId: string): Promise<boolean>`——按 list 同口径定位会话目录（全库跨根），`fs.rm(dir, {recursive: true, force: true})`；目录不存在返回 false；成功后该会话不再出现在 `list()`/`search()`。**不做**运行中判定（那是壳的上下文，core 不持有 store 状态）。

**Steps:**

1. 实现方法 + 用例：临时目录造 3 会话 → 删 1 → list 剩 2；删不存在 id → false；重复删同一 id → 第二次 false；删除后 `loadSession` 抛既有「不存在」口径。
2. 跑：`pnpm --filter @harness2/core exec vitest run test/manager-delete.test.ts`
   期望：全绿。
3. 基线：`pnpm build && H2_UPDATE_API_SNAPSHOT=1 pnpm --filter @harness2/core exec vitest run test/api-surface.test.ts`，同提交更新 fixture；**diff 必须 0 removed / 0 kindChanged**。
4. Commit：`✨feat(core): SessionManager.deleteSession 会话物理删除（S1-T1，加性）`

---

## Task 2：桌面主进程批量 IPC

**Files:** `packages/desktop/src/main/metadata-file.ts`、`packages/desktop/src/main/bridge.ts`、`packages/desktop/src/main/core.ts`（导出 `deleteSession` 经 requireCore 桥）、`packages/desktop/test/bridge-bulk-ops.test.ts`

**行为:**

- `metadata:patchMany`：ids 数组 + 白名单 patch（archived 布尔），一次读-合-写（temp+rename 原子），返回 written 数；空数组直接返回 0 不写盘。
- `sessions:deleteMany`：逐 id 调 core `deleteSession`；每 id 独立 try/catch（EBUSY/EPERM 等计入 failed，不中断批次）；成功者同步从 metadata 覆层移除条目（一次合批写）；返回计数 + errors 摘要（过 `redactSecrets`）。**handler 为 async，fs.promises 不阻塞主进程事件循环**（window:* 命令期间仍可响应——B2 口径）。
- preload 通道白名单 + `protocol.test.ts` 静态一致性照既有模式同步。

**Steps:**

1. 实现两命令 + 用例（注入 fake core/文件层：patchMany 断言**仅一次** write 调用；deleteMany 断言逐 id 容错与计数；白名单外字段忽略）。
2. 跑：`pnpm --filter @harness2/desktop exec vitest run test/bridge-bulk-ops.test.ts`
   期望：全绿。
3. Commit：`✨feat(desktop): metadata:patchMany 与 sessions:deleteMany 批量 IPC（S1-T2）`

---

## Task 3：ui-shared 菜单 / 确认 / 计数（Z-50/Z-51）

**Files:** `packages/ui-shared/src/renderer/sidebar/SessionBrowser.tsx`、`labels.ts`、`app-controller.ts`、`session-items.ts`、相关测试

**行为:**

- 行级菜单（ContextMenu 与 hover DropdownMenu **两处同步**加项，位置在既有「归档/删除」之后、分隔线之前）：
  - 「归档其他会话」（Z-50）：回调可选 `onArchiveOthers`；一键执行无确认；toast「已归档 N 个会话」；N=0 时菜单项禁用。
  - 「删除其他会话…」（Z-51）：回调可选 `onDeleteOthers`；弹强确认（「将永久删除 N 个会话目录（不可恢复）」+ destructive「删除」/「取消」）；确认后执行，toast 报「已删除 x，失败 y」。
- 目标集组装（controller）：当前会话列表除 keepId（**含已归档区**；不含列表外会话）；排除 running（`peekStream(id)?.running`）与当前活跃会话；确认框数量 = 目标集大小。
- 已归档区（Z-49 对齐 v3.16.2 ArchiveGroupCard 形态）：单条「彻底删除…」（确认同上）+ 区头「清空归档…」（批量确认 + 计数）；回调可选，缺省不显示。
- **回调未接线 ⇒ 菜单项不渲染**（红线⑩；web 壳因此天然不出现）。

**Steps:**

1. 实现组件/控制器 + jsdom 用例：菜单项出现条件（回调传/不传）；确认框文案含数量与「不可恢复」；取消不调 IPC；running 会话被排除（构造 store peekStream stub）；结果 toast 计数；归档区两入口同断言。
2. 跑：`pnpm --filter @harness2/ui-shared exec vitest run`
   期望：不低于基线（776 passed，以 HANDOFF 当轮记录为准）且新增用例全绿。
3. **变异验证**：临时移除「排除 running」守卫 → 对应用例必红；恢复后复绿，无残留。
4. Commit：`✨feat(ui-shared): 会话行批量归档/删除其他 + 归档区物理清理（S1-T3，Z-50/Z-51）`

---

## Task 4：desktop 接线 + web 零回归

**Files:** `packages/desktop/src/renderer/layout/shell-seat-contents.tsx`、web 壳（零改动，仅验证）

**Steps:**

1. desktop 接线：`onArchiveOthers` → `metadata:patchMany`；`onDeleteOthers`/`onPurgeArchived` → `sessions:deleteMany`（经 controller）；toast 走既有通知通道。
2. web 验证：`pnpm --filter @harness2/web exec vitest run` 全绿；grep 确认 web 未传新回调（菜单项不出现的既有机制用例覆盖）。
3. 跑：`pnpm --filter @harness2/desktop exec vitest run`
   期望：不低于基线（1288 passed + 1 skipped）。
4. Commit：`✨feat(desktop): 批量会话操作接线渲染端（S1-T4）`

---

## Task 5：端到端 + 六包全量（编排者亲验）

**Steps:**

1. **真实规模副本压测（不动真实数据）**：`robocopy C:\Users\ASUS\.harness2\sessions <临时目录>\sessions /E` → 以 `--root`/home 重定向指向副本 → 构造/复用桌面 dev 启动，实测：批量归档 1400+ 会话（patchMany）耗时、批量物理删除耗时、删除期间 `window:minimize` 响应。记录数字进验收表。
2. `pnpm -r build && pnpm -r --no-bail run test` 六包全量 + `pnpm -r typecheck` + `pnpm lint`。
3. 冻结区核查：`git diff --stat <基线>..HEAD -- packages/gateway` = 0；core diff 仅加性文件/行。
4. Commit（如需收尾）：`📝docs(s1): S1 验收记录与预算数字回填`

---

## 代码审查（阶段级环节，验收前；全能档含）

**审查方：** 独立只读子代理（非本阶段实现者），按 `CODE_REVIEW.md` 出 P0/P1/P2。

**审查面：** 物理删除安全语义（确认/跳过/计数/取消路径）/ core 加性与基线 / 批量单次落盘 / 红线⑩ / web 零回归 / 密钥与错误消息脱敏。

| 审查项     | 结论 | 问题清单 |
| ---------- | ---- | -------- |
| 安全语义   |      |          |
| 架构红线   |      |          |
| 测试完整性 |      |          |
| API 契约   |      |          |

**结论：** ✅ / ⚠️（P1 修复后复验）/ ❌（阻塞）

---

## 验收标准总表

| #   | 标准       | 通过条件                                                                                                    | 验证责任人                   |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------- |
| V1  | core 加性  | api-surface 基线 0 removed / 0 kindChanged（净增 ≤1）；gateway 零改动                                       | 自动化 + 编排者复跑          |
| V2  | 六包测试   | 不低于 HANDOFF 当轮基线（core 1519+2 / ui-shared 776 / desktop 1288+1 / web 150 / gateway 40 / cli 1575+2） | 自动化（执行方）+ 编排者抽跑 |
| V3  | 批量预算   | 副本库 1400+ 会话：patchMany ≤ 500ms；deleteMany ≤ 60s 且期间 window:* 响应正常                             | 编排者亲测（Task 5）         |
| V4  | 安全语义   | 确认框含数量+不可恢复；running/当前会话跳过并计数；取消零执行；变异验证留痕                                 | 自动化 + 审查                |
| V5  | web 零回归 | web 测试全绿；新菜单项在 web 不出现                                                                         | 自动化                       |
| V6  | 代码审查   | ✅ 或 ⚠️（P1 已修）；❌ 阻塞                                                                                | 独立子代理                   |
| V7  | 真机观感   | 右键菜单/确认框/计数 toast 真机点验                                                                         | 用户（残留手工清单）         |

---

## 风险与降级

| 风险                                          | 缓解                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Windows 句柄占用（serve 持有 writer）删除失败 | 逐 id 容错计 failed；渲染端已排除 running；EBUSY 天然兜底                                  |
| 1465 真实库误删                               | 端到端一律用副本根目录；真实清理由用户真机亲自执行（残留手工清单）                         |
| metadata 覆层膨胀                             | deleteMany 成功后合批移除条目（Task 2）                                                    |
| 批量删除期间 UI 无进度                        | 首版同步等待 + toast spinner（fs.promises 不阻塞主进程）；进度事件流为后续增强，本阶段不做 |
| 子代理通道故障（cat-jam 上游）                | 降级等职能子代理（U1 先例，如实登记）；编排者不写功能代码                                  |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给执行 AI 即可开工：

---

你是负责 **harness2** 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线

- 目录：`D:/AI_Projects/harness2`
- 从 `feat/phase-u1-desktop-parity-fixes`（HEAD `3acd156`）创建并切换：`feat/phase-s1-session-bulk-cleanup`
- 已完成：refs 条目 Z-50/Z-51 已入库（`docs/refs/refs-zcode-layout.md`，勿重做）；U1/U2 已收口
- 唯一实施计划：`docs/ai-framework/plans/2026-10-20-phase-s1-session-bulk-cleanup.md`
- 必读：`docs/ai-framework/phased-plan-driven.md`、`AGENTS.md`、refs Z-48/Z-49/Z-50/Z-51

### 做

1. Task 1→5 严格按顺序；每 Task 测试绿后 commit（规范见 AGENTS.md）。
2. core 仅加性（deleteSession）；基线同步走 `H2_UPDATE_API_SNAPSHOT=1` 流程；gateway 零改动。
3. 物理删除安全语义是硬线：强确认 + 跳过 running/当前 + 结果计数 + 取消零执行。
4. 批量写单次落盘；web 壳不接线新回调（菜单项不出现）。
5. Task 5 的真实库压测**只用副本目录**（robocopy + root 重定向），绝不触碰 `C:\Users\ASUS\.harness2\sessions` 真实数据。

### 不做

- serve delete API / CLI prune / 回收站机制 / ZCode 壳迁移相关工作
- 提交密钥；未授权的 `git push`；修改 `docs/refs/**`（refs 已由编排者完成）

### 工作方式

1. 先跑 `pnpm -r build` 确认基线干净。
2. 证据优先：完成前重跑计划中的验证命令并贴真实输出。
3. 用简体中文回复进度；代码标识符保持原样。

### 交卷

全部完成后给出：分支名、提交列表、验收表自评（V1-V7）、测试/构建结果、残留风险。

现在开始：读完本阶段计划，从 Task 1 执行到最后。

---

## 残留手工验收清单（自动化之外）

1. 用户真机：右键菜单两项观感、确认框文案、结果 toast 计数。
2. 用户真机：**真实**执行一次「归档其他会话」与（谨慎起见先小规模验证的）「删除其他会话」——真实数据操作由用户亲自完成，AI 不代删。
3. 已归档区「清空归档」真机一轮。
