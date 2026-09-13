# refs-deepseek-harness —— 桌面/Web 壳布局与页面参考

> 定位：**桌面壳的对话页面、会话列表、模型配置、轨迹视图、布局与样式参考。复刻等级默认「参考」**（形似即可，允许本地化）。
> 注意：该项目**功能面偏薄**，功能完整性不以它为准，见 `refs-hermes-agent.md`。

## 分析基线

| 项目         | 值                                                |
| ------------ | ------------------------------------------------- |
| 本地路径     | `D:/AI_Projects/refs/deepseek-harness`            |
| 远程         | `https://github.com/deepseek-ai/deepseek-harness` |
| 分析 commit  | `d347e70`                                         |
| 上游提交时间 | `2026-09-04T17:16:23+08:00`                       |
| 分支         | `master`                                          |
| 分析日期     | 2026-09-13                                        |
| 分析者       | 编排会话（Notion AI）                             |

## 定位与仓库结构

pnpm 单仓 TypeScript，CLI 名 `dsh`，包名前缀 `@deepseek-ai/dsh-*`。

- `apps/{cli,web}`；`apps/web/src` 只有 `main.ts` / `preview.ts` / `node-module-stub.ts`，**真 UI 在 `packages/client`**。
- `packages/` 50+ 个接缝包：`acp api attachment boot bundle client code-runtime compaction context core credentials e2b experimental extensions feedback fs goal guard hooks host identity interaction jobs llm lsp mcp plan preset runtime-diagnostics sandbox schedule sdk session session-query settings shell skill spill storage subagent subprocess terminal test-support todo typert util web webhook workflow workspace`。
- 工程配置：`tsconfig.base.json`(36KB)、`tsconfig.host.json`、`tsconfig.client.json`（**宿主面与浏览器面源平面拆分**，禁止跨平面 import）、`vitest.config.ts`(21KB) + 6 个专用配置、`lefthook.yml`、`.oxlintrc.json`。

**分层对应 harness2**：`packages/{core,session,llm,mcp,skill,...}` ≈ 我们的 `core`；`packages/client/*` ≈ 我们的 `desktop` / `web` 壳；`packages/host/*` ≈ 壳的宿主侧。

## 权威依据

本轮结论来源（均为仓库内 README，中英双语）：

- `packages/client/README.zh.md`（壳的组装模型与 slot 总纲）
- `packages/client/ui-layout/README.zh.md`（三栅布局）
- `packages/client/ui-sidebar/README.zh.md`（侧栏与会话列表宿主）
- `packages/client/ui-conversation/README.zh.md`（对话页装配）
- `packages/client/ui-trajectory/README.zh.md`（轨迹视图）
- `packages/client/ui-settings-models/README.zh.md`（模型配置页）

## D-0x 组装模型（slot 系统）

| ID   | 条目        | 要点                                                                                                                                                                               | 等级 | 状态 |
| ---- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| D-01 | slot 注册表 | `ui-slots` 定义声明式席位（single / keyed / list），`ui-renderer` 把 slot 数据绑到 React；壳只渲染装配好的树                                                                       | 参考 | ⬜   |
| D-02 | 功能包填席  | 每个 UI 能力是一个独立包，通过 `ctx.slots.inject` 注入声明好的席位，带类型化 props 与 store                                                                                        | 参考 | ⬜   |
| D-03 | ctx 服务面  | `ctx.clientModules` `ctx.modules` `ctx.connection` `ctx.fileUpload` `ctx.locale` `ctx.uiRenderer` `ctx.layout` `ctx.uiConversation` `ctx.uiSession` `ctx.slots` `ctx.conversation` | 参考 | ⬜   |
| D-04 | 源平面拆分  | 浏览器侧不得 import 宿主侧包（必要时允许“复刻而非依赖”，如 `normalizeApiKey`）                                                                                                     | 参考 | ⬜   |

## D-1x 三栅布局（`ui-layout`）

