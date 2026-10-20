# U1 二轮独立审查 · 片4 红线/卫生

> 执行说明：片4 全部为机械核验，因两个审查子代理实例接连死于派发层抖动，由**编排者本人直跑**（工具输出原样粘贴；本属「验收复跑证据」职责，无独立性问题）。全部命令独立重跑，未引用第一轮报告结论。

## 1 冻结区红线（命令+输出+判定）

```
$ git diff main...HEAD -- packages/core packages/gateway | grep -E "^[+-][^+-]"
-  "version": "1.0.1",
+  "version": "1.0.2",
-export const CORE_VERSION = '1.0.1';
+export const CORE_VERSION = '1.0.2';
-  "version": "1.0.1",
+  "version": "1.0.2",
```
逐行=core/package.json、core/src/version.ts、gateway/package.json 各一对版本字符串，**无任何其他行**。
`git diff main...HEAD --name-only -- packages/core/test/fixtures/api-surface-baseline.json` → **0 行**。
**判定：PASS**（越界信号未触发；版本 bump 属 T8 发布物料，计划 §80 先例同型）。

## 2 web/cli 包面

```
$ git diff main...HEAD --stat -- packages/web packages/cli
 packages/cli/package.json | 2 +-
 packages/web/package.json | 2 +-
```
各仅版本行；web 的 3b 一度改动已被 `b34f327` 回退为净零（与计划 T3 行登记一致）。**判定：PASS**。

## 3 密钥/凭据扫 diff

```
$ git diff main...HEAD | grep -inE "sk-[A-Za-z0-9]{8,}|api[_-]?key[[:space:]]*[:=][[:space:]]*['\"][^'\"]{12,}|Bearer [A-Za-z0-9_-]{20,}"
(零命中)
```
**判定：PASS**（无凭据入 diff；auth token 均为运行时生成/注入逻辑，无字面量）。

## 4 全量 lint/format（68 个 diff 文件）

```
$ FILES=$(git diff main...HEAD --name-only | grep -E '\.(ts|tsx|mjs)$' | grep -v -E '^packages/(core|gateway)/')
$ ./node_modules/.bin/eslint $FILES
✖ 1 problem (0 errors, 1 warning)
$ ./node_modules/.bin/prettier --check $FILES
All matched files use Prettier code style!
```
0 error；唯一 warning=`App.tsx:173` react-hooks 依赖（**既有代码区**，T3 报告已如实登记非新引入）。**判定：PASS**。

## 5 manual-pack.mjs 审读

256 行。危险面扫描：`rmrf` 唯一作用域 = `.tmp-cmp/u1-stage/stage`（仓内暂存，:197）；robocopy 经 `execFile` 绝对路径直调、参数 `/E /R:1 /W:1` **无 `/MIR`**（append-copy，不删目标既有文件）；symlink 显式 throw（:107）防误拷；写范围=STAGE/OUT + `release/win-unpacked` 内壳文件——全部仓内。**幂等**：重跑=重建 stage→覆盖 OUT（本会话 22:0x 已实测二次跑通出 22:11 包）。
⚠️ **P2 一条**：:73 注释「镜像一棵树」与实际 `/E`（非镜像）术语不符——行为正确（幂等追加语义），注释误导。修法：注释改「递归拷贝（非镜像，幂等）」。

## 6 提交面卫生

```
$ git log main..HEAD --oneline | wc -l
42
```
格式抽验：正则粗筛 18 条「不匹配」全因 scope 大写（`(U1)`），逐条人工过目——**42/42 符合** `<gitmoji><type>(<scope>): 中文`。**判定：PASS**。

## 片4 清单

**P0=0 / P1=0 / P2=1**（manual-pack 注释术语，见 §5）。六面红线全 PASS，无凭据、无越界、lint/format 真全绿。
