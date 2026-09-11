# 阶段 15 质量收口 · 终验返工清单（R1–R6）

> **状态：** ⬜ 待执行 —— 2026-09-10 编排者终验后开出
>
> **判定：** ❌ 联合验收不通过，**阻塞合入 `main`**。任务实现基本完成，收尾没收干净。
>
> **被返工对象：** 分支 `chore/phase15-quality-closeout`，45 个提交（`7efc0c5` … `a3db36d`）
>
> **执行者：** 原执行者（一人顺序执行）
>
> **口径：** 本清单闭环前分支不得合入 `main`；本清单只做返工，**不新增功能、不改架构、不扩范围**。
>
> **配套文档：** 计划 `2026-09-09-phase-quality-closeout.md` · 验收表 `2026-09-09-phase-quality-closeout-acceptance.md` · 审查任务书 `2026-09-09-phase-quality-closeout-review-brief.md`

---

## 0. 终验实测基线

环境：本机 Windows 10 LTSC，**PowerShell 5.1（注意：不是 Git Bash 终端）**，Node v22.23.1，pnpm 11.13.0。时间 2026-09-10 12:46–12:56。

| 检查            | 命令                                                                           | 结果                                                                                                                  | 判定              |
| --------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 类型            | `pnpm -r typecheck`                                                            | 4 包全 Done，exit 0                                                                                                   | ✅                |
| lint · ESLint   | `pnpm lint` 前半段                                                             | 0 error / 38 warning                                                                                                  | ✅                |
| lint · Prettier | `pnpm lint` 后半段                                                             | 3 个文件未过，exit 1                                                                                                  | ❌ → R3           |
| 全量回归        | `pnpm test`                                                                    | core **830 passed / 2 failed / 1 skipped（833）**，exit 1；`pnpm -r` 首败即停，desktop / gateway / cli **根本没跑到** | ❌ → R1           |
| 对照实验        | 注入 `GIT_BASH` 后复跑同样两个测试文件                                         | **25 passed，exit 0**                                                                                                 | R1 的根因证据     |
| 工作树          | `git status` / `git stash list`                                                | 干净，无 stash，无 `dist/`·`node_modules`·`.tmp` 误入                                                                 | ✅                |
| 导出面基线      | `git diff main..HEAD -- packages/core/test/fixtures/api-surface-baseline.json` | 仅 +2 行（`BashConfig`、`DEFAULT_BASH_CONFIG`），属 A1-1 加性变更                                                     | ✅ 未被格式化污染 |

> 执行者在验收表 §9 记录的是「core 832 passed + 1 skipped」。**总数一致（833），差异全部落在 R1 的两个用例上**——说明不是有人改坏了代码，而是当时的运行环境把缺陷遮住了。详见 R1。

---

## 1. R1 ｜ P0 ｜ 阻塞合入 ｜ Git Bash 探测在 Git 装于非 C 盘时失效

### 现象

- `packages/core/test/doctor.test.ts:64` → `AssertionError: expected 'warn' to be 'ok'`（bash 分节）
- `packages/core/test/windows-bash.test.ts:157` → `AssertionError: expected 'exit code 1' to be undefined`（`ls package.json`）

### 根因

落点 `packages/core/src/tools/shell.ts` 的 `gitBashCandidates()`：

