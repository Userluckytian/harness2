# 方案 A：Ink 基线（spike/tui-renderer-spike/ink）

日期：2026-09-12 · 执行：实施子代理 · 环境：Windows 10.0.26200 x64，Windows Terminal，Git Bash，Node v22.23.1，npm 10.9.8

## 0. 版本与体积

同主版本安装（`packages/cli/package.json`：ink ^7.1.1 / react ^19.2.8）：

```
$ npm install ink@^7.1.1 react@^19.2.8
added 38 packages in 6s
$ npm ls ink react --depth=0
├── ink@7.1.1
└── react@19.3.0
$ du -sh node_modules node_modules/ink node_modules/react
19M      node_modules
925K     node_modules/ink
239K     node_modules/react
```

## 1. 复跑命令

```bash
cd spike/tui-renderer-spike/ink
npm install ink@^7.1.1 react@^19.2.8
node bench.mjs            # 全部性能阶段（每阶段独立子进程）
node worker.mjs init-10k  # 单独跑非虚拟化 10k
node demo-selftest.mjs    # demo 逻辑自检（非 TTY 可跑，7 项 PASS）
node demo.mjs             # 真机 demo（需真终端，人工复跑）
```

## 2. 基准结果（node bench.mjs 原始输出）

```
[ok] 冷启动（子进程 spawn→import→首帧）: {"mode":"cold","rssDataMB":55.3,"importInkMs":270.4,"firstFrameMs":150.7,"totalMs":463.2}
[ok] 非虚拟化 10k 行初始渲染: {"mode":"init-10k","rssDataMB":55,"wallToFirstWriteMs":2372.7,"reactRenderTimeMs":1584.9,"rssAfterInitMB":550.4,"stdoutBytesFirstFrame":1632631}
[ok] 虚拟化窗口初始渲染（viewport±10 缓冲）: {"mode":"init-vp","rssDataMB":54.9,"wallToFirstWriteMs":45.9,"reactRenderTimeMs":14.3,"rssAfterInitMB":89.5,"stdoutBytesFirstFrame":5784}
[ok] 虚拟化滚动 2000 步（每步 3 行）: {"mode":"scroll","rssDataMB":55,"steps":2000,"frameLatency":{"n":2000,"avg":26.24,"p50":39.66,"p95":44.71,"max":49.26},"rerenderCpu":{"n":2000,"avg":5.78,"p50":6.07,"p95":11.24,"max":16.35},"rssAfterScrollMB":202.3,"stdoutTotalBytes":15084760,"note":"rerenderCpu 只含 rerender() 同步调用；ink 30fps 节流的排队等待包含在 frameLatency 里"}
[ok] 输入回显延迟 120 样本: {"mode":"echo","rssDataMB":55.1,"samples":120,"echoLatency":{"n":120,"avg":17.49,"p50":33.49,"p95":34.46,"max":34.7},"rssMB":96.8,"note":"延迟含 ink 30fps 节流的尾沿排队；useInput→setState→重渲→落写全链路"}
```

### 指标对齐统一协议

| 指标                                           | 数值                                                          | 门槛     | 判定                         |
| ---------------------------------------------- | ------------------------------------------------------------- | -------- | ---------------------------- |
| 冷启动（spawn→import→首帧，含 node bootstrap） | **524ms**（wall），其中 import ink 270ms、首帧 write 151ms    | —        | 记录值                       |
| 10k 初始渲染（虚拟化，现产思路）               | **46ms** 到首帧（React 渲染 14ms）                            | —        | 通过                         |
| 10k 初始渲染（非虚拟化）                       | **2373ms**，RSS **550MB**，首帧输出 1.6MB                     | —        | 不可用（启动与内存双重超支） |
| 滚动帧耗（2000 步 × 3 行）                     | avg **26.2ms** / **p95 44.7ms**（rerender CPU p95 仅 11.2ms） | p95<33ms | **不达标**                   |
| 输入回显延迟（120 样本）                       | p50 **33.5ms** / p95 **34.5ms**                               | <30ms    | **不达标（边缘）**           |
| 常驻 RSS                                       | 虚拟化初始 **89MB**；滚动 2000 步后 **202MB**；echo 后 97MB   | —        | 记录值（滚动后增长 ~110MB）  |