| ID   | 条目         | 要点                                                                                                        | 等级   | 状态 |
| ---- | ------------ | ----------------------------------------------------------------------------------------------------------- | ------ | ---- |
| D-10 | AppFrame     | 四子席位：`sidebar` / `conversation` / `details` / `shell.overlay`，注册进内建 `root` 槽                    | 参考   | ⬜   |
| D-11 | 可拖拽缩放   | 侧栏与详情栏均可拖宽；详情栏以浮动胶囊形式展示                                                              | 参考   | ⬜   |
| D-12 | **让步链**   | 窗口变窄时：先收缩详情栏 → 再自动关闭（推导出零宽度，**不修改用户偏好宽度**）                               | 参考   | ⬜   |
| D-13 | 侧栏收起     | 收起后保留 **56px 控制轨道**（不是彻底消失）                                                                | 参考   | ⬜   |
| D-14 | 面板几何瞬时 | 宽度/开关状态**不持久化**，刷新或切会话即重置                                                               | 参考   | ⬜   |
| D-15 | 主题呈现器   | 写 `html{color-scheme}`、`body[data-ds-dark-theme]`、`--dsh-content-font-size`、`<meta name="theme-color">` | 参考   | ⬜   |
| D-16 | 降动效       | `prefers-reduced-motion` 时禁用过渡                                                                         | 参考   | ⬜   |
| D-17 | 已知限制     | 挤压重排期间无滚动锚定（上游自认缺陷，我们不必复刻缺陷）                                                    | 不采纳 | ➖   |

## D-2x 侧栏与会话列表（`ui-sidebar` + `ui-workspace`）

| ID   | 条目         | 要点                                                                                                             | 等级 | 状态 |
| ---- | ------------ | ---------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| D-20 | 品牌行       | `sidebar.brand.mark` 与 `sidebar.brand.name` 两个 single 席位（可被品牌包接管）                                  | 参考 | ⬜   |
| D-21 | 新会话按钮   | 工作区选择优先级：显式指定 → 当前会话所属 → 最近活跃 → 空白                                                      | 参考 | ⬜   |
| D-22 | 收起动画     | 淘出 → 淘入并向左位移进 56px 轨道；`prefers-reduced-motion` 禁用                                                 | 参考 | ⬜   |
| D-23 | 区域席位     | `sidebar.workspaces`（归 `ui-workspace` 拥有，会话列表在此）；底部固定 `sidebar.settings` 席位                   | 参考 | ⬜   |
| D-24 | 滚动条可供性 | 指针离开 2 秒后隐藏；预留宽度避免显隐时重排                                                                      | 参考 | ⬜   |
| D-25 | 版本徐标     | `version[-commit][-dirty]`，来源 `DSH_CLIENT_VERSION` / `DSH_CLIENT_COMMIT_HASH`（7 位）/ `DSH_CLIENT_GIT_DIRTY` | 参考 | ⬜   |

## D-3x 对话页面（`ui-conversation` + `ui-chat`）

| ID   | 条目             | 要点                                                                                                                                                   | 等级 | 状态 |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---- |
| D-30 | 与 target 无关   | 对话装配层不绑定具体渲染目标；`UiConversation.events` / `.views` 是唯一注册表（拒重复 key、保注册顺序、幂等 disposer）                                 | 参考 | ⬜   |
| D-31 | **视图选择规则** | 有效持久选择 > 已注册 `chat` > 不渲染；**绝不选“第一个注册的”**                                                                                        | 参考 | ⬜   |
| D-32 | 视图环           | `conversation.view` 多标签（Chat / Trajectory / …），切换不重建会话                                                                                    | 参考 | ⬜   |
| D-33 | 常驻 composer    | 跳过“无会话/有会话”切换保持挂载（Lexical 编辑器）；引用 chip 为原子 decorator 节点；斜杠命令为行首样式文本                                             | 参考 | ⬜   |
| D-34 | **乐观提交**     | Enter 在**同一事务**内清空草稿 + occurrence + 撤销历史；发送为 detached attempt，`pendingSubmissions` 保序                                             | 参考 | ⬜   |
| D-35 | 繁忙态 Enter     | 设置二选：**Queue**（进 QueueDock）或 **Steer**（pending-steering）；空闲态进 transcript                                                               | 参考 | ⬜   |
| D-36 | 主指针操作       | 主按钮在 Stop 与 Queue Send 之间切换（不并列两个按钮）                                                                                                 | 参考 | ⬜   |
| D-37 | 附件             | 图片走 FileReader data URL；文件走 FIFO 上传队列，`maxConcurrentFileUploads` 默认 2                                                                    | 参考 | ⬜   |
| D-38 | composer 链      | `conversation.composer` 链 + `ComposerChainProps{sessionId, session, pendingInteraction}`；`ChainSelect` 纯函数选 takeover（priority 升序 → 注册顺序） | 参考 | ⬜   |
| D-39 | 图片 URL 缓存    | `ctx.uiConversation.imageUrl(sessionId, attachment)` 逐会话缓存，Chat 与 Trajectory 共用一次授权读取                                                   | 参考 | ⬜   |