1. 固定候选只覆盖 `GIT_BASH` / `ProgramFiles` / `ProgramW6432` / `ProgramFiles(x86)` / `LOCALAPPDATA`，外加硬编码的 `C:\Program Files\Git` 与 `C:\Program Files (x86)\Git`。本机 Git 装在 **`D:\Program Files\Git`**，以上全部落空。
2. PATH 分支只做了 `join(entry, 'bash.exe')`。Windows 上 PATH 里通常只有 `...\Git\cmd`（`git.exe` 所在目录），拼出来的 `...\Git\cmd\bash.exe` **不存在**；真正的 `bash.exe` 在兄弟目录 `bin\` 与 `usr\bin\`（本机两处都在）。
3. 于是探测一路走到 `cmd.exe` 回退：`ls` 不是 cmd 内建命令 → exit 1；doctor 的 bash 分节报 `warn` 而不是 `ok`。

本机实测佐证：

- `(Get-Command git).Source` → `D:\Program Files\Git\cmd\git.exe`
- `Test-Path 'D:\Program Files\Git\bin\bash.exe'` → `True`
- `Test-Path 'C:\Program Files\Git\bin\bash.exe'` → `False`
- `(Get-Command bash).Source` → `C:\Windows\system32\bash.exe`（WSL 的壳，不是 Git Bash）

### 为什么之前是绿的

从 **Git Bash 终端**里跑测试时，该终端的 PATH 自带 `...\Git\usr\bin`，恰好命中 PATH 分支，探测成功；换成 PowerShell / cmd 就红。

**这正是 A1「Windows 可用性 P0」立项要消灭的那一类问题，却因为验证终端选错而漏网。** A1 此前被判 ✅ 属于误判，依据是被环境掩盖的绿。

### 改法（约十几行，不动对外契约）

`shell.ts` 顶部补 `dirname` 导入：

```ts
import { delimiter, dirname, join } from 'node:path';
```

把 `gitBashCandidates()` 末尾的 PATH 循环替换掉。

改前：

```ts
// PATH 中的 Git 目录（仅限路径含 git，避免误选 WSL/其它 bash）：`...\Git\usr\bin\bash.exe`
for (const entry of (env['PATH'] ?? '').split(delimiter)) {
  if (entry.length === 0 || !/git/i.test(entry)) continue;
  out.push(join(entry, 'bash.exe'));
}
return out;
```

改后：

```ts
// PATH 中的 Git 目录（仅限路径含 git，避免误选 WSL / 其它 bash）。
// 注意：PATH 里通常只有 `...\Git\cmd`（git.exe 所在），bash.exe 在兄弟目录 bin\ 与 usr\bin\，
// 因此除了 entry 自身，还要用 dirname(entry) 推出 Git 安装根目录再拼一次（Git 装在非 C 盘时这是唯一可靠来源）。
for (const raw of (env['PATH'] ?? '').split(delimiter)) {
  const entry = raw.trim().replace(/^"|"$/g, '');
  if (entry.length === 0 || !/git/i.test(entry)) continue;
  out.push(join(entry, 'bash.exe'));
  const root = dirname(entry);
  out.push(join(root, 'bin', 'bash.exe'));
  out.push(join(root, 'usr', 'bin', 'bash.exe'));
}
return [...new Set(out)];
```

要点：

- `/git/i` 的过滤保持不变（继续挡住 WSL 的 `C:\Windows\system32\bash.exe`）。
- 去引号是顺手加固：Windows PATH 条目允许带引号。
- `new Set` 去重，避免候选表在多来源命中时重复探测。
- **不要**改 `resolveBashShell` 的探测优先级（`config.bash.shell` > Git Bash > cmd），也不要改返回结构。

### 完成判据

- 在 **PowerShell**（且 `$env:GIT_BASH` 为空）下执行：
  `pnpm --filter @harness2/core exec vitest run test/windows-bash.test.ts test/doctor.test.ts` → 全绿
- `harness2 doctor` 的 bash 分节显示「实际使用 … `D:\Program Files\Git\…\bash.exe`」，状态 `ok`
- 提交：`🐛fix(core): Git Bash 探测支持非 C 盘安装（从 PATH 推导 Git 根目录）（R1）`

---

## 2. R2 ｜ P1 ｜ 真机用例会被终端类型掩盖 —— 补确定性覆盖

### 问题

`windows-bash.test.ts` 的真机块是 `describe.skipIf(!IS_WINDOWS)`，内部直接跑真实 shell；`doctor.test.ts:64` 也直接断言本机探测结果。两者都读真实 `process.env`，**结论随运行终端而变**——这就是 R1 漏网的机制性原因。修完 R1 如果不补这一条，同样的坑还会再踩。

### 改法

`resolveBashShell` 本身已支持注入（`{ platform, env, exists, configured }`），直接用它写确定性用例。加在 `windows-bash.test.ts` 的**非真机**区（不带 `skipIf`，Linux CI 也要跑）：

```ts
it('Git 装在非 C 盘：PATH 只有 ...\\Git\\cmd 时仍能探到 Git Bash', () => {
  const bash = 'D:\\Program Files\\Git\\bin\\bash.exe';
  const spec = resolveBashShell({
    platform: 'win32',
    env: {
      PATH: 'C:\\Windows\\system32;D:\\Program Files\\Git\\cmd',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    },
    exists: (p) => p === bash,
  });
  expect(spec.kind).toBe('git-bash');
  expect(spec.executable).toBe(bash);
});

