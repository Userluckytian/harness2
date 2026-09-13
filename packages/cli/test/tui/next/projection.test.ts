// W1 projection 单测（headless，零 ink/react）：TranscriptItem → next 渲染库文本行。
// - 每类 item 的行数 / 前缀 / 颜色断言（颜色用 FG 常量，不钉 magic number）
// - 折叠/展开（collapsed 覆盖集 + toggleCollapse 纯函数）
// - lineIndex 反查 item 下标；10k item 投影性能冒烟（<200ms 报警级）
// - fixture 用 transcript.ts 真实类型，构造方式借鉴 transcript.test.ts（reducer 驱动为主）
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { FG, projectTranscript, toggleCollapse, type ProjectionLine } from '../../../src/tui/next/projection.js';
import {
  emptyTranscript,
  transcriptReducer,
  type TranscriptEvent,
  type TranscriptItem,
} from '../../../src/tui/transcript.js';

/** reducer 驱动构造 items（与真实事件流同源，保证 summary/id 语义一致） */
function build(...events: TranscriptEvent[]): TranscriptItem[] {
  let s = emptyTranscript();
  for (const e of events) s = transcriptReducer(s, e);
  return s.items;
}

function texts(lines: readonly ProjectionLine[]): string[] {
  return lines.map((l) => l.text);
}

function kinds(lines: readonly ProjectionLine[]): string[] {
  return lines.map((l) => l.kind);
}

