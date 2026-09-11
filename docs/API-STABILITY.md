# API 稳定承诺（@harness2/core）

> 状态：v1.0.0 起生效（阶段 12 Task 1）· 承诺对象：公开导出面
> 快照测试：`packages/core/test/api-surface.test.ts` · 基线 fixture：`packages/core/test/fixtures/api-surface-baseline.json`

## 承诺范围（只承诺这一处）

- **`@harness2/core` 主入口**：`packages/core/src/index.ts` → 发布产物 `dist/index.d.ts` 的全部导出（当前基线 372 个名字，含值导出与类型导出）。
- core 的 `package.json` `exports` 字段只暴露 `"."` 主入口——`@harness2/core/dist/...` 等**深路径不在发布映射内、不做任何兼容承诺**（随版本可能删除/移动，不另行通知）；使用方一律从主入口导入。

## semver 政策（1.0 起）

| 变更类型                                                          | 判定     | 版本动作  |
| ----------------------------------------------------------------- | -------- | --------- |
| 新增导出、新可选字段、新可选参数（缺省行为不变）                  | 加性     | minor     |
| 删除导出、导出改名、声明种类变更（function→const 等）、行为不兼容 | breaking | **major** |
| bug 修复、内部实现调整（公开面不变）                              | —        | patch     |

- **best-effort 范围（不属本 semver 承诺）**：`harness2`（CLI）的命令行输出格式、桌面端 protocol、serve HTTP/WS API——v1 冻结是工程约定（见 `architecture.md`「会话服务」），破坏性调整在 `CHANGELOG.md` 显著声明。
- 事件日志格式（`session.v1.jsonl`）的兼容性由「代际字段 v + 加性演进」机制独立保障（见 `architecture.md`「会话事件日志」），不在本政策范围。

## 跨端展示语义：turn 终态文本（P3-a / P3-b，2026-09-11 冻结）

> 契约落点：serve WS `turn-end` 帧（`packages/core/src/server/ws.ts`；`TurnTextOutcome` 定义在 `interaction/types.ts`）。
> 终端（cli）、桌面（desktop）、网关（gateway）**必须引用同一处定义**（帧字段 + 本表），不得各自发明。

| `textOutcome` | 含义                                           | 客户端渲染规则                                                                  |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `final`       | 有完整最终文本（`finalText`）                  | 按普通 assistant 正文渲染                                                       |
| `partial`     | 仅有不完整 attempt 的半截文本（`partialText`） | 渲染 `partialText`，并**必须**显式标注「未完成 / 已中断」+ `stopReason`/`error` |
| `empty`       | 无可展示正文（如首个 token 前失败）            | 只渲染 `stopReason`/`error` 与已执行工具行；**禁止空白气泡**                    |

不变量（冻结）：

1. `finalText` 只承载完整正文；半截文本只进 `partialText`，两者互斥，`textOutcome` 是唯一判别。
2. `assistant/attempt` 事件（append-only）是半截文本的**日志权威**；`turn-end.partialText` 是它的展示投影。
3. 「无最终文本但有可行动结果」= `empty` + 已执行工具行 + 可读错误原因（不是静默、也不是伪造正文）。

---

## 快照测试口径（宽松匹配，防抖动）

- 测试从**构建产物** `dist/index.d.ts` 递归解析导出面（处理 `export *`、named 别名重导出、import 后裸 `export {}`），与基线 fixture 逐名比对。
- 钉住两级：**导出名 + 声明种类**（function / class / const / interface / type / enum / namespace）。
- **参数/返回类型级别的签名变化不在捕获范围**——这是有意的宽松匹配（签名文本快照天然抖动，详见阶段计划风险表）；此类变化依赖 code review 与测试保障，本文件如实声明。
- 判定行为：
  - 新增导出 → **不红**（加性允许，minor）；基线 fixture 应随同次变更更新（流程见下）。
  - 删除/改名/声明种类变更 → **红**，失败消息给出决策指引（恢复导出 / 走 major / 经批准更新快照）。
- **防漏报双保险**：另有「运行时值导出 ⊆ 声明导出面」交叉断言——若 d.ts 解析漏报某个值导出，该用例即红。

## 基线更新流程

```bash
# 1. 构建后以快照更新模式重跑（重写 fixture）
pnpm build
H2_UPDATE_API_SNAPSHOT=1 pnpm --filter @harness2/core exec vitest run test/api-surface.test.ts

# 2. 审查 diff：只允许出现「经批准的新增导出」；出现删除/种类变更即回退并走 major 决策
git diff packages/core/test/fixtures/api-surface-baseline.json
```

> 维护约定：fixture 变更必须与导出面变更出现在**同一次**提交中，review 时对照 `src/index.ts` 的 diff 核对。
