# 方案 B：Node 自研最小渲染层（spike/tui-renderer-spike/selfdraw）

日期：2026-09-12 · 执行：实施子代理 · 环境：Windows 10.0.26200 x64，Windows Terminal，Git Bash，Node v22.23.1

## 0. 实现

**零外部依赖**（仅 Node 内置模块），5 个文件：

| 文件 | 职责 |
| --- | --- |
| `cell-buffer.mjs` | 字符网格：char + 显示宽度 + 24bit 前景色；内置 East Asian Wide 区段表（emoji 一律按 2 列，注明近似）；`writeText` 宽字符感知、超宽截断不切半边 |
| `renderer.mjs` | 双 buffer diff → 差量 ANSI：跳过相同单元格段、段起点落在宽字符续列时自动回扩到首列、CUP 绝对定位光标、SGR 前景色按段合并；alt-screen 进出 + 光标显隐 + SGR 鼠标开关；SIGINT/SIGHUP/SIGTERM/exit 统一 restore（幂等） |
| `scrollback.mjs` | 10k 行滚动模型：宽字符感知断行（不切半边）、按行缓存 + 前缀和、二分定位 viewport、follow 贴尾/回底自动恢复、wheel/PgUp/PgDn/Home/End、append 增量 |
| `demo.mjs` | raw mode + StringDecoder（UTF-8 半码点安全）+ SGR 滚轮（`\x1b[<64/65;x;yM`）+ CSI 键盘（↑↓/PgUp/PgDn/Home/End）+ j/k/g/G + 底部输入行回显 + Enter 追加 + Ctrl+C(0x03) 显式恢复退出 + resize 全量重绘 |
| `bench.mjs` | 进程内压测，输出流接 NullStdout |

复跑：

```bash
cd spike/tui-renderer-spike/selfdraw
node bench.mjs          # 性能（原始 JSON 最后一行 RESULT_JSON=...）
node demo-selftest.mjs  # 逻辑自检（非 TTY 可跑，7 项 PASS，exit=0）
node demo.mjs           # 真机 demo（需真终端，人工复跑）
```

## 1. 基准结果（node bench.mjs 原始输出）

```
RESULT_JSON={"rssBaseMB":48.6,"wrapAll10kMs":16.5,"wrapTotalPhysicalRows":19570,"wrapCjkLine":{"n":3034,"avg":0.002,"p50":0.001,"p95":0.003,"max":0.523},"prefixBuildMs":39.07,"totalPhysicalRows":19570,"initFullFrame":{"fillMs":0.35,"presentMs":0.42,"totalMs":0.77,"bytes":2527},"coldStartToFirstFrameMs":95.4,"rssAfterInitMB":122.6,"wheelFrames":{"n":2000,"avg":0.068,"p50":0.063,"p95":0.08,"max":0.985},"wheelFrameBytesAvg":4424.2,"pageFrames":{"n":2000,"avg":0.065,"p50":0.061,"p95":0.076,"max":0.483},"pageFrameBytesAvg":4175,"echoFrame":{"n":200,"avg":0.039,"p50":0.023,"p95":0.096,"max":0.138},"rssEndMB":125.5,"stdoutTotalBytes":8560050}
```

demo 逻辑自检（7 项全 PASS）：

```
PASS 每个输入事件触发一帧（frames>=9）
PASS 上滚后离开 follow（sb.follow=false）
PASS draft 回显为 "x"
PASS 追加行后 lines=10001
PASS 渲染总字节数有限（差量生效，<200KB）
PASS CJK 断行：每物理行宽度≤cols 且行数>1
PASS cell buffer 行宽计算一致
frames=13 stdoutBytes=15336 writes=11 lines=10001
恢复序列尾部: "?1006l\u001b[?1000l\u001b[?25h\u001b[0m\u001b[?1049l"
```

### 指标对齐统一协议

| 指标 | 数值 | 门槛 | 判定 |
| --- | --- | --- | --- |
| 冷启动（进程起→首帧就绪，含模块加载+数据生成+10k 断行+首帧输出） | **95.4ms** | — | 通过 |
| 10k 行初始满帧（fill+diff 输出，冷 wrap 16.5ms 另计） | **0.77ms**（2527 字节） | — | 通过 |
| 滚动帧耗（wheel 3 行 ×2000） | avg **0.068ms** / **p95 0.08ms** / max 0.99ms | p95<33ms | **通过（约 400 倍余量）** |
| 整页翻页帧耗（×2000） | avg **0.065ms** / p95 0.076ms | p95<33ms | 通过 |
| 输入回显（键入→draft→差量帧，进程内） | avg **0.039ms** / p95 0.096ms | <30ms | 通过（不含真实终端 I/O，真实延迟由 demo 人工验证） |
| 常驻 RSS | 基线 48.6MB → 初始化后 **122.6MB** → 压测结束 125.5MB（稳定不涨） | — | 记录值 |
| 宽字符测量/断行 | 10k 行全量 **16.5ms**（→19,570 物理行，均 1.65µs/行）；CJK 行 3,034 条 p95 **3µs** | — | 通过 |

### 口径与方法（如实写明）

