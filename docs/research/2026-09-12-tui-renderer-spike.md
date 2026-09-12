# TUI 渲染层选型 Spike 报告（P0）

> **日期：** 2026-09-12 · **分支：** `feat/tui-p0-renderer-spike`（基于 main 58fe6fe）· **状态：** ✅ 已定案（2026-09-12 需求方拍板：采纳推荐 **方案 B 自研最小渲染层**；独立审查 ⚠️→P1-1 已修复）
> **对应施工单：** `docs/ai-framework/plans/2026-09-12-terminal-grok-parity-execution.md` §2（T0-1~~T0-7）
> **demo 与原始数据：** `spike/tui-renderer-spike/`（**不并入主线**，仅本目录与本报告进入分支）
> **环境登记（T0-1）：** Windows 10.0.26200 x64 · Node v22.23.1 · pnpm 11.13.0 · cargo/rustc 1.97.1 · Windows Terminal 已安装（真机项见 §6）· 数据 `common/transcript-10k.txt`（四方案同一份：10000 行，60% ASCII / 20% CJK / 10% emoji / 10% 200~~400 字符长行）

---

## 0. 结论（TL;DR）

**推荐方案 B（Node 自研最小渲染层，业务层保留 React 可选）**；**回退方案 A（继续 Ink，现链路保留为回退开关）**。

- **A（Ink）未过性能门槛**：虚拟化滚动 p95 **44.79ms > 33ms**（30fps 节流硬顶 `ink.js` maxFps??30），且鼠标协议零支持（只能靠 stdin 拦截 hack）、无文本选择/图片能力、默认每帧整帧重写——达不到 C 档复刻目标，但作为回退链路保留。
- **B（自研）headless 指标全部通过（真机项见 §6，P2 开工前确认）**：滚动 p95 **0.086ms**（≈380 倍余量）、回显 p95 0.084ms、CJK 断行自检通过、纯 TS 零原生依赖、esbuild 单文件 bundle 实测 8.2KB 成功。代价是生产化工程量（估 16~26 人日，落在 P2+P3 预算内）。
- **C（OpenTUI）未过平台门槛**：**Node 22 不可运行**（原生 FFI 需 `node:ffi`（Node≥26）或 `bun:ffi`；engines=`node>=26.4.0, bun>=1.3.0`，实测 Node 22.23.1 报 `Failed to initialize OpenTUI render library`）。Bun 1.4.2 下其余全达标（滚动 p95 17.99ms、MIT、20MB、Windows 预编译 DLL 免编译）——**仅当需求方接受捆绑 Bun 运行时或升 Node≥26 才可复活**。
- **D（Rust）性能与许可达标，组织成本最高**：p95 0.204ms、ratatui/crossterm 均 MIT；但引入第二语言 + 三平台交叉编译产物分发 + 新 IPC 协议面。按总览 §4 定位，除非 B 生产化受阻，否则不选。

> 按 §7.3 边界：本阶段零改动 `packages/**`；`git diff --name-only main..HEAD` 全部落在 `docs/**` 与 `spike/**`（其中 `docs/ai-framework/plans/…program.md` 仅为 main 遗留格式问题的 Prettier 修复提交 f1c4c11）。

---

## 1. 决策矩阵（1~5 分，5 优）

