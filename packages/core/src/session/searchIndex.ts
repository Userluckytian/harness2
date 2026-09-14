// H-11 会话全文检索（索引化）：把 manager.search 的线性子串扫描替换为倒排索引检索。
//
// 架构定位（ROADMAP D2：会话 = append-only JSONL 事件日志，索引是派生物）：
//   - 索引文件 `search.index.json` 位于会话目录内、与 session.v1.jsonl 同级，
//     **绝不回改事实源**：本模块只读日志、只写自己的索引文件（零 writer 触点）；
//   - 索引可随时删除/重建，重建结果与增量维护结果逐字节一致（测试断言）；
//   - 索引不入导出白名单（export.ts 结构冻结）——派生物不是资产。
//
// 依赖政策：不引入任何新依赖（无 SQLite/FTS5）。倒排索引为自研纯 TS 实现：
//   tokenize（NFKC + 小写 + CJK 单字/双字）→ postings（token → 消息序号，升序去重）；
//   检索时只在命中候选行做定点读取（readSync(offset)）取原文片段。
//
// 增量语义（append-only 日志红利）：索引记录 consumedBytes（已消费到的字节偏移）与
// lastSeq；update() 只从 consumedBytes 向后扫描新行，新事件按同一个投影遮蔽算法判定
// 活动性，不重扫历史 → 增量不漏不重（测试用「增量结果 == 全量重建结果」钉死）。
// 文件变小（截断/回退/替换）或遇到撕裂行 → 自动全量重建（派生索引允许丢弃重来）。
//
// 遮蔽（rewind/marker）等价性：消息活动性由 markers 的区间规则重算——
//   标记遮蔽「标记之前已出现且 seq > rewindToSeq」的非标记事件，本模块只关心消息，
//   故按消息 seq 区间 [first, last] 求并集；redo 标记额外中立化 seq = rewindToSeq+1
//   处的标记（与 reader.computeProjection 同口径，测试用合成 rewind 日志做等价断言）。
//
// LLM 摘要（H-11 的「+ LLM 摘要」部分）：core 内**不硬编模型调用**。调用方注入
// `SearchHitSummarizer` 回调；未注入（或注入方抛错/返回空）时如实降级为原文片段拼接。
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SESSION_LOG_FILE, parseEventLine } from './types.js';
import type { ProjectionRole } from './reader.js';

/** 倒排索引文件名（位于会话目录内；派生物，可删可重建，不入导出包） */
export const SEARCH_INDEX_FILE = 'search.index.json';

/** 索引格式代际（与日志代际解耦：索引可重建，升级即重建） */
export const SEARCH_INDEX_VERSION = 1;

/** 单条消息的索引元数据（不含原文，原文经 offset 定点读取） */
export interface IndexedMessage {
  /** 事件 seq（与投影一致） */
  seq: number;
  ts: string;
  role: ProjectionRole;
  /** 行首字节偏移（相对日志文件起点） */
  offset: number;
  /** 行字节长度（不含换行符） */
  bytes: number;
  /** 该消息贡献的 token 数（长度归一化打分用） */
  tokenCount: number;
}

/** 回退标记的索引投影（只需三个字段即可重算遮蔽区间） */
export interface IndexedMarker {
  seq: number;
  rewindToSeq: number;
  /** reason 以 'redo' 开头（redo 链中立化语义） */
  redo: boolean;
}

/** 索引文件内容（JSON 持久化形状；字段顺序固定便于 diff 与字节幂等） */
export interface SessionSearchIndexData {
  v: typeof SEARCH_INDEX_VERSION;
  /** 会话 id（header.sessionId；缺头时回退目录名） */
  sessionId: string;
  /** 已消费字节偏移（含最后一个换行符）；update() 从这里继续 */
  consumedBytes: number;
  /** 索引时的日志字节数（与 consumedBytes 相等即无待消费尾部） */
  logBytes: number;
  /** 已索引的最后一个事件 seq（0 = 空） */
  lastSeq: number;
  /** 构建时跳过的非法行数（0 表示事实源健康；>0 时检索结果按「跳过」口径登记） */
  badLines: number;
  messages: IndexedMessage[];
  markers: IndexedMarker[];
  /** token → 消息下标（升序、去重） */
  postings: Record<string, number[]>;
}

