# ZS5 T0 盘点 — 资源管理器入口 / 采样协议 / logger 现状 / sessions-index 契约

> 生成日期：2026-10-22（Task 0，零功能代码）  
> 分支：`feat/phase-zs5-observability`  
> 计划来源：`docs/ai-framework/plans/2026-10-22-phase-ZS5-observability.md` Task 0  
> 证据约定：`文件:行` + 命令输出摘录 + 截图路径；所有结论可复验。

---

## ① 原生资源管理器打开路径

### 证据

- scratch 源：`D:/AI_Projects/harness2-zs1-build/ZCode/packages/desktop/src/main/resourceManagerWindow.ts:257` `openResourceManager()` —— 创建单例 `BrowserWindow`（900×600），加载 `resource-manager.html`，`logger.info("[resource-manager] window opened")`。
- 菜单注册：`packages/desktop/src/main/desktopApplicationMenu.ts:340-346`（Help 菜单末段）：
  ```
  {
    label: getLabel(desktopMenuMessageIds.helpResourceManager),
    click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenResourceManager),
  }
  ```
- 命令处理：`packages/desktop/src/main/desktopCommandHandlers.ts:622-624`：
  ```
  case DesktopCommandIds.OpenResourceManager:
    openResourceManager();
    return;
  ```
- IPC 通道：`packages/desktop/src/main/desktopMainIpcPlatform.ts:215-217`：
  ```
  ipcMain.on(PlatformChannels.OpenResourceManager, () => { openResourceManager(); });
  ```
  `PlatformChannels.OpenResourceManager` = `"zcode:open-resource-manager"`（`packages/shared/src/channels.ts:339`）。
- UI 入口（装配壳内真实用户路径）：`packages/ui/src/WorkspaceHelpMenuButton.tsx:65-66` `handleOpenResourceManager` → `platform.executeDesktopCommand(DesktopCommandIds.OpenResourceManager)`；渲染条件 `isDesktop`；菜单项 `data-testid="workspace-help-menu-resource-manager"`（`packages/shared/src/test-ids.ts:556`）；触发按钮 `data-testid="workspace-help-menu-trigger"`（`packages/shared/src/test-ids.ts:554`）。
- Host 进程注册：`packages/desktop/src/main/desktopHostProcess.ts` 启动时 `registerHostProcess(label, child)`；main 侧 `resolveHostResourceUsageResult`（`resourceManagerHostSampling.ts`）按 `requestId` 关联回帖。
- host 行现状（CDP 实探）：资源管理器窗口已在线，进程表含 `zcode-host-local-1`（pid 58992），CPU 0.0%；因 adapter host 尚未应答采样协议，数值为兜底/上一轮（T1 缺口）。

### CDP 实探证据

- 起壳：port 9229 已有 scratch electron（`D:\AI_Projects\harness2-zs1-build\ZCode\node_modules\electron\dist\electron.exe`，PID 43444）；未重复起壳。
- 截图：`D:/AI_Projects/harness2/docs/screenshots/zs5/zs5-resource-manager-window.png`（资源管理器窗口，7 个进程，host 行可见）。
- 截图：`D:/AI_Projects/harness2/docs/screenshots/zs5/zs5-resource-manager-entry.png`（主窗口，Help 菜单路径入口证据）。
- 本轮探针 additionally 确认：打开 Help 下拉 → 选择「资源管理器」菜单项后，新 page target `Resource Manager` 出现（`/json/list` 两 page target：`ZCode` + `Resource Manager`），证明入口在装配壳内**可用**。

### 结论

- **入口可用**：装配壳内用户路径 = 工作区顶栏 Help（问号）按钮 → 下拉 →「资源管理器」（`workspace-help-menu-resource-manager`），等价于原生 Help 菜单。**无需 UI patch**。
- T1/T4 可直接复用原生窗口与 `HostMessageTypes.ResourceUsageSnapshot*` 协议；悬浮卡片形态不另造（遵守 patch=2 红线）。
- host 行当前为兜底值，T1 补 adapter 应答后应出现随负载变化的 CPU/内存。

