# ZS5 core 侧提案（✅ 已批准 2026-10-23，✅ 已实施）

> 人类批准=2026-10-23 用户「没问题。可以开始ZS6了」一并批复。实施记录：
> **P1#1 落地形态**：`titleOf/rename/autoTitle/clearTitle` 四法入口统一私有 `assertSessionId`
> （`SESSION_ID_PATTERN` 同源，非法 throw `invalid session id`）。**locate 不下沉**（实证决策）：
> `fork.test.ts:146` / `manager.test.ts:190` 钉死畸形 id 既有契约=「session not found」，
> 改 throw 属行为变更超出提案；server 面已有 `sessions-assembly.assertValidSessionId`、
> 桌面面已有 adapter T8 封堵，标题写面（真实穿越风险）本轮 core 根治。
> **P1#3 落地形态**：deleteSession catch 区分 `code==='ENOENT'`（静默继续）与非 ENOENT
> （`process.emitWarning` 上浮后继续清理——坏目录删除正当性保留）。
> 测试：`session-titles.test.ts` 闸门 describe（6 畸形×4 法+合法回归）、`manager.test.ts`
> EISDIR→告警 spy 断言（弃 'warning' 事件监听：runner 环境异步派发不保序，实证）。
> 门：core **1641 passed + 2 skipped**（含 api-surface 基线=零导出漂移）、adapter 157、
> eslint 0 error（manager.ts:138 warning 预存在非本次）、prettier 绿。

## P1#1 rename/autoTitle/clearTitle 统一校验

- `packages/core/src/session/manager.ts:362` `rename`
- `:368` `autoTitle`
- `:375` `clearTitle`

建议：三方法入口先校验 `SESSION_ID_PATTERN`（`manager.ts:41`），非法 id 明确 throw `invalid session id`，与 `deleteSession:428` 一致；或下沉到 `locate` 入口统一校验。

签名：`rename(id: string, title: string, opts?)` / `autoTitle(id, ...)` / `clearTitle(id, ...)`。

测试：`../evil`、`a/b`、`..%2f` 全部 throw；合法 id 正常落盘 `title.json`。

## P1#3 deleteSession 非锁异常区分

- `packages/core/src/session/manager.ts:437`

建议：`SessionWriter.open` 抛错时区分 `ENOENT`（允许继续 `rmSync`）与权限/IO 错误（记录日志或返回失败，不掩盖）。

测试：模拟权限错误 → 不静默成功；ENOENT → 正常清理。

## 验收

- core 测试（`packages/core`）全绿；不破坏现有 `SESSION_ID_PATTERN` 调用方。
- ~~本提案不实施，等人类批准~~ → **2026-10-23 批准并实施**（形态偏离原文两点及理由见文首实施记录）。
