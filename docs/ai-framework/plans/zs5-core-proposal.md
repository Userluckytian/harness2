# ZS5 core 侧提案（待人类批准，不实施）

> 本文件仅提案。core 仍冻结，需人类批准后另开任务实施。

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
- 本提案不实施，等人类批准。