### 口径与方法（如实写明）

- stdout 为 `NullStdout`（丢弃字节、记录写入时间戳/字节数）。「落写」= ink 向 stdout 发起 write，**不含真实终端刷屏耗时**；真实终端复跑用 `demo.mjs` 人工验证。
- `frameLatency` = `rerender()` 调用 → 下一笔 stdout write 之间的 wall time，**包含 ink 默认 30fps 节流（leading+trailing throttle，33ms 周期）的排队等待**；`rerenderCpu` 只含同步 React reconcile+布局，不含节流。
- 虚拟化窗口：viewport 28 行 ± 10 行缓冲，`lines.slice()` 切片渲染（模拟 `TranscriptView`/`computeViewport` 的思路）。
- 回显：`FakeStdin.push()` 注入字节 → `useInput` → setState → 重渲 → write 的全链路。
- **滚动 p95 超标的直接原因不是渲染太慢，而是 ink 的 30fps 节流设计**：任何两次落写间隔被强制 ≥33ms，再叠加调度抖动即 40~49ms。`rerenderCpu` p95=11.2ms 说明有降节流（`maxFps` 调高）的空间，但随之而来的是整帧重写字节数与 React 全量 reconcile 成本线性上升（未实测更高 maxFps，如实登记为未做项）。
- 滚动期间 stdout 累计输出 **15.1MB / 2000 帧 ≈ 7.5KB/帧**——默认模式每帧整帧重写（见 §3 第 6 条），虚拟化只能限制行数、不能避免整帧重写。

## 3. 能力边界表（A 方案核心产出）

依据：ink@7.1.1 源码（`node_modules/ink/build/`，行号对应本目录安装版本）+ 本目录实验（`demo-selftest.mjs`）。

| 能力                     | 结论                                                                                                                                                                                                                         | 依据 / 实验                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **文本选择与复制**       | **部分可用（默认模式）**：非 alt-screen 下输出留在正常 scrollback，终端原生选择可用；但每次重渲对变化区域「擦除+重写」，正在选择的内容被抹掉即选择丢失。alt-screen 模式下无 scrollback，选择复制基本不可用。无程序化选择 API | `log-update.js` `createStandard.render`：`eraseLines(previousLineCount) + str` 整帧重写；`ink.js` `setAlternateScreen`（`options.alternateScreen`）                                                                           |
| **鼠标点击命中/拖动**    | **不支持**：ink 输入层无任何鼠标解析；命中测试需自算 yoga 布局坐标，无 hit-test API。点击/拖拽事件即使自建桥接到应用层，也要自己做「坐标→组件」映射                                                                          | `grep mouse\|1000\|1006\|wheel` 于 `input-parser.js`/`parse-keypress.js`/`App.js` 均无结果；实验：`demo-selftest.mjs` 证明 `useInput` 收到 `[<64;10;5M` 字面文本（ESC 被吞）；packages/cli `parseSgrMouse` 点击/拖拽返回 null |
| **SGR 鼠标协议支持方式** | **必须自建 stdin 拦截桥**：在 `render()` 之前对 stdin 注册 `'readable'`（依赖注册顺序先于 ink 读取），剥出鼠标序列、其余字节 `unshift()` 回流。这是 hack，不是 ink 提供的能力；ink 7 无官方 mouse API                        | 本目录 `demo.mjs` `attachWheelBridge`（packages/cli `terminal-events.ts` 同思路）；实验证据同上                                                                                                                               |
| **平滑/逐帧滚动**        | **硬天花板：默认 30fps**。`maxFps ?? 30` → 33ms 节流周期，滚动帧率被锁死且两次落写间隔 ≥33ms；实测 flush p95 44.7ms 超 33ms 门槛。可调 `maxFps` 但代价见 §2                                                                  | `ink.js` 构造器：`const maxFps = options.maxFps ?? 30; throttle(this.onRender, renderThrottleMs, {leading, trailing})`                                                                                                        |
| **内联图片**             | **不支持（无内置）**：可向 stdout 手写 iTerm2/kitty OSC 序列，但 ink 把屏幕当「文本行集合」管理（按行擦除/重写），图片不占行高，任何重绘都会破坏图片区域。未做真终端图片实验，此条为源码推断                                 | `log-update.js` 行级管理模型；`render.d.ts` 无任何 image 选项                                                                                                                                                                 |
| **CJK 宽字符**           | **内置支持（良好）**：`string-width` 测量对齐、`wrap-ansi` + `widest-line` 折行，yoga 布局用同一测量。emoji 由 string-width 处理                                                                                             | `output.js:173`（stringWidth 对齐）、`ink.js:11`/`wrap-text.js:1`/`measure-text.js:1`（wrap-ansi/widest-line）                                                                                                                |
| **全屏重绘行为**         | **默认每帧整帧重写**（光标回退 + eraseLines(n) + 全部行 + 同步序列）。setState → 重渲 → 整帧字符串重建 → 整帧 write。可选 `incrementalRendering: true`（默认 false）做**行级** diff（跳过相同行），仍无 cell 级粒度          | `log-update.js` `createStandard`（整帧）vs `createIncremental`（行级 diff）；`render.js:17` `incrementalRendering: false`                                                                                                     |
| **alt-screen 进出恢复**  | **ink 7 内置** `options.alternateScreen`，进出与恢复由 ink 管理（本仓库现状未启用）                                                                                                                                          | `render.js:19`、`ink.js:256,699`                                                                                                                                                                                              |
| **resize**               | **内置**：监听 stdout `'resize'`，宽度变小时 clear + 全量重绘                                                                                                                                                                | `ink.js` `resized()`                                                                                                                                                                                                          |
| **异常退出恢复**         | **尽力而为**：signal-exit 注册 unmount（SIGINT/SIGHUP/exit 时清屏恢复）；SIGKILL/硬崩溃无法恢复（任何方案相同）                                                                                                              | `ink.js` 构造器 `signalExit(this.unmount)`                                                                                                                                                                                    |
| **键盘输入/粘贴/焦点**   | 内置：useInput（parse-keypress）、bracketed paste、focus 事件（DECSET 1004）、kitty keyboard 协议探测（7.1 新增）                                                                                                            | `input-parser.js`、`App.js`、`kitty-keyboard.js`                                                                                                                                                                              |

