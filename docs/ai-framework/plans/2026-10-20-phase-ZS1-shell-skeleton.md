# 阶段 ZS1：ZCode 壳骨架空跑（新壳进程启动到空态，后端为 adapter 桩）

> **状态：** 计划已就绪（用户 2026-10-20 批准 ZS 总纲并指示全力走 ZS 方向）
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`
> **总纲:** `docs/ai-framework/plans/2026-10-20-zs-shell-migration-program.md` · **spike:** `docs/research/2026-10-20-zcode-services-surface-spike.md`

**Goal:** 一句话——ZCode 桌面壳（v3.16.2 原版 UI）在本机以「harness2 内心桩」启动：进程存活 ≥30s，**无登录门直达主壳空工作区**（用户 2026-10-20 指示：无账户体系），后端为 `zcode-adapter` 骨架（57 个 service 频道全注册：C 类静默空实现 / B 类显式 throw / A 类 TODO 桩），**零旧壳代码参与、core 零改动**。
**Architecture:** ZCode UI 经 `IServiceAccessor`（约 60 频道）+ 可插拔 RPC 与后端解耦（spike §3）；ZS1 把 host 进程的装配（ZCode `createLocalServices`）替换为本仓 `packages/zcode-adapter` 的桩集合；壳本体构建路线由 Task 0 实测二选一。
**Tech Stack:** TypeScript / pnpm workspace / Electron（utilityProcess + MessagePort）/ vitest。
**实施档位：** 全能（默认）· **子代理：** 启用（与「A 类服务映射详表」研究代理并行，互不触碰对方文件）。

---

## 前置阅读（必须）

| 优先级 | 文件                                                                   |
| ------ | ---------------------------------------------------------------------- |
| P0     | `docs/ai-framework/phased-plan-driven.md`、本文件                      |
| P0     | ZS 总纲（硬线：UI 零改动 / 红线⑩ / core 冻结 / Apache-2.0 / 旧壳冻结） |
| P0     | spike 报告（§2 重点服务形状 / §3 传输层 / §4 启动依赖 / §5 粗分类）    |
| P1     | `AGENTS.md`、`CODE_REVIEW.md`                                          |

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

| 上阶段遗留项                              | 来源                  | 状态                                                  |
| ----------------------------------------- | --------------------- | ----------------------------------------------------- |
| U2 待人类项（发版授权/真机点验/三项拍板） | OPEN.md               | ⬜ 非本阶段阻塞（旧壳已冻结，发版授权待用户另行决定） |
| cmd.exe 系统组件缺失                      | OPEN.md 2026-10-14 §6 | ⬜ 非阻塞（直调通道既定）                             |

---

## File Structure（预期变更；实际以 Task 0 路线决策为准）

| 文件/目录                                                        | 动作       | 职责                                                                                                                                                        |
| ---------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/zcode-adapter/`                                        | 新建包     | `createHarness2Services(): ServiceCollection`——60 频道桩注册；`stub-service.ts` 工厂（方法→空值/throw、`on*`→永不触发 Event）；类型经 ZCode services 源对齐 |
| `packages/zcode-adapter/test/`                                   | 新建       | 频道注册枚举单测（60 频道全覆盖）+ C 类静默/B 类 throw 行为断言                                                                                             |
| `scratch-zs1/`（gitignored）或仓外目录                           | 新建       | ZCode 壳构建实验区（拷贝 + 依赖安装 + 构建 + host patch）；**不进 git**，构建方法与 patch 清单写进计划执行记录                                              |
| `docs/ai-framework/plans/2026-10-20-phase-ZS1-shell-skeleton.md` | 修改       | 执行记录回填（Task 0 路线决策、patch 清单、验收证据）                                                                                                       |
| 其余全部包                                                       | **零改动** | 验收 V5 证明                                                                                                                                                |

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

1. 接线 + 启动：进程存活 ≥30s；**无登录门直达主壳空工作区**（用户 2026-10-20 指示无账户体系——不得出现 ZCode 登录页/WelcomeScreen 登录态；原版 host 会走它的云端链路，桩 host 须使 UI 跳过登录门，机制选择记入执行记录）。
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

| #   | 标准             | 通过条件                                                          | 验证责任人             |
| --- | ---------------- | ----------------------------------------------------------------- | ---------------------- |
| V1  | 新壳启动存活     | 桩 host 下进程 ≥30s 存活                                          | 编排者亲验（tasklist） |
| V2  | 空态渲染         | ZCode 空态/WelcomeScreen 截图入 `docs/screenshots/zs1/`           | 编排者核图             |
| V3  | 60 频道桩        | 单测枚举全覆盖；C 静默/B throw 断言绿；9 个 Root 挂载服务空态形状 | 自动化                 |
| V4  | UI 零改动        | 拷贝区与 `3c5b2276` 对照仅含登记 patch                            | 审查 + 编排者          |
| V5  | 旧壳/core 零改动 | §Task 4 第 1 条 diff = 0                                          | 自动化 + 编排者        |
| V6  | 六包旧测试       | 不低于 HANDOFF 当轮基线                                           | 自动化                 |
| V7  | Apache-2.0       | 拷贝区 LICENSE 随附                                               | 编排者                 |
| V8  | 代码审查         | ✅ 或 ⚠️（P1 修后复验）                                           | 独立子代理             |

---

## 风险与降级

