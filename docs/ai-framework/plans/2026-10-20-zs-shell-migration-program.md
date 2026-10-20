# ZS 程序总纲：ZCode 壳 + harness2 内心（GUI 架构迁移）

> **状态：** 总纲待用户审（2026-10-20 立项方向经用户两次确认：「要 ZCode 的壳，内心换成我们的」）
> **性质：** 程序级总纲——各阶段（ZS1–ZS6）开工前按 `docs/ai-framework/phase-plan.template.md` 出独立阶段计划（含验收表与交接提示词），本文件只定方向、边界与闸门。
> **元规范：** `docs/ai-framework/phased-plan-driven.md`
> **spike 依据：** `docs/research/2026-10-20-zcode-services-surface-spike.md`（ZS0 ✅ 已完成）

**Goal:** 一句话——桌面 GUI 换成 ZCode 的 UI 壳（外观与交互 100% 还原，含 composer/侧栏/轨迹/设置），后端「内心」全部换成 harness2 core（会话 JSONL 事件日志、审批、工具、记忆、MCP、子代理、cron、provider）。
**Architecture:** ZCode UI 与后端的耦合收敛于 `IServiceAccessor`（约 60 个 service 频道）+ VS Code 式可插拔 RPC；**UI 代码零改动**，在 harness2 侧实现该契约（A 类真实现 / B 类补能力 / C 类空实现+隐藏）。桌面沿用 ZCode 的 main→utilityProcess host→MessagePort→renderer 链路，host 内装配从 `createLocalServices`（ZCode 实现）换成 harness2 适配层。
**Tech Stack:** TypeScript monorepo；ZCode vendored 源码（Apache-2.0）；harness2 `@harness2/core`。
**实施档位：** 全能（默认）· **子代理：** 启用（实施/测试/审查按工作模式派发）。

---

## 0 决策与前提（2026-10-20）

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 方向 | 用户拍板：ZCode 壳 + harness2 内心，外观不变 | 用户 2026-10-20 两次原话确认 |
| **旧壳投入** | **2026-10-20 用户追加指示：「不要管这个了，直接走 ZCode 壳方向」——旧壳全面冻结（不再投入任何修复，含 P0/P1）**。附实测备案：1.0.2 portable 本机可正常启动并稳定运行（5 进程存活 30s+、解包 exe smoke exit 0），用户此前「完全不可用」源于安装版 v1.0.0 已知缺陷 | 用户原话 + 编排者 2026-10-20 实测 |
| **账户体系** | **无账户登录（用户 2026-10-20 指示：「我们不需要账户登录哦，这点和 zcode 有点不同」）**——oauth/订阅/用量升级/登录登出全 C 类隐藏；**壳不得出现任何登录门**（ZCode 未登录收敛 WelcomeScreen 的路径必须绕过，直达主壳空工作区）。ZS1 已按「桩报告已登录·本地身份」实现（`restoreCachedSessionState` 恒 authenticated + `getActiveProvider` 恒 null 防写路径）；上游若出现真实无账户路径则优先切换 | 用户原话 + ZS1 执行记录 Task 3 |
| 法律 | **Apache-2.0**，vendored 代码须保留版权与 LICENSE 声明 | `D:/AI_Projects/refs/ZCode/LICENSE` 实查 |
| 上游锚点 | `3c5b2276`（v3.16.2，2026-10-20 拉取成功） | refs 基线表 |
| 可行性 | 耦合面 = `IServiceAccessor` 单门面 + 频道 + 自动代理；换后端不动 UI | spike §3 |
| 最大工程量 | `IZCodeAgentService` v4 conversation 竖切 + `IZCodeTaskService` task 索引/派发管线 | spike §2/§5 |
| 并行关系 | S1（会话批量清理）走旧壳快速通道；其 core 能力（deleteSession）被 ZS4 复用；Z-50/Z-51 语义在新壳 task 菜单重接线 | S1 计划 |

## 1 目标架构