### 关键实验记录：鼠标序列在 useInput 中的行为

`demo-selftest.mjs` 初版直接在 `useInput` 里匹配 `\x1b[<64`，实测失败并留下原始帧日志：

```
echo:[<64;10;5M
frame: follow=false scrollTop=9972 first="throughput report instal" draft="j[<64;10;5M" appended=0
```

即：**ink 的 useInput 吞掉 ESC 前缀后，把剩余 `[<64;10;5M` 当作字面文本交付**，滚轮变乱码输入——与 `packages/cli/src/tui/terminal-events.ts` 头注释描述完全一致，独立复现成立。修正式 demo（render 前挂拦截桥）后 `demo-selftest.mjs` 7 项全 PASS：

```
PASS j 回显且不污染（draft 含 "j"）
PASS 滚轮上生效：scrollTop 9972→9969
PASS 鼠标序列未流入输入行（draft 无 "[<"）
PASS a 回显 → draft="ja"
PASS Enter 追加消息并贴尾
PASS 滚轮下后恢复 FOLLOW
PASS 鼠标上报开启/关闭序列已写
```

## 4. 结论（供选型报告引用）

1. **性能**：虚拟化下 Ink 的渲染 CPU 不是瓶颈（rerender p95 11.2ms）；瓶颈是**架构性的 30fps 节流 + 整帧重写**（滚动 p95 44.7ms 不达标、回显 p50 33.5ms 贴线、7.5KB/帧输出）。调 maxFps 可救帧率但救不了输出字节量与 React 全量 reconcile 的线性增长。
2. **能力**：CJK/resize/alt-screen/键盘/粘贴生态完善；**鼠标点击命中、文本级选择、内联图片、cell 级差量刷新全部缺失或需大量自建**，且鼠标接入依赖「注册顺序 hack」这一脆弱机制（已被实验复现其必要性）。
3. **非虚拟化 10k**：2373ms/550MB，确认现产必须维持虚拟化窗口（与现状一致）。
4. **未做项**（如实登记）：更高 `maxFps` 的重测、真终端滚动观感（人工复跑 `node demo.mjs`）、真终端内联图片实验、Windows ConPTY 下的鼠标序列行为差异。