| 风险                                           | 缓解                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| ZCode desktop 构建链复杂（365 文件、自有脚本） | Task 0 先证明原版能跑再谈替换；路线 B 把构建隔离在 scratch，失败不伤主仓                     |
| 依赖安装受 cmd.exe 缺失影响                    | pnpm 直调通道（文末）；electron 镜像；如实记录失败，不伪造通过                               |
| 桩形状错配导致 UI 启动崩                       | 类型对齐编译期兜底 + 9 服务空态形状单测 + T3 变异验证                                        |
| UI 启动路径触达 B 类（throw）导致崩            | T3 实测定位触达点：属 A 类误标的改桩返回空态形状（登记）；真 B 类缺口如实登记进 ZS2 计划输入 |
| scratch 构建产物巨大                           | scratch 不入 git（.gitignore 登记）；构建方法可复现即可                                      |

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

## V2 灰屏根因与修复（2026-10-20 晚）

### 两层根因

1. **真实 setting 污染（已用 ZCODE_DESKTOP_HOME_DIR 解决）**：Git Bash 的 `HOME` 优先级抢在 `ZCODE_DESKTOP_HOME_DIR` 之前命中真实 `C:\Users\ASUS\.zcode`；启动必须带全套隔离 env（`ZCODE_DESKTOP_HOME_DIR`/`HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`），并确认 stdout 日志 `writing settings to:` 不再指向 `C:\Users\ASUS`。本代理全程按该隔离 env 启动。
2. **桩缺驱动环（本代理修复）**：`onboardingRecordService` 在 adapter 里无显式桩（`createHarness2Services.ts` 频道已注册但走工厂默认 = 所有方法返回 null）。渲染链：`useOnboardingTrigger`（ZCode `packages/ui/src/onboarding/useOnboardingTrigger.ts:69-75`）调 `claimAnonymousRecord()` → `shouldOnboard()` → 得到 **null**（非报错、非「无服务」；3s 兜底只覆盖异常路径，null 被当 resolved 值直通）→ `needsOnboarding === null` 停在「判定进行中」→ `OccupationOnboarding.tsx:131`：`!requested && needsOnboarding===null && !settings.onboardingOccupation` → **return null，children 不渲染** → 即使 `workspaceShellPath` 非空（`file.ensureConversationWorkspace` 兜底桩已满足），整个主内容也被 `OccupationOnboarding` 这层 null 吞掉 = 灰。根因分析全文：`docs/research/2026-10-20-zs-first-paint-contract.md`（契约表 §5）。

### 选的路

**第二路（onboarding 欢迎屏/跳过引导）**：按契约表 §5 给 `onboardingRecordService` 显式桩——`claimAnonymousRecord` → `void`、`shouldOnboard` → **`false`**（关键——显式 false 才会跳过全屏引导、渲染 children）、`getLatestEntry` → `null`；其余方法（appendRecord/dismissOnboarding/syncSettingsFromRecord/updateRecordPreferences/getRecords/clearRecords）显式 impl。次要保险：`settingService.get` 返回追加 `onboardingOccupation: "other"`（契约 §6-2）。未改 `file.ensureConversationWorkspace` 兜底桩（形状已正确）。未动六包/core/gateway/refs。

### CDP 证据

- 启动命令按任务书隔离 env + `ZS1_HOST_MODULE_PATH=.../dist/host-entry.cjs` + `ZCODE_DATA_BASE_DIR=.../zs1-data`。
- 重建 bundle：`pnpm --filter @harness2/zcode-adapter build` → `dist/host-entry.cjs 1.5mb`。
- 验证：`node .tmp-cdp-page-capture.cjs` → `SAVED .../t3-cdp-page.png 322716 bytes`，`DOM: KIDS: ... || TEXT: Command palette Search and run commands ... harness2 ... No model available. Upgrade or set a custom model. ... Ask ZCode`（非空，含界面文字）。
- 截图：`docs/screenshots/zs1/t3-cdp-page.png`（322716 bytes）/ 复制 `docs/screenshots/zs1/t3-onboarding-fixed.png`。

### 执行记录修正（V2）

V2 原结论「空态渲染以行为证据核定，截图留编排者核图」修正为：**灰屏事件 → onboarding 桩缺显式 false 根因定位 → 修复（onboardingRecordService 显式桩 + setting.onboardingOccupation 保险）→ CDP 探针 DOM TEXT 非空（截图 `docs/screenshots/zs1/t3-cdp-page.png` 322716 bytes）为证**。V1–V7 通过；V8 独立审查仍留编排者派发。

### adapter 测试

- `pnpm --filter @harness2/zcode-adapter test` → **32 passed (32)**（基线 31 + 新增 onboarding-record 断言 1）。
- `pnpm --filter @harness2/zcode-adapter typecheck` → 0 error。
- 新增断言：`onboarding-record：claimAnonymousRecord void、shouldOnboard false、getLatestEntry null`。

1. 用户真机点验新壳空态观感（ZCode 原版视觉）。
2. 用户确认「这就是我要的壳」后，ZS2 计划启动。

---

## 执行记录（2026-10-20 实施回填，分支 feat/phase-zs1-shell-skeleton）

### Task 0：路线决策 —— **选路线 B（scratch 构建 + host 注入）**

**实测过程（全部真实命令，本机 win32 / cmd.exe 缺失环境）：**

