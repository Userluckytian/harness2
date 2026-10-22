import { describe, expect, it } from 'vitest';
import { createBootTiming, parseBootTimingLine, formatBootTimingLine } from '../src/real/boot-timing.js';

describe('boot-timing (ZS5-T4)', () => {
  it('里程碑顺序与毫秒字段存在（mock 日志收集器）', () => {
    const collected: string[] = [];
    const nowValues = [10, 20, 35, 50];
    let i = 0;
    const timing = createBootTiming({
      now: () => nowValues[Math.min(i, nowValues.length - 1)] ?? 0,
      origin: 0,
      emit: (line) => collected.push(line),
    });

    // 模拟里程碑推进：每次 mark 前推进时钟指针
    const mark = (name: string) => {
      const ms = timing.mark(name);
      i += 1;
      return ms;
    };

    mark('module_load');
    mark('init_local');
    mark('database_ready');
    mark('services_ready');

    expect(collected).toHaveLength(4);
    // 顺序
    const names = collected.map((l) => parseBootTimingLine(l)?.name);
    expect(names).toEqual(['module_load', 'init_local', 'database_ready', 'services_ready']);

    // 毫秒字段存在且匹配格式
    for (const line of collected) {
      expect(line).toMatch(/^\[h2-boot-timing\] \S+ \+\d+ms$/);
      const parsed = parseBootTimingLine(line);
      expect(parsed).not.toBeNull();
      expect(typeof parsed!.ms).toBe('number');
      expect(parsed!.ms).toBeGreaterThanOrEqual(0);
    }

    // 时序单调（非严格递减）
    const ms = collected.map((l) => parseBootTimingLine(l)!.ms);
    for (let k = 1; k < ms.length; k++) {
      expect(ms[k]).toBeGreaterThanOrEqual(ms[k - 1]);
    }
  });

  it('毫秒为非负整数，origin 缺省用 now()', () => {
    const collected: string[] = [];
    const timing = createBootTiming({ emit: (l) => collected.push(l) });
    // now 默认 performance.now；mark 一次
    const ms = timing.mark('x');
    expect(Number.isInteger(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(collected[0]).toBe(formatBootTimingLine('x', ms));
  });

  it('emit 抛错不炸 host', () => {
    const timing = createBootTiming({
      now: () => 5,
      origin: 0,
      emit: () => {
        throw new Error('boom');
      },
    });
    expect(() => timing.mark('safe')).not.toThrow();
  });

  it('负/NaN 时钟被夹到 0', () => {
    const collected: string[] = [];
    const timing = createBootTiming({
      now: () => -100,
      origin: 0,
      emit: (l) => collected.push(l),
    });
    const ms = timing.mark('neg');
    expect(ms).toBe(0);
    expect(collected[0]).toContain('+0ms');
  });

  it('milestones 数组记录顺序', () => {
    const timing = createBootTiming({ now: () => 1, origin: 0 });
    timing.mark('a');
    timing.mark('b');
    expect(timing.milestones.map((m) => m.name)).toEqual(['a', 'b']);
  });

  it('parseBootTimingLine 解析失败返回 null', () => {
    expect(parseBootTimingLine('no timing here')).toBeNull();
    expect(parseBootTimingLine('[h2-boot-timing] foo +12ms')).toEqual({ name: 'foo', ms: 12 });
    // 畸形输入
    expect(parseBootTimingLine('[h2-boot-timing] foo 12ms')).toBeNull(); // 缺 +
    expect(parseBootTimingLine('[h2-boot-timing] foo -5ms')).toBeNull(); // 负数
    expect(parseBootTimingLine('[h2-boot-timing] foo + 12ms')).toBeNull(); // 多空格
    expect(parseBootTimingLine('')).toBeNull(); // 空串
  });
});