describe('projectTranscript：user / assistant', () => {
  it('user 单行：`❯ ` 前缀，kind=user，默认前景色', () => {
    const lines = projectTranscript(build({ type: 'user/message', seq: 1, text: '你好' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('❯ 你好');
    expect(lines[0]?.kind).toBe('user');
    expect(lines[0]?.fg).toBeUndefined();
    expect(lines[0]?.lineIndex).toBe(0);
  });

  it('user 多行：逐行保留，仅首行带 `❯ ` 前缀', () => {
    const lines = projectTranscript(build({ type: 'user/message', seq: 1, text: '第一行\n第二行\n第三行' }));
    expect(texts(lines)).toEqual(['❯ 第一行', '第二行', '第三行']);
    expect(lines.every((l) => l.kind === 'user')).toBe(true);
  });

  it('assistant 正文：原样一行，不做物理换行（长行整行产出）', () => {
    const long = 'x'.repeat(200);
    const lines = projectTranscript(build({ type: 'assistant/message', seq: 2, text: long }));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe(long);
    expect(lines[0]?.kind).toBe('assistant');
  });

  it('assistant 多行正文：按 \n 拆成逻辑行', () => {
    const lines = projectTranscript(build({ type: 'assistant/message', seq: 2, text: 'A\nB' }));
    expect(texts(lines)).toEqual(['A', 'B']);
  });

  it('assistant 空 text：仍产出一行空文本（item 不消失，lineIndex 可反查）', () => {
    const lines = projectTranscript(build({ type: 'assistant/step', stepIndex: 0, text: '' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('');
    expect(lines[0]?.kind).toBe('assistant');
    expect(lines[0]?.lineIndex).toBe(0);
  });
});

describe('projectTranscript：reasoning（默认折叠）', () => {
  it('折叠态：一行 `  ▸ 思考…(N 字)` 灰色，N 为去空白字符数', () => {
    const lines = projectTranscript(
      build({ type: 'assistant/message', seq: 2, text: '答案', reasoning: 'step one two three' }),
    );
    expect(texts(lines)).toEqual(['答案', '  ▸ 思考…(18 字)']);
    expect(lines[1]?.kind).toBe('reasoning');
    expect(lines[1]?.fg).toBe(FG.gray);
  });

  it('展开态（collapsed 集含该下标 = 与默认取反）：逐行 `  │ ` 前缀灰色', () => {
    const lines = projectTranscript(
      build({ type: 'assistant/message', seq: 2, text: '答案', reasoning: '想一步\n想二步' }),
      { collapsed: new Set([0]) },
    );
    expect(texts(lines)).toEqual(['答案', '  │ 想一步', '  │ 想二步']);
    expect(lines.slice(1).every((l) => l.kind === 'reasoning' && l.fg === FG.gray)).toBe(true);
  });

  it('纯空白 reasoning 不产生推理行', () => {
    const lines = projectTranscript(build({ type: 'assistant/message', seq: 2, text: '答案', reasoning: '  \n  ' }));
    expect(lines).toHaveLength(1);
  });
});

describe('projectTranscript：tool 调用行与结果', () => {
  it('pending：`⏺ tool(摘要)` 黄色，无结果行（args 含 file_path 时提炼紧凑摘要）', () => {
    const items = build({ type: 'tool/call', seq: 3, callId: 'c1', tool: 'read', args: '{"file_path":"a.ts"}' });
    const lines = projectTranscript(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('⏺ read(a.ts)');
    expect(lines[0]?.fg).toBe(FG.yellow);
    expect(lines[0]?.kind).toBe('tool');
  });

  it('ok + 单行输出：`  └ ✓ 输出` 绿色 kind=tool-result', () => {
    const items = build(
      { type: 'tool/call', seq: 3, callId: 'c1', tool: 'read', args: '{}', summary: 'a.ts' },
      { type: 'tool/result', callId: 'c1', ok: true, output: '内容' },
    );
    const lines = projectTranscript(items);
    expect(texts(lines)).toEqual(['⏺ read(a.ts)', '  └ ✓ 内容']);
    expect(lines[0]?.fg).toBe(FG.green);
    expect(lines[1]?.kind).toBe('tool-result');
    expect(lines[1]?.fg).toBe(FG.green);
  });

  it('ok + 多行输出（默认折叠）：首行 + 「共 N 行」摘要', () => {
    const items = build(
      { type: 'tool/call', seq: 3, callId: 'c1', tool: 'bash', args: '{}', summary: 'ls' },
      { type: 'tool/result', callId: 'c1', ok: true, output: 'l1\nl2\nl3' },
    );
    const lines = projectTranscript(items);
    expect(texts(lines)).toEqual(['⏺ bash(ls)', '  └ ✓ l1（共 3 行）']);
  });

  it('ok + 多行输出（展开态）：`  └ ✓` 头 + 每行 `  │ ` 前缀灰色', () => {
    const items = build(
      { type: 'tool/call', seq: 3, callId: 'c1', tool: 'bash', args: '{}', summary: 'ls' },
      { type: 'tool/result', callId: 'c1', ok: true, output: 'l1\nl2\nl3' },
    );
    const lines = projectTranscript(items, { collapsed: new Set([0]) });
    expect(texts(lines)).toEqual(['⏺ bash(ls)', '  └ ✓', '  │ l1', '  │ l2', '  │ l3']);
    expect(lines[1]?.fg).toBe(FG.green);
    expect(lines.slice(2).every((l) => l.kind === 'tool-result' && l.fg === FG.gray)).toBe(true);
  });

  it('failed：`  └ ✗ 错误首行` 红色；多行错误默认只显首行', () => {
    const items = build(
      { type: 'tool/call', seq: 3, callId: 'c1', tool: 'bash', args: '{}', summary: 'x' },
      { type: 'tool/result', callId: 'c1', ok: false, error: '权限拒绝\n详情: EACCES' },
    );
    const lines = projectTranscript(items);
    expect(texts(lines)).toEqual(['⏺ bash(x)', '  └ ✗ 权限拒绝']);
    expect(lines[0]?.fg).toBe(FG.red);
    expect(lines[1]?.fg).toBe(FG.red);
  });

  it('failed + 展开态：错误全部行可见', () => {
    const items = build(
      { type: 'tool/call', seq: 3, callId: 'c1', tool: 'bash', args: '{}', summary: 'x' },
      { type: 'tool/result', callId: 'c1', ok: false, error: '权限拒绝\n详情: EACCES' },
    );
    const lines = projectTranscript(items, { collapsed: new Set([0]) });
    expect(texts(lines)).toEqual(['⏺ bash(x)', '  └ ✗ 权限拒绝', '  │ 详情: EACCES']);
  });

  it('failed 无 error：占位「（无错误详情）」；ok 无 output：`  └ ✓`', () => {
    const failed = build({ type: 'tool/result', seq: 1, callId: 'g1', tool: 'bash', ok: false });
    const fLines = projectTranscript(failed);
    expect(texts(fLines)).toEqual(['⏺ bash()', '  └ ✗ （无错误详情）']);
    const ok = build(
      { type: 'tool/call', seq: 2, callId: 'g2', tool: 'read', args: '{}', summary: 'b.ts' },
      { type: 'tool/result', callId: 'g2', ok: true },
    );
    expect(texts(projectTranscript(ok))).toEqual(['⏺ read(b.ts)', '  └ ✓']);
  });

  it('summary 为空时从 args 提炼（file_path 优先）', () => {
    const items = build({ type: 'tool/call', seq: 3, callId: 'c1', tool: 'write', args: '{"file_path":"src/x.ts"}' });
    const lines = projectTranscript(items);
    expect(lines[0]?.text).toBe('⏺ write(src/x.ts)');
  });

  it('cols 提供时超宽摘要行截断为不超过 cols 且以 … 结尾', () => {
    const items = build({ type: 'tool/call', seq: 3, callId: 'c1', tool: 'read', summary: 'y'.repeat(100) });
    const lines = projectTranscript(items, { cols: 40 });
    const t = lines[0]?.text ?? '';
    expect(t.startsWith('⏺ read(')).toBe(true);
    expect(t.endsWith('…')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(41); // 截断后不超过 cols（含省略号余量）
  });
});

describe('projectTranscript：partial / empty / system / status', () => {
  it('partial：正文 + 黄色 `[未完成 / 已中断] stopReason=… · error`', () => {
    const items = build({
      type: 'turn-partial',
      turnId: 't1',
      text: '半截回答',
      error: 'cancelled',
      stopReason: 'cancelled',
    });
    const lines = projectTranscript(items);
    expect(texts(lines)).toEqual(['半截回答', '[未完成 / 已中断] stopReason=cancelled · cancelled']);
    expect(lines[1]?.kind).toBe('system');
    expect(lines[1]?.fg).toBe(FG.yellow);
  });

  it('partial 无 stopReason：只带 error；两者皆缺：占位文案', () => {
    const a = projectTranscript(build({ type: 'turn-partial', turnId: 't1', text: 'x', error: 'boom' }));
    expect(a[1]?.text).toBe('[未完成 / 已中断] boom');
    const b = projectTranscript(build({ type: 'turn-partial', turnId: 't2', text: 'y' }));
    // reducer 对缺省 error 兜底为「（未提供错误信息）」，投影如实透传
    expect(b[1]?.text).toBe('[未完成 / 已中断] （未提供错误信息）');
  });

  it('empty：单行红色（禁止空白气泡）', () => {
    const lines = projectTranscript(
      build({ type: 'turn-empty', turnId: 't3', error: 'network error', stopReason: 'error' }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('[未完成 / 已中断] stopReason=error · network error');
    expect(lines[0]?.kind).toBe('system');
    expect(lines[0]?.fg).toBe(FG.red);
  });

  it('system / status：灰色单行 kind=system', () => {
    const lines = projectTranscript(
      build(
        { type: 'system', id: 'boot:0', text: '会话已恢复' },
        { type: 'status', id: 'st:1', text: '[end_turn · steps 1]' },
      ),
    );
    expect(texts(lines)).toEqual(['会话已恢复', '[end_turn · steps 1]']);
    expect(lines.every((l) => l.kind === 'system' && l.fg === FG.gray)).toBe(true);
  });
});

describe('projectTranscript：subagent', () => {
  it('pending：`⏺ Subagent "描述" 运行中` 黄色（描述从 args.description 提炼）', () => {
    const items = build({
      type: 'tool/call',
      seq: 3,
      callId: 's1',
      tool: 'subagent_start',
      args: '{"description":"调查 bug"}',
    });
    const lines = projectTranscript(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('⏺ Subagent "调查 bug" 运行中');
    expect(lines[0]?.kind).toBe('subagent');
    expect(lines[0]?.fg).toBe(FG.yellow);
  });

  it('ok：`⏺ Subagent "描述" 完成` 绿色；childSessionId 产出 `  ↳ 子会话` 灰行', () => {
    const items = build(
      {
        type: 'tool/call',
        seq: 3,
        callId: 's1',
        tool: 'subagent_start',
        args: '{"description":"调查 bug"}',
      },
      { type: 'tool/result', callId: 's1', tool: 'subagent_start', ok: true, output: '{"childSessionId":"child-1"}' },
    );
    const lines = projectTranscript(items);
    expect(texts(lines)).toEqual(['⏺ Subagent "调查 bug" 完成', '  ↳ 子会话 child-1']);
    expect(lines[0]?.fg).toBe(FG.green);
    expect(lines[1]?.kind).toBe('subagent');
    expect(lines[1]?.fg).toBe(FG.gray);
  });

  it('failed：`⏺ Subagent "描述" 失败` 红色 + `  └ ✗ 错误首行`', () => {
    const items = build(
      { type: 'tool/call', seq: 3, callId: 's1', tool: 'subagent_continue', args: '{"description":"续跑"}' },
      { type: 'tool/result', callId: 's1', tool: 'subagent_continue', ok: false, error: 'boom\nstack' },
    );
    const lines = projectTranscript(items);
    expect(texts(lines)).toEqual(['⏺ Subagent "续跑" 失败', '  └ ✗ boom']);
    expect(lines[0]?.fg).toBe(FG.red);
    expect(lines[1]?.kind).toBe('tool-result');
  });
});

describe('projectTranscript：diff（edit/write 展开态）', () => {
  it('默认折叠：edit 不产 diff 行', () => {
    const items = build(
      {
        type: 'tool/call',
        seq: 3,
        callId: 'c1',
        tool: 'edit',
        args: '{"file_path":"a.ts","old_text":"foo\\nbar","new_text":"foo\\nbaz"}',
      },
      { type: 'tool/result', callId: 'c1', ok: true, output: 'written' },
    );
    const lines = projectTranscript(items);
    expect(kinds(lines).includes('diff')).toBe(false);
    expect(texts(lines)).toEqual(['⏺ edit(a.ts)', '  └ ✓ written']);
  });

  it('展开态：文件头 `── a.ts ──` + `+ `绿 / `- `红 / 上下文灰', () => {
    const items = build(
      {
        type: 'tool/call',
        seq: 3,
        callId: 'c1',
        tool: 'edit',
        args: '{"file_path":"a.ts","old_text":"foo\\nbar","new_text":"foo\\nbaz"}',
      },
      { type: 'tool/result', callId: 'c1', ok: true, output: 'written' },
    );
    const lines = projectTranscript(items, { collapsed: new Set([0]) });
    expect(texts(lines)).toEqual([
      '⏺ edit(a.ts)',
      '  └ ✓',
      '── a.ts ──',
      'foo',
      '@@ -2 +2 @@', // 变更块不紧贴文件头 → 带 hunk 头（紧贴头部的首块省略，见 hunk 专项用例）
      '- bar',
      '+ baz',
      '  │ written',
    ]);
    const header = lines[2];
    expect(header?.kind).toBe('diff');
    expect(header?.fg).toBe(FG.gray);
    expect(lines[3]?.fg).toBe(FG.gray); // 上下文
    expect(lines[4]?.text).toBe('@@ -2 +2 @@');
    expect(lines[5]?.text).toBe('- bar');
    expect(lines[5]?.fg).toBe(FG.red);
    expect(lines[6]?.text).toBe('+ baz');
    expect(lines[6]?.fg).toBe(FG.green);
  });

  it('write 展开态：before 为空 → 全部 `+ ` 行', () => {
    const items = build(
      {
        type: 'tool/call',
        seq: 3,
        callId: 'c1',
        tool: 'write',
        args: '{"file_path":"new.ts","content":"a\\nb"}',
      },
      { type: 'tool/result', callId: 'c1', ok: true },
    );
    const lines = projectTranscript(items, { collapsed: new Set([0]) });
    const diffLines = lines.filter((l) => l.kind === 'diff');
    expect(texts(diffLines)).toEqual(['── new.ts ──', '+ a', '+ b']);
    expect(diffLines.slice(1).every((l) => l.fg === FG.green)).toBe(true);
  });

  it('diff 超 20 行折叠为 `… 还有 N 行`', () => {
    const content = Array.from({ length: 25 }, (_, i) => `line${i}`).join('\\n');
    const items = build(
      { type: 'tool/call', seq: 3, callId: 'c1', tool: 'write', args: `{"file_path":"big.ts","content":"${content}"}` },
      { type: 'tool/result', callId: 'c1', ok: true },
    );
    const lines = projectTranscript(items, { collapsed: new Set([0]) });
    const diffTexts = texts(lines.filter((l) => l.kind === 'diff'));
    expect(diffTexts[0]).toBe('── big.ts ──');
    expect(diffTexts.at(-1)).toBe('… 还有 5 行');
    expect(diffTexts).toHaveLength(1 + 20 + 1); // 文件头 + 20 可见行 + 截断提示
  });

  it('多处修改块间产出 `@@ -o +n @@` hunk 头', () => {
    const oldText = ['a', 'b', 'c', 'd', 'e'].join('\\n');
    const newText = ['a', 'B', 'c', 'd', 'E'].join('\\n');
    const items = build(
      {
        type: 'tool/call',
        seq: 3,
        callId: 'c1',
        tool: 'edit',
        args: `{"file_path":"h.ts","old_text":"${oldText}","new_text":"${newText}"}`,
      },
      { type: 'tool/result', callId: 'c1', ok: true },
    );
    const lines = projectTranscript(items, { collapsed: new Set([0]) });
    const hunks = lines.filter((l) => l.kind === 'diff' && l.text.startsWith('@@'));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.text).toBe('@@ -2 +2 @@');
    expect(hunks[1]?.text).toBe('@@ -5 +5 @@');
  });
});

describe('折叠集与 toggleCollapse', () => {
  it('无 opts 与空 collapsed 集：投影结果一致（纯默认态）', () => {
    const items = build(
      { type: 'assistant/message', seq: 2, text: '答案', reasoning: '想' },
      { type: 'tool/call', seq: 3, callId: 'c1', tool: 'bash', args: '{}', summary: 'ls' },
      { type: 'tool/result', callId: 'c1', ok: true, output: 'a\nb' },
    );
    expect(projectTranscript(items)).toEqual(projectTranscript(items, { collapsed: new Set() }));
  });

  it('toggleCollapse：空集加入下标，返回新 Set 且不改原集', () => {
    const empty = new Set<number>();
    const next = toggleCollapse(3, empty);
    expect(next.has(3)).toBe(true);
    expect(empty.has(3)).toBe(false); // 原集未被修改（纯函数）
    expect(next).not.toBe(empty);
  });

  it('toggleCollapse：已含下标则移除；两次 toggle 回到原态', () => {
    const start = new Set([1, 2, 3]);
    const once = toggleCollapse(2, start);
    expect(once.has(2)).toBe(false);
    expect(once.has(1)).toBe(true);
    const twice = toggleCollapse(2, once);
    expect([...twice].sort()).toEqual([1, 2, 3]);
  });

  it('collapsed 集驱动折叠/展开前后行数变化（tool 多行输出 +10 行）', () => {
    const items = build(
      { type: 'tool/call', seq: 3, callId: 'c1', tool: 'bash', args: '{}', summary: 'ls' },
      { type: 'tool/result', callId: 'c1', ok: true, output: Array.from({ length: 12 }, (_, i) => `L${i}`).join('\n') },
    );
    const collapsedLines = projectTranscript(items);
    const expandedLines = projectTranscript(items, { collapsed: new Set([0]) });
    expect(collapsedLines).toHaveLength(2);
    expect(expandedLines).toHaveLength(2 + 12); // └ 头 + 12 行输出
    expect(toggleCollapse(0, new Set())).toEqual(new Set([0]));
  });
});

describe('lineIndex 反查与整体不变量', () => {
  it('混合流：每行 lineIndex 恒等于所属 item 下标', () => {
    const items = build(
      { type: 'user/message', seq: 1, text: 'q1\nq2' },
      { type: 'tool/call', seq: 2, callId: 'c1', tool: 'read', args: '{}', summary: 'a' },
      { type: 'tool/result', callId: 'c1', ok: true, output: 'out' },
      { type: 'assistant/message', seq: 3, text: 'done', reasoning: 'why' },
      { type: 'system', id: 'sys', text: 'sys-line' },
    );
    const lines = projectTranscript(items);
    for (const l of lines) expect(items[l.lineIndex]).toBeDefined();
    const byItem = new Map<number, ProjectionLine[]>();
    for (const l of lines) {
      const arr = byItem.get(l.lineIndex) ?? [];
      arr.push(l);
      byItem.set(l.lineIndex, arr);
    }
    expect(byItem.get(0)?.map((l) => l.text)).toEqual(['❯ q1', 'q2']);
    expect(byItem.get(3)?.map((l) => l.text)).toEqual(['sys-line']);
    expect(lines.every((l) => l.text.length >= 0)).toBe(true);
  });

  it('8 类 kind 全覆盖冒烟（混合 fixture 中逐一出现）', () => {
    const items = build(
      { type: 'user/message', seq: 1, text: 'u' },
      { type: 'assistant/message', seq: 2, text: 'a', reasoning: 'r' },
      { type: 'tool/call', seq: 3, callId: 'c1', tool: 'read', args: '{}', summary: 'f' },
      { type: 'tool/result', callId: 'c1', ok: true, output: 'o1\no2' },
      { type: 'tool/call', seq: 4, callId: 's1', tool: 'subagent_start', args: '{"description":"d"}' },
      { type: 'tool/result', callId: 's1', tool: 'subagent_start', ok: false, error: 'e' },
      {
        type: 'tool/call',
        seq: 5,
        callId: 'c2',
        tool: 'edit',
        args: '{"file_path":"a.ts","old_text":"x","new_text":"y"}',
      },
      { type: 'tool/result', callId: 'c2', ok: true },
      { type: 'turn-partial', turnId: 't1', text: 'p', error: 'err' },
      { type: 'system', id: 'sys', text: 's' },
    );
    // item 下标：0 user / 1 assistant / 2 tool:c1 / 3 tool:s1 / 4 tool:c2(edit) / 5 partial / 6 system
    // 展开下标 4（edit）→ diff 可见；assistant 推理走默认折叠
    const all = projectTranscript(items, { collapsed: new Set([4]) });
    const seen = new Set(kinds(all));
    for (const k of ['user', 'assistant', 'tool', 'tool-result', 'reasoning', 'subagent', 'system', 'diff']) {
      expect(seen.has(k)).toBe(true);
    }
  });

  it('空 items：返回空数组', () => {
    expect(projectTranscript([])).toEqual([]);
  });
});

describe('性能冒烟', () => {
  function bulkItems(n: number): TranscriptItem[] {
    const items: TranscriptItem[] = [];
    for (let i = 0; i < n; i += 1) {
      switch (i % 5) {
        case 0:
          items.push({ kind: 'user', id: `user:${i}`, seq: i, text: `问题 ${i}：请处理这批数据` });
          break;
        case 1:
          items.push({
            kind: 'assistant',
            id: `assistant:${i}`,
            seq: i,
            text: `回答 ${i}：${'x'.repeat(80)}`,
            outcome: 'final',
            reasoning: '推理'.repeat(60),
          });
          break;
        case 2:
          items.push({
            kind: 'tool',
            id: `tool:${i}`,
            callId: `c${i}`,
            tool: 'read',
            summary: `src/file-${i}.ts`,
            status: 'ok',
            output: 'line1\nline2\nline3',
          });
          break;
        case 3:
          items.push({ kind: 'system', id: `system:${i}`, text: `系统事件 ${i}` });
          break;
        default:
          items.push({ kind: 'assistant', id: `a2:${i}`, seq: i, text: `正文段落 ${i}`, outcome: 'final' });
      }
    }
    return items;
  }

  it('10k item 全量投影 < 200ms（报警级阈值）', () => {
    const items = bulkItems(10000);
    // 预热一次（JIT），再计量
    projectTranscript(items);
    const t0 = performance.now();
    const lines = projectTranscript(items);
    const ms = performance.now() - t0;
    expect(lines.length).toBeGreaterThan(10000);
    expect(ms).toBeLessThan(200);
  });

  it('10k item lineIndex 首/中/尾抽查正确', () => {
    const items = bulkItems(10000);
    const lines = projectTranscript(items);
    expect(lines[0]?.lineIndex).toBe(0);
    expect(lines[0]?.kind).toBe('user');
    const mid = lines.find((l) => l.lineIndex === 5000);
    expect(mid).toBeDefined();
    const lastUser = lines.filter((l) => l.lineIndex === 9996);
    expect(lastUser.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.lineIndex).toBeGreaterThanOrEqual(0);
  });
});

// —— P3-D：subagent 耗时 + 运行 spinner（2026-09-12）——
describe('projectTranscript：subagent 耗时（P3-D）', () => {
  const call = {
    type: 'tool/call' as const,
    seq: 1,
    callId: 's1',
    tool: 'subagent_start',
    args: '{"description":"调查 bug"}',
  };
  const okResult = {
    type: 'tool/result' as const,
    callId: 's1',
    tool: 'subagent_start',
    ok: true,
    output: '{"childSessionId":"child-1"}',
  };

  it('durations 命中：`⏺ Subagent "调查 bug" 完成（43s）`（对齐 grok completed in 43s）', () => {
    const lines = projectTranscript(build(call, okResult), { durations: new Map([['s1', 43]]) });
    expect(lines[0]?.text).toBe('⏺ Subagent "调查 bug" 完成（43s）');
  });

  it('durations 未命中该 callId：不显示耗时（不伪造）', () => {
    const lines = projectTranscript(build(call, okResult), { durations: new Map([['other', 43]]) });
    expect(lines[0]?.text).toBe('⏺ Subagent "调查 bug" 完成');
  });

  it('不传 durations：保持既有文案（回归）', () => {
    const lines = projectTranscript(build(call, okResult));
    expect(lines[0]?.text).toBe('⏺ Subagent "调查 bug" 完成');
  });

  it('≥60s：分钟格式 `（1m35s）`', () => {
    const lines = projectTranscript(build(call, okResult), { durations: new Map([['s1', 95]]) });
    expect(lines[0]?.text).toBe('⏺ Subagent "调查 bug" 完成（1m35s）');
  });

  it('failed 命中：`⏺ Subagent "续跑" 失败（43s）`', () => {
    const lines = projectTranscript(
      build(
        { type: 'tool/call' as const, seq: 3, callId: 's2', tool: 'subagent_continue', args: '{"description":"续跑"}' },
        { type: 'tool/result' as const, callId: 's2', tool: 'subagent_continue', ok: false, error: 'boom\nstack' },
      ),
      { durations: new Map([['s2', 43]]) },
    );
    expect(lines[0]?.text).toBe('⏺ Subagent "续跑" 失败（43s）');
  });

  it('普通工具不受 durations 影响（耗时只对子代理块显示）', () => {
    const lines = projectTranscript(
      build(
        { type: 'tool/call' as const, seq: 4, callId: 'r1', tool: 'read', args: '{"file_path":"a.txt"}' },
        { type: 'tool/result' as const, callId: 'r1', tool: 'read', ok: true, output: 'hi' },
      ),
      { durations: new Map([['r1', 43]]) },
    );
    expect(lines[0]?.text).toBe('⏺ read(a.txt)');
    expect(lines[1]?.text).not.toContain('43');
  });
});

describe('projectTranscript：subagent 运行 spinner（P3-D）', () => {
  const call = {
    type: 'tool/call' as const,
    seq: 1,
    callId: 's1',
    tool: 'subagent_start',
    args: '{"description":"调查 bug"}',
  };
  const okResult = {
    type: 'tool/result' as const,
    callId: 's1',
    tool: 'subagent_start',
    ok: true,
    output: '{"childSessionId":"child-1"}',
  };

  it('运行中 + spinner：指示字符替换 ⏺ 前缀', () => {
    const lines = projectTranscript(build(call), { spinner: '⠋' });
    expect(lines[0]?.text).toBe('⠋ Subagent "调查 bug" 运行中');
  });

  it('运行中无 spinner：保持 ⏺ 前缀（回归）', () => {
    const lines = projectTranscript(build(call));
    expect(lines[0]?.text).toBe('⏺ Subagent "调查 bug" 运行中');
  });

  it('spinner 只作用于运行中子代理行（完成行/普通工具行不变）', () => {
    const lines = projectTranscript(
      build(call, okResult, {
        type: 'tool/call' as const,
        seq: 2,
        callId: 's3',
        tool: 'subagent_start',
        args: '{"description":"二号"}',
      }),
      { spinner: '◐', durations: new Map([['s1', 12]]) },
    );
    expect(lines[0]?.text).toBe('⏺ Subagent "调查 bug" 完成（12s）');
    expect(lines[2]?.text).toBe('◐ Subagent "二号" 运行中');
  });
});