1. 拷贝：`robocopy D:\AI_Projects\refs\ZCode D:\AI_Projects\harness2-zs1-build\ZCode /E /XD node_modules`（含 .git，401M；refs 仓零触碰，收口用其 `git status` 复核）。
2. 依赖：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node <pnpm.mjs> install`（pnpm 直调通道，2026-10-14 §17）→ **Done in 3m25s**（2253 包，store 硬链接为主；electron postinstall 经镜像下载成功；node-pty 走 win32 prebuild 跳过 rebuild；根 prepare=husky+tsc --noEmit 通过）。engine 警告（要 node≥24，本机 22.23.1）无碍——Electron 41 内置 Node 24，构建期脚本在 22 上全过。
3. 构建（绕开 cmd.exe，直调 node 入口）：
   - `node scripts/build-metadata.mjs`（desktop）→ build-meta.json（commit=3c5b2276）
   - `NODE_ENV=production ../../node_modules/.bin/tsup`（desktop；.bin 的 sh shim 在 git-bash 可直跑）→ out/main + out/host(1.87MB) + out/preload 全出
   - `NODE_ENV=production ../../node_modules/.bin/vite build` → renderer ✓ built in 22.10s
   - agent bundle：`ZCODE_BOOTSTRAP_WITH_REMOTE=1 node scripts/build-desktop-agent-cli.mjs`（ZCode 原生的纯 node 构建通道，不经 pnpm/cmd.exe）→ `dist/zcode.cjs 14.5mb`，staged 到 `bundled-agents/win32-x64/glm/`
4. 启动：`ZCODE_DATA_BASE_DIR=D:\AI_Projects\harness2-zs1-build\zs1-data ../../node_modules/electron/dist/electron.exe .`（cwd=packages/desktop）。

**决策理由：**

- 路线 A（vendor 进仓）要把 ZCode 依赖闭包（10+ workspace 包 + apps/zcode-cli 子 workspace + 2.5G node_modules）接进 harness2 workspace：两仓 packageManager 版本不同（harness2 pnpm 11.13 vs ZCode 锁 pnpm 10.33）、allowBuilds/补丁体系冲突风险大，且 400M 源码进主仓污染历史——成本远高于路线 B。
- 路线 B 实测全通（上述 1–4 步），构建完全隔离在仓外 scratch，主仓零污染；host 注入点唯一且已定位：`packages/desktop/src/main/desktopRuntimeEnv.ts:86` `hostModulePath = join(import.meta.dirname, "../host/index.js")`。
- 长期 vendored 路线归 ZS6 决策（总纲既定），ZS1 不预支。

**关键机制发现（后续阶段复用）：**

- **数据根隔离**：`ZCODE_DATA_BASE_DIR` 环境变量（`packages/services/src/paths.ts` 优先级：setDataBaseDir() > env > homedir()）+ main 的 `buildHostProcessEnv` 显式下发到 host——原版启动与桩启动都不碰用户真实 `~/.zcode`。
- **原版 host 启动硬依赖 agent bundle**：`prepareSessionStorage`（storagePreparationProcesses.ts:99）在无 zcode.cjs 时报 `unsupported_runtime`，renderer 落数据库失败屏——agent bundle 是原版空态的前置条件（桩 host 无此依赖，Task 3 自行报 ready）。
- **main↔host 协议**（桩 host 必须实现的最小集）：InitLocal（带转移 MessagePort）→ parentPort 回 `DatabaseStartupState`（phase=ready，startupId 用 InitLocal 下发的 databaseStartupId 原样回填，schema 见 shared/database-startup.ts，strict 校验）→ 在 port 上开 ChannelServer 注册服务；Dispose → 退出。renderer 侧 DatabaseStartupAdmission 按 startupId 配对 state+port 才放行业务 Root。

**patch 清单（scratch 内，非 refs；随 Task 3 落地后在此登记 diff）：**

| #   | 文件（scratch 内）                                                         | 内容                                                                                                                                                             | 理由                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | `packages/desktop/src/main/desktopRuntimeEnv.ts`                           | hostModulePath 支持 `ZS1_HOST_MODULE_PATH` 环境变量注入                                                                                                          | 唯一装配点 patch：把 host 进程模块指向本仓 zcode-adapter 构建的 host bundle（Task 3）                                                                                                                      |
| P2  | `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx` | 「模型」区加**获取模型**按钮 + 勾选面板（Discover→列表勾选→添加所选，2026-10-22 ZS4.5f）                                                                         | 用户点名需求：「在【添加模型】按钮左侧增加一个获取模型的按钮……我勾选了哪些，下面才显示哪些」；后端 discoverModels/addDiscoveredModels 纯适配器侧，UI 只加交互壳，不改任何既有组件行为                      |
| P3  | `packages/ui/src/lib/settingsNavigation.ts`                                | `HIDDEN_SETTINGS_SECTIONS` 追加 `usage` + `remoteDevices`（2026-10-23 ZS6-T1）                                                                                   | 红线⑩隐藏清单：两分区的后端（UsageStats/RemoteProject/SourceServer）在 harness2 内心=空态桩，入口可见即点即空壳；用 ZCode 自家既有隐藏机制（同 automations/plugins/workspaceFileSearch），非改交互         |
| P4  | `packages/ui/src/settings/model-provider-section/constants.ts`             | `PRESET_PROVIDER_SPECS`/`CODING_PLAN_PROVIDER_SPECS` 两表置空（2026-10-23 ZS6-T1）                                                                               | 红线⑩：Z.ai/BigModel 预设 OAuth 卡与 Coding Plan/Start Plan 订阅卡的后端（OAuth/订阅/配额 SaaS）不存在，「连接 Z.ai」可见即假入口；置数据表使整族卡片/导航不渲染（消费面全经 .get()/.find() 可选链，已核） |
| P5  | `packages/ui/src/settings/model-provider-section/Navigation.tsx`           | 分组过滤条件由「仅空 custom 隐藏」改「一切空组不渲染标题」（2026-10-23 ZS6-T1，配套 P4）                                                                         | 预设卡置空后「预设」空标题会孤悬；对上游非空数据行为不变（严格更安全）                                                                                                                                     |
| P6  | `packages/ui/src/WorkspaceHelpMenuButton.tsx`                              | 新增 `VENDOR_HELP_LINKS_HIDDEN` 常量，隐藏文档/社群/反馈/漏洞/需求/检查更新 6 项（2026-10-23 ZS6-T1）                                                            | 红线⑩+品牌口径：这些链接指向 ZCode 官方运营与私有 SaaS（Feedback/CloudContent/ClientScenes=空态桩），对 harness2 内心产品既无后端也误导流；导出日志/资源管理器/关于=真实能力（ZS5）保留                    |
| P7  | `packages/desktop/src/main/desktopRuntimeEnv.ts`（同 P1 文件）             | packaged 应用名回退「ZCode」→「Harness2 Desktop」；dev 回退「ZCode Dev」→「Harness2 Desktop Dev」（2026-10-23 ZS6-T2，工作名；dev/packaged 分离=审查 P2-1 闭环） | 品牌装配：进程身份/userData 目录/任务栏归属跟随产品名；env `ZCODE_DESKTOP_APPLICATION_NAME` 覆盖通道（ZCode 原生）保留优先；dev 后缀保留上游单实例分离语义                                                 |
| P8  | `packages/desktop/src/main/about.ts`                                       | 关于窗应用名「ZCode Desktop App」→「Harness2 Desktop」+ 中英文版权行 ZCode→harness2（2026-10-23 ZS6-T2）                                                         | 品牌装配：关于页=用户确认产品身份的主路径；测试 about.test.ts 同步                                                                                                                                         |
| P9  | `packages/shared/src/desktopMenu.ts`                                       | 托盘 tooltip / 托盘「打开 ZCode」/ 主菜单「关于 ZCode」×zh+en 共 6 串（2026-10-23 ZS6-T2）                                                                       | 品牌装配：原生托盘+应用主菜单标签；desktopTray.test.ts 同步                                                                                                                                                |
| P10 | `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`                            | `titleBar.menu.help.about` 两字串（2026-10-23 ZS6-T2）                                                                                                           | 品牌装配：窗内 Help 下拉的关于项=本机主可见路径；纯 i18n 字串零交互；help-menu-about e2e 同步                                                                                                              |
| P11 | `packages/desktop/src/renderer/index.html`                                 | `<title>ZCode</title>`→`<title>Harness2 Desktop</title>`（2026-10-23 ZS6-T2）                                                                                    | 品牌装配：Electron 把页面 title 传播到窗口/任务栏标题（覆盖 BrowserWindow `title:""`，V3 实证）；计划约束 1 明列 index.html 壳为授权面                                                                     |

> **2026-10-22 红线变更登记**：UI patch 基线由 **1 处 → 2 处**（+P2，用户明确拍板的功能诉求；AskUserQuestion 时未答复但前一条消息已点名「建议直接……增加一个获取模型的按钮」，视为授权）。除 P2 外 UI 仍零改动；后续阶段引用「UI patch 仍 1 处」的验收行按 2 处口径复核。
>
> **2026-10-23 ZS6-T1 红线变更登记**：UI patch 基线由 **2 处 → 6 处**（+P3–P6，均为**红线⑩隐藏清单执行**，非新增交互）。依总纲 ZS6 行「C 类隐藏清单执行」与本计划约束 1「后端能力不足时走隐藏入口而非改 UI 降级」；用户授权 ZS6 开工即授权该清单执行（AskUserQuestion 拍板问题未答复，按系统指示以最佳判断继续，全部走 ZCode 自家既有隐藏机制=数据置空/静态集合/常量门，无一处改交互组件行为）。P3–P6 完整 diff 落盘 `docs/patches/zs-shell-patches.patch`（6 文件，供上游 re-sync 重放）；运行态回归 `scripts/zs6/t1-verify.cjs` GATE=PASS。后续阶段引用「UI patch=2 处」的验收行按 **6 处**口径复核。
>
> **2026-10-23 ZS6-T2 红线变更登记**：UI patch 基线由 **6 处 → 11 处**（+P7–P11，均为**品牌装配**，工作名「Harness2 Desktop」=用户 2026-10-23 拍板（OPEN.md ZS6 行），正式名人类后替）。P7/P8=desktop main 装配点、P9=shared 菜单数据表、P10=UI i18n 纯字串、P11=index.html 壳标题——全部落在 ZS6 计划约束 1 授权面（「品牌与隐藏所需的装配点：desktop main / 构建配置 / index.html 壳」），零改交互组件行为；构建配置（identity `productName`/`appId`、builder `extraMetadata`）不占编号。触点清单/通道判定/保留不改项（`zcode://` scheme、macOS dev bundle 名、图标待人类供给）见 `docs/ai-framework/plans/zs6-brand-checklist.md`。scratch 侧 P1–P11 全集+受影响测试同步（about/desktopTray/desktopProductIdentity 单测 + help-menu-about e2e）提交 **`247b4c0e`**，审查 P1/P2-1 修复（en 托盘 2 值+dev 身份分离）追加 **`48915dd1`**；`docs/patches/zs-shell-patches.patch` 自 base `3c5b2276` 重生成=**18 文件 842 行**（re-sync 重放源）。运行态回归：`t2-brand-verify.cjs` **GATE=PASS 6/6**（修复后复跑同绿）、`t1-verify.cjs` 复跑 **GATE=PASS**（两 patch 族共存无冲突）、e2e `-Fresh` 基础轮 exit=0、V3 截图 `docs/screenshots/zs6/zs6-t2-*.png` ×3。后续阶段引用「UI patch=6 处」的验收行按 **11 处**口径复核。