### 对 T1–T6 落点

- T1：adapter `host-entry.ts` 应答 `ResourceUsageSnapshotRequest` → main 侧 host 行接通（纯加性，无 scratch 改动）。
- T2：desktop main 已有 `initializeCrashCapture`（crashReporter 本地、无上传）+ `unhandledRejection` 日志；**无 `uncaughtException` 主进程钩子**（host 侧 scratch 有）。adapter host 也无崩溃钩子 → T2 接线点。
- T4：复用原生日志，不自造。

---

## ② 采样协议确切形状

### 证据（shared）

- `packages/shared/src/channels.ts:659-660`：
  ```
  ResourceUsageSnapshotRequest: "resource-usage-snapshot-request",
  ResourceUsageSnapshotCancel: "resource-usage-snapshot-cancel",
  ```
  （`@zcode/shared` 导出 `HostMessageTypes`）
- `packages/shared/src/channels.ts:708`：
  ```
  ResourceUsageSnapshotResult: "resource-usage-snapshot-result",
  ```
  （`HostResponseTypes`）
- `packages/shared/src/validation.ts:958-965` 请求消息 schema：
  ```ts
  hostResourceUsageSnapshotRequestMessageSchema = z.object({
    type: z.literal("resource-usage-snapshot-request"),
    requestId: nonEmptyStringSchema,
  }).strict();
  ```
- 取消消息：`{ type: "resource-usage-snapshot-cancel", requestId }`（`validation.ts` hostIncomingMessageSchema 内联）。
- `packages/shared/src/validation.ts:1559-1568` 响应 schema：
  ```ts
  hostResourceUsageSnapshotResultResponseSchema = z.object({
    type: z.literal("resource-usage-snapshot-result"),
    requestId: nonEmptyStringSchema,
    sampledAt: z.number().int().nonnegative(),
    processes: z.array(hostResourceUsageProcessSchema).max(10_000),
  }).strict();
  ```
- `packages/shared/src/protocol.ts:237`：
  ```ts
  export type HostResourceUsageProcess = Omit<ResourceUsageProcess, "sampled">;
  ```
- `packages/shared/src/protocol.ts:224-236` `ResourceUsageProcess` 字段：
  - `pid: number`（正整数）
  - `name: string`（非空，如 `zcode-agent-...` / `node_repl`）
  - `category: "base" | "builtin-plugin" | "community-plugin"`
  - `groupKey: string`、`groupLabel: string`
  - `cpuPercent: number`（有限、≥0；**整机归一化百分比**）
  - `memoryBytes: number`（有限、≥0；**字节**）
  - （Host 侧无 `sampled` 字段）

### 证据（scratch fan-out）

- `packages/desktop/src/main/resourceManagerHostSampling.ts`：
  - `HOST_SNAPSHOT_TIMEOUT_MS = 900`（main 等待 host 回帖上限，超时用上一轮兜底）。
  - main → host：`child.postMessage({ type: HostMessageTypes.ResourceUsageSnapshotRequest, requestId })`（`requestHostResourceUsage`，行 86-88）。
  - 取消：`child.postMessage({ type: HostMessageTypes.ResourceUsageSnapshotCancel, requestId })`（行 70）。
  - host → main：`resolveHostResourceUsageResult(label, result)` 校验 `pending.label === label` 且 `requestId` 匹配，然后 `lastHostResults.set(label, result.processes)`（行 28-37）。
  - 宿主进程标签：`registerHostProcess(label, child)` 的 `label`（如 `zcode-host-local-1`），与响应中的进程名无强绑定；进程行由 host 自报。

### 传输方式

- Electron `utilityProcess.postMessage`（parentPort）的结构化消息，**非 RPC MessagePort**；host 侧在 `parentPort.on('message')` 分发（adapter `host-entry.ts:132`）。
- 采样方向：main→host 请求（无 payload 除 requestId），host→main 响应（requestId + sampledAt + processes）。