- 全部为**进程内 wall time**（performance.now()），输出流接 NullStdout（丢弃字节、计字节数），**不含真实终端 I/O 与渲染管线**；真实终端表现由 `demo.mjs` 人工复跑确认。
- 滚动帧 = 滚动模型更新 + viewport 重填（31 行）+ 全帧 diff + 差量输出。实测每帧输出 ~4.4KB（交替滚动使全部可视行变化，接近最坏情况）；对比 ink 同口径 ~7.5KB/帧且被 30fps 节流锁死。
- 「初始满帧」不含 16.5ms 的冷断行（单独计时）；若把断行做惰性（只断可视区±缓冲），冷启动还能再降。
- diff 为单元格级：本压测中滚动使整屏行移动，等于逐行全比较的最坏路径，仍然 p95<0.1ms。

## 2. 局限（如实列明）

### 2a. demo 简化（补齐是工程量，不是架构风险）

- **无 IME**：alt-screen 下终端 IME 本就受限；需设计（占位区/外部编辑器）。补齐：设计 1-2 人日 + 实现。
- **无文本选择/复制**：本 demo 未做任何选择逻辑；终端原生选择在差量重写下可用性同 ink（变化区打断选择）。
- **鼠标只有滚轮**：SGR 点击/拖动解析未写（协议已知，解析是小事）；**命中测试**（坐标→UI 元素）需要布局层信息，是后面的大头。
- **输入解析子集**：单字符 + 少量 CSI（↑↓/PgUp/PgDn/Home/End）；无 bracketed paste、焦点事件（DECSET 1004）、kitty 键盘协议、功能键全集。
- **颜色只有前景 24bit**：无背景色、无粗体/斜体等属性位。
- **无滚动区域优化（DECSTBM）**：滚一屏时整屏重写（本 demo 因输出流为 null 感知不到，真实终端可再省 ~80% 字节）。
- **前缀和一次性构建 39ms**：应做惰性/失效重建（现 transcript.ts 已有同类高度缓存思路可移植）。
- **无 Static 语义**：历史落定内容没有「写进终端 scrollback 再不重绘」的通道（长期内存优化项）。
- **窄终端截断策略简单**：宽字符放不下整字丢弃（不产生断字残影，但可能浪费 1 列）。

### 2b. 路线固有成本（任何 cell buffer 自研方案都要付）

- **组件/布局系统自建**：ink 用 yoga 免费提供的 flex 布局、边框、对齐、wrap，全部要自己造——这是最大的一块（见 §3 估算）。
- **终端兼容性矩阵**：Windows Terminal / conhost / ConPTY、iTerm2、kitty、alacritty、tmux/screen 的转义序列差异与 quirk 测试，无社区替你踩坑。
- **alt-screen 与原生选择/IME 的根本矛盾**：进 alt-screen 就没有 scrollback 可选可复制（ink 默认模式反而保留这一能力）；不进 alt-screen 则差量刷新收益打折。
- **生态零**：没有 ink 的 useInput/Static/focus 社区组件，一切自带。
- **过渡期双栈维护**：现有 Ink UI 迁移完成前两套渲染层并存。

## 3. 自研成本评估（估人日）

本 spike（可跑的骨架：buffer+diff+滚动+输入+demo+bench，~700 行）≈ **1 人日**。生产化最低可用（聊天场景，固定布局）：

| 项 | 人日 |
| --- | --- |
| cell buffer 精确化（宽度表换 string-width 级、属性位扩展） | 1-2 |
| renderer 生产化（光标管理、DECSTBM 滚动优化、resize、异常恢复、256/truecolor 降级） | 3-5 |
| 终端兼容性矩阵测试与修复（WT/conhost/ConPTY/iTerm/kitty/tmux） | 3-5 |
| 输入层全集（功能键、bracketed paste、焦点、鼠标点击/拖动+命中） | 2-3 |
| 滚动模型生产化（高度缓存、惰性 wrap、Static 落盘语义） | 2-3 |
| 迁移现有 UI（Transcript 卡片/Composer/StatusBar/Modal/SelectList → 固定布局绘制） | 3-5 |
| 测试/验收/文档/灰度开关 | 2-3 |
| **合计（固定布局，不造组件系统）** | **≈16-26 人日** |
| 若另需通用组件/布局系统（对齐 ink 的 Box/flex 能力） | 再 +5-8 人日 |

## 4. 结论（供选型报告引用）

1. **性能全面碾压门槛**：滚动 p95 0.08ms（门槛 33ms，约 400 倍余量）、回显帧 <0.1ms、冷启动 95ms、RSS 稳定 ~123MB；差量输出 4.4KB/帧 vs ink 7.5KB/帧且无 30fps 锁。性能不是该路线的风险点。
2. **风险全在生态面**：组件/布局系统、终端兼容性矩阵、选择/IME 的 alt-screen 矛盾。spike 已验证的只有「渲染核心可行且便宜」；§2a 清单是工程量，§2b 清单是架构成本。
3. 与方案 A 的互补关系：B 的滚动模型/宽度断行与现产 `transcript.ts` 的 viewport 思路同构，迁移的认知成本可控；若选 A，本 spike 的差量思想也可反哺（如 ink `incrementalRendering` 开关实验）。
4. 未做项（如实登记）：真终端人工复跑（编排者执行）、DECSTBM 优化、点击命中、真终端下 ConPTY 对 raw mode 的行为差异验证。
