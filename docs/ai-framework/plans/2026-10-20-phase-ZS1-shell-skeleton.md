# 阶段 ZS1：ZCode 壳骨架空跑（新壳进程启动到空态，后端为 adapter 桩）

> **状态：** 计划已就绪（用户 2026-10-20 批准 ZS 总纲并指示全力走 ZS 方向）
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`
> **总纲:** `docs/ai-framework/plans/2026-10-20-zs-shell-migration-program.md` · **spike:** `docs/research/2026-10-20-zcode-services-surface-spike.md`

**Goal:** 一句话——ZCode 桌面壳（v3.16.2 原版 UI）在本机以「harness2 内心桩」启动：进程存活 ≥30s，渲染出空态/WelcomeScreen，后端为 `zcode-adapter` 骨架（60 个 service 频道全注册：C 类静默空实现 / B 类显式 throw / A 类 TODO 桩），**零旧壳代码参与、core 零改动**。
**Architecture:** ZCode UI 经 `IServiceAccessor`（约 60 频道）+ 可插拔 RPC 与后端解耦（spike §3）；ZS1 把 host 进程的装配（ZCode `createLocalServices`）替换为本仓 `packages/zcode-adapter` 的桩集合；壳本体构建路线由 Task 0 实测二选一。
**Tech Stack:** TypeScript / pnpm workspace / Electron（utilityProcess + MessagePort）/ vitest。
**实施档位：** 全能（默认）· **子代理：** 启用（与「A 类服务映射详表」研究代理并行，互不触碰对方文件）。

---

## 前置阅读（必须）

| 优先级 | 文件 |
| ------ | ---- |
| P0 | `docs/ai-framework/phased-plan-driven.md`、本文件 |
| P0 | ZS 总纲（硬线：UI 零改动 / 红线⑩ / core 冻结 / Apache-2.0 / 旧壳冻结） |
| P0 | spike 报告（§2 重点服务形状 / §3 传输层 / §4 启动依赖 / §5 粗分类） |
| P1 | `AGENTS.md`、`CODE_REVIEW.md` |

**仓库路径：** `D:/AI_Projects/harness2` · ZCode 源：`D:/AI_Projects/refs/ZCode`（`3c5b2276` v3.16.2，**Apache-2.0**）
**基线分支：** 从 `feat/phase-u1-desktop-parity-fixes` 当前 HEAD 拉 `feat/phase-zs1-shell-skeleton`

---

## Global Constraints（冲突时以本节为准）

1. **UI 零改动原则**：ZCode 的 `packages/ui`（及 desktop 渲染层）组件/交互**一行不改**；允许改动的只有**装配点**（host 模块路径注入、数据根目录、branding 字符串），每处 patch 逐条登记进本计划执行记录（文件 + diff 摘要 + 理由）。
2. **core 零改动**：ZS1 不改 `packages/core/**`（adapter 只 import 现有导出）；`packages/gateway`、旧壳六包**零改动**（`git diff` 证明）。
3. **红线⑩**：C 类服务（spike §5）给**静默空实现**（方法返回空值/空数组、Event 永不触发），不得让 UI 出现可点但必炸的入口；B 类给显式 `throw NOT_IMPLEMENTED`（调用即炸比静默假成功安全——但 ZS1 空态路径不应触达 B 类）。
4. **Apache-2.0 合规**：任何形式的 ZCode 代码拷贝（vendor/scratch 构建目录）必须随附原 LICENSE 与版权头，不得删除。
5. **不污染参考仓**：`D:/AI_Projects/refs/ZCode` 只读——构建实验一律在拷贝目录进行（scratch 位置见 Task 0）。
6. 密钥不进 git；**默认不 push**；ZS1 **不打包不发版**（dev 启动即达标）。
7. **环境既成事实**：本机 `C:\Windows\System32\cmd.exe` 缺失——`pnpm`/`npx` 的 `.cmd` shim 全部 ENOENT，必须走直调通道（见「给接手 AI」）；electron 二进制下载失败设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。
8. **明确不做（本阶段）**：❌ 任何真实数据流（会话/serve 接线归 ZS2）❌ vendored 长期路线定案（Task 0 只定 ZS1 用哪条，长期归 ZS6）❌ branding/品牌词替换（ZS1 用原样标题）❌ web 壳 ❌ 打包。

---

## 阶段开头：上阶段遗留

| 上阶段遗留项 | 来源 | 状态 |
| ------------ | ---- | ---- |
| U2 待人类项（发版授权/真机点验/三项拍板） | OPEN.md | ⬜ 非本阶段阻塞（旧壳已冻结，发版授权待用户另行决定） |
| cmd.exe 系统组件缺失 | OPEN.md 2026-10-14 §6 | ⬜ 非阻塞（直调通道既定） |

---

## File Structure（预期变更；实际以 Task 0 路线决策为准）

| 文件/目录 | 动作 | 职责 |
| ---- | ---- | ---- |
| `packages/zcode-adapter/` | 新建包 | `createHarness2Services(): ServiceCollection`——60 频道桩注册；`stub-service.ts` 工厂（方法→空值/throw、`on*`→永不触发 Event）；类型经 ZCode services 源对齐 |
| `packages/zcode-adapter/test/` | 新建 | 频道注册枚举单测（60 频道全覆盖）+ C 类静默/B 类 throw 行为断言 |
| `scratch-zs1/`（gitignored）或仓外目录 | 新建 | ZCode 壳构建实验区（拷贝 + 依赖安装 + 构建 + host patch）；**不进 git**，构建方法与 patch 清单写进计划执行记录 |
| `docs/ai-framework/plans/2026-10-20-phase-ZS1-shell-skeleton.md` | 修改 | 执行记录回填（Task 0 路线决策、patch 清单、验收证据） |
| 其余全部包 | **零改动** | 验收 V5 证明 |

---

## Task 0：壳构建路线实测与决策（探索性，先做）

**行为:** 二选一路线，以「哪条能最快稳定跑起 ZCode desktop（原版 host 也算）」为准：

- **路线 A（vendor 进仓）**：把 ZCode 的依赖闭包（`ui`/`desktop`/`shared`/`rpc`/`client`/`services` 等，以 desktop 构建实际所需为准）拷入 `packages/zcode-shell/`（含 LICENSE），接入 pnpm workspace，装依赖、跑通其 desktop 构建。
- **路线 B（scratch 构建 + host 注入）**：把上述包拷到仓外 scratch 目录（如 `D:/AI_Projects/harness2-zs1-build/`，不进 git、不动 refs 仓），在其内装依赖构建 desktop；对 desktop 主进程做**最小 patch**——host 模块路径（`desktopHostProcess.ts:251` 一带）改为可经环境变量注入，指向本仓 `zcode-adapter` 构建出的 host bundle。

**Steps:**
1. 先在 scratch 里试跑 ZCode desktop 原版（`pnpm install` + 其 desktop 构建/启动脚本；pnpm 直调通道见文末）——**先证明壳本身能在本机跑**（这一步两条路线共用）。
2. 评估路线 A 的 workspace 接线成本（依赖树规模、构建脚本冲突、tsconfig 兼容）；与路线 B 的 patch 成本对比。
3. 决策写入执行记录：选哪条、为什么、patch/接线清单。**预期路线 B 更快**（总纲 §4 风险表预判），但以实测为准。
4. Commit（仅计划执行记录与 zcode-adapter 骨架起步，scratch 不入库）：`📝docs(zs1): Task0 构建路线决策留痕`

---

## Task 1：壳原版启动达标（不含 adapter）

**行为:** 按选定路线，ZCode desktop 以**原版 host**启动：进程存活 ≥30s，主窗口出现（ZCode 原版空态/登录界面即可）。

**Steps:**
1. 启动 + 截图（`--smoke` 类无头模式若 ZCode desktop 有则优先；否则 GUI 启动 + 截屏工具）。
2. 证据：进程清单（tasklist）+ 截图存 `docs/screenshots/zs1/`（截图入 git；真实运行截取，禁 AI 生成）。
3. Commit：`✨feat(zs1): ZCode 壳原版本机启动达标（T1）`

---

## Task 2：zcode-adapter 骨架（60 频道桩）

**Files:** `packages/zcode-adapter/**`

**行为:**
- `createHarness2Services()`：按 spike §1 的频道清单（`packages/shared/src/channels.ts:91-175` `ServiceChannels`）注册全部 service 桩。
- 桩工厂：普通方法 → 返回类型相容的空值（空数组/空对象/null/false）；`on*` 事件 → 永不触发的 Event；B 类方法 → `throw new Error('ZS1: not implemented')`。
- 分类清单（A/B/C）以 spike §5 为基线，逐频道标注在代码注释（`// C: 云端绑定 静默` / `// B: v4 竖切 ZS2/ZS3` / `// A: 映射 core ZS2+`）。
- Root 挂载期 9 个服务（spike §4：codingPlanSubscription/sourceServerManagement(可选)/oauth/broadcast/zcodeAgent.syncAppRuntimePreferences/bots/modelSelection.getView/providerSettings/setting）**必须返回让 UI 稳定走空态的数据形状**（空视图/未登录态）——这是 ZS1 能到空态的关键。
- 类型对齐：adapter 的桩对象须通过 ZCode services 接口的 TS 类型检查（编译期兜底，防止形状错配）。

**Steps:**
1. 实现 + 单测：60 频道枚举注册断言；C 类静默（调用返回空值不炸）；B 类 throw；9 个 Root 挂载服务返回空态形状。
2. 跑：`pnpm --filter @harness2/zcode-adapter test`（直调通道）全绿；`pnpm -r typecheck` 不回归。
3. Commit：`✨feat(zcode-adapter): IServiceAccessor 60 频道桩骨架（ZS1-T2）`

---

## Task 3：host 装配替换 + 启动到空态

**行为:** 把壳的 host 进程装配指向 `createHarness2Services()`（路线 A：改 workspace 内装配文件；路线 B：环境变量注入 host bundle 路径）。数据根重定向：`getZCodeDataRootDir`/`setDataBaseDir` 适配为 `~/.harness2`（ZS1 桩阶段不写真实数据；若壳启动期必写索引，重定向到 `~/.harness2/zs1-scratch/` 并注释说明）。

**Steps:**
1. 接线 + 启动：进程存活 ≥30s；渲染出 **ZCode 空态/WelcomeScreen**（不是原版登录页——原版 host 会走它的云端链路；桩 host 应让 UI 落在未登录/空工作区态）。
2. 证据：截图 + tasklist + host 进程命令行（证明 fork 的是本仓 adapter bundle）。
3. **变异验证**：把 9 个 Root 挂载服务之一改成 throw → 启动应落错误/loading 态而非空态（证明桩真的在被消费）；恢复后复绿。
4. Commit：`✨feat(zs1): host 装配替换为 harness2 桩集合，新壳启动到空态（ZS1-T3）`

---

## Task 4：收口核查（编排者亲验）

1. `git diff --stat <基线>..HEAD -- packages/core packages/gateway packages/cli packages/desktop packages/ui-shared packages/web` = **0**（旧壳与 core 零改动）。
2. ZCode UI 源零改动：对拷贝区 `packages/ui`（或 scratch 内）做 `git diff`/哈希对照原版 `3c5b2276`——仅允许登记过的装配点 patch。
3. 六包旧测试不回归（`pnpm -r --no-bail run test`，已 build 前提）。
4. LICENSE 随附检查（拷贝区含原 LICENSE 文件）。
5. 验收证据回填本计划执行记录。

---

## 代码审查（阶段级；全能档含）

**审查方：** 独立只读子代理，按 `CODE_REVIEW.md`。**审查面：** UI 零改动核查（patch 清单 vs 实际 diff）/ 红线⑩（C 类静默不产生假入口）/ core 与旧壳零改动 / LICENSE 合规 / 桩类型对齐。

---

## 验收标准总表

| # | 标准 | 通过条件 | 验证责任人 |
|---|------|----------|------------|
| V1 | 新壳启动存活 | 桩 host 下进程 ≥30s 存活 | 编排者亲验（tasklist） |
| V2 | 空态渲染 | ZCode 空态/WelcomeScreen 截图入 `docs/screenshots/zs1/` | 编排者核图 |
| V3 | 60 频道桩 | 单测枚举全覆盖；C 静默/B throw 断言绿；9 个 Root 挂载服务空态形状 | 自动化 |
| V4 | UI 零改动 | 拷贝区与 `3c5b2276` 对照仅含登记 patch | 审查 + 编排者 |
| V5 | 旧壳/core 零改动 | §Task 4 第 1 条 diff = 0 | 自动化 + 编排者 |
| V6 | 六包旧测试 | 不低于 HANDOFF 当轮基线 | 自动化 |
| V7 | Apache-2.0 | 拷贝区 LICENSE 随附 | 编排者 |
| V8 | 代码审查 | ✅ 或 ⚠️（P1 修后复验） | 独立子代理 |

---

## 风险与降级

| 风险 | 缓解 |
| ---- | ---- |
| ZCode desktop 构建链复杂（365 文件、自有脚本） | Task 0 先证明原版能跑再谈替换；路线 B 把构建隔离在 scratch，失败不伤主仓 |
| 依赖安装受 cmd.exe 缺失影响 | pnpm 直调通道（文末）；electron 镜像；如实记录失败，不伪造通过 |
| 桩形状错配导致 UI 启动崩 | 类型对齐编译期兜底 + 9 服务空态形状单测 + T3 变异验证 |
| UI 启动路径触达 B 类（throw）导致崩 | T3 实测定位触达点：属 A 类误标的改桩返回空态形状（登记）；真 B 类缺口如实登记进 ZS2 计划输入 |
| scratch 构建产物巨大 | scratch 不入 git（.gitignore 登记）；构建方法可复现即可 |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给执行 AI 即可开工：

---

你是负责 **harness2** 的实现代理，执行 **ZS1 阶段**（ZCode 壳骨架空跑）。请完整执行，不要只写方案。

### 基线

- 目录：`D:/AI_Projects/harness2`；从当前 HEAD（`feat/phase-u1-desktop-parity-fixes`）创建并切换 `feat/phase-zs1-shell-skeleton`
- ZCode 源（只读！）：`D:/AI_Projects/refs/ZCode`（`3c5b2276` v3.16.2，Apache-2.0）
- 唯一实施计划：`docs/ai-framework/plans/2026-10-20-phase-ZS1-shell-skeleton.md`；总纲与 spike 报告为必读
- **环境硬事实**：本机 `cmd.exe` 缺失，`pnpm`/`npx` 命令不可用，直调通道：`node "D:/AI_Projects/harness2/node_modules/..."`——先读 `docs/issue-log/2026-10-14.md` §17 的 pnpm 直调记录（pnpm.mjs 完整路径在那），所有 install/build/test 都走它；electron 下载失败设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

### 做

1. Task 0→4 严格顺序；每 Task 证据（真实命令输出/截图）后 commit（gitmoji 规范见 AGENTS.md）。
2. 硬线：ZCode UI 组件零改动（装配点 patch 逐条登记）；`packages/core`/`packages/gateway`/旧壳六包零改动；C 类桩静默、B 类桩 throw；拷贝区保留 LICENSE。
3. Task 0 的 scratch 实验不入 git；路线决策与 patch 清单写进计划执行记录。
4. 截图必须真实运行截取（禁 AI 生成），存 `docs/screenshots/zs1/`。

### 不做

- 真实数据流/serve 接线（ZS2）；branding 替换；web 壳；打包发版；修改 `D:/AI_Projects/refs/ZCode`；提交密钥；未授权 push

### 工作方式

1. 先读计划/总纲/spike 三份文档再动手。
2. 证据优先：验收命令真实跑，输出贴进执行记录。
3. 用简体中文回复进度；代码标识符保持原样。

### 交卷

分支名、提交列表、验收表自评（V1–V8）、测试/构建结果、路线决策与 patch 清单、残留风险。

现在开始：读完三份文档，从 Task 0 执行到最后。

---

## 残留手工验收清单

1. 用户真机点验新壳空态观感（ZCode 原版视觉）。
2. 用户确认「这就是我要的壳」后，ZS2 计划启动。