/** 检索命中（角色/seq/片段/相对得分） */
export interface IndexedSearchHit {
  seq: number;
  role: ProjectionRole;
  /** 命中得分（同一次检索内可比：命中 token 数、词频与长度归一化） */
  score: number;
  /** 命中片段（≤ SESSION_SEARCH_SNIPPET_CHARS 字符） */
  snippet: string;
  /** 命中的查询 token（去重，保持查询顺序） */
  matchedTokens: string[];
}

/** 单会话索引检索结果 */
export interface IndexedSearchResult {
  sessionId: string;
  query: string;
  /** 查询分词结果（去重后；空数组 = 查询无有效 token） */
  tokens: string[];
  /** 索引中的消息总数 */
  totalMessages: number;
  /** 活动（未被 rewind 遮蔽）消息数 */
  activeMessages: number;
  hits: IndexedSearchHit[];
}

export interface IndexedSearchOptions {
  /** 返回命中上限（缺省 20） */
  limit?: number;
  /** 多 token 语义：'and'（缺省，全部 token 命中——对齐 FTS5 默认） / 'or' */
  mode?: 'and' | 'or';
}

/** 命中片段宽度（与 manager.SUMMARY_TEXT_MAX 同为 60 字，保持壳渲染一致） */
export const SESSION_SEARCH_SNIPPET_CHARS = 60;

/** 单条消息索引的 token 上限（防病态输入把索引撑爆；超出部分丢弃，不影响可达性） */
export const MAX_TOKENS_PER_MESSAGE = 2000;

/** 单 token 最大字符数（超长 run 截断；避免唯一长串写满索引） */
export const MAX_TOKEN_CHARS = 64;

// —— 分词 ——

const LATIN_RUN_RE = /[\p{L}\p{N}_]+/gu;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function isCjk(ch: string): boolean {
  return CJK_RE.test(ch);
}

/**
 * 会话文本分词（确定性命中口径，索引与查询共用）：
 *   - NFKC 归一 + 小写（全角/半角、大小写不影响命中）；
 *   - ASCII/拉丁/数字/下划线的连续 run → 一个词（截断到 MAX_TOKEN_CHARS）；
 *   - CJK run → **单字 + 相邻双字**（无分词器依赖下的中文可检索性折中）：
 *     「会话压缩」→ 会/话/压/缩/会话/话压/压缩；
 *   - 其余标点/空白为分隔符；不产生单字符的非 CJK token。
 */
export function tokenizeSessionText(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];
  for (const match of normalized.matchAll(LATIN_RUN_RE)) {
    const run = match[0];
    let segment = '';
    let cjkRun = '';
    const flushWord = (): void => {
      if (segment.length > 0) tokens.push(segment.slice(0, MAX_TOKEN_CHARS));
      segment = '';
    };
    const flushCjk = (): void => {
      for (let i = 0; i < cjkRun.length; i++) {
        tokens.push(cjkRun[i]!);
        const pair = cjkRun.slice(i, i + 2);
        if (pair.length === 2) tokens.push(pair);
      }
      cjkRun = '';
    };
    for (const ch of run) {
      if (isCjk(ch)) {
        flushWord();
        cjkRun += ch;
      } else {
        flushCjk();
        segment += ch;
      }
    }
    flushWord();
    flushCjk();
  }
  return tokens;
}

/** 查询分词（去重、保持先后顺序；空 token 丢弃） */
export function tokenizeQuery(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenizeSessionText(query)) {
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// —— 遮蔽（rewind/marker）区间重算 ——

/** 二分：首个 seq > n 的消息下标 */
function lowerBound(messages: readonly IndexedMessage[], n: number): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid]!.seq > n) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** 二分：首个 seq >= n 的消息下标 */
function lowerBoundInclusive(messages: readonly IndexedMessage[], n: number): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid]!.seq >= n) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * 被 rewind/marker 遮蔽的消息下标集合。规则与 reader.computeProjection 等价：
 *   规则 r（标记 seq = mS、rewindToSeq = n）遮蔽消息区间 [首个 seq > n, 末尾 seq < mS]；
 *   redo 标记（reason 以 'redo' 开头）额外中立化「seq = n + 1 的标记规则」（仅中立化
 *   在其之前出现的规则——按日志顺序处理），其余标记永不复活已被遮蔽的消息。
 */