构建绕行全部使用 ZCode 原生环境开关（非 patch）：`ZCODE_BOOTSTRAP_WITH_REMOTE=1`（纯 node 构建通道）、`ZCODE_DATA_BASE_DIR`（数据根）、`ELECTRON_MIRROR`（二进制下载）。

### Task 1：壳原版启动达标 ✅

- **进程存活**：启动后 40s 检查 `tasklist` → 6 个 electron.exe（main 76124 / host 42088 / renderer 74008 / gpu+utility 等），远超 30s 判据。
- **数据库启动**：`[database-startup] terminal { status: 'ready', durationMs: 3512 }`（agent bundle 就位后一次通过；首次无 bundle 时为 `unsupported_runtime`，已定位并修复——见上）。
- **空态/登录界面证据**（boot log，zs1-t1-boot2.log）：
  - 46 条 `[rpc:call] ... OK`（window-controller.listTaskList / remote-projects.readDirectory / project.readTree / provider-settings.getView / model-selection.getView / oauth.getProviders / oauth.getActiveProvider / credential.load 等）——renderer 已过 DB loading 屏、业务 Root 挂载成功；
  - `[zcode-agent-service] ZCode agent 等待 provider/model 就绪 …"当前没有可用的模型供应商和模型，请先登录或配置 API Key。"`——未登录空态。
