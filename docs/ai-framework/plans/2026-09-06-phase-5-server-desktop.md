# 阶段 5：会话服务化 + Electron 桌面壳（多会话并行 / 分屏）

> **状态：** 计划已就绪（阶段 4 已于 2026-09-06 验收通过，基线 253 passed + 1 skipped；API 契约以本文件为准）
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 把会话内核变成独立本地服务（D5 落地：UI 是观察者），交付 Electron 桌面端第一版：多会话并行切换不断流（后台会话只记事件）、分屏拖拽——M2 的地基。
**Architecture:** `harness2 serve`（127.0.0.1，HTTP 控制 + WS 事件流）是唯一内核入口；桌面端 spawn 该进程（hermes desktop 已验证的形态），渲染进程零 Node（contextIsolation + preload 桥）；不活跃会话只落事件不渲染，切换时从事件日志快速重放。
**Tech Stack:** 现有栈 + `ws`（WS 服务端）+ desktop 包新增 electron / react / vite / electron-builder（版本由实现代理取当期最新稳定并锁版本）。

---

## 前置阅读（必须）

| 优先级 | 文件 |
|--------|------|
| P0 | 本文件、`docs/MASTER-PLAN.md`（Ph5/Ph7 边界） |
| P0 | `packages/core/src/session/manager.ts`、`agent/loop.ts`（runTurn 依赖注入形态）、`provider/factory.ts` |
| P0 | `packages/cli/src/chat.ts`（REPL 是服务层的第一个参照消费者） |
| P1 | `docs/ROADMAP.md`（D5）、`docs/issue-log/OPEN.md` |

**仓库路径：** `D:\AI_projects\harness2`（默认分支 `master`）
**基线分支：** 从 `master` 拉 `feat/phase-5-server-desktop`（阶段 4 验收后）

---

## Global Constraints（冲突时以本节为准）

1. **单一事实源不变**：服务层与 REPL 一样只经 SessionManager/SessionWriter/loop 操作内核；WS 推送的事件 = 落盘事件的超集（增量 delta 是唯一允许的"未落盘"内容，且必须与随后落盘的最终事件一致）。
2. **安全边界**：服务只绑 127.0.0.1；首个实例持有端口锁（`~/.harness2/serve.lock`，复用会话锁思路）；渲染进程不开 nodeIntegration、不加远程内容加载。
3. **密钥三不**照旧：config/auth 不经 WS 下发明文（key 永不出服务进程）。
4. **明确不做（本阶段）**：记忆系统/分叉/内嵌浏览器/压缩/定时任务（Ph6/7）；远程访问/多用户；自动更新（Ph11）； IM（Ph9）。
5. **Git：** 每 Task 一提交；禁止 push。

---

## File Structure（预期变更）

| 文件 | 动作 | 职责 |
|------|------|------|
| `packages/core/src/server/{http,ws,sessions}.ts` | 新建 | 控制面（HTTP JSON API）+ 事件面（WS 订阅/推送）+ 服务内会话注册表（含运行中 turn 管理、取消） |
| `packages/cli/src/index.ts` | 修改 | `harness2 serve [--port 0] [--root <dir>]`：启动服务并打印实际端口（stdout 一行 JSON），`--port 0` 随机端口 |
| `packages/desktop/*` | 新建 | Electron 主进程（spawn serve / 连接管理 / 窗口）、preload 桥、React 渲染端（Vite 构建） |
| `packages/desktop/electron-builder.yml` | 新建 | win 先行打包配置（nsis，unsigned） |
| `packages/core/test/server.test.ts`、`packages/desktop/test/*.test.ts` | 新建 | 见各 Task |

### 服务 API 契约（冻结 v1）

```
HTTP（控制面，均 /api/*）
  GET  /api/sessions?cwd=           → 列表（manager.list 形态）
  POST /api/sessions {cwd}          → 创建，返回 {id}
  GET  /api/sessions/:id/events     → 全量事件（含 active 标记，供切换重放）
  POST /api/sessions/:id/undo  {n?, dryRun?}
  POST /api/sessions/:id/redo
  GET  /api/config                  → 脱敏报告（config check 同源）
WS（事件面，单连接多会话订阅）
  → {op:'subscribe', sessionId} / {op:'unsubscribe', sessionId} / {op:'abort', sessionId}
  → {op:'user-message', sessionId, text}        # 触发 runTurn（同会话串行，排队）
  ← {type:'delta', sessionId, kind:'text'|'reasoning'|'tool', ...}   # 流式增量
  ← {type:'event',  sessionId, event: SessionEvent}                  # 落盘事件镜像
  ← {type:'turn-end', sessionId, stopReason, warning?}
  ← {type:'approval-request', sessionId, tool, args, requestId}      # 桌面端审批按钮
  → {op:'approval-response', requestId, decision: 'allow'|'deny'}
```