export function computeShadowedMessageIndexes(
  messages: readonly IndexedMessage[],
  markers: readonly IndexedMarker[],
): Set<number> {
  interface Rule {
    seq: number;
    from: number;
    to: number; // 含；to < from 表示空区间
    neutralized: boolean;
  }
  const rules: Rule[] = [];
  for (const marker of markers) {
    if (marker.redo) {
      const victimSeq = marker.rewindToSeq + 1;
      for (const rule of rules) {
        if (rule.seq === victimSeq) rule.neutralized = true;
      }
    }
    const from = lowerBound(messages, marker.rewindToSeq);
    const to = lowerBoundInclusive(messages, marker.seq) - 1;
    rules.push({ seq: marker.seq, from, to, neutralized: false });
  }
  const shadowed = new Set<number>();
  for (const rule of rules) {
    if (rule.neutralized) continue;
    for (let i = rule.from; i <= rule.to && i < messages.length; i++) {
      if (i >= 0) shadowed.add(i);
    }
  }
  return shadowed;
}

// —— 索引构建 ——

interface CollectResult {
  /** 已消费字节偏移（含最后一个换行符） */
  consumed: number;
  /** 跳过的非法行数 */
  badLines: number;
  /** 是否存在「无法安全消费的尾部」（未终止尾行或非法行）——增量路径据此转全量重建 */
  torn: boolean;
}

/**
 * 从字节缓冲收集索引条目（纯函数：不触碰文件系统；offset/bytes 为绝对偏移）。
 * `tolerateBadLines`：全量重建路径为 true（与 reader.loadSession 同款「非法行跳过并计数」），
 * 增量路径为 false（遇到非法行即停止消费，交由调用方全量重建，保证与事实源同口径）。
 */
function collectFromBuffer(
  buf: Buffer,
  base: number,
  messages: IndexedMessage[],
  markers: IndexedMarker[],
  opts: { tolerateBadLines: boolean },
): CollectResult {
  let pos = 0;
  let consumed = 0;
  let badLines = 0;
  let torn = false;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) {
      torn = true; // 未以 \n 终止的尾行 = 未提交（writer「换行即提交」语义），留待下次
      break;
    }
    const lineStart = pos;
    const lineBuf = buf.subarray(lineStart, nl);
    const event = lineBuf.length > 0 ? parseEventLine(lineBuf.toString('utf8')) : null;
    if (lineBuf.length > 0 && event === null) {
      badLines += 1;
      if (!opts.tolerateBadLines) {
        torn = true;
        break;
      }
    }
    if (event !== null) {
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        messages.push({
          seq: event.seq,
          ts: event.ts,
          role: event.type === 'user/message' ? 'user' : 'assistant',
          offset: base + lineStart,
          bytes: lineBuf.length,
          tokenCount: Math.min(tokenizeSessionText(event.payload.text).length, MAX_TOKENS_PER_MESSAGE),
        });
      } else if (event.type === 'rewind/marker') {
        markers.push({
          seq: event.seq,
          rewindToSeq: event.payload.rewindToSeq,
          redo: (event.payload.reason ?? '').startsWith('redo'),
        });
      }
    }
    consumed = nl + 1;
    pos = nl + 1;
  }
  return { consumed, badLines, torn };
}

/** 取最大 seq（大数组避免 Math.max(...spread) 的栈风险） */
function maxSeq(messages: readonly IndexedMessage[], floor: number): number {
  let max = floor;
  for (const m of messages) if (m.seq > max) max = m.seq;
  return max;
}

/** 由消息文本重建 postings（增量路径下只对新消息调用） */
function addPostings(
  postings: Map<string, number[]>,
  messages: readonly IndexedMessage[],
  startIndex: number,
  texts: readonly string[],
): void {
  for (let k = 0; k < texts.length; k++) {
    const idx = startIndex + k;
    const tokens = tokenizeSessionText(texts[k]!);
    const pushed = new Set<string>();
    let count = 0;
    for (const token of tokens) {
      if (count >= MAX_TOKENS_PER_MESSAGE) break;
      count += 1;
      if (pushed.has(token)) continue;
      pushed.add(token);
      const list = postings.get(token);
      if (list === undefined) postings.set(token, [idx]);
      else if (list[list.length - 1] !== idx) list.push(idx);
    }
  }
}

function serializePostings(postings: Map<string, number[]>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const key of [...postings.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[key] = postings.get(key)!;
  }
  return out;
}