- **截图**：`docs/screenshots/zs1/t1-original-shell.png`（真实运行截取，PowerShell CopyFromScreen 全屏 2560x1440；像素统计 514 distinct colors、浅色为主，与 ZCode 浅色主题一致。实施代理模型无视觉输入，截图内容留编排者核图）。
- 现场已清（taskkill electron 全灭）。

### Task 2：zcode-adapter 骨架 ✅（57 频道桩）

**实测频道数**：`@zcode/shared` ServiceChannels **56** + 字面量 `"gen-ui"`（services/src/gen-ui/contract.ts）= **57**（spike「约 60」的实数；accessor 65 属性中有复合属性与可选属性，频道注册以 57 为全集）。

**交付（`packages/zcode-adapter/`）**：

- `src/stub-factory.ts`：`createStubService<T>()`——Proxy 桩工厂；`on*`→`Event.None`（@zcode/rpc 基准）、`onDynamic*`→返回 Event.None、方法默认按分类（A/C→`async () => null`、B→async throw）；`throws`/`nulls` 可覆盖。**async throw**（RPC 语义：远端错误总是 rejected promise，同步 throw 会炸穿 ProxyChannel.call 调用点——单测实证后修正）。
- `src/channel-registry.ts`：57 频道逐条 A/B/C 分类 + 依据备注（spike §5 + A 类映射详表）；`assertRegistryMatchesServiceChannels()` 与 shared 全集对账。
- `src/root-mount-stubs.ts`：Root 挂载 9 服务 + boot log 空态 19 方法的显式类型化桩（形状经 TS 接口对齐）。要点：setting.get→`{recentProjects:[],locale:"en-US"}`；model-selection.getView→`{revision:0,providers:[]}`；provider-settings.getView→空 view；oauth 读路径未登录态（restoreCachedSessionState→`signed-out`）+ 登录动作 throw；coding-plan getDynamicWorkflowClientConfig→`disabled/default`（fail-closed）；window-controller listTaskList→空列表 + subscribeV4→snapshot ack；project.readTree→空树；broadcast send no-op/tryClaim true/onMessage 永不触发；zcode-agent/bots syncAppRuntimePreferences→void。
- `src/createHarness2Services.ts`：57 频道全注册进真实 `@zcode/services` ServiceCollection（非仿制）。
- `src/host-entry.ts`：桩 host 进程入口——main↔host 协议最小集（InitLocal→DatabaseStartupState ready（startupId 原样回填）→ChannelServer 暴露；AttachServicePort/DatabaseStartupControl/Dispose 处理；其余消息静默）。端口适配复刻 ZCode electronPort.ts（Apache-2.0）。
- `build/host-bundle.mjs`：esbuild 打包 host-entry + @zcode/rpc/services/shared 依赖闭包 → `dist/host-entry.cjs`（1.5MB，含 Apache-2.0 衍生作品 banner）；模块解析走包内 tsconfig paths（精确匹配）+ scratch 包级 node_modules 自然解析。
- `LICENSE-ZCODE.md`：随附 ZCode Apache-2.0 原许可证（V7）。

**设计决策（登记）**：

1. A 类读路径空态形状、**写路径 throw**（假成功比 throw 危险，如 setting.update）；
2. C 类读路径空值（入口显示空数据，红线⑩），动作路径（登录/支付/连接）throw——空数据下这些入口自然不可达；
3. **source-server-management 必须注册**：与 A 类映射详表「accessor 可不提供」结论不同——renderer 侧 RemoteServiceAccess 恒提供代理（懒失败），boot log 空态实证调用 getSnapshot 4 次，不注册会 RPC 报错；已注册并返回空 snapshot；
4. tsconfig/vitest/esbuild 的 `@zcode/*` 映射必须**精确匹配**（字符串 alias 是前缀匹配，会破坏 `@zcode/shared/model-config` 等子路径解析——vitest 实证后改正则/tsconfig paths）；
5. 包级 tsconfig 放宽 `noUncheckedIndexedAccess`/`verbatimModuleSyntax`（ZCode 源码约定不同，不放宽则外部源码 30+ 报错）。

**证据（真实命令输出）**：

- `tsc -p tsconfig.json --noEmit` → **0 error**（类型对齐达成）
- `vitest run` → **24 passed (24)**：57 频道枚举对账（无缺无多）/ C 静默（oauth/coding-plan/source-server/usage-stats 不炸）/ B throw（zcode-agent v4、file、window-controller 变更动作）/ 9 服务空态形状 / **ProxyChannel 集成测**（fromService(stub) 的 call/listen/动态事件全通——桩与真实 RPC 层兼容性实证）
- `pnpm -r --no-bail run typecheck` → **7/7 包全绿**（core/gateway/cli/desktop/ui-shared/web 无回归 + zcode-adapter 新增）
- `node build/host-bundle.mjs` → `dist/host-entry.cjs 1.5mb`；`node dist/host-entry.cjs` → 守卫报「must run inside Electron utilityProcess」exit 1（bundle 可加载性冒烟）

