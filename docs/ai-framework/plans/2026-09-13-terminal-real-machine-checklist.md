# 真机验收清单（终端 grok 复刻 P1~P4 + 桌面 D-P2）

> **执行人：** 需求方（人工真机） · **记录方式：** 在下表逐项填 ✅/❌ + 现象/截图路径
> **被测代码：** `main` = `66cc7b2`（已推送） · **测试目录：** `D:\AI_Projects\harness2-main`（main 检出，依赖已就绪）
> **目的：** 决定 `HARNESS2_RENDERER=next` 是否切换为默认；确认桌面补丁的用户可见行为

---

## 0. 准备（一次，约 1 分钟）

```powershell
cd D:\AI_Projects\harness2-main
pnpm build
node packages/cli/dist/index.js config check
```

预期：显示 `local openai http://127.0.0.1:40080/v1`、`roles: main -> local/big-pickle`、`keys: local: auth.json`（**已实测 OK**）。
真机建议用 **Windows Terminal**（新渲染器的鼠标/选择/主题在 WT 表现最好）。

---

## A. CLI 快速通（legacy 路径，零 key，3 分钟）

```powershell
node packages/cli/dist/index.js chat --provider mock
```

- [ ] A1 发一条消息 → 有流式回答 + `write`/`read` 工具行
- [ ] A2 `/undo --dry-run` → 预览不执行；`/undo` → 文件被删；`/redo` → 文件恢复
- [ ] A3 `/exit` 正常退出

预期：与既有行为一致（这是旧 Ink/legacy 路径的回归检查）。

---

## B. CLI 新渲染器（核心，逐项打勾）

```powershell
$env:HARNESS2_RENDERER="next"     # Git Bash: export HARNESS2_RENDERER=next
node packages/cli/dist/index.js chat
```

> 真实模型（可选）：不传 `--provider` 即走 `local/big-pickle`（你的 config 已配好）；`--provider mock` 也可先跑通交互。

- [ ] **B1 布局**：输入框贴屏幕最底；状态行/快捷键条在底部；转录在上方占满；**拖动窗口 resize 不溢出**
- [ ] **B2 鼠标**：滚轮滚动转录（跟随/锚定语义正常）；向上滚动后状态提示可回到末尾
- [ ] **B3 选择复制**：鼠标拖动选择文本 → `Ctrl+C`（或 `y`）复制 → 到别处粘贴能粘出内容（OSC52）
- [ ] **B4 超链接**：回答里出现 URL 时高亮可点（Windows Terminal 支持时）；无链接时不应误标
- [ ] **B5 斜杠菜单**：输入 `/` → 候选出现在**输入框上方**；继续打字模糊过滤；`Tab`/`Enter` 接受
- [ ] **B6 审批卡**：触发一次工具审批（真实模型让它写文件）→ 卡片在输入框上方；数字直选 / `Tab` 走行 / `Esc` 把焦点寄放到滚动区（不误答）；拒绝后文件不存在
- [ ] **B7 模式循环**：`Shift+Tab` 循环 Normal→Plan→Auto→Always-approve；底边指示随切换变化；`/mode` 选择器也在输入框上方
- [ ] **B8 折叠/展开**：`e`/`E`、`h`/`l` 折叠与展开；`Ctrl+O` 展开最近工具卡（注意：`Ctrl+O` 现在是 always-approve，按新键位表）
- [ ] **B9 子代理**：让它派个子代理（或说「用子代理查一下 X」）→ 转录出现**子代理块**（状态/耗时）；`v` 打开**全屏子视图**，运行中能看到实时输出；`Esc` 返回
- [ ] **B10 主题/搜索**：`/theme dark`、`/theme light` 切换即时生效；`/search <关键字>` 能命中定位
- [ ] **B11 提示音**：终端**失焦时**发一轮对话，结束时应有响铃/系统提示（默认 unfocused）；`$env:HARNESS2_NOTIFY="always"` 时聚焦也响；`"never"` 时完全不响
- [ ] **B12 性能体感**：长会话滚动流畅、无闪烁；`Ctrl+C` 取消回合正常
- [ ] **B13 回退**：`$env:HARNESS2_RENDERER="legacy"`（或不设）→ 旧界面仍可用；`$env:HARNESS2_INPUT="legacy"` → 输入层回退可用