## D-4x 轨迹视图（`ui-trajectory`）

| ID   | 条目     | 要点                                                                                  | 等级 | 状态 |
| ---- | -------- | ------------------------------------------------------------------------------------- | ---- | ---- |
| D-40 | 入口     | 作为 `conversation.view` 视图环里的 Trajectory 标签页（不是弹窗）                     | 参考 | ⬜   |
| D-41 | 记录表   | 按轮次组织（用户/助手/工具/嵌套子工具）；**粗分割线 = 轮次边界**，行内紧凑标记 = 步骤 | 参考 | ⬜   |
| D-42 | 时间概览 | 左→右投影**真实开始时间与耗时**；助手条区分 TTFT 与解码段                             | 参考 | ⬜   |
| D-43 | 概览交互 | 悬停 500ms 出详情；拖选区间过滤；滚轮缩放；右键清除；放大后右键拖动平移               | 参考 | ⬜   |
| D-44 | 检查器   | 选中记录开**局部**检查器：token 用量、耗时、输入、输出、计时、图片/文件附件摘要       | 参考 | ⬜   |
| D-45 | 虚拟化   | 挂载时尾部 50 个节点、按需前向补页、只挂可见窗口+缓冲、语义行键与 ARIA 索引稳定       | 参考 | ⬜   |
| D-46 | 壳的义务 | 会话壳必须把 composer 作为**浮层**置于全高记录表之上，并预留其实时高度                | 参考 | ⬜   |
| D-47 | 诚实性   | 进行中的行**不虚构耗时**（Time 列留空）；独立压缩请求进 `Between turns` 区段          | 参考 | ⬜   |

## D-5x 模型配置页（`ui-settings-models`）

| ID   | 条目         | 要点                                                                                                                                                                        | 等级 | 状态 |
| ---- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| D-50 | 页面形态     | 按**提供方行**展示，**一次只展开一张编辑卡片**；未配置的整节提供方首次直接渲染为展开卡                                                                                      | 参考 | ⬜   |
| D-51 | API 密钥     | 卡上只有**单一密钥输入框**，从不询问环境变量名；**只写**存入凭据引用，缺引用时派生 `<ROUTE>_API_KEY`；配置文件永不持有密钥值                                                | 参考 | ⬜   |
| D-52 | 状态点       | **仅在已确认**凭据已配置时标绿点，仅在已确认具名引用缺失时标红点（不猜）；成功后发无障碍消息且**不回显机密**                                                                | 参考 | ⬜   |
| D-53 | 自定义字段   | 收起的“自定义设置”折叠区：`baseURL`、模型目录、显示名称、API 协议；**Provider ID 不可改**（它是配置键与凭据引用词干）                                                       | 参考 | ⬜   |
| D-54 | 推理等级     | **故意不放在提供方级**：它是按模型的能力，提供方级控件只会设出部分模型会拒的值                                                                                              | 参考 | ⬜   |
| D-55 | 发现模型     | “获取可用模型”拿表单当前端点去查；回复打开**可搜索选择器而非直写**，点“添加所选”才写入；已有行保留用户调过的值                                                              | 参考 | ⬜   |
| D-56 | 选择器细则   | 搜索同时匹配 id 与显示名；不清除隐藏项勾选；全选仅加可见结果，取消全选清空全部                                                                                              | 参考 | ⬜   |
| D-57 | 校验         | 密钥去空白后非空且全为可打印 ASCII（`\x21-\x7E`）；拒 `NAME=value` 粘贴与引号包裹；拒空 id/重复 id/空显示名/非正整容量                                                      | 参考 | ⬜   |
| D-58 | 并发与同步   | 每次写入带 `revision`，并发写报 `settings/conflict`；订阅 `settings/document-updated`、`credentials/reference-updated`、`llm/adapters-updated`、`connection/reset` 无需轮询 | 参考 | ⬜   |
| D-59 | 删除与首运行 | 仅当用户层独自携带该行时可删（删后恢复组合基线），确认对话框**指名**提供方；首运行两个有序弹窗（版本化声明 + 条件式凭据步）                                                 | 参考 | ⬜   |