| 维度（权重）                              | A Ink           | B 自研              | C OpenTUI                   | D Rust                  |
| ----------------------------------------- | --------------- | ------------------- | --------------------------- | ----------------------- |
| 10k 行滚动性能 p95<33ms（×3）             | 2（44.79ms）    | 5（0.086ms）        | 4（17.99ms）                | 5（0.204ms）            |
| 输入回显 <30ms（×2）                      | 2（p95 34.5ms） | 5（0.084ms）        | 4（≈17ms）                  | 5（<1ms）               |
| 鼠标/选择/图片能力上限（×3）              | 1（hack）       | 5（全自控）         | 5（API 齐全）               | 5（ratatui 同栈 grok）  |
| Node≥22 可运行（×3）                      | 5               | 5                   | **1（需 Bun≥1.3/Node≥26）** | N/A→2（独立运行时）     |
| 打包（npm + desktop 单文件 bundle）（×2） | 5（现状）       | 5（8.2KB 实测）     | 2（DLL 需额外分发+Bun）     | 2（需 exe 分发通道）    |
| CJK/resize/退出恢复（×2）                 | 4（生态内建）   | 4（自研已验证基础） | 5（原生测量）               | 5（unicode-width 内建） |
| 许可宽松（×2）                            | 5（MIT）        | 5（零依赖）         | 5（MIT）                    | 5（MIT）                |
| 工程成本（P2~P3 预算内）（×2）            | 5（≈0）         | 3（16~26 人日）     | 3（迁移+运行时改造）        | 1（双语言+IPC）         |
| **加权合计（满分 95）**                   | **66**          | **89**              | **68**                      | **72**                  |

---

## 2. 原始数据（各方案摘录；完整见各自 results.md）

### A：Ink（`spike/tui-renderer-spike/ink/results.md`）

| 指标                   | 实测                                                                              | 门槛       | 判定         |
| ---------------------- | --------------------------------------------------------------------------------- | ---------- | ------------ |
| 虚拟化 10k 初始渲染    | 46.3ms（reactRender 14.3ms）                                                      | —          | ✅           |
| 非虚拟化 10k 初始渲染  | 2341ms / RSS 550MB                                                                | —          | ❌（不可用） |
| 虚拟化滚动 2000 步     | **p95 44.79ms**（rerender CPU p95 仅 11.34ms，瓶颈=30fps 节流排队）               | <33ms      | ❌           |
| 输入回显               | p50 33.44ms / p95 34.46ms                                                         | <30ms      | ❌           |
| RSS（滚动后）          | 89→205MB                                                                          | 无持续暴涨 | 🟡           |
| 鼠标协议               | 零支持；`[<64;10;5M` 被 useInput 当字面文本流入输入行（demo-selftest 帧日志为证） | 需原生     | ❌           |
| 文本选择/复制/内联图片 | 无内置能力                                                                        | C 档需要   | ❌           |

复跑：`node spike/tui-renderer-spike/ink/bench.mjs`、`node spike/tui-renderer-spike/ink/demo-selftest.mjs`（7 项断言 PASS）、`node spike/tui-renderer-spike/ink/demo.mjs`（真机）。

### B：自研（`spike/tui-renderer-spike/selfdraw/results.md`）

| 指标               | 实测                                                                    | 门槛             | 判定              |
| ------------------ | ----------------------------------------------------------------------- | ---------------- | ----------------- |
| 冷启动→首帧        | 101.8ms                                                                 | —                | ✅                |
| 10k 行宽字符断行   | 15.5ms（CJK 行 p95 0.003ms；19570 物理行，自检「不切半边」PASS）        | —                | ✅                |
| 滚轮差量帧 2000 次 | **avg 0.070ms / p95 0.086ms**；每帧输出 4.4KB                           | <33ms            | ✅（≈380 倍余量） |
| 整页翻页 p95       | 0.073ms                                                                 | <33ms            | ✅                |
| 输入回显 p95       | 0.084ms                                                                 | <30ms            | ✅                |
| RSS                | 基线 48.6 → 结束 125.4MB（无持续增长）                                  | 滚动 5 分钟 <20% | ✅                |
| 退出恢复           | 自检输出尾部 `?1006l ?1000l ?25h ?1049l`（关鼠标/显光标/退 alt-screen） | 必须恢复         | ✅                |

复跑：`node spike/tui-renderer-spike/selfdraw/bench.mjs`、`node spike/tui-renderer-spike/selfdraw/demo-selftest.mjs`（PASS）、`node spike/tui-renderer-spike/selfdraw/demo.mjs`（真机）。
**成本评估**：spike 核心（cell buffer + diff 刷新 + 滚动模型，~700 行零依赖）≈1 人日已验证可行；生产化（IME/焦点/粘贴/主题/组件层/终端兼容矩阵）估 **16~26 人日**；固有风险=终端兼容矩阵测试与 alt-screen 下选择/IME 的取舍。