**残留（T3 实测兜底）**：C 类默认 null 的频道（usage-stats/client-config/client-scenes/cloud-content/cua 等）空态不触达（boot log 实证），若 T3 启动路径触达则补显式形状并登记。

### Task 3：host 装配替换 + 启动到空工作区（无登录门）✅

**目标态按无登录门执行（编排者 2026-10-20 指示：「我们不需要账户登录哦，这点和 zcode 有点不同」）**——Task 3 原文「渲染出 ZCode 空态/WelcomeScreen」修正为「直达主壳空工作区，无登录门」；总纲/计划正式修订由编排者交卷后落盘。

**P1 patch 落地（scratch 内 `packages/desktop/src/main/desktopRuntimeEnv.ts:86`）**：

```diff
- export const hostModulePath = join(import.meta.dirname, "../host/index.js");
+ // ZS1-P1（harness2 装配点 patch，登记于 ZS1 计划执行记录）：
+ export const hostModulePath =
+   process.env.ZS1_HOST_MODULE_PATH?.trim() || join(import.meta.dirname, "../host/index.js");
```

唯一装配点改动；tsup 重建 main 后生效。数据根隔离沿用 ZCode 原生 `ZCODE_DATA_BASE_DIR`（env 通道，非 patch）指向 `D:\AI_Projects\harness2-zs1-build\zs1-data`——**ZS1 桩不写真实数据**；字面 `~/.harness2` 根（paths.ts 改造）归 ZS2 真实数据流时再做。

**无登录门实现（方案 1：桩报告已登录·本地身份）**：

- 登录门判据（实测定位）：`useProviderAvailabilityLoginEntryGuard` 的 `shouldOpenLoginEntry = !providerFamilyDomain || (!user && !hasUsableProvider)`；桌面 UI 无「本地模式」开关（`shouldEnableProviderAvailabilityLoginEntryGuard` 仅排除 Web 远控）→ 必须走桩侧满足判据。
- `setting.get` → 增加 `providerFamilyDomain: "zai"`（类型只有 "zai"|"bigmodel"，占位取 "zai"；ZS4/ZS6 正式隐藏账户面）+ `providerFamilyDomainMigrated: true`（防迁移写路径）。
- `oauth.restoreCachedSessionState` → `{status: "authenticated", userInfo: harness2LocalUserInfo}`（id=harness2-local）；`onDidChangeSession` 永不触发（身份恒定）；`getActiveProvider` 保持 null（`refreshRestoredOAuthProviderFamilyAfterStartup` 对 null 直接返回，不触发 family selection 写入）。
- **空态触达点补形状（按计划风险表预案登记）**：`file.ensureConversationWorkspace`（Root.tsx:1176-1214 启动兜底，失败会显示 workspace 错误横幅）→ 返回 `{path: {ZCODE_DATA_BASE_DIR}/.zcode/workspace/default, created: false, workspacePurpose: "conversation"}`；目录由启动步骤预建（scratch 数据根内，非真实数据）。

**证据（真实命令输出，boot log `zs1-t3-final.log`）：**

1. **host 装配替换**：`[spawnHostProcess] host module path: D:\AI_Projects\harness2\packages\zcode-adapter\dist\host-entry.cjs`（main 日志）+ `[zs1-stub-host] zs1 stub host started`（桩 bundle 自身日志经 parentPort 中继）。
2. **进程存活**：50s 检查 6 个 electron.exe（main/renderer/gpu/host/scheduler/network）。
3. **无登录门直达主壳空工作区**：rpc:call 全 OK（**0 FAIL**），调用面与原版 T1 空态对齐且含主壳签名——`file.ensureConversationWorkspace OK`（工作区引导成功）、`window-controller.listTaskList`（侧栏任务列表）、`onboarding-record.shouldOnboard/getLatestEntry/claimAnonymousRecord`（引导流程静默通过）、`project.readTree`/`task-groups.read`/`remote-projects.readDirectory`；signed-out 对照轮（zs1-t3-nogate 前身）无 listTaskList 且 ensureConversationWorkspace FAIL——翻转前后行为差异实证。
4. **变异验证**：`modelSelectionServiceStub.getView` 临时改 throw → `model-selection.getView FAIL ×4`（rpc 日志）+ 截屏 150 distinct colors（对照健康态 1435——UI 落错误/降级态而非空态，Root.tsx:283-291 加载失败 toast 路径）；恢复后复绿（getView OK + 1435 colors）。工作树无残留（变异代码已还原）。
5. **截图**：`docs/screenshots/zs1/t3-stub-host-empty-state.png`（真实运行截取 2560x1440；像素统计 1435 distinct colors；实施代理模型无视觉输入，内容留编排者核图）。窗口标题 `ZCode`。
6. **refs 仓零污染**：`D:/AI_Projects/refs/ZCode` git status 仍为初始态（3c5b2276 + 原有 1 个非本任务未跟踪文件）。

**连带口径（登记）**：oauth/codingPlanSubscription/用量升级/登录登出全部 C 类静默；footer 账户菜单会显示桩身份「harness2」（cosmetic，ZS4/ZS6 隐藏）；设置页 providerFamilyDomain 占位 "zai" 的账户面入口在空数据下无可点支付/登录动作（读路径空值）。

### Task 4：收口核查 ✅

**V5 冻结区零改动**：`git diff --stat feb9526..HEAD -- packages/core packages/gateway packages/cli packages/desktop packages/ui-shared packages/web` → **0 行**（输出为空）。

