// 引用块构造（Z4-02 / Z4-03 共用纯函数）：格式、路径边界、行号越界的如实处理。
import { describe, expect, it } from 'vitest';
import { buildFileQuote, buildQuoteBlock, buildTranscriptQuote } from '../src/shared/quote-block.js';

describe('buildQuoteBlock（底层构造）', () => {
  it('单行：定位头（行内代码）+ `> ` 逐行前缀', () => {
    expect(buildQuoteBlock({ source: 'src/a.ts:3', text: 'const x = 1' })).toBe('`src/a.ts:3`\n> const x = 1');
  });

  it('多行：逐行 `> ` 前缀；内部空行以裸 `>` 保持块连续', () => {
    expect(buildQuoteBlock({ source: 'src/a.ts:3-5', text: 'a\n\nb' })).toBe('`src/a.ts:3-5`\n> a\n>\n> b');
  });

  it('结尾空行丢弃（引用块不留尾部噪声）', () => {
    expect(buildQuoteBlock({ source: 's', text: 'a\n\n\n' })).toBe('`s`\n> a');
  });

  it('行尾 \\r 剥离（CRLF 内容来自文件读取/选区复制）', () => {
    expect(buildQuoteBlock({ source: 's', text: 'a\r\nb\r' })).toBe('`s`\n> a\n> b');
  });

  it('空白文本 → null（无可引用内容）；空白定位头 → null', () => {
    expect(buildQuoteBlock({ source: 's', text: '  \n\t ' })).toBeNull();
    expect(buildQuoteBlock({ source: '   ', text: 'a' })).toBeNull();
  });

  it('定位头含反引号 → 定界符升级为双反引号（CommonMark code span）', () => {
    // 内容不以反引号开头 / 结尾 → 无需补空格，双反引号定界即可包住内容里的单反引号
    expect(buildQuoteBlock({ source: 'we`ird.ts:1', text: 'x' })).toBe('``we`ird.ts:1``\n> x');
    // 内容以反引号结尾 → 两侧各补一个空格（否则定界歧义）
    expect(buildQuoteBlock({ source: 'path`', text: 'x' })).toBe('`` path` ``\n> x');
  });
});

describe('buildFileQuote（文件行引用，Z4-02）', () => {
  const lines = ['alpha', 'beta', 'gamma'];

  it('单行：`路径:行号`（定位头不带区间）', () => {
    expect(buildFileQuote({ path: 'src/a.ts', lines, startLine: 2 })).toBe('`src/a.ts:2`\n> beta');
  });

  it('跨行：`路径:起-止` + 逐行前缀', () => {
    expect(buildFileQuote({ path: 'src/a.ts', lines, startLine: 1, endLine: 3 })).toBe(
      '`src/a.ts:1-3`\n> alpha\n> beta\n> gamma',
    );
  });

  it('路径带反斜杠（Windows）原样进定位头（code span 内无需转义）', () => {
    expect(buildFileQuote({ path: 'src\\inner\\a.ts', lines, startLine: 1 })).toBe('`src\\inner\\a.ts:1`\n> alpha');
  });

  it('部分越界夹取到实际行数（end 超过末行 → 夹到末行）', () => {
    expect(buildFileQuote({ path: 'p', lines, startLine: 2, endLine: 99 })).toBe('`p:2-3`\n> beta\n> gamma');
  });

  it('整段越界 → null（请求第 5 行但文件只有 3 行，不伪造「最近的行」）', () => {
    expect(buildFileQuote({ path: 'p', lines, startLine: 5 })).toBeNull();
    expect(buildFileQuote({ path: 'p', lines, startLine: 5, endLine: 9 })).toBeNull();
  });

  it('start > end 按大小归一（引用区间与输入顺序无关）', () => {
    expect(buildFileQuote({ path: 'p', lines, startLine: 3, endLine: 1 })).toBe('`p:1-3`\n> alpha\n> beta\n> gamma');
  });

  it('非整数 / 非有限行号 → null；空路径 → null；空行文件 → null', () => {
    expect(buildFileQuote({ path: 'p', lines, startLine: 1.5 })).toBeNull();
    expect(buildFileQuote({ path: 'p', lines, startLine: Number.NaN })).toBeNull();
    expect(buildFileQuote({ path: '  ', lines, startLine: 1 })).toBeNull();
    expect(buildFileQuote({ path: 'p', lines: ['', '  '], startLine: 1 })).toBeNull();
  });
});

describe('buildTranscriptQuote（转录划词，Z4-03）', () => {
  it('user / assistant 来源行类型进定位头', () => {
    expect(buildTranscriptQuote({ origin: 'user', text: '这段报错是什么意思' })).toBe(
      '`对话选区（用户消息）`\n> 这段报错是什么意思',
    );
    expect(buildTranscriptQuote({ origin: 'assistant', text: '先看第一行\n再看第二行' })).toBe(
      '`对话选区（助手消息）`\n> 先看第一行\n> 再看第二行',
    );
  });

  it('空白选区 → null（无可引用内容）', () => {
    expect(buildTranscriptQuote({ origin: 'user', text: '   ' })).toBeNull();
  });
});