```text
harness2/
├── packages/core/            # 内心（不动壳职责）：会话/审批/工具/记忆/MCP/子代理/cron/provider —— 冻结纪律不变，新能力走计划授权加性
├── packages/zcode-shell/     # vendored ZCode 源码（ui/desktop/shared/rpc/client/services 类型），Apache-2.0 声明保留，上游 re-sync 脚本登记锚点
├── packages/zcode-adapter/   # ★ 新建：实现 IServiceAccessor——A 类映射 core；B 类补齐；C 类空实现
└── packages/{cli,gateway,web,ui-shared}/  # 迁移期并存；ZS6 决定去留
```

- **桌面链路**：ZCode main（改 branding/数据根目录指向 `~/.harness2`）→ utilityProcess host → host 内 `createHarness2Services()`（zcode-adapter 装配 core）→ MessagePort → renderer（ZCode UI 原样）。
- **数据根**：`getZCodeDataRootDir`/`setDataBaseDir` 适配为 harness2 数据根（`~/.harness2`），会话库沿用 JSONL 事件日志——**内心不迁就壳，壳适配内心**。
- **C 类隐藏**：用 ZCode UI 既有 optional/feature-gate 语义（spike §4：accessor 可选约 20 个 + `supportsSettings` 等开关）真隐藏，红线⑩禁止假入口。

## 2 阶段划分（每阶段独立计划 + 独立验收）

| 阶段 | 内容 | 出口判据（闸门） |
| --- | --- | --- |
| **ZS0** ✅ | spike：services 契约面盘点（本总纲依据） | 报告入库（research/） |
| **ZS1 骨架空跑** | vendored ZCode 壳编译链打通；zcode-adapter 骨架（60 频道注册：C 类空实现、B 类 throw、A 类 TODO）；数据根重定向；启动路径 loading→空态→WelcomeScreen | 新壳进程起、显示 ZCode 空态界面；Root 挂载期 9 个服务（spike §4）stub 返回空数据不崩；零旧壳代码参与 |
| **ZS2 垂直切片** | 一个真实 harness2 会话跑通：`zcodeTaskService.createTask/list/initialize` → core SessionManager；v4 最小竖切（hello/initialize/subscribe）→ core 事件投影；`IFileService` 最小（readdir/stat/readTextFile）；mock provider 一轮对话 | 新壳内完成一轮真实对话（发送→流式渲染→终态）；会话落 `~/.harness2/sessions` JSONL |
| **ZS3 对话区完整** | v4 全竖切（rowsRange 行分页/resync/plans）；`SessionRealtimePort` 审批（respond_permission/respond_elicitation/hook 审阅）→ core approval；工具卡流事件；composer 附件管线（`IPromptAttachmentTransferService`）+ 图片；真实 provider | 审批/工具/长会话分页/断线 resync 全通；composer 全交互（用户此前「输入框难用」在此终结） |
| **ZS4 侧栏与周边** | task 索引/置顶/归档（**接线 Z-50/Z-51 批量语义 + core deleteSession**）；轨迹 `getModelTrajectory` → core trajectory；settings/provider/model selection → core provider+auth；commands/skills/memory/hooks/subagents/automations(cron)/MCP 状态 | 侧栏全功能（含批量归档/物理删除）；设置页可用 |
| **ZS5 观测性与监控卡片** | crashReporter + uncaughtException/unhandledRejection 落盘（`~/.harness2/crash/`）；结构化运行日志（`~/.harness2/logs/`）；启动分段计时；soak/内存曲线采集；**悬浮监控小卡片**（主进程/renderer/host 三进程资源占用 + 日志 tail，快捷键/命令面板开关）——用户 2026-10-20 三项需求内建于此 | 崩溃可归因（复现一次崩溃能拿到报告）；监控卡片可用；soak ≥30min 内存平稳判据 |
| **ZS6 收尾与切换** | C 类隐藏清单执行（feature-gate 逐项核对）；旧 desktop renderer/ui-shared 退役决策（web 壳去留：ZCode web build vs 旧 web）；打包（manual-pack 通道）+ 发版（**major**：架构变更）；上游 re-sync 流程文档化 | 新壳成为唯一桌面入口；红线⑩全量自查；发版授权（人类） |

## 3 Global Constraints（全程序硬线）