---

## C. 桌面端（D-P2 补丁，逐项打勾）

```powershell
cd D:\AI_Projects\harness2-main
pnpm --filter @harness2/desktop dev
```

- [ ] **C1 配置写路径**：设置里改模型/审批模式 → 提示「新会话/重启生效」；检查 `C:\Users\ASUS\.harness2\config.json` 真的被写入；**不显示明文密钥**
- [ ] **C2 文件树**：工作区面板能列目录；输入越界路径（如 `..\..`）应被拒（提示而非崩溃）
- [ ] **C3 关窗口**：有任务运行时关窗口 → 出对话框（保持后台/退出）；无任务时关窗行为正常
- [ ] **C4 redo 冲突守卫**：先 undo，再在外部改动文件，然后 redo → 应**阻止**并给出可行动提示（不静默重放）；确认无冲突时 redo 正常
- [ ] **C5 分屏六页签**（P1-1 回归）：新建 2 个会话 → 分屏 → 左右各选一个 → 计划/任务/审批/变更/工作区/配置六页签**都有数据**
- [ ] **C6 断线恢复**（可选）：杀掉 serve 进程 → 桌面应在重连后恢复订阅与快照（不永久 loading）

---

## D. 开关键/回退对照表

| 开关                               | 取值                                    | 作用                                  |
| ---------------------------------- | --------------------------------------- | ------------------------------------- |
| `HARNESS2_RENDERER`                | `next` / 不设                           | 新渲染层 / 旧 Ink                     |
| `HARNESS2_INPUT`                   | `legacy` / 不设                         | 旧输入路径 / 新统一输入层             |
| `HARNESS2_MOUSE`                   | `0`                                     | 关闭鼠标上报（保留解析）              |
| `HARNESS2_SELECT`                  | `0`                                     | 关闭文本选择复制                      |
| `HARNESS2_OSC8`                    | `0`                                     | 关闭超链接                            |
| `HARNESS2_NOTIFY`                  | `always` / `unfocused`（默认）/ `never` | 提醒时机                              |
| `HARNESS2_NOTIFY_METHOD`           | `bel`（默认）/ `osc9`                   | 提醒方式                              |
| `HARNESS2_TUI` / `HARNESS2_NO_TUI` | `1`                                     | 强制开/关 TUI（退回 legacy readline） |

---

## E. 记录表（测试后填写）

| 编号  | 结果（✅/❌） | 现象 / 截图路径 | 备注 |
| ----- | ------------- | --------------- | ---- |
| A1–A3 |               |                 |      |
| B1    |               |                 |      |
| B2    |               |                 |      |
| B3    |               |                 |      |
| B4    |               |                 |      |
| B5    |               |                 |      |
| B6    |               |                 |      |
| B7    |               |                 |      |
| B8    |               |                 |      |
| B9    |               |                 |      |
| B10   |               |                 |      |
| B11   |               |                 |      |
| B12   |               |                 |      |
| B13   |               |                 |      |
| C1    |               |                 |      |
| C2    |               |                 |      |
| C3    |               |                 |      |
| C4    |               |                 |      |
| C5    |               |                 |      |
| C6    |               |                 |      |

**异常记录格式：** 操作步骤 + 命令原文 + 实际现象（截图路径）+ 终端名称/版本（如 Windows Terminal 1.x）。
先按 §D 回退开关恢复可用状态，再记录——不要为了继续测试硬扛。

**测完把这张表发我：** 我据此更新验收表、判定「产品缺陷 vs 环境问题」，然后清理已合并分支、并决定是否把 `HARNESS2_RENDERER=next` 切为默认。