### 对 T1 落点

- adapter `host-entry.ts` 在 `parentPort.on('message')` 增加 `case HostMessageTypes.ResourceUsageSnapshotRequest`：读 `requestId`，采样自身进程（`process.pid` / `process.cpuUsage()` 差分 / `process.memoryUsage().rss`），post 回 `{ type: HostResponseTypes.ResourceUsageSnapshotResult, requestId, sampledAt: Date.now(), processes: [hostRow] }`。
- 未知 type 保持 `default: return`（不破坏 DatabaseStartup 流程）。
- `HostResourceUsageProcess` 无 `sampled` 字段，host 行 category 建议 `"base"`，groupKey/groupLabel `"host"`。
- CPU 单位：整机归一化百分比（与 main 侧 `app.getAppMetrics` 口径一致）；内存字节。

---

## ③ desktop 原生 logger 与崩溃/错误处理

### 证据（logger 落盘）

- `packages/desktop/src/main/logger.ts:7-14`：
  ```
  function getLogDir() {
    const e2eLogDir = process.env.ZCODE_ENV === "test" ? process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim() : undefined;
    if (e2eLogDir) return e2eLogDir;
    return join(getAppConfigDir(), "logs");
  }
  ```
- `packages/services/src/paths.ts:56-68`：`getAppConfigDir()` = `join(getDataBaseDir(), ".zcode", "v2")`；`getDataBaseDir()` 优先 `_dataBaseDir` → env `ZCODE_DATA_BASE_DIR` → `homedir()`。
- **实测路径**（ZCODE_DATA_BASE_DIR=`D:\AI_Projects\harness2-zs1-build\zs1-data`）：
  - 日志：`D:\AI_Projects\harness2-zs1-build\zs1-data\.zcode\v2\logs\YYYY-MM-DD.log`（实测 `2026-10-22.log`，280KB，正在写入）。
  - 崩溃：`D:\AI_Projects\harness2-zs1-build\zs1-data\.zcode\v2\crash\{live,archive}`（目录已建）。
- `logger.ts:73-92`：每行格式 `[ts] [level] [pid:PID] [source] message\n`，文件按日期滚动，保留 console 输出。
- `packages/desktop/src/main/logger.ts:116-119` 注释确认：main 进程日志默认 `~/.zcode/v2/logs/YYYY-MM-DD.log`。

### 证据（崩溃/错误处理）

- `packages/desktop/src/main/desktopCrashCapture.ts`：`initializeCrashCapture()` 启动本地 `crashReporter`（`submitURL = https://zcode.invalid/local-crash-only`，`uploadToServer: false`），归档 `.dmp` 到 `crash/archive`，保留 V8 OOM 注解；零网络上传。
- `packages/desktop/src/main/index.ts:309-311`：仅 `process.on("unhandledRejection", ...)` → `logger.error`，**无 `uncaughtException` 主进程钩子**。
- scratch host（`packages/desktop/src/host/index.ts:2921-2940`）：有 `process.on("uncaughtException", ...)`，fatal 时 `disposeHostResources` + `process.exit(1)`；recoverable TLS 分配失败仅 warn。
- adapter host（`packages/zcode-adapter/src/host-entry.ts`）：**无任何崩溃钩子**；日志通过 `HostResponseTypes.Log` post 到 main（`host-entry.ts:73-75`），由 main 侧 hostLogRelay 落盘；无 `uncaughtException`/`unhandledRejection` 处理。
- core：`packages/core/src/doctor/crash.ts` 提供 `crashReportDir` / `writeCrashReport` / `formatCrashReport` / `installCrashReporter` / `noteCrashSessionId` / `CRASH_DIR_NAME`（`packages/core/src/index.ts:87` 导出）；报告目录 `~/.harness2/crash/`（`crashReportDir`，行 24-26）；零遥测、redactSecrets 闸门。**注意：无 `reportCrash` 符号**（计划文案用词偏差；实际应调 `writeCrashReport` 或 `installCrashReporter`）。