---

## Task 1：服务核心（HTTP 控制面）

**Files:** `server/{http,sessions}.ts`、`cli` 挂 `serve`、`core/test/server.test.ts`

**行为:** 端口锁（陈旧接管）；API 按契约实现（输入校验、错误→JSON `{error}` 单行、脱敏）；`/api/sessions/:id/undo|redo` 直调 Ph4 内核；approval-request 经 Ph2 审批缝 `onAsk` 上抛为待处理请求表（HTTP 不可用时超时拒绝，默认 120s）。

**Steps:** 1. 实现+测试（node http 客户端直连：创建/列表/undo dryRun/错误路径/端口锁）。2. Commit：`✨feat(core): 会话服务控制面（HTTP API/端口锁）`

## Task 2：WS 事件面 + turn 流转

**Files:** `server/ws.ts`、测试扩展

**行为:** 单 WS 多会话订阅；`user-message` → 该会话串行 runTurn（排队语义同 REPL）；`delta`（text/reasoning/tool 进度）与落盘 `event` 双通道推送；`abort` → AbortController（复用 loop 取消语义）；服务端崩溃安全：turn 由事件日志兜底，重启后客户端以 `/events` 重放恢复。

**Steps:** 1. 实现+测试（`ws` 客户端：订阅后 mock/stub provider 流式全链、双会话并行互不阻塞、abort、审批 request/response 往返）。2. Commit：`✨feat(core): WS 事件面（订阅/流式增量/取消/审批往返）`

## Task 3：桌面壳骨架

**Files:** `packages/desktop/*`

**行为:** Electron 主进程：spawn `harness2 serve --port 0`（dev 用仓库内 dist；打包用 bundled cli）、解析端口、健康检查 `/api/config`；窗口创建（contextIsolation、preload 暴露 `window.harness2`：`listSessions/createSession/subscribe/sendMessage/undo/redo/on(...)`）；连接断开自动重启服务（上限+退避）；React+Vite 渲染端骨架（会话列表 + 对话区空态 + 连接状态角标）。

**Steps:** 1. 骨架+单元测试（preload 桥逻辑与 store 纯函数；Electron 主进程逻辑拆纯函数测）。2. 手工冒烟 `electron .` 记录 diary（GUI 自动化登记 OPEN 待真机）。3. Commit：`✨feat(desktop): Electron 壳骨架（spawn serve/preload 桥/连接管理）`

## Task 4：对话 UI

**Files:** desktop 渲染端、`desktop/test/*.test.ts`

**行为:** 会话列表（新建/搜索）；对话视图（用户/助手气泡、工具行、reasoning 折叠块、turn 摘要、流式光标）；输入框（Enter 发送、Shift+Enter 换行、turn 中变"停止"按钮=abort）；审批按钮（allow/deny 对应 WS op）；切换会话=先 `/api/sessions/:id/events` 全量重放再接增量（渲染按 active 投影，影子事件不显示）。

**Steps:** 1. store/渲染逻辑单测（事件折叠、重放排序、active 过滤纯函数）。2. Commit：`✨feat(desktop): 对话 UI（流式/重放/审批/多会话切换）`

## Task 5：分屏与拖拽

**Files:** desktop 渲染端

**行为:** 布局引擎：1/2/3 分栏（每栏独立绑定一个会话流，最多 3 并发订阅渲染）；从会话列表拖拽会话到分栏（HTML5 DnD）；布局持久化到 `~/.harness2/desktop-layout.json`。超出 3 的会话保持订阅事件但 UI 标记"后台"（不渲染历史，只显示新消息计数徽标）——多会话"切换不断流"的核心验收。

**Steps:** 1. 布局纯函数单测 + DnD 组件测试（jsdom）。2. Commit：`✨feat(desktop): 分屏拖拽与后台会话徽标`