1. **UI 代码零改动原则**：vendored ZCode UI 组件不因后端缺口而改交互；后端能力不足时走「隐藏入口」而非「改 UI 降级」。确需改 UI（如品牌词、数据根）须在阶段计划单列并留 diff 清单。
2. **红线⑩（无假入口）**：C 类功能必须真隐藏（feature-gate/optional 语义），空实现不得暴露可点击入口。
3. **core 冻结纪律不变**：zcode-adapter 是 core 的消费方；core 新能力（B 类）走「计划授权 + api-surface 基线同步 + 编排者验收」加性流程；`packages/gateway` 零改动。
4. **Apache-2.0 合规**：vendored 目录保留原 LICENSE/NOTICE 与版权头；re-sync 时不得删除。
5. **旧壳冻结纪律（2026-10-20 用户指示升级）**：旧壳（packages/desktop 现渲染层 + ui-shared 桌面接线）**全面冻结，不再投入任何修复**；迁移期如需临时使用，跑 1.0.2 portable（实测可启动）；新壳尽快到位是唯一目标。
6. 密钥不进 git；默认不 push；破坏性操作（真实会话库写入/删除）需人类授权或走副本。
7. **明确不做**：❌ **账户登录（无账户体系——壳不得出现登录门，见 §0 决策表）**❌ ZCode 云端绑定功能（订阅/闲时/高速卡/OAuth/反馈/运营场景）❌ SSH 远端 source server 体系 ❌ Android/CUA 专有面 ❌ 旧壳大改（全面冻结）。

## 4 风险与对策

| 风险 | 对策 |
| --- | --- |
| v4 conversation 协议面大（B 类最大项） | ZS2 先最小竖切、ZS3 分批补；每批以 ZCode UI 实际调用路径为准（不是全实现协议，是「UI 用到什么实现什么」） |
| 上游漂移（v3.14→3.16 仅两周） | 锚定 `3c5b2276`；re-sync 作为独立小阶段（合入前跑全量闸门）；不追 HEAD |
| ZCode 构建链引入成本（365+501 文件） | ZS1 实测两条路线后定：vendored 源码进仓 vs 源码路径引用（决策记录进 ZS1 计划） |
| 双壳维护成本 | 旧壳冻结（只修 P0/P1）；ZS6 前明确切换日期，避免长期双轨 |
| 事件语义错配（ZCode 流事件 vs core 事件日志词表） | ZS2 起建「事件词表映射表」随阶段扩充；投影层单测覆盖每类事件 |
| 子代理通道故障 | 降级等职能子代理（U1 先例，如实登记） |

## 5 验收与闸门（每阶段通用）

- 六包测试不低于 HANDOFF 当轮基线（新包 zcode-shell/zcode-adapter 各自建立基线）；
- `pnpm -r typecheck` / `pnpm lint` 全绿；
- core `api-surface-baseline.json`：0 removed / 0 kindChanged（加性走流程）；
- 阶段级独立只读审查（CODE_REVIEW.md，P0/P1 修复后复验）；
- 每阶段出口判据（§2 表）由编排者亲验留痕。

## 6 与既有程序/挂账的关系

| 项 | 关系 |
| --- | --- |
| S1 会话批量清理（已批准后改向） | **2026-10-20 用户指示「直接走 ZS」→ S1 整体并入 ZS4**（task 侧栏接线时一并交付 Z-50/Z-51 批量语义 + core `deleteSession`）；S1 计划文档保留作语义与验收依据，不再按旧壳快速通道执行 |
| 观测性/监控卡片/composer 重构（用户 2026-10-20 需求） | 全部并入本程序（ZS3 composer / ZS5 观测性），不再单独立项 |
| U2 发版（v1.0.2 待授权） | 不受影响，独立执行；ZS 完成后的发版为 major |
| refs 文档 | Z-* 条目继续是交互语义权威；本程序实现的是「ZCode 原生壳」，ZS4 接线时按条目核对语义（如 Z-50/Z-51） |
| 旧 Z 程序（Z0–Z7 复刻） | 历史成果保留（ui-shared/web 壳仍在用）；ZS6 时随旧壳一并决策去留 |

---

## 给接手 AI 的说明

本文件为**总纲**，不直接派发。各阶段开工流程：编排者按模板出阶段计划（含 Task/验收表/交接提示词）→ 用户确认 → 派子代理实施 → 独立审查 → 编排者验收。当前待用户：①审本总纲 ②审 S1 计划 ③换 1.0.2 portable 验证崩溃归因。