### 对 T2/T4 落点

- T2：adapter host 增 `process.on('uncaughtException'/'unhandledRejection')` → 调 core `writeCrashReport(err, { home })`（或 `installCrashReporter`），写入 `~/.harness2/crash/`；测试放 SECRET 断言不出现在报告。
- desktop main 侧：已有 crashReporter + unhandledRejection 日志；**不新增 main 进程 uncaughtException**（保持 scratch 行为，避免 patch 越界）——T2 范围限 adapter host。
- T4：host 的 `log()` 已汇入 main 日志（`HostResponseTypes.Log`），可读；启动分段计时可从 main log 时间戳差分或 adapter 侧打点；无需 scratch 改动。

---

## ④ `subscribeSessionsIndexV4` 消费契约

### 证据（消费方）

- `packages/ui/src/v4/agentSessionsIndexTransport.ts:126`：UI 调用
  ```ts
  const result = await agentService.subscribeSessionsIndexV4({
    ...workspace,
    runtimePolicy: "existing-only",
    ...(params.base ? { base: params.base } : {}),
    ...(params.visibility ? { visibility: params.visibility } : {}),
  });
  ```
  期望返回 `result.ack.subscriptionId`（行 137 `barrier.bind(pending, result.ack.subscriptionId)`）。
- 同文件 `resyncSessionsIndexV4`（行 170）、`unsubscribeSessionsIndexV4`（行 184）、`onDynamicSessionsIndexFrame(workspace)`（行 192）为成套契约。
- `ZCodeAgentSessionsIndexSubscribeParams`（scratch `packages/services/src/zcode-agent/zcodeAgent.ts:565-585`）字段：`workspacePath`、`workspaceIdentity?`、`base?`、`visibility?`、`subscriberScope?`、`runtimePolicy?`（`existing-only` 时 runtime 不可用返回稳定 unavailable）。
- `packages/ui/src/v4/agentSessionsIndexTransport.ts:51-64` 的 `SessionsIndexV4AgentService` Pick：必须实现 `subscribeSessionsIndexV4` / `resyncSessionsIndexV4` / `unsubscribeSessionsIndexV4` / `onDynamicSessionsIndexFrame`（+ 可选 handshake/lifecycle）。

### 证据（adapter 现状）

- `packages/zcode-adapter/src/real/agent-service.ts`：`impl` 中**未实现** `subscribeSessionsIndexV4` / `resyncSessionsIndexV4` / `unsubscribeSessionsIndexV4` / `onDynamicSessionsIndexFrame`（仅 `onDynamicSessionsIndexFrame()` 返回 `Event.None`，行 1414）。
- 结果：host log 每 ~20s FAIL 重试（ZS4 收口登记的观测噪声源）。
- adapter 已有会话枚举：`listSessions()`（行 1442）调用 `manager.list()` → `SessionManager.list(cwd?)`（`packages/core/src/session/manager.ts:198-216`），返回 `SessionSummary[]`（mtime 倒序，含 id/dir/cwd/mtime 等）。
- core **无**会话变更事件/推送原语（grep `sessionsIndex`/`SessionCreated` 于 `packages/core/src` 为空）；`SessionManager` 仅同步文件系统枚举，无 watcher/emitter。

### 结论

- **不能 adapter 侧"直译零 core 改动"地实现真推送**：core 无会话变更事件源，adapter 只能轮询 `manager.list()` diff 推帧（降级，T3 可先做）。
- 若要达到 ZCode 契约的实时推送（消除 20s FAIL + controller 帧），需 core 窗口提案。提案要点（三条）：
  1. **事件原语**：在 `SessionManager` 或 core 层增加会话变更通知（create/update/delete/archive）的 emitter/watcher（文件系统 watch 或显式 emit），避免 adapter 轮询全库。
  2. **快照形状**：定义 sessions-index 快照/增量帧的最小字段（sessionId、cwd/workspaceKey、title/firstUserText、mtimeMs、parentSession、archived），与 `V4SessionsIndexSubscribeResult.ack` + topic wire 帧对齐，供 adapter 直译。
  3. **生命周期语义**：明确 `existing-only` runtimePolicy 下 runtime 不可用时的稳定 unavailable 返回（不启动 agent），以及进程重启后的 logEpoch/代际切换与客户端重建策略。