/** 全量重建：逐字节扫描日志（撕裂行跳过并计数），返回索引数据（不落盘） */
function buildFromLog(dir: string): SessionSearchIndexData {
  const logPath = join(dir, SESSION_LOG_FILE);
  if (!existsSync(logPath)) {
    throw new Error(`session log not found: ${logPath}`);
  }
  const buf = readFileSync(logPath);
  const messages: IndexedMessage[] = [];
  const markers: IndexedMarker[] = [];
  const collected = collectFromBuffer(buf, 0, messages, markers, { tolerateBadLines: true });
  // 原文只在构建时读取一次（用于分词）；postings 只存下标，不存文本
  const texts = messages.map((m) => extractMessageText(buf.subarray(m.offset, m.offset + m.bytes).toString('utf8')));
  const postings = new Map<string, number[]>();
  addPostings(postings, messages, 0, texts);
  const header = readHeaderSessionId(dir);
  return {
    v: SEARCH_INDEX_VERSION,
    sessionId: header ?? basename(dir),
    consumedBytes: collected.consumed,
    logBytes: collected.consumed,
    lastSeq: maxSeq(messages, 0),
    badLines: collected.badLines,
    messages,
    markers,
    postings: serializePostings(postings),
  };
}

/** 从原始 JSONL 行取消息文本（解析失败返回空串——索引层已过滤过非法行） */
function extractMessageText(line: string): string {
  const event = parseEventLine(line);
  if (event === null) return '';
  if (event.type === 'user/message' || event.type === 'assistant/message') return event.payload.text;
  return '';
}

/** 读取 header 的 sessionId（只读首行） */
function readHeaderSessionId(dir: string): string | null {
  const logPath = join(dir, SESSION_LOG_FILE);
  if (!existsSync(logPath)) return null;
  const buf = readFileSync(logPath);
  const nl = buf.indexOf(0x0a);
  const line = (nl === -1 ? buf : buf.subarray(0, nl)).toString('utf8');
  const event = parseEventLine(line);
  return event?.type === 'session/header' ? event.payload.sessionId : null;
}

function isIndexData(obj: unknown): obj is SessionSearchIndexData {
  if (typeof obj !== 'object' || obj === null) return false;
  const d = obj as Partial<SessionSearchIndexData>;
  return (
    d.v === SEARCH_INDEX_VERSION &&
    typeof d.sessionId === 'string' &&
    typeof d.consumedBytes === 'number' &&
    typeof d.logBytes === 'number' &&
    typeof d.lastSeq === 'number' &&
    Array.isArray(d.messages) &&
    Array.isArray(d.markers) &&
    typeof d.postings === 'object' &&
    d.postings !== null
  );
}

/** 原子写索引（tmp + rename；索引损坏可重建，故写坏也不影响事实源） */
function writeIndexFile(indexPath: string, data: SessionSearchIndexData): void {
  mkdirSync(dirname(indexPath), { recursive: true });
  const tmp = `${indexPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`, 'utf8');
  try {
    renameSync(tmp, indexPath);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件清理失败不影响主错误
    }
    throw e;
  }
}

