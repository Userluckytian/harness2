// T2-3 测试辅助：确定性合成转录生成器。
// 移植自 spike/tui-renderer-spike/common/generate-transcript.mjs（P0 spike 共享数据源），
// 该文件不在本 worktree，故内嵌同款逻辑：mulberry32 seeded PRNG，同参数输出逐字节一致。
// 构成：60% ASCII 散文 / 20% CJK / 10% emoji+混合 / 10% 200~400 字符长行（测换行与宽字符测量）。

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASCII_WORDS =
  'the renderer scrolls transcript buffer diff cell grid frame budget latency throughput virtualization viewport anchor sticky follow momentum inertia flicker tear resize alternate screen cursor report sequence grade compile bundle package install license native binding'.split(
    ' ',
  );
const CJK_SENTENCES = [
  '渲染层选型需要实测数据支撑，不能只看社区口碑。',
  '终端本质是字符网格，宽字符占两列，断行时不能切开。',
  '滚动模型要区分跟随、锚定与粘性三种状态。',
  '输入框恒定贴底，弹层锚定在输入框上方。',
  '鼠标滚轮在任意区域滚动转录，悬停下拉时改选。',
  '子代理块运行时有动画，完成后按成功失败着色。',
  '异常退出必须恢复鼠标上报与光标状态。',
  '一万行转录下滚动帧耗要低于三十三毫秒。',
];
const EMOJI = ['✅', '⏺', '🐛', '⚠️', '🚀', '🇨🇳', '👍', '🎉'];

function asciiLine(rand: () => number): string {
  const n = 8 + Math.floor(rand() * 20);
  const parts: string[] = [];
  for (let i = 0; i < n; i += 1) parts.push(ASCII_WORDS[Math.floor(rand() * ASCII_WORDS.length)] ?? '');
  return parts.join(' ');
}

function cjkLine(rand: () => number): string {
  const n = 1 + Math.floor(rand() * 3);
  const parts: string[] = [];
  for (let i = 0; i < n; i += 1) parts.push(CJK_SENTENCES[Math.floor(rand() * CJK_SENTENCES.length)] ?? '');
  return parts.join('');
}

function emojiLine(rand: () => number): string {
  const e = EMOJI[Math.floor(rand() * EMOJI.length)] ?? '';
  return `${e} ${asciiLine(rand)} ${e} ${cjkLine(rand)}`;
}

function longLine(rand: () => number): string {
  const target = 200 + Math.floor(rand() * 200);
  let s = '';
  while (s.length < target) s += `${asciiLine(rand)} `;
  return s.slice(0, target);
}

const KINDS = [
  { w: 0.6, make: asciiLine },
  { w: 0.2, make: cjkLine },
  { w: 0.1, make: emojiLine },
  { w: 0.1, make: longLine },
];

/** 生成 n 行合成转录（默认 10000）。同 seed 输出一致。 */
export function generateLines(n = 10000, seed = 42): string[] {
  const rand = mulberry32(seed);
  const lines = new Array<string>(n);
  for (let i = 0; i < n; i += 1) {
    const r = rand();
    let acc = 0;
    for (const k of KINDS) {
      acc += k.w;
      if (r < acc) {
        lines[i] = k.make(rand);
        break;
      }
    }
  }
  return lines;
}