### 对 T3 落点

- 短期（T3 可落地）：adapter 实现 `subscribeSessionsIndexV4` 返回 `{ ack: { subscriptionId, mode, logEpoch } }` + `onDynamicSessionsIndexFrame` 推送；用轮询 diff（mtime/集合变化）代替 core 事件，如实登记机制差异。
- 长期：提交 core 窗口提案（上述三条），获批后再切真推送。

---

## 决策点（T0 登记）

| # | 决策 | 结论 | 状态 |
|---|------|------|------|
| ① 资源管理器入口在装配壳是否可用 | **可用**：Help 按钮下拉 → 资源管理器（native 窗口），无 UI patch | T4/T1 复用原生；悬浮卡片不另造（patch 仍 =2） | ✅ 已确认，无需人类拍板 |
| ② soak 阈值 1.25 是否维持 | **建议维持 1.25**（比值判据，抗开发机抖动；绝对值不作门）；最终数字在 T6 实跑前与用户一次确认 | T6 定稿前复核 | 🟡 待 T6 用户确认 |

### 补充：UI patch 计数复核

- 本仓受保护 UI patch 仍为 2 处（P1 `desktopRuntimeEnv` / P2 `ProviderCardSections`），T0 未新增。`git diff --stat main...HEAD`（本分支仅 docs 提交）不含 src 改动。

---

## 附：基线回归

- 命令：`pnpm --filter @harness2/zcode-adapter test`
- 结果：`Test Files 16 passed (16)` / `Tests 129 passed (129)`（2026-10-22 实跑，14.19s）。

---

## 附：探针/文件引用速查

| 项 | 路径:行 |
|---|---------|
| openResourceManager | `harness2-zs1-build/ZCode/packages/desktop/src/main/resourceManagerWindow.ts:257` |
| 菜单注册 | `.../desktop/src/main/desktopApplicationMenu.ts:340-346` |
| 命令处理 | `.../desktop/src/main/desktopCommandHandlers.ts:622-624` |
| IPC 通道 | `.../desktop/src/main/desktopMainIpcPlatform.ts:215-217` |
| UI 入口 | `.../ui/src/WorkspaceHelpMenuButton.tsx:65-66,139` |
| testid | `.../shared/src/test-ids.ts:554,556` |
| HostMessageTypes 采样 | `.../shared/src/channels.ts:659-660,708` |
| 请求/响应 schema | `.../shared/src/validation.ts:958-965,1559-1568` |
| HostResourceUsageProcess | `.../shared/src/protocol.ts:224-237` |
| fan-out 超时 | `.../desktop/src/main/resourceManagerHostSampling.ts:15` |
| logger 落盘 | `.../desktop/src/main/logger.ts:7-14` |
| 路径解析 | `.../services/src/paths.ts:56-68` |
| crash capture | `.../desktop/src/main/desktopCrashCapture.ts:55-58,353-388` |
| unhandledRejection（main） | `.../desktop/src/main/index.ts:309-311` |
| host uncaughtException（scratch） | `.../desktop/src/host/index.ts:2921-2940` |
| core crash exports | `harness2/packages/core/src/doctor/crash.ts:12-90`；`index.ts:87` |
| adapter host 入口 | `harness2/packages/zcode-adapter/src/host-entry.ts`（采样/崩溃均未实现） |
| agent-service 契约 | `harness2/packages/zcode-adapter/src/real/agent-service.ts:1414,1442` |
| SessionManager.list | `harness2/packages/core/src/session/manager.ts:198-216` |
| consumer transport | `harness2-zs1-build/ZCode/packages/ui/src/v4/agentSessionsIndexTransport.ts:126-192` |