**V4 UI 零改动（源码级对照）**：`diff -rq --exclude=node_modules --exclude=dist refs/ZCode/packages/ui scratch/packages/ui` → **exit 0（完全一致）**；`packages/desktop` 全量对照仅 `src/main/desktopRuntimeEnv.ts` 一处差异（=登记的 P1 patch，git diff 5 insertions/1 deletion）；refs 仓 `git status` 保持初始态（3c5b2276 + 1 个非本任务未跟踪文件）。

**V6 六包旧测试（全量 + 隔离复跑定性）**：

| 包        | 全量（并行）                                    | 隔离复跑                    | 定性                                           |
| --------- | ----------------------------------------------- | --------------------------- | ---------------------------------------------- |
| core      | 110 files / **1623 passed + 2 skipped（全绿）** | —                           | ≥基线（1232+2 → 已随后续阶段增至 1623）        |
| gateway   | **40/40 全绿**                                  | —                           | =基线                                          |
| web       | **150/150 全绿**                                | —                           | =基线                                          |
| cli       | 93 files / **1575 passed + 2 skipped（全绿）**  | —                           | =基线                                          |
| ui-shared | 763 passed + 13 failed                          | 3 红文件复跑 **42/42 全绿** | 并行负载计时抖动（OPEN.md 既登记模式），非回归 |
| desktop   | 1278 passed + 10 failed + 1 skipped             | 8 红文件复跑 **75/75 全绿** | 同上（红用例均 17–29s 超时形态）               |

lockfile 净增 321 行 = zcode-adapter devDeps（与既有包同版本：typescript 7.0.2 / vitest 5.0.0 / @types/node 26.4.1 / esbuild 0.25.0）+ 1 处传递依赖 `@bramus/specificity` 2.4.2→2.4.x（CSS 工具，与测试无关）。

**V7 Apache-2.0 随附**：scratch 根 `LICENSE` 在位（robocopy 原样拷贝）；`packages/zcode-adapter/LICENSE-ZCODE.md` 随附原许可证；host bundle 产物带衍生作品 banner（build/host-bundle.mjs）。

**事故登记（已恢复，留痕）**：收口期 `pnpm -r build` 首跑时，zcode-adapter 旧 build 脚本（`tsc -p tsconfig.build.json`）因 rootDir 外部源码（scratch paths）把 **1465 个编译产物（.js/.d.ts/.map × 366 模块）发射进 scratch 的 rpc/services/shared src 目录**，导致后续 esbuild 解析到类型已擦除的 .js 报 "No matching export"。处置：scratch `git clean -f -- packages/{rpc,services,shared}/src` 精确清除（scratch git status 复核回 P1+原有文件初始态）；build 脚本改为 `tsc --noEmit && node build/host-bundle.mjs`（包的唯一构建产物即 host bundle，tsconfig.build.json 删除）。**T3 全部取证（boot log/截图/变异验证）均在该事故发生前采集，证据有效**；事故后重建 bundle + 复跑 24/24 测试 + 最终冒烟（6 进程存活 40s、43 rpc:call 全 OK、主壳调用面完整、host=本仓 bundle）复验通过。

**V8 代码审查**：⬜ 独立只读子代理审查未在本代理职权内执行（实施代理不可自审）——审查面建议：UI 零改动核查（P1 清单 vs 实际 diff）/ 红线⑩（C 类静默不产生假入口；登录门绕过的桩身份口径）/ core 与旧壳零改动 / LICENSE 合规 / 桩类型对齐。留编排者派发。

### 验收标准总表自评（V1–V8）

| #   | 标准             | 自评                                                         | 证据                                                                                                                                                                                     |
| --- | ---------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | 新壳启动存活     | ✅                                                           | 桩 host 下 6 进程 ≥40s 存活（tasklist，t3-final 与 t4-smoke 两轮）                                                                                                                       |
| V2  | 空态渲染         | ✅（目标态已按编排者指示修正为「无登录门直达主壳空工作区」） | 截图 `docs/screenshots/zs1/t3-stub-host-empty-state.png`（1435 colors）+ 主壳调用面（listTaskList/ensureConversationWorkspace/onboarding 全 OK）；截图内容需编排者核图（实施代理无视觉） |
| V3  | 频道桩           | ✅                                                           | 57 频道枚举对账单测 + C 静默/B throw 断言 + 9 服务空态形状 + ProxyChannel 集成测，24/24 全绿；typecheck 0                                                                                |
| V4  | UI 零改动        | ✅                                                           | packages/ui 源码 diff exit 0；desktop 仅 P1 一处（登记）                                                                                                                                 |
| V5  | 旧壳/core 零改动 | ✅                                                           | 六包 git diff = 0 行                                                                                                                                                                     |
| V6  | 六包旧测试       | ✅                                                           | core/gateway/web/cli 全量全绿；ui-shared/desktop 红点隔离复跑全绿（并行负载抖动，既登记模式）                                                                                            |
| V7  | Apache-2.0       | ✅                                                           | scratch LICENSE + adapter LICENSE-ZCODE.md + bundle banner                                                                                                                               |
| V8  | 代码审查         | ⬜                                                           | 留编排者派独立子代理（实施代理不可自审）；审查面建议见 Task 4 节                                                                                                                         |

### 残留风险（交卷）