function readIndexFile(indexPath: string): SessionSearchIndexData | null {
  if (!existsSync(indexPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(indexPath, 'utf8'));
    return isIndexData(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 把消息下标映射为 postings（增量合并用） */
function postingsToMap(postings: Record<string, number[]>): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const [token, list] of Object.entries(postings)) map.set(token, [...list]);
  return map;
}

// —— 检索 ——

/** 定点读行（只读命中候选行的字节区间，不整文件读） */
function readLineAt(fd: number, offset: number, bytes: number): string {
  const buf = Buffer.alloc(bytes);
  const read = readSync(fd, buf, 0, bytes, offset);
  return buf.subarray(0, read).toString('utf8');
}

function normalizeSnippetText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 生成命中片段：优先定位完整查询（大小写不敏感），否则定位首个命中 token，再退行首 */
function buildSnippet(text: string, query: string, tokens: readonly string[]): string {
  const flat = normalizeSnippetText(text);
  const lower = flat.toLowerCase();
  let idx = query.length > 0 ? lower.indexOf(query.normalize('NFKC').toLowerCase()) : -1;
  if (idx === -1) {
    for (const token of tokens) {
      idx = lower.indexOf(token);
      if (idx !== -1) break;
    }
  }
  if (idx === -1) idx = 0;
  const start = Math.max(0, idx - 20);
  const slice = flat.slice(start);
  return slice.length <= SESSION_SEARCH_SNIPPET_CHARS ? slice : `${slice.slice(0, SESSION_SEARCH_SNIPPET_CHARS)}…`;
}

/** 命中打分：命中 token 数（主序）→ 词频 → 长度归一化（短消息优先），全部确定可复现 */
function scoreMessage(matched: number, occurrences: number, tokenCount: number): number {
  const lengthPenalty = Math.min(tokenCount, 400) / 400;
  return matched * 100 + Math.min(occurrences, 20) * 5 - lengthPenalty;
}

/**
 * 廉价格（只用索引元数据、零 IO）：命中 token 数 → 短消息优先。
 * 用途见 CANDIDATE_FACTOR 注释。
 */
function cheapScore(matchedTokens: number, tokenCount: number): number {
  return matchedTokens * 100 - Math.min(tokenCount, 400) / 400;
}

/**
 * 候选裁剪系数：候选集合可能远大于返回上限（合成基准里常见命中上千条），
 * 逐条 readSync 取原文会让时延随命中数线性增长——故先用**零 IO** 的廉价格取
 * 前 limit × 系数 个候选，再只为这些候选定点读行算精确得分与片段。
 * 读取量因此只与 limit 有关（与命中规模无关），检索时延有界。
 */
export const SEARCH_CANDIDATE_FACTOR = 5;

/**
 * 会话级倒排索引（一个实例绑定一个会话目录）。
 * 常驻内存缓存 + 日志字节数判新旧：日志增长 → 增量消费；变小/损坏 → 全量重建。
 * 任何时刻索引都只是日志的函数：`rebuild()` 的结果与增量维护结果一致（测试断言）。
 */
export class SessionSearchIndex {
  private cache: SessionSearchIndexData | null = null;

  constructor(readonly dir: string) {}

  get indexPath(): string {
    return join(this.dir, SEARCH_INDEX_FILE);
  }

  /** 加载（内存缓存 → 索引文件 → 全量重建），并顺带消费日志新增尾部 */
  load(): SessionSearchIndexData {
    if (this.cache !== null) return this.cache;
    const fromDisk = readIndexFile(this.indexPath);
    this.cache = fromDisk ?? buildFromLog(this.dir);
    if (fromDisk !== null && fromDisk.sessionId !== (readHeaderSessionId(this.dir) ?? basename(this.dir))) {
      this.cache = buildFromLog(this.dir); // 目录被复用/会话被替换 → 重建
    }
    return this.cache;
  }

  /** 日志当前字节数（不存在 → 0） */
  private logSize(): number {
    try {
      return statSync(join(this.dir, SESSION_LOG_FILE)).size;
    } catch {
      return 0;
    }
  }

  /**
   * 增量同步：把索引推进到日志当前末尾。返回增量统计。
   *   - 日志变小（截断/回退/替换）→ 全量重建；
   *   - 已消费位置起出现非法行（撕裂/损坏）→ 全量重建（只读容错，不修事实源）；
   *   - 否则只解析新增行（append-only 保证不漏不重）。
   */
  update(opts: { persist?: boolean } = {}): { added: number; rebuilt: boolean; index: SessionSearchIndexData } {
    const persist = opts.persist ?? true;
    const size = this.logSize();
    const current = this.load();
    if (size < current.consumedBytes) {
      const rebuilt = buildFromLog(this.dir);
      this.cache = rebuilt;
      if (persist) writeIndexFile(this.indexPath, rebuilt);
      return { added: rebuilt.messages.length, rebuilt: true, index: rebuilt };
    }
    if (size === current.consumedBytes) {
      if (persist && !existsSync(this.indexPath)) writeIndexFile(this.indexPath, current);
      return { added: 0, rebuilt: false, index: current };
    }
    const fd = openSync(join(this.dir, SESSION_LOG_FILE), 'r');
    const newMessages: IndexedMessage[] = [];
    const newMarkers: IndexedMarker[] = [];
    let collected: CollectResult;
    try {
      const tail = Buffer.alloc(size - current.consumedBytes);
      const read = readSync(fd, tail, 0, tail.length, current.consumedBytes);
      collected = collectFromBuffer(tail.subarray(0, read), current.consumedBytes, newMessages, newMarkers, {
        tolerateBadLines: false,
      });
    } finally {
      closeSync(fd);
    }
    if (collected.torn) {
      if (newMessages.length === 0 && newMarkers.length === 0) {
        // 尾部撕裂（未提交尾行 / 非法行）且无新条目：不改索引，等事实源推进（不做无谓重建）
        return { added: 0, rebuilt: false, index: current };
      }
      const rebuilt = buildFromLog(this.dir);
      this.cache = rebuilt;
      if (persist) writeIndexFile(this.indexPath, rebuilt);
      return { added: rebuilt.messages.length, rebuilt: true, index: rebuilt };
    }
    const next: SessionSearchIndexData = {
      ...current,
      consumedBytes: current.consumedBytes + collected.consumed,
      logBytes: current.consumedBytes + collected.consumed,
      messages: [...current.messages, ...newMessages],
      markers: [...current.markers, ...newMarkers],
      badLines: current.badLines + collected.badLines,
      lastSeq: maxSeq(newMessages, current.lastSeq),
    };
    if (newMessages.length > 0) {
      const postings = postingsToMap(current.postings);
      const fd2 = openSync(join(this.dir, SESSION_LOG_FILE), 'r');
      try {
        const texts = newMessages.map((m) => extractMessageText(readLineAt(fd2, m.offset, m.bytes)));
        addPostings(postings, next.messages, current.messages.length, texts);
      } finally {
        closeSync(fd2);
      }
      next.postings = serializePostings(postings);
    }
    this.cache = next;
    if (persist) writeIndexFile(this.indexPath, next);
    return { added: newMessages.length, rebuilt: false, index: next };
  }

  /** 全量重建（覆盖索引文件），返回新索引 */
  rebuild(): SessionSearchIndexData {
    const rebuilt = buildFromLog(this.dir);
    this.cache = rebuilt;
    writeIndexFile(this.indexPath, rebuilt);
    return rebuilt;
  }

  /** 删除索引文件（事实源不动）；重新检索会自动重建 */
  remove(): boolean {
    this.cache = null;
    if (!existsSync(this.indexPath)) return false;
    unlinkSync(this.indexPath);
    return true;
  }

  /** 检索（默认先增量同步，保证「刚追加的消息」可被命中且不漏不重） */
  search(query: string, opts: IndexedSearchOptions & { sync?: boolean } = {}): IndexedSearchResult {
    const sync = opts.sync ?? true;
    const index = sync ? this.update().index : this.load();
    return searchInIndex(index, this.dir, query, opts);
  }

  /** 索引规模（诊断/基准用） */
  stats(): { messages: number; tokens: number; indexBytes: number } {
    const index = this.load();
    let tokens = 0;
    for (const list of Object.values(index.postings)) tokens += list.length;
    let indexBytes: number;
    try {
      indexBytes = statSync(this.indexPath).size;
    } catch {
      indexBytes = 0; // 索引尚未落盘（内存态）
    }
    return { messages: index.messages.length, tokens, indexBytes };
  }
}

/** 在索引数据上执行检索（纯函数，可单测） */
export function searchInIndex(
  index: SessionSearchIndexData,
  dir: string,
  query: string,
  opts: IndexedSearchOptions = {},
): IndexedSearchResult {
  const tokens = tokenizeQuery(query);
  const limit = opts.limit ?? 20;
  const mode = opts.mode ?? 'and';
  const activeCount = index.messages.length - computeShadowedMessageIndexes(index.messages, index.markers).size;
  const base: IndexedSearchResult = {
    sessionId: index.sessionId,
    query,
    tokens,
    totalMessages: index.messages.length,
    activeMessages: activeCount,
    hits: [],
  };
  if (tokens.length === 0) return base;
  // 候选集合：每个 token 的 postings 求交（and）或并（or）
  const postingLists = tokens.map((t) => new Set(index.postings[t] ?? []));
  const first = postingLists[0]!;
  const candidates: number[] =
    mode === 'and'
      ? [...first].filter((idx) => postingLists.every((set) => set.has(idx))).sort((a, b) => a - b)
      : [...new Set(postingLists.flatMap((set) => [...set]))].sort((a, b) => a - b);
  if (candidates.length === 0) return base;
  const shadowed = computeShadowedMessageIndexes(index.messages, index.markers);
  const active = candidates.filter((idx) => !shadowed.has(idx));
  if (active.length === 0) return base;
  // 候选裁剪：廉价格（零 IO）排序后取前 limit × 系数，保证读取量有界（见 SEARCH_CANDIDATE_FACTOR）
  const shortlist = [...active]
    .sort((a, b) => {
      const ma = index.messages[a]!;
      const mb = index.messages[b]!;
      const delta = cheapScore(tokens.length, mb.tokenCount) - cheapScore(tokens.length, ma.tokenCount);
      return delta !== 0 ? delta : a - b;
    })
    .slice(0, Math.max(limit * SEARCH_CANDIDATE_FACTOR, limit));
  const fd = openSync(join(dir, SESSION_LOG_FILE), 'r');
  const scored: IndexedSearchHit[] = [];
  try {
    for (const idx of shortlist) {
      const m = index.messages[idx]!;
      const text = readLineAt(fd, m.offset, m.bytes);
      const event = parseEventLine(text);
      if (event === null || (event.type !== 'user/message' && event.type !== 'assistant/message')) continue;
      const body = event.payload.text;
      const normalized = body.normalize('NFKC').toLowerCase();
      const matchedTokens = tokens.filter((t) => normalized.includes(t));
      if (mode === 'and' && matchedTokens.length !== tokens.length) continue; // 兜底校验（index 与文本同源）
      let occurrences = 0;
      for (const t of matchedTokens) {
        let from = 0;
        for (;;) {
          const at = normalized.indexOf(t, from);
          if (at === -1) break;
          occurrences += 1;
          from = at + t.length;
        }
      }
      const flatTs = normalizeSnippetText(body);
      scored.push({
        seq: m.seq,
        role: m.role,
        score: scoreMessage(matchedTokens.length, occurrences, m.tokenCount),
        snippet: buildSnippet(flatTs, query, tokens),
        matchedTokens,
      });
    }
  } finally {
    closeSync(fd);
  }
  // 得分降序，同分按 seq 升序（确定序）
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.seq - b.seq));
  return { ...base, hits: scored.slice(0, limit) };
}