## D-6x 其余可借鉴模块（包名即壳层能力清单）

`ui-approval`（审批）、`ui-tool`（工具卡）、`ui-plan`、`ui-goal`、`ui-workflow-run`、`ui-commands`（命令面板）、`ui-input-trigger`、`ui-reference`（@文件/@会话引用）、`ui-skill`、`ui-subagent`、`ui-schedule`、`ui-jobs`、`ui-model-selection`、`ui-permission-presets`、`ui-user-questions`、`ui-deliverables`、`ui-message-feedback`、`ui-directory-picker-browse` / `-native`、`ui-attachment`、`ui-primitives`、`ui-theme`、`ui-session`、`ui-workspace`、`ui-agent-preset`、`ui-settings` / `-general` / `-plugins` / `-plugin-inventory`。

> 用法：做桌面壳的功能拆分时，以这份包名表作为**模块边界参考**（一个能力一个模块，不要堆进一个巨型组件）。

## D-7x 工程与文档规范（可直接借用）

| ID   | 条目         | 要点                                                                                                            | 等级 | 状态 |
| ---- | ------------ | --------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| D-70 | 每包 README  | 固定小节：概述 / 使用本包 / 理解实现 / 进一步探索 / 模型体验（含 KV Cache 影响）/ 已知限制与延期工作 / 开发备注 | 参考 | ⬜   |
| D-71 | 运行时不变式 | 每包 README 末尾写一行“运行时不变式”（是否发伴生入口、是否持有跳插件可变关系）                                  | 参考 | ⬜   |
| D-72 | 已知限制小节 | 把“故意不做的事”写进文档（与本仓 `➖` 理由同构）                                                                | 参考 | ⬜   |

## 与 harness2 当前实现的差距

| 维度     | harness2 现状（`packages/desktop`）                                           | 目标       |
| -------- | ----------------------------------------------------------------------------- | ---------- |
| 布局     | 自制分屏 + 六页签（`PaneArea.tsx`），无三栅 AppFrame、无 details 栏、无让步链 | D-10～D-17 |
| 组装模型 | 直接组件引用，无 slot 注册表                                                  | D-01～D-04 |
| 侧栏     | `SidePanel.tsx` + `SessionList.tsx`，无 56px 轨道、无工作区席位、无版本徐标   | D-20～D-25 |
| 对话页   | `ChatView.tsx`，无视图环、无乐观提交、无 QueueDock、无 composer 链            | D-30～D-39 |
| 轨迹     | 有 CLI `traj` 与桥接视图，但**无时间概览、无区间筛选、无检查器、无虚拟化**    | D-40～D-47 |
| 模型配置 | 只能手改 `~/.harness2/config.json` + `auth.json`，**无 UI**                   | D-50～D-59 |

## 不采纳清单

| 项                             | 理由                                      |
| ------------------------------ | ----------------------------------------- |
| Cordis 事件系统                | 上游框架选型，我们用现有 store + IPC 即可 |
| `e2b` / 云沙箱包               | 本轮不做云端执行                          |
| `ui-brand-official` / 品牌资产 | DeepSeek 专有品牌                         |
| `python/` `native/` 旁路       | 与壳层无关                                |
| D-17 滞留缺陷                  | 上游自认缺陷，不复刻                      |

## 本轮更新记录

| 日期       | 执行者                | 上游 commit | 变更摘要                                                                                                      |
| ---------- | --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| 2026-09-13 | 编排会话（Notion AI） | `d347e70`   | 首版：建立 D-01～D-72，含 slot 组装、三栅让步链、侧栏、对话页乐观提交、轨迹时间概览、模型配置页校验与凭据模型 |
