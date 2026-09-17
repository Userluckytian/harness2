# hermes 桌面壳的 7 条不变量（中文提要）

> **用途：** R2「换壳」阶段的契约底本。本文是提要，**不是权威源**；有冲突以同目录下的 `AGENTS.md`（架构/状态/传输/测试）与 `DESIGN.md`（视觉/交互契约）原文为准。
>
> **出处：** [NousResearch/Hermes-Agent](https://github.com/NousResearch/Hermes-Agent) 的 `apps/desktop/`，基线 commit `79445a4`。许可：**MIT**（全文见同目录 `LICENSE`）。本目录下的 `AGENTS.md` / `DESIGN.md` 为**逆向参考用的原文副本**，未修改。
>
> **使用约束：** 搜“契约与主题”，**不搜代码**。hermes 桌面是 React + Tailwind + Radix + assistant-ui + nanostores 技术栈，1864 文件/~15MB；harness2 桌面是 106 文件/593KB。**照搬骨架不现实也不必要**，要搬的是下面这些“为什么”。

---

## 一、架构不变量（来自 `AGENTS.md`）

### 1. 三方权威分立

Electron 主进程管**机器**（进程、窗口、文件系统、凭据），renderer 管**体验**， agent backend 管**工作**。一个关心只能有一个东家；跨层做决定就是 bug。

> **对 harness2 的直接含义：** 我们已经违反了。`bridge.ts` 把 48 条命令（含 27 条纯本地操作）全汇入同一个 IPC 通道，并在 switch 前统一取 serve 的 `baseUrl` ⇒ 「机器关心」被「工作关心」的就绪状态绑架（即 D-a）。拆连坐不只是修 bug，是回归这条不变量。

### 2. 状态按权威归属，持久化必须声明 scope

每个持久化 key 都要明确它活在哪个作用域：`global` / `connection` / `profile` / `session` / `project` / `window`。没声明 scope 的持久化会在切换连接或项目时泄漏到错误上下文。

> harness2 现状：`~/.harness2/desktop-layout.json`、`desktop-metadata.json`、`desktop-drafts.json`、`desktop-preferences.json` 四个文件**均为隐含 global**，无 scope 概念。多项目/多窗口一旦做起来就会撞车。

### 3. 身份不可混用

三种身份必须分开：**durable identity**（持久实体 id）、**runtime identity**（本次运行的实例）、**lineage root**（fork/派生的源头）。用一个 id 冒充三种，在 fork / resume / 重连三个场景必崩。

> harness2 有 `fork` 与 append-only + rewind 标记，这条直接关系到轨迹回放的正确性，R2 换壳时不得把三者拍扁成一个 `sessionId`。

### 4. server truth 是缓存，不是所有权

服务端下发的状态按六条规矩合并：

1. merge，不 clobber（不用整包覆盖本地）
2. 乐观更新后要**诚实回滚**（失败要看得见）
3. generation counter 防乱序
4. 只有前台可以发布
5. 噪声合批，但**终态立即送达**
6. no-op 保持引用同一性（避免无意义重渲染）

### 5. 切上下文是 re-home，不是 reboot

切连接/项目/profile 时，软 re-home 必须**显式 wipe 那些绑定到 gateway 的 store**；runtime home 变更才做硬 re-home；live profile swap 是合并而非清空。不允许用「全局重启」掊平这个问题。

### 6. 可观测降级阶梯

降级要分级且可见，不是「要么好要么坏」。五种状态各自有**文案与出口**：`empty` / `loading` / `reconnecting` / `degraded` / `exhausted`。

> 对应 harness2 红线 10「UI 不得显示假状态」。我们现在 `steeringAvailable` 恒 true（D-c）、serve 未就绪时弹错而不是进 connecting 态（D-a）——两条都是这条的反例。

### 7. 能力面窄腰，边缘生长

核心保持窄腰，新能力优先长在边缘。hermes 把这条固化为 **Footprint Ladder 六级**，按顺序优先：

扩展现有代码 → CLI command + skill → service-gated tool（`check_fn`）→ plugin → MCP server → **新增 core tool（最后手段）**

配套拆分阈值：文件 >~2000 行 / 函数 >~300 行 / 圈复杂度 30；**禁用 ≥4 分支的 if/elif 名称派发**。

> 直接可用于 harness2：`packages/cli/src/tui/next/next-shell.ts` 已 **236KB**，`bridge.ts` 的 48 分支 switch 正是被禁的名称派发形态。

### 附：auth 两条推论

- 一次性凭据**永不复用**；只有 401/403 算「需重新认证」，其余错误不得清凭据。
- 连接测试**必须走真实要用的那条腿**（不允许用 `/models` 的 200 冲抵 `/chat/completions` 的可用性）。

> **本轮实例印证：** 本地 40080 网关 `/v1/models` = 200 而 `/v1/chat/completions` = 502。若按「能列模型就算连通」判定，桌面会显示「已连接」而实际一发就挂——正是这条要防的。harness2 的 `waitForHealth` 曾有同类 bug（修前 `res.status > 0` 把 401 当健康），已修，但模型可用性这一层仍未探测。

---

## 二、设计契约要点（来自 `DESIGN.md`）

总纲一句话：**一个关心一个来源，token 优于字面值，扁平优于嵌套盒子。**

### 七条原则（持久，不随组件生灭）

1. **扁平而非盒套盒**—— 无 card-in-card，面板内不用分割边框，用留白 + 单条发丝线分组
2. **浮层用无框浮雕**—— `shadow-nous` + `--stroke-nous` 发丝线，不用厚框
3. **一个关心一个原件**—— 一个 `Button`、一个 `SearchField`、一个 `Loader`、一个 `ErrorState`；迁移而不分叉
4. **用 token 不用字面值**—— 组件里禁现 hex / 临时 rgba，只引 CSS 变量
5. **样式住在原件里**—— 调用方传 `variant`/`size`，**不传** `h-*`/`px-*`/`className` 覆盖
6. **意图先于自动化**—— 不因为工具刚好产出了东西就开面板、移焦点、跳路由
7. **即时反馈**—— 直接操作先画，持久化随后对账，失败**可见回滚**

### 信息架构

- **对话是主页面**；工具/预览/文件/审阅/终端都是补充，不抢主位
- **路由浮层是短任务**（设置、命令中心、cron……），关闭即回上一路由，**不是导航栈**
- **一个动作一个家**：快捷键/命令面板/可见按钮可以有三个入口，但必须调同一个动作与状态
- **导航必须保住上下文**：后台会话完成、工具结果到达只能更新角标与缓存，**不得替换前台对话或抢焦点**

### 状态与反馈（直接对应我们的红线 10）

- **Loading**：统一 `Loader`，**永不出现字面的“Loading…”**
- **Error**：统一 `ErrorState` + `ErrorIcon`，React 边界/弹窗内/启动失败横幅共用一套观感
- **Empty**：`EmptyState`（页面）/ `PanelEmpty`（浮层主次栏），不手搓第三种居中空态
- **确认**：`ConfirmDialog` 是唯一的“你确定吗”，焦点默认落在 Confirm（Enter 确认 / Esc 取消），它自己拥有 pending → done → close 节奏与内联错误。**禁用 `window.confirm`**
- **日志**：统一 `LogView`（无背景、发丝线边框、小号等宽）

### 性能与直接操作

- 热路径状态**就近**，不订阅重树；指针事件按帧合并
- **昂贵的有状态面隐藏但不卸载**——可见性不等于生命周期
- 不用 `transition-all` 动几何；动画跟随状态，**永不延迟状态**
- **用真实负载证明速度**：空状态 demo 跑得快说明不了任何问题

> 直接转化为 R2 验收项：长会话 1000+ 消息下 60fps profile。

### 键盘与取消

- **键盘所有权跟随焦点**；shell 快捷键不得抢终端/编辑器的绑定
- 全局快捷键走共享层注册，不挂 ad-hoc 监听
- **一个取消手势只做一件事**：要么取消当前交互，要么关最上层可关闭面；绝不同时做两件，也绝不穿透到下层控件
- **UI 层的取消是同步的**，哪怕清理是异步的

### z-index 梯子（不允许字面值）

`--z-modal-backdrop` → `--z-modal` → `--z-modal-popover` → `--z-over-modal`（toast/tooltip）→ `--z-over-modal-content` → `--z-switcher-backdrop` / `--z-switcher` → 启动链 `--z-connecting` → `--z-onboarding` → `--z-setup` → `--z-crash`。

组件**内部**堆叠用 `z-10`/`z-20` 仍然正当。

### 可直接搬的测试思路

- **测会弄坏用户的行为，而不是测快照**；seam（缝）必测
- 典范例：`no-native-title.test.ts` —— 用一条**静态约束测试**禁止任何 `<Button>` 带原生 `title=`。这类“契约守卫测试”成本极低、回归拦截率极高，**R2 应成建制引入**

---

## 三、对 R2 的落地建议（本提要的结论）

| 搬什么 | 怎么搬 | 为何 |
| --- | --- | --- |
| 上述 7 条架构不变量 | 写成 harness2 自己的 `packages/desktop/AGENTS.md`（R2-1「立宪」） | 契约无技术栈依赖，**直接适用** |
| token 化 + 一关心一原件 + 五态文案 | 重写骨架时落实 | 这是壳质量的地基，不是装饰 |
| z-index 梯子、取消语义、键盘所有权 | 逐条抄成验收清单 | 都是“不做就会痛”的隐形规则 |
| 具体组件实现、Tailwind/Radix/nanostores 技术选型 | **不搬** | 我们不跟它同栈，搬了只会得到一层半成品适配层 |
| `BrandMark` / `nous-girl` 等品牌资产 | **绝不搬** | MIT 许可不覆盖商标；且我们需要自己的身份 |

**最后一句提醒：** 这份文档最大的价值不是“hermes 长得好看”，而是它把「哪些东西一旦做错就会系统性地痛」写成了可检查的条文。harness2 桌面当前的 D-a / D-c 两条阻塞缺陷，分别命中了其中的第 1 条与第 6 条——**这本身就是这份契约值得搬的证据。**