// —— 便捷函数 ——

/** 单会话检索（懒更新 + 增量同步；索引缺失/损坏自动重建） */
export function searchSessionIndex(dir: string, query: string, opts: IndexedSearchOptions = {}): IndexedSearchResult {
  return new SessionSearchIndex(dir).search(query, opts);
}

/** 全量重建单会话索引 */
export function rebuildSessionIndex(dir: string): SessionSearchIndexData {
  return new SessionSearchIndex(dir).rebuild();
}

/** 删除单会话索引文件（返回是否实际删除） */
export function removeSessionIndex(dir: string): boolean {
  return new SessionSearchIndex(dir).remove();
}

// —— 可选 LLM 摘要（注入式；core 不硬编模型调用） ——

/** 调用方注入的摘要函数（典型实现：包装 roles.small provider 的一次流式调用） */
export type SearchHitSummarizer = (input: {
  query: string;
  hits: Array<{ sessionId: string; snippet: string }>;
}) => Promise<string>;

export interface SearchSummaryResult {
  summary: string;
  /** 'llm' = 注入方产出；'snippets' = 未注入或注入方失败后的原文片段降级 */
  source: 'llm' | 'snippets';
  /** 降级原因（source='snippets' 且有注入方时给出；未注入时为 undefined） */
  fallbackReason?: string;
}

/**
 * 检索结果摘要：注入 summarizer 时用其结果（空结果/抛错 → 记录原因并降级），
 * 未注入时**如实降级**为命中原文片段拼接（不伪造摘要、不隐式调用模型）。
 */
export async function summarizeSearchResults(
  query: string,
  hits: Array<{ sessionId: string; snippet: string }>,
  opts: { summarizer?: SearchHitSummarizer } = {},
): Promise<SearchSummaryResult> {
  const fallback = (reason?: string): SearchSummaryResult => ({
    summary: hits.map((h) => `${h.sessionId}: ${h.snippet}`).join('\n'),
    source: 'snippets',
    ...(reason !== undefined ? { fallbackReason: reason } : {}),
  });
  const summarizer = opts.summarizer;
  if (summarizer === undefined) return fallback();
  if (hits.length === 0) return { summary: '', source: 'snippets' };
  try {
    const summary = (await summarizer({ query, hits })).trim();
    if (summary.length === 0) return fallback('summarizer 返回空摘要');
    return { summary, source: 'llm' };
  } catch (e) {
    return fallback((e as Error | undefined)?.message ?? String(e));
  }
}