1. **scratch 依赖**：zcode-adapter 的 typecheck/test/bundle 依赖仓外 `D:/AI_Projects/harness2-zs1-build/ZCode`（路线 B 既定；其他机器需先按执行记录步骤重建 scratch）。长期 vendored 路线归 ZS6。
2. **C 类默认 null 频道**（usage-stats/client-config/client-scenes/cloud-content/cua 等）：空态不触达（boot log 实证）；用户主动点开相关入口可能显示异常——ZS4/ZS6 隐藏清单处理。
3. **桩身份口径**：footer 显示「harness2」本地身份、providerFamilyDomain 占位 "zai"（类型仅两值）——ZS4/ZS6 正式隐藏账户面时替换。
4. **B 类可点入口**：插件市场/远程连接/会话分享等入口点击会显式报「ZS1: not implemented」——显式失败优于假成功（红线⑩口径），ZS2/ZS3 补能力或 ZS6 隐藏。
5. **登录门绕过为桩侧方案**（编排者授权的方案 1）：ZCode UI 无本地模式开关（实测确认）；若上游出现真实无账户路径，ZS2+ 优先切换。
6. **zcode-agent/bots syncAppRuntimePreferences 未在桩启动日志出现**（原版 T1 出现 1 次）——Root effect 依赖数组时序细节，无功能影响（ZS2 接真实偏好同步时复核）。
7. **footer「退出登录」可点必败且失败无用户可见反馈**（独立审查 P1-2 登记）：无登录门桩身份（`restoreCachedSessionState`→authenticated，编排者授权方案，不改）使 footer 渲染该入口；点击 confirm 后 `oauthService.logout()` 桩 throw，错误无用户可见反馈（静默）。归 ZS4/ZS6 隐藏清单；ZS2 若引入真实登出语义再定桩口径。
8. **footer「奖励」打开云端 webview 必加载失败**（独立审查 P1-2 登记）：同上桩身份使 footer 渲染该入口；harness2 无账户体系，点击打开的云端 Rewards webview 必加载失败。归 ZS4/ZS6 隐藏清单；ZS2 若引入真实账户/登出语义再定桩口径。

---

## 编排者验收记录（2026-10-20；V8 审查另派独立代理）

| #   | 结论                         | 证据（编排者亲跑，非转抄）                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | ✅                           | 编排者亲启桩 host 新壳（ZS1_HOST_MODULE_PATH + ZCODE_DATA_BASE_DIR 指向 scratch）：40s 后 scratch 路径下 **6 个 electron 进程存活**（main 158MB / renderer 220MB / gpu / host / scheduler / network），验收后仅清理 scratch 进程                                                                                                                                                                                                                                                  |
| V2  | ✅（灰屏事件→修复→CDP 复核） | **用户实机发现窗口纯灰**（视觉模型双确认）→ 两层根因定位（真实 setting 污染 + onboarding 桩缺显式 false，见「V2 灰屏根因与修复」节 + `docs/research/2026-10-20-zs-first-paint-contract.md`）→ 修复 `e7139ca`。**编排者亲跑 CDP 探针复核**：`DOM TEXT` 非空含主壳界面文字（"No tasks yet / harness2 / Ask ZCode / Projects / Tasks / No model available..."）、截图 `t3-cdp-page.png` 322KB/3695 采样色（灰屏时=1 色）。**用户终验进行中**（隔离实例已启动在案）。观察项见文末结论 |
| V3  | ✅                           | 编排者亲跑 `pnpm --filter @harness2/zcode-adapter test`：首轮 24/24；P1+灰屏修复后复跑 **32/32 绿**（channels 4 + stub-behavior 28）；typecheck 0                                                                                                                                                                                                                                                                                                                                 |
| V4  | ✅                           | scratch `git status` 干净（编排者复核）；packages/ui `diff -rq` exit 0（实施代理，执行记录 T4）                                                                                                                                                                                                                                                                                                                                                                                   |
| V5  | ✅                           | `git diff --stat feb9526..HEAD -- 六包` 输出为空（编排者亲跑）                                                                                                                                                                                                                                                                                                                                                                                                                    |
| V6  | ✅                           | 六包全量全绿（实施代理跑；ui-shared 13 红 / desktop 10 红隔离复跑 42/42、75/75 全绿——OPEN.md 既登记的并行负载抖动模式，非回归）                                                                                                                                                                                                                                                                                                                                                   |
| V7  | ✅                           | LICENSE-ZCODE.md 与 refs 原版 LICENSE **逐字节一致** + bundle banner（`build/host-bundle.mjs:41-49` 与产物头部均在位）+ scratch LICENSE——**独立审查代理逐字节复核属实**                                                                                                                                                                                                                                                                                                           |
| V8  | ✅（P1 闭环）                | 独立只读审查：**⚠️ 有条件通过（无 P0 / P1×2 / P2×4）**；审查面逐项复核属实（UI 零改动逐字节、六包零 diff、57 频道对账、无登录门判据链、事故清理、变异推演非空转）。P1-1 五频道写路径显式 throw（`531c538`，编排者复验测试绿 + 零改动不破）+ P1-2 logout/Rewards 登记（`c06030e`）→ **定论通过**。P2×4 登记不修（throws 无编译期校验 / package.json exports 死映射与 license 字段 / tsconfig 硬编码 scratch 路径 / 两处测试小项）                                                  |

**结论：V1–V8 全部通过（`e7139ca` 后状态）——ZS1 阶段收口，待用户终验一眼。**

**V2 观察项（用户终验时留意，均非阻塞）**：

1. 首帧 DOM 出现 radix dialog + `bg-black/60` 遮罩节点（疑似命令面板浮层自动打开）——若窗口内有半透明遮罩按 Esc 关闭即可；根因待 ZS2 复核（可能为桩触发焦点/快捷键路径异常）。
2. 空 provider 桩的预期空态横幅「No model available. Upgrade or set a custom model.」带「Upgrade」按钮——ZS2 接真实 `config.providers` 后自然消失（届时按红线⑩决定该入口去留）。
3. footer 显示桩身份「harness2」+「退出登录/奖励」可点必败（残留风险 #7/#8，归 ZS4/ZS6 隐藏清单）。