### C：OpenTUI（`spike/tui-renderer-spike/opentui/results.md`）

| 项                                        | 实测                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node 22.23.1                              | ❌ `import('node:ffi')` → `ERR_UNKNOWN_BUILTIN_MODULE`；初始化报 `Failed to initialize OpenTUI render library: OpenTUI native FFI is not available for this runtime yet`；engines=`node>=26.4.0, bun>=1.3.0` |
| Bun 1.4.2（npm i -D bun 即得）+ win32-x64 | ✅ 10k 初始渲染 261.4ms；滚动 p95 **17.99ms**（内部 averageFrameTime 3.32ms）；回显 17.45ms；RSS 245~263MB                                                                                                   |
| 安装                                      | npm i 成功（20 包 3s，仅 EBADENGINE 警告）；@opentui/* 合计 20MB（含 win32 平台包 6.2MB 内 `opentui.dll` 6.4MB，免编译）；tarball 2.2MB                                                                      |
| 许可                                      | MIT（含 DLL 内静态链接 libwebp/lcms2/ghostty/stb/wuffs，随包附 LICENSE，无 GPL）                                                                                                                             |
| 能力（headless）                          | CJK 原生宽度正确（「中中中文」=8 列）；鼠标 7 类事件；selection/剪贴板/Image/Kitty 图片 API 齐全；`destroy()` 实测完整恢复终端序列                                                                           |
| 待真机                                    | 滚轮/键盘观感、拖选复制端到端、WT 下 resize 与图片协议                                                                                                                                                       |

复跑：`cd spike/tui-renderer-spike/opentui && npm i && npx bun bench.mjs`（`SPIKE_SCROLL_FRAMES` 可调）、`npx bun capabilities.mjs`、`npx bun demo.tsx`（真机）。

### D：Rust ratatui（`spike/tui-renderer-spike/rust/results.md`）

| 项                         | 实测                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 构建                       | `cargo add ratatui crossterm` 锁 182 包；crates.io 网络两次超时中断、第三次成功；release 编译 29.12s；二进制 2.2MB；target 150MB |
| 压测（TestBackend 120x40） | 初始 0.504ms；滚动 2000 帧 **p95 0.204ms**；idle diff 帧 p95 0.122ms（差量刷新生效）；exit 0                                     |
| 许可                       | ratatui 0.30.2 / crossterm 0.29.0 均 MIT；182 包中非宽松仅 `terminfo: WTFPL`（宽松，非传染）                                     |
| 组织成本                   | 第二语言 + 三平台交叉编译 CI + extraResources 分发 exe + 经 core serve（HTTP/WS）的新 IPC 协议面                                 |

复跑：`cd spike/tui-renderer-spike/rust && cargo build --release && ./target/release/tui-spike-d.exe --bench`；真机 `./target/release/tui-spike-d.exe`。

---

## 3. 打包验证（T0-6）

desktop 现链路（已核实）：`dist:win/mac/linux` → `pnpm --filter harness2 bundle`（esbuild 单文件 `dist-bundle/harness2-cli.cjs`）→ electron-builder `extraResources` 随包分发，`ELECTRON_RUN_AS_NODE` 运行，无 node_modules。

| 方案 | 兼容性结论                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | ✅ 即现状（ink/react 纯 JS，已被该链路 bundle）                                                                                                   |
| B    | ✅ **实测**：`npx esbuild spike/tui-renderer-spike/selfdraw/renderer.mjs --bundle --platform=node --format=cjs` → 8.2KB 单文件成功（Done in 6ms） |
| C    | ⚠️ 原生 `opentui.dll` 无法内联进单文件 cjs → 需改为「平台包随 extraResources 分发 + 运行时路径解析」；且需捆绑 Bun 运行时或升 Node≥26，链路改动大 |
| D    | ⚠️ 需新增「Rust 二进制 extraResources 分发 + CI 三平台交叉编译」通道（electron-builder 支持，但为新增维护面）                                     |

---

## 4. 通过门槛逐条判定（总览 §4.2，四方案）

| 门槛                                    | A                                     | B                                         | C                         | D                      |
| --------------------------------------- | ------------------------------------- | ----------------------------------------- | ------------------------- | ---------------------- |
| ① Node≥22 + Windows 真机鼠标/选择/IME   | 🟡 Node✅；鼠标 hack；选择/IME 不可用 | 🟡 Node✅；鼠标/IME 基础已验证，选择待 P4 | ❌ Node 22 不可运行       | N/A（独立运行时）      |
| ② 10k 行性能                            | ❌ p95 44.79ms                        | ✅ p95 0.086ms                            | ✅ p95 17.99ms            | ✅ p95 0.204ms         |
| ③ npm 安装 + desktop 单文件 bundle 兼容 | ✅                                    | ✅（实测 8.2KB）                          | ⚠️ DLL+Bun 需改链路       | ⚠️ 需 exe 分发通道     |
| ④ CJK/resize/退出恢复                   | ✅（生态内建）                        | ✅（自检通过，resize 待真机）             | ✅（原生，resize 待真机） | ✅（框架内建，待真机） |
| ⑤ 宽松许可                              | ✅ MIT                                | ✅ 零依赖                                 | ✅ MIT                    | ✅ MIT                 |

**缺一不可口径下的结论：A②不达标、C①不达标 → 出局；B、D 为「headless 项全过 + 真机项挂账」（真机项见 §6，P2 开工前确认）。** 结合组织成本与「结构同构（core serve + TS 前端）」现状，**推荐 B**。

---

## 5. 建议与对 P1~P4 的影响

**推荐：B（自研最小渲染层）。** 决策依据：唯一同时通过性能、平台、打包、许可四门槛且不引入新运行时/语言的方案；渲染核心已被 spike 证明便宜（1 人日），成本集中在生态面（IME/焦点/粘贴/选择/组件层），属可控工程量而非技术不确定性。

- **P1（输入层）不变**：统一输入解析与渲染引擎无关，按施工单继续；B 路线下它直接服务新渲染层。
- **P2（渲染与布局）细化**：10~20 人日维持；里程碑建议 ①cell buffer/diff/alt-screen 生命周期 → ②分层布局+scrollback pane → ③Composer/浮层锚定 → ④快照与 bench 脚本。`bench-tui.mjs` 口径直接复用 spike 协议（同一份数据与指标）。
- **P3（功能对齐）不变**：B 的全控渲染面解除 Ink 天花板，鼠标命中/悬停/滚动条等项按 §3 表推进。
- **P4**：文本选择/图片在 B 路线下为自研（预算内），OpenTUI 的 API 设计可作参考（MIT）。
- **回退开关**：P2 期间保留现有 Ink 链路为回退（环境变量切换），直到新渲染层真机验收通过。

**备选：** 若需求方接受捆绑 Bun 或升 Node≥26，C 的能力上限与开发效率最优（flexbox/内建组件/图片），可重开评审；若团队愿承担双语言与 IPC 维护，D 与 grok 同栈保真度最高。

---

## 6. 待真机项（需求方/编排者确认，Windows Terminal）

1. B demo：滚轮/键盘滚动观感、resize、中文 IME 输入、粘贴、Ctrl+C 退出后终端恢复（`node spike/tui-renderer-spike/selfdraw/demo.mjs`）。
2. C demo（若评审考虑复活）：`npx bun demo.tsx` 拖选复制端到端、WT 图片协议。
3. D demo：`./target/release/tui-spike-d.exe` 滚轮/resize 观感。
4. A 现状：滚轮 hack 与 30fps 节流的体感确认（对照性能数据）。

## 7. 未决/风险

- B 的终端兼容矩阵（ConHost/VSCode 终端/旧 WT 版本）未测，生产化阶段需清单化。
- B 在 alt-screen 下「鼠标选择复制」与「应用内交互」的取舍需 P2 定案（grok 为自绘实现）。
- C 的 EBADENGINE 仅为 npm 警告，但 engines 与本项目 `node>=22` 的冲突是硬约束，非警告级。