it('机器上没有 Git Bash：回退 cmd 且 display 写明原因', () => {
  const spec = resolveBashShell({
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\system32', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    exists: () => false,
  });
  expect(spec.kind).toBe('cmd');
  expect(spec.display).toContain('未找到 Git Bash');
});

it('PATH 里的 WSL bash 不会被误选', () => {
  const spec = resolveBashShell({
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\system32', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    exists: (p) => p.toLowerCase() === 'c:\\windows\\system32\\bash.exe',
  });
  expect(spec.kind).toBe('cmd');
});
```

`doctor.test.ts:64` 同步改成不依赖本机是否装了 Git Bash：

- 断言 `byId.get('bash')!.summary` 含「实际使用」（这条是 A1-1 的真实契约）
- `status` 放宽为 `ok | warn`，并保留 `r.exitCode` 为 `0`
- 「探测是否命中 Git Bash」的正确性由上面三条注入用例保证

### 完成判据

- 新增 3 条用例在 Windows 与非 Windows 下都执行且通过（不是 skip）
- 故意把 R1 的改动回退，新增用例应当**变红**（自证用例真的命中，不是空跑）
- 提交：`✅test(core): 补 shell 探测确定性用例（非 C 盘 / 无 Git Bash / 不误选 WSL）（R2）`

---

## 3. R3 ｜ P1 ｜ 阻塞合入 ｜ `pnpm lint` 现在是红的

### 问题

`prettier --check .` 未通过，exit 1，三个文件：

1. `docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md`
2. `docs/HANDOFF.md`
3. `docs/screenshots/README.md`

原因：B2 的全量格式化排在 Day1（顺序是对的），但 B5 阶段之后又写了这些文档，写完没再格式化。验收表 B-2 标着 ✅，**在终验时点已经过期**。

### 改法

```powershell
pnpm format
pnpm lint    # 必须 exit 0
```

- 独立提交，**不得夹带任何逻辑改动**：`🎨style(docs): 补格式化 B5 之后新增/修改的文档（R3）`
- 若 `pnpm format` 顺带改动了本清单文件，一并提交，属正常。

### 附带的流程修补

在计划文档「完成的统一定义」里加一条硬性要求：**每个任务收尾前跑一次 `pnpm lint`，改文档也算改动**。B2 只保证了「某一时刻干净」，不保证之后一直干净。

---

## 4. R4 ｜ P1 ｜ 阻塞合入 ｜ 验收表回填与 §9 结论订正

### 问题

验收表内部自相矛盾：`A-12`、`B-15`、`J-1`～`J-6` 全部空着（⬜），但 §9 总结论已经写了完整复跑数据并给出「有条件通过」。而且 §9 那组数据在终验时点已不成立。

### 改法

1. **待回填（R1–R3 全绿之后，用真实输出填）**：`A-12`、`B-15`、`J-1`、`J-2`、`J-3`、`J-4`、`J-5`、`J-6`
2. **需订正**：
   - `B-2` —— 终验时为红，R3 之后复跑再标 ✅，证据写复跑时间与 exit code
   - §9 的「复跑的命令与结果」三行整体作废重填
   - §9 的「阶段 15 各任务结论」中 `A1 ✅` 改为 `A1 🟡`（R1 闭环后再回 ✅），并注明「原 ✅ 系环境掩盖导致的误判」
3. **需新增到第 6 节（不通过项与下放）**：R1 作为终验发现的 P0 缺陷登记，标注「本清单内闭环，不下放」
4. `J-2`（CI 首次真实运行）：仓库未 push，CI 无法触发 → 维持 ➖，并写明解除条件为「人类授权 push 后由 GitHub Actions 实跑」
5. 规则不变：**每行必须「状态 + 一句证据（命令 / 输出 / 提交号）」，证据为空视为未完成**

提交：`📝docs(plans): 回填阶段15联合验收证据并订正 §9 总结论（R4）`

---

## 5. R5 ｜ P2 ｜ 四个包的 test 脚本仍带 `--passWithNoTests`

四个 `package.json` 的 test 脚本全是 `vitest run --passWithNoTests`，与计划红线「禁止用 `--passWithNoTests`」冲突。四个包都有真实用例（core 60 / desktop 15 / gateway 5 / cli 17 个测试文件），该 flag 没有存在必要，去掉即可暴露「用例被意外全过滤」这类事故。

- 若判定为历史遗留且有人依赖，请在 issue-log 写明理由后保留，不要默默留着
- 提交：`🔧chore(repo): 移除 test 脚本中的 --passWithNoTests（R5）`

---

## 6. R6 ｜ P1 ｜ 联合验收与合入

### 执行顺序（不要跳步）

1. R1（改代码）
2. R2（补测试）
3. R3（格式化）
4. R5（去 flag）
5. **全量复跑**（见下）
6. R4（拿复跑输出回填验收表）
7. 请专职审查者补 `A-13` / `B-16` 两份审查报告
8. 再谈合入

### 复跑命令（必须在 PowerShell 里跑，逐条记 exit code）

```powershell
cd D:\AI_Projects\harness2
pnpm -r typecheck
pnpm lint
pnpm test
```

三条全绿才算联合验收通过。cli 的 crash-drill / export / memory 三个 spawn 型用例在机器高负载时会因 5s 默认超时假红，复跑时若遇到，用 `--testTimeout=30000` 复核并在证据里注明，**不得直接标绿**。

### 合入方式

```powershell
git switch main
git merge --no-ff chore/phase15-quality-closeout
```

- **需人类明确点头后才执行**
- `push` 仍然默认禁止；`main` 目前领先 `origin/main` 31 个提交，是人类刻意的口径

---

## 7. 验证纪律（本次事故的直接教训）

1. **跑 Windows 相关测试一律用 PowerShell 或 cmd，不要在 Git Bash 终端里跑。** Git Bash 会往 PATH 里塞 `...\Git\usr\bin`，直接掩盖 shell 探测缺陷。
2. **任何依赖本机环境的「真机」用例，必须配一条注入 env 的确定性用例。** 真机用例证明「这台机器能用」，注入用例才证明「逻辑是对的」。
3. **任务收尾前跑 `pnpm lint`，改文档也要跑。**
4. **验收表的 ✅ 只能来自当次复跑输出**，不能来自「我记得刚才是绿的」。

---

## 8. 完成的定义（每一条 R 都适用）

代码改完 + 相关测试在 PowerShell 下绿 + `pnpm lint` exit 0 + 验收表对应行有状态与证据 + 独立 commit（`<gitmoji><type>(<scope>): <中文描述>（R编号）`）+ 涉及行为变化时在 `docs/issue-log/` 当日文件按四要素记一笔（需求描述 / 处理过程 / 修改结果 / 遗留风险）。

提交红线不变：**只显式 `git add <具体文件>`，禁止 `git add -A`；小步提交；默认不 push。**

---

## 9. 仍需人类决定或执行（不属于本清单，别卡在这里）

| 事项                        | 关联验收行 | 状态                             |
| --------------------------- | ---------- | -------------------------------- |
| 授权 push 到 `origin/main`  | `J-2`、A0  | 待人类                           |
| 云端三家 API key            | `A-7b`     | 待人类，无 key 记 ➖，不得顶替   |
| `NPM_TOKEN` 与 `v1.0.0` tag | B6         | 待人类逐项授权                   |
| README 三张真机截图         | `B-13`     | 图槽已就位，待人类出图           |
| Windows 真机联网任务验证    | `A-6`      | 待人类                           |
| A2-1 第 6 项（桌面端真机）  | `A-7`      | 待人类                           |
| A2-1 第 8 项 finalText 为空 | `A-7`      | 执行者已登记缺陷，随 R1 一并复核 |

此外，A3 的 `P1-1`/`P1-2`（serve token 默认不强制、desktop 把 401 当已连接）与 A5 阶段 9 的 3 个 P1 已登记在验收表第 6 节，属**发布前必闭环**，不在本次返工范围内，但合入 `main` 前需确认它们仍在册未丢失。
---

## 10. 第二轮收尾（2026-09-11 人类授权：R7 / R8 / R9）

第一轮 `R1`–`R6` 已于 2026-09-10 全部闭环，并经编排者独立复跑验收：`pnpm lint` exit 0、`pnpm -r typecheck` exit 0、core 835 passed + 1 skipped · desktop 158 · gateway 14 默认超时全绿；cli 3 例 `Test timed out in 5000ms.` 假红，`--testTimeout=30000` 复核 17 files / 71 passed exit 0。执行者额外自查出并闭环了 1 条 P1（doctor warn 分支 summary 不含「实际使用」，`c5b9ea8`），该缺陷是本清单 `R2` 方案自身的漏洞，属超出清单要求的正确加分。

人类于 2026-09-11 授权继续执行 `R7`、`R8`，两项全绿后授权合入 `main`（`R9`）。**「独立人工审查（丙）」经人类明确豁免，本阶段不再安排**——因此 `R7` 必须把豁免事实写进文档，而不是留空或伪装成已审查。

### R7（P1，文档一致性）回填 §5 审查登记表 + 声明人工审查豁免

- 文件：`docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md` 第 5 节（约 L105–L119）
- 现状问题：`A1`/`A3`/`A4`/`B2`/`B3`/`B4` 六行的「丙（专职审查者）」与「只读子代理」两列**全空**，但 `A-13`/`B-16` 单元格已写明子代理审查报告的范围与结论，`J-6`（文档一致）又标了 ✅ → 表内自相矛盾。
- 做法：
  1. 「只读子代理」列按 `A-13` 已有结论逐行回填：审查范围（commit 区间）、结论、P0/P1 清零情况、日期。本阶段未派子代理审查的行写 `➖ 未派`，**不要留空**。
  2. 「丙（专职审查者）」列统一写 `➖ 人类豁免（2026-09-11）`，同样不留空。
  3. 表尾补一句说明：本阶段独立人工审查经人类于 2026-09-11 明确豁免，代码审查由「执行者自评 + 独立只读子代理 + 编排者独立复跑」三层承担；`git worktree` 只读审查树未建立。
  4. `A-13`/`B-16` 由 🟡 转 ✅，证据原文必须保留「人工丙审查已豁免」字样，**不得**改写成「两份报告齐备」。
  5. 在验收表第 6 节（发布前必闭环）新增一条遗留风险：**本阶段无独立人工审查**，下一阶段计划的「阶段开头：上阶段遗留」小节需抄入并考虑补做。
- `J-6` 的 ✅ 要等 1–3 做完才继续成立；先回填，再复核 `J-6`。

### R8（P1，让 `pnpm test` 默认为绿）给 cli 配确定性 testTimeout

- 事实依据：三个失败用例报的都是 `Test timed out in 5000ms.`（vitest 默认值），说明它们**没有** per-test 超时；而 `chat.test.ts` / `chat-cancel.test.ts` / `context-ref-integration.test.ts` 等同类 spawn 型用例本来就显式写 `}, 30000)`。`packages/cli` 目前**没有** vitest 配置文件，走的是默认 5s。
- 做法（照 `packages/desktop` 的现成范式，不要自创）：
  1. 新建 `packages/cli/vitest.config.mts`（**用 `.mts`**，与 desktop 一致，不要用 `.ts`）：

     ```ts
     // cli 集成用例大量 spawn 真实子进程（serve / export / memory / crash-drill），
     // vitest 默认 5s 在高负载机器上会假红（阶段 15 终验实测 3–7 例抖动）。
     // 统一抬到 30s：与既有 spawn 型用例显式写的 }, 30000) 口径一致。
     import { defineConfig } from 'vitest/config';

     export default defineConfig({
       test: {
         include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
         testTimeout: 30000,
         hookTimeout: 30000,
       },
     });
     ```

  2. 把该文件加进 `packages/cli/tsconfig.json` 的 `include`：`["src", "test", "vitest.config.mts"]`。**不要**加进 `tsconfig.build.json`（会被编译进 `dist`）。
     - 依据：desktop 的 `include` 正是 `["src", "test", "vite.config.mts", "vitest.config.mts"]`；ESLint 类型感知用 `projectService`，文件不在任何 tsconfig project 内会直接报 parsing error（`eslint.config.js` 顶部注释与 `allowDefaultProject` 就是为此存在）。
  3. 若 `pnpm -r typecheck` 因 `NodeNext` + `verbatimModuleSyntax` 对该文件报错，参照 desktop 的 `compilerOptions`（`module: ESNext` / `moduleResolution: Bundler` / `verbatimModuleSyntax: false`）**只补必要项**，禁止改 `tsconfig.base.json`。
  4. 禁止用 `--passWithNoTests`；禁止在根 `package.json` 的 test 脚本上加全局 `--testTimeout`（会掩盖其它包的真实超时问题）。
- 验收：`pnpm lint` exit 0；`pnpm -r typecheck` exit 0；**`pnpm test` 不带任何额外参数默认 exit 0**（四包全绿）。随后把 `A-12`/`B-15` 由 🟡 转 ✅ 并附本次复跑原文（含 cli 的 `Test Files 17 passed`），并订正第 9 节总结论里「`pnpm test` 整体 exit 1」那句为默认全绿，保留一句原因说明（原为环境超时 flake，已由确定性 testTimeout 消除）。
- issue-log：属测试基线行为变化，按四要素在 `docs/issue-log/2026-09-11.md` 记一笔。

### R9（合入，`R7` + `R8` 全绿后执行）

- 前置：`R7`、`R8` 各自独立 commit；工作树干净；三条命令默认全绿。
- 执行：

  ```
  git switch main
  git merge --no-ff chore/phase15-quality-closeout
  ```

- 合入后在 `main` 上再跑一遍 `pnpm lint` / `pnpm -r typecheck` / `pnpm test`，全绿才把 `J-1` 由 🟡 转 ✅ 并附 `main` 上的输出；随后第 9 节总结论定稿（B6 发布仍待人类授权，保持 ⬜）。
- **`push` 仍然禁止**（`J-2` 保持 ➖）。`main` 领先 `origin/main` 的提交数是人类刻意口径，不要「顺手」推。
- 合入前确认验收表第 6 节的 A3 `P1-1`/`P1-2`、A5 的 3 条 P1、B2「CI 从未真实运行」、以及 `R7` 新增的「无独立人工审查」仍在册未丢。

### 完成定义与提交规范

沿用第 7 节验证纪律与第 8 节完成定义（含收尾跑 `pnpm lint`、只显式 `git add <具体文件>`、禁止 `git add -A`、默认不 push）。提交信息示例：

- `📝docs(plans): 回填 §5 审查登记表并声明人工审查豁免（R7）`
- `🔧chore(cli): 配置确定性 testTimeout 30s 消除 spawn 型假红（R8）`
- `🔧chore(repo): 合入 chore/phase15-quality-closeout 到 main（R9）`

## 11. 第三轮：CI 首次真实运行即红（2026-09-11，人类授权 push 后发现）

### 背景（事实，勿改写）

- 人类于 2026-09-11 08:24（+08:00）授权推送，`main` 一次性推出 91 个提交：`b1c2d81..05d43ab  main -> main`；推送后 `git rev-list --left-right --count origin/main...main` = `0  0`。
- 这是本仓库 CI 的**首次真实运行**，验收表第 6 节登记的「B2 CI 从未真实运行」由此解除 —— 而首跑即 failure。
- run #40：<https://github.com/Userluckytian/harness2/actions/runs/34546351918>（`head_sha` = `05d43ab`，event = `push`，结论 = **failure**）
  - 7 个 job：`pages (docsify)` ✅ · `desktop build (win-setup)` ✅ · `desktop build (mac-dmg)` ✅ · `desktop build (linux-appimage)` ✅ · `test (windows-latest)` ✅ · **`test (ubuntu-latest)` ❌** · **`test (macos-latest)` ❌**
  - 两个红 job 都只在第 10 步 `Test`（根脚本 `pnpm test` = `pnpm -r build && pnpm -r test`）失败；同 job 内 `Install dependencies` / `Install chromium` / `Build packages` / `Typecheck` / `Lint` 全部 ✅。
  - ubuntu 红 job：<https://github.com/Userluckytian/harness2/actions/runs/34546351918/job/103099713528>（Test 步 `00:25:36Z` → `00:26:09Z`，33s）
  - macos 红 job：<https://github.com/Userluckytian/harness2/actions/runs/34546351918/job/103099713431>（Test 步 `00:25:22Z` → `00:25:54Z`，32s）
  - windows 绿 job：<https://github.com/Userluckytian/harness2/actions/runs/34546351918/job/103099713560>（Test 步 113s，全绿）
  - 公开 API 能取到的失败信息只有注解 `Process completed with exit code 1.`（指向 workflow 的 `Test` 步）；**日志正文需登录才能下载**，因此根因尚未确定。
- 根因教训：阶段 15 的 91 个提交全部只在一台 Windows 机器上验过，POSIX 分支从未被执行过一次。

### 已排除的假设（编排者 2026-09-11 静态核查，勿重复排查）

- `doctor.test.ts` 的 `toContain('实际使用')` 跨平台安全：`packages/core/src/doctor/index.ts` 的 `checkBash` 在 ok 分支（`bash 工具实际使用 …`）与 warn 分支都含该契约词。
- R2 三条注入用例（`packages/core/test/windows-bash.test.ts` L150–182）显式传 `platform: 'win32'` 并注入 `env` / `exists`，不依赖宿主平台。
- 真机用例位于 L185 起的 `describe.skipIf(!IS_WINDOWS)` 内，POSIX 上 skip。
- 全仓 `*.test.ts` 只有 8 处平台分支（`process.platform` / `IS_WINDOWS` / `skipIf`）；其余 Windows 字面量（如 `encodeCwd('C:\\')`、desktop 的 `'C:\\work'`）只作纯函数输入，不依赖宿主。
- 不是 cli 的 spawn 超时：R8 已配 30s，且 windows job 的 Test 步 113s 全绿。

### 头号嫌疑（待日志确认，**不得据此直接开修**）

- 失败包很可能是 **core**：POSIX 上 Test 步 32–33s（其中 `pnpm -r build` 约 5–8s）即退出，而 `pnpm -r test` 按拓扑先跑 core，`-r` 遇首个失败包即中止。
- core 中「在 Windows 上从未走过 POSIX 分支」的用例：`browser.test.ts`（CI 装了 chromium，三平台都会真跑）、`command-output-exit-code.test.ts` 与 `serve-functional-query.test.ts`（POSIX 走 `/bin/sh` 分支，Windows 走 `ComSpec` 分支）。

### R10（定位并修复 CI 在 POSIX 上的红 · P0 · 先取证后动手）

1. **取证（不许猜）**：打开上面两个红 job → 展开 `Test` 步 → 找**第一个** `FAIL` / `AssertionError` / `Error:`，把从该行起连续 40 行原文按四要素记进 `docs/issue-log/2026-09-11.md`。有 `gh` 权限的话更快：`gh auth login` 后 `gh run view 34546351918 --log-failed > ci-run40.log`。**在贴出失败原文之前，禁止改任何代码。**
2. **POSIX 复现**：用 Docker 或 WSL2 的**原生目录**（不要在 `/mnt/d` 上装依赖，会慢到不可用）：`node:22` 容器内 `corepack enable` → `pnpm install --frozen-lockfile` → `pnpm --filter @harness2/core exec playwright install chromium` → `pnpm test`。复现不出来就以 CI 为准，在**分支**上 push 迭代，**不要拿 `main` 当试验场**。
3. **修复原则**：只修被日志点名的用例/实现；**禁止为了变绿而 skip 掉 POSIX 分支**（确需 skip 必须在验收表第 6 节登记理由并下放到下阶段）；禁止 `--passWithNoTests`；除非日志证明是 workflow 缺陷（例如 ubuntu 缺 chromium 系统依赖 → 改为 `playwright install --with-deps chromium`），否则不许改 CI 迁就代码，且这类改动要在 issue-log 写清依据。
4. **分支纪律**：新分支 `fix/ci-posix-red`，小步提交；在该分支上 push 让 CI 验证；**7 个 job 全绿**后再 `git switch main` + `git merge --no-ff fix/ci-posix-red`，合入后 `main` 上的 CI 也必须绿。
5. **文档回填**：
   - 验收表 `J-2` 立刻从 ➖ 改为 ❌，写明「run #40 首跑：windows 绿，ubuntu / macos 在 `pnpm test` 红」并附 run 链接；修复绿了再转 ✅ 附新 run 链接。
   - 第 9 节总结论从「✅ 有条件通过」**下调**为「❌ 未通过（CI 三平台未全绿）」，直到 R10 全绿再恢复。
   - 第 6 节把「B2 CI 从未真实运行」改写为「已真实运行；首跑 POSIX 两平台红，由 R10 跟踪」。
6. **P2（可同批、须独立提交）**：run #40 注解提示 `actions/checkout@v4`、`actions/setup-node@v4`、`pnpm/action-setup@v4` 因 Node 20 弃用被强制跑在 Node 24 上，按官方公告升级到各自新版本，单独提交、单独验证。

- **验收门槛**：贴出 run 链接且 7 个 job 全绿；POSIX 环境（容器或 CI）内 `pnpm test` 不带任何额外参数 exit 0；Windows 本机三条命令仍全绿；未用 skip 换绿。
- **禁止**：force push；在 `main` 上试错；注释掉或删掉失败用例；把「本机绿」当作通过证据 —— 本轮红的全部成因就是只在一台 Windows 上验过。

### R10 闭环记录（2026-09-11，编排者复核后登记）

- **取证**：CI 日志正文不可得（`gh` 未登录、环境无 `GH_TOKEN`，公开 API 只有注解 `Process completed with exit code 1.`）→ 改用 **WSL2 Ubuntu-24.04 原生目录等价复现**；四要素已记入 `docs/issue-log/2026-09-11.md`。
- **四处真因与修复**（分支 `fix/ci-posix-red`）：`4f2937c` win32 路径语义（`shell.ts` 用宿主 `join`/`delimiter` 拼 Windows 路径）· `bcbbc84` pending 暂存毫秒单调（同毫秒排序不确定）· `d0ac358` cron 完成帧轮询等待（固定 `sleep(150)` 竞态）· `07e2e6c` core 确定性 `testTimeout/hookTimeout 30s`；P2 独立提交 `26399f9` 升 checkout/setup-node/pnpm-action-setup 至 v5。`browser.test.ts`×8 判定为 WSL 缺 chromium 系统库（`libnspr4.so`，非缺陷），**未据此改 CI**。
- **CI**：分支 [run #43](https://github.com/Userluckytian/harness2/actions/runs/34554717607) 6/6 绿（`pages` 按 `ref==main` 跳过）；`--no-ff` 合入 main（`fd8979a`，parents `94c30b5` + `26399f9`）后 [run #44](https://github.com/Userluckytian/harness2/actions/runs/34555011219) **7/7 全绿**；文档提交 `e2fb34a` 的 [run #45](https://github.com/Userluckytian/harness2/actions/runs/34555365483) 仍 7/7。
- **编排者独立复核（2026-09-11）**：全量 diff 核对**未出现** skip / `--passWithNoTests` / `continue-on-error` / `.only` / 新增 `if:` 门控（`ci.yml` 仅 3 处 action 版本号变更）；core 新增 `vitest.config.mts` 的 `include: ['test/**/*.test.ts']` 与实际 **60 个**测试文件完全吻合（`src/` 下无测试文件，`test/` 下无 `.tsx`/`.mts`/`.spec`），无用例被静默排除；本机 `e2fb34a` 复跑 `pnpm lint` / `pnpm -r typecheck` / `pnpm test` 三条 **exit 0**（core 60 files · desktop 15 · gateway 5 · cli 17）。
- **状态：✅ 已闭环** —— 验收表 J-2 ✅、第 6 节 R10 ✅、第 9 节总结论恢复「✅ 有条件通过」。
- **遗留（登记，不擅自动）**：`upload-artifact@v4` / `configure-pages@v5` / `deploy-pages@v4` / `download-artifact@v4` 仍 targeting node20（本次按指定范围只升三个 action）；分支 `fix/ci-posix-red` 已合入，本地与 origin 仍在，可择机删除。
