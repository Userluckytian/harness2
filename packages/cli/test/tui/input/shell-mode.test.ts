// shell-mode 单测：G-11 行首 `!` 检测与命令提取，含全部转义边界（边界定义见 shell-mode.ts 文件头）。
import { describe, expect, it } from 'vitest';
import {
  detectShellMode,
  formatShellHistoryEntry,
  isShellMode,
  parseShellHistoryEntry,
} from '../../../src/tui/input/shell-mode.js';

describe('G-11 触发：草稿第一个字符是 ASCII `!`', () => {
  it('`!cmd` 直接触发，命令 = 剩余部分', () => {
    expect(detectShellMode('!ls -la')).toEqual({ shell: true, command: 'ls -la', notShellReason: null });
  });

  it('`! cmd`（空格分隔）触发，命令剥一个空白分隔符', () => {
    expect(detectShellMode('! git status')).toEqual({ shell: true, command: 'git status', notShellReason: null });
  });

  it('`!  cmd`（两个空格）：只剥一个分隔符，第二个空格归命令（对齐上游 strip_prefix("! ") 口径）', () => {
    expect(detectShellMode('!  echo hi')).toEqual({ shell: true, command: ' echo hi', notShellReason: null });
  });

  it('多行草稿：第一字符触发即整段进 shell（命令含换行，支持多行脚本）', () => {
    expect(detectShellMode('!for i in 1 2; do\n  echo $i\ndone')).toEqual({
      shell: true,
      command: 'for i in 1 2; do\n  echo $i\ndone',
      notShellReason: null,
    });
  });

  it('isShellMode 便捷判断', () => {
    expect(isShellMode('!pwd')).toBe(true);
    expect(isShellMode('pwd')).toBe(false);
  });
});

describe('G-11 转义边界', () => {
  it('`!!` 前缀 = 字面文本（转义口），任何后缀都不触发', () => {
    expect(detectShellMode('!!cmd').notShellReason).toBe('double-bang-escape');
    expect(detectShellMode('!!').notShellReason).toBe('double-bang-escape');
    expect(detectShellMode('!! 这不是命令').shell).toBe(false);
  });

  it('空草稿不触发', () => {
    expect(detectShellMode('')).toEqual({ shell: false, command: '', notShellReason: 'empty' });
  });

  it('只有 `!` 或 `!`+纯空白：不触发（无可执行物）', () => {
    expect(detectShellMode('!').notShellReason).toBe('blank-command');
    expect(detectShellMode('!   ').notShellReason).toBe('blank-command');
    expect(detectShellMode('! \n \n').notShellReason).toBe('blank-command');
  });

  it('首字符之外的 `!` 不触发（` !cmd`、`hello !`、多行第二行行首）', () => {
    expect(detectShellMode(' !cmd').notShellReason).toBe('first-char-not-bang');
    expect(detectShellMode('hello ! world').notShellReason).toBe('first-char-not-bang');
    expect(detectShellMode('hello\n!cmd').notShellReason).toBe('first-char-not-bang');
  });

  it('全角 `！`（U+FF01）不触发（shell 语法只认 ASCII）', () => {
    expect(detectShellMode('！ls').notShellReason).toBe('fullwidth-bang');
  });
});

describe('G-11 历史条目口径（上游 `! cmd` 存储形态）', () => {
  it('format → parse 往返还原命令', () => {
    const entry = formatShellHistoryEntry('git status');
    expect(entry).toBe('! git status');
    expect(parseShellHistoryEntry(entry)).toBe('git status');
  });

  it('普通模型消息不带前缀，parse 返回 null（恢复时走 Normal 模式）', () => {
    expect(parseShellHistoryEntry('hello world')).toBeNull();
    expect(parseShellHistoryEntry('!!literal')).toBeNull(); // `!!` 开头不是 `! ` 前缀
  });
});
