// 帮助文本与大小写别名补口（P1-② 覆盖矩阵补缺，加性文件不改既有用例）：
//   既有 help-exit.test.ts 只抽查 HELP_TEXT 的 5 条命令行与说明区关键行；
//   既有 parse.test.ts 只在 splitCommandLine 层测 /HELP、在 parseCoreCommand 层测 /UNDO。
//   本文件补：
//   - HELP_TEXT 命令清单区逐条含全部 13 条命令 id（声明顺序，防漏登记）；
//   - 13 条命令大写输入经 parseCoreCommand 全管线解析为规范 id（含别名 /QUIT → exit）；
//   - /HELP /EXIT 大写输入经 runCoreCommand 分发（输出帮助 / 请求退出）；
//   - 大写未知命令的报错文案中命令词已小写归一。
import { describe, expect, it } from 'vitest';
import { CORE_COMMANDS, HELP_TEXT, parseCoreCommand, runCoreCommand } from '../../src/commands/index.js';
import { execCommand, makeRecordingCtx } from './helpers.js';

describe('HELP_TEXT 命令清单全覆盖', () => {
  it('清单区逐条含全部 13 条命令 id（声明顺序，/id 前缀）', () => {
    const listed = HELP_TEXT.split('\n')
      .filter((l) => l.startsWith('  /'))
      .map((l) => l.trim().split(/\s+/)[0]!.slice(1));
    expect(listed).toEqual(CORE_COMMANDS.map((c) => c.id));
    expect(listed).toHaveLength(13);
  });
});

describe('大小写不敏感（parseCoreCommand 全管线）', () => {
  it('13 条命令大写输入 → 解析为规范 id；大写别名 /QUIT → exit', () => {
    for (const c of CORE_COMMANDS) {
      expect(parseCoreCommand(`/${c.id.toUpperCase()}`)?.id).toBe(c.id);
    }
    expect(parseCoreCommand('/QUIT')?.id).toBe('exit');
    expect(parseCoreCommand('/Quit')?.raw).toBe('/quit'); // raw 保留原词（小写归一）
  });

  it('/HELP 输出 HELP_TEXT；/EXIT 请求退出（runCoreCommand 分发）', async () => {
    const helpCtx = makeRecordingCtx();
    await execCommand('/HELP', helpCtx);
    expect(helpCtx.lines).toEqual([HELP_TEXT]);

    const exitCtx = makeRecordingCtx();
    const parsed = parseCoreCommand('/EXIT');
    expect(parsed?.id).toBe('exit');
    void runCoreCommand(parsed!, exitCtx); // /exit 为同步 run（union 返回类型按仓库惯例 void 标注）
    expect(exitCtx.exitCalls.count).toBe(1);
    expect(exitCtx.lines).toEqual([]);
  });

  it('大写未知命令 → 报错文案中命令词已小写归一（未知命令 /nope）', async () => {
    const ctx = makeRecordingCtx();
    await execCommand('/NOPE x', ctx);
    expect(ctx.lines).toEqual(['未知命令 /nope（/help 查看命令列表）']);
  });
});