## Task 6：打包与整备

**Files:** `electron-builder.yml`、`package.json` scripts、文档

**行为:** electron-builder win（nsis，unsigned，artifact 落 `release/`，gitignore）；`pnpm --filter @harness2/desktop dist`；`.github/workflows/ci.yml` 增加 desktop 构建矩阵（不跑 GUI 测试）；文档：architecture（服务层小节）、ROADMAP（P1-11/12/13 → ✅）、HANDOFF、diary、OPEN。

**Steps:** 1. 配置+本地打包冒烟（记录产物路径与大小）。2. Commit：`🔧chore(desktop): win 打包配置与 CI 构建`

---

## 验收标准总表

| # | 标准 | 通过条件 |
|---|------|----------|
| 1 | 服务控制面 | API/端口锁/undo 接入/审批上抛测试通过 |
| 2 | WS 事件面 | 订阅/双会话并行/abort/审批往返测试通过；delta 与落盘事件一致性断言 |
| 3 | 桌面壳 | spawn/端口解析/断线重启单测通过；`electron .` 本地冒烟记录 |
| 4 | 对话 UI | 事件折叠/重放/active 过滤单测通过 |
| 5 | 分屏 | 布局引擎/DnD/后台徽标单测通过 |
| 6 | 打包 | electron-builder 产物生成（win nsis） |
| 7 | 红线 | 渲染进程无 Node 权限；服务仅 127.0.0.1；key 不出服务进程/不进 WS |
| 8 | 单测/构建 | `pnpm test && pnpm -r typecheck` exit 0 |

---

## 风险与降级

| 风险 | 缓解 |
|------|------|
| Electron 版本/API 变动快 | 锁定当期稳定版；主进程逻辑拆纯函数降低耦合 |
| GUI 无法自动化验收 | GUI 项全部登记 OPEN 待真机；可自动化部分（store/布局/服务）测试锁死 |
| spawn 打包后找不到 cli | 打包把 cli dist 一并入包（asar unpacked 或 extraResources），冒烟验证 |
| WS 与 REPL 双消费者语义漂移 | 服务层复用 loop/审批缝原语；REPL 行为回归测试保留 |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给实现 AI 即可开工：

---

你是 **harness2** 阶段 5 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线
- 目录：`D:\AI_projects\harness2`（默认分支 `master`）；从 master 创建并切换 `feat/phase-5-server-desktop`
- 已完成（勿重做）：阶段 1-4 均验收（内核/loop+工具/Provider+配置/CLI chat+undo-redo+快照+发布物料）
- 唯一实施计划：`docs/ai-framework/plans/2026-09-XX-phase-5-server-desktop.md`（以仓库内实际文件为准）
- 必读：本计划（含服务 API 契约）、`session/manager.ts`、`agent/loop.ts`、`cli/chat.ts`、`AGENTS.md`

### 做
1. 严格按 Task 1→6 顺序执行；每 Task 测试通过后规范 commit（gitmoji 中文，禁止 push）
2. 遵守 Global Constraints：单一事实源（服务只经内核原语操作）；服务仅 127.0.0.1+端口锁；渲染进程零 Node；key 不出服务进程
3. GUI 无法自动化的项登记 OPEN.md 待真机验证；本地 `electron .` 冒烟记录进 diary

### 不做
- 记忆/分叉/内嵌浏览器/压缩/定时任务/IM/自动更新
- 提交密钥；任何 `git push`

### 工作方式
1. 先跑基线 `pnpm test` 确认全绿再动工
2. 证据优先：交卷前重跑 `pnpm test && pnpm -r typecheck`，粘贴真实输出；记录 electron 冒烟与打包产物信息
3. 简体中文回复；代码标识符原样

### 交卷
分支名、提交列表、验收表逐项自评（带命令与真实结果）、新增测试数、electron 冒烟与打包产物记录、残留风险与未关闭项。

现在开始：读完本阶段计划，从 Task 1 执行到 Task 6。

---

## 残留手工验收清单

1. Windows Terminal / 桌面实机：窗口、多会话并行流式、切换重放速度、分屏拖拽手感
2. 打包后的 nsis 安装包安装/卸载/启动全流程
3. 后台会话长任务（如 bash 长命令）时切换会话不阻塞、回来快速重放
