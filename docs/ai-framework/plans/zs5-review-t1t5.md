# ZS5 T1-T5 独立审查报告（feat/phase-zs5-observability）

审查范围：`git diff main...HEAD` 全量（含 T1 436a641、T2 f49ff20、T3 4701637、T5 3732c92/1639975/4a69d7e、T4 2534218）。审查者：只读独立代理，未改源码。

## 0. 范围确认

```
git diff main...HEAD --stat  -> 21 files changed, 1725 insertions(+), 22 deletions(-)
```

新增源码：host-entry.ts、host-sampling.ts、host-crash.ts、boot-timing.ts、agent-service.ts(sessions-index)、provider-views.ts(写路径)。

## 1. 零遥测 / 密钥红线

- 全 diff 无 `fetch(`/`http.`/`WebSocket` 等网络发送（grep 无命中）。崩溃/采样/帧路径均为本地 IPC/落盘。
- `redactSecrets` 出口：host-sampling 行文本字段 `name/groupKey/groupLabel` 全过 redact（host-sampling.ts:126-129,144-153）；discoverModels 错误（provider-views.ts:603-606）；crash 报告 core 层 redact（crash.ts:43-47）。
- 密钥形态扫描 `sk-[A-Za-z0-9-]{6,}` 仅命中测试夹具：host-sampling.test.ts:93 `sk-abcdefghijklmnop`、host-crash.test.ts:29 `sk-supersecret-ABCDEFGHIJKLMNOP`。均为 redact 单测夹具，非真实密钥，但 CI 扫描规则会命中，建议 allowlist 或改夹具前缀（P2）。

## 2. 协议正确性（host-sampling）

- 字段/单位对照 shared strict schema（hostResourceUsageSnapshotResultResponseSchema）：响应仅 `type/requestId/sampledAt/processes`；进程行字段与 schema 一致；`sampledAt` Math.trunc 且 Math.max(0,...)（host-sampling.ts:165）；cpuPercent 有限非负（host-sampling.ts:116）；memoryBytes=rss。符合。
- 未知/多余字段：isHostSamplingRequest/isHostSamplingCancel 仅校验 type+requestId string（host-sampling.ts:170-186），多余字段被静默忽略（adapter 侧宽松）；main 侧 incoming response schema 为 `.strict()`，host 出口无多余字段，不会被 main 拒收。OK。
- Cancel 竞态（P1）：`cancelRequest` 仅对已登记 pending 生效（host-sampling.ts:216-220）；若 cancel 消息先于 request 处理到达，pending 尚未登记，cancel 为 no-op，随后 request 仍回帖 —— cancel 语义被吞。同一 requestId 复用时 handleRequest 直接 overwrite pending Map（host-sampling.ts:199-200），旧 token 丢失，取消目标错乱。建议：维护 `cancelledIds` 集合在 handleRequest 入口检查；requestId 已 pending 时拒绝/忽略复用。
- 采样出口 `off` 缺失泄漏（P2）：HostSamplingPort.off 可选；dispose 仅在 off/removeListener 存在时移除监听（host-sampling.ts:253-260），port 不提供 off 时 listener 无法卸载。生产 Electron port 有 off，但接口应要求 off 或 dispose 兜底。建议接口将 off 必选或 dispose 记录未卸载。
- 其他：getHostSamplingController 的 WeakMap 缓存忽略后续 options（host-sampling.ts:276-289）；sampledAt 在 options.now 返回 NaN 时 Math.max(0,NaN)=NaN（host-sampling.ts:165）；建议 Number.isFinite 兜底（P2）。

## 3. 崩溃钩子

- 处置语义与 scratch 原版差异已登记（host-crash.ts 文件头）：adapter host 两类钩子均写报告后吞掉、不 process.exit；recoverable 分配失败仅 warn。与 ZCode main unhandledRejection 仅记日志口径一致（host-crash.ts:90）。可接受，但 header 承诺 "options.exit 注入点" 而代码从未调用 exit（host-crash.ts:69-71）——注入契约死代码（P1）。建议 either 调用 exit（fatal 场景）或删除选项并修正文档。
- try/catch 完备：writer/console 均包裹（host-crash.ts:50-59,79-89）；installCrashHooks 监听器再包裹（host-crash.ts:98-117）。OK。
- ZS5_TEST_CRASH env：仅 run-e2e.ps1 -Crash 设置；host-entry.ts:257 在 env==='1' 时 3s 后 reject。正常 launch-manual 不设置该 env，不触发。但 env 若被用户/脚本误带入会触发（P2），建议增加 NODE_ENV/test 守卫或更显式开关。

## 4. sessions-index

- 轮询定时器生命周期：ensureSessionsIndexTimer 单例 setInterval 3s（agent-service.ts:200-220）；全 unsub 后 clearInterval（agent-service.ts:212-217,1555-1558）。OK。但 setInterval 回调内 manager.list/fireSessionsIndexFrame 未 try/catch（agent-service.ts:202-217），异常会以 uncaughtException 形态冒泡并可能中断本轮后续订阅；建议包裹（P1）。
- 帧 schema 与 TopicWireFrameAssembler：outer frame fromSeq=0/toSeq=0、topic `sessions-index/<workspaceKey>`、subscriptionId、sentAt、payload.kind='snapshot'（agent-service.ts:171-186）；snapshot 含 protocolVersion=1/workspaceId/logEpoch/sessions。与 sessionsIndexSnapshotSchema 一致。OK。ordinal 从 1 起（agent-service.ts:187），符合 assembler >=1 要求。
- subscriptionId 映射内存增长（P2）：sessionsIndexSubs 仅 unsub 时删除（agent-service.ts:1550-1558）；客户端异常断开时残留。建议 TTL/心跳清理或弱引用。
- resync no-op 语义（P2）：未知 subscriptionId 返回 ack mode='snapshot' 且不 fire（agent-service.ts:1540-1545），可能掩盖真实错误；建议返回 reasonCode/available=false 或记录日志。

## 5. 测试质量

- host-sampling CPU 测试断言过弱（host-sampling.test.ts:79-86）：仅断言 second>=0，无法证伪"采样失败"；建议断言 busy 后 second>0 或至少与 first 差分有限（P2）。
- sessions-index unsubscribe 测试固定等待 3.5s（sessions-index.test.ts:98-101），慢 CI flake 面（P2）。
- boot-timing parse 测试仅覆盖 2 例（boot-timing.test.ts:88-91），缺少畸形输入（缺 +、负数、多空格、空串）覆盖（P2）。

## 6. 风格/结构

- 新文件头注释如实登记机制差异（host-crash.ts、host-sampling.ts、boot-timing.ts）。OK。
- provider-views/agent-service 既有模式一致性：afterMutation/revisionClock 等保持；discoverModels redact 统一出口（provider-views.ts:603-606）。OK。

## 7. 结论

⚠️ 无 P0 阻塞；存在 3 项 P1（cancel 竞态/requestId 复用、exit 选项死代码、sessions-index 定时器异常未包裹）建议必修后再合入；其余 P2 为建议。

---

## 自证

```
$ git status --short docs/ai-framework/plans/zs5-review-t1t5.md
?? docs/ai-framework/plans/zs5-review-t1t5.md

$ wc -l docs/ai-framework/plans/zs5-review-t1t5.md
62 docs/ai-framework/plans/zs5-review-t1t5.md
```

文件存在且为 untracked 新增，diff 中包含本报告；任务完成。
