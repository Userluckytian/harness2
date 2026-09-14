// 经验造技能（P7-A / H-22，对照 hermes `agent/curator.py`、`tools/skill_manager_tool.py`
// 与 `agent/learn_prompt.py` 的思想子集）：
//   提炼 → 结构化草稿 → 渲染带 frontmatter 的 SKILL.md → **人工审批** → 原子写回项目级技能目录。
// 为什么必须审批：skill 会持久化到用户磁盘，并进入后续每个 turn 的 system「[Skills 可用]」注入；
// 静默写入等于让模型改写自己的指令面——本模块只允许 propose（暂存）与 approve（显式放行）两段式，
// 工具面（skill_author）只做 propose，approve/reject 留给人类入口。
// 写盘前的防护（全部 fail-closed）：
//   1) 形状：name 必须 slug（禁路径分隔符 / 绝对路径）、description 单行且 ≤ 上限、正文非空；
//   2) 体积：整份 SKILL.md ≤ SKILL_MAX_CHARS（对照 hermes MAX_SKILL_CONTENT_CHARS 同量级）；
//      新增还受技能总数上限 SKILLS_MAX 约束（不得靠写入绕过扫描截断的上限）；
//   3) 密钥：候选文本过 redactSecrets，脱敏后与原文不一致即**拒绝**（宁可误杀长随机串，绝不落盘密钥）；
//   4) 路径：目标恒定 <root>/<name>/SKILL.md，resolve 后必须仍以 <root> 为前缀（禁任意路径写入）；
//      与同名单文件技能（<root>/<name>.md）撞名也拒绝，避免扫描出「层内重名」告警；
//   5) 来源：frontmatter 记录 derivedFrom（累计会话 id，去重保序）与 revision（自改进递增）、
//      createdAt/updatedAt——自改进保留「在哪些会话里提炼的、改过几版」的痕迹。
// 暂存区 = <root>/.pending/<id>.json（技能扫描只认 *.md 与 <dir>/SKILL.md，不会把 .json 当技能，
// 也不产生告警）；原子写 = 同目录 tmp + rename（与 MemoryStore 同口径）。
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { redactSecrets } from '../config/redact.js';
import type { ToolDefinition, ToolOutput } from '../tools/types.js';
import {
  SKILL_FILE_NAME,
  SKILLS_MAX,
  SkillStore,
  parseSkillFrontmatter,
  parseSkillFrontmatterFields,
} from './store.js';

/** 暂存区目录名（在技能根目录内，扫描忽略非 .md 内容） */
export const SKILL_PENDING_DIR_NAME = '.pending';

/** SKILL.md 全文上限（字符）：对照 hermes `MAX_SKILL_CONTENT_CHARS = 100_000` 同量级 */
export const SKILL_MAX_CHARS = 100_000;

/** description 单行上限（字符） */
export const SKILL_DESCRIPTION_MAX_CHARS = 500;

/** 技能名 slug：小写字母/数字开头，允许 . _ -，最长 64（禁路径分隔符与空白） */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 会话 id 形状（derivedFrom 的每一项） */
export const SKILL_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** 待审批提案上限（防无界堆积） */
export const SKILL_AUTHORING_MAX_PENDING = 50;

/** 工具名（三壳统一注册用；本人形如 create<X>Tool 的既有约定） */
export const SKILL_AUTHORING_TOOL_NAME = 'skill_author';

/**
 * 提炼阶段的一次性系统提示（对照 hermes `agent/learn_prompt.py` / `curator.py` 的
 * class-level skill 写作纪律）：由壳层挂在一次性提炼子会话上，模型把会话里的**可复用流程**
 * 经 skill_author 提交成提案。提炼本身不落盘、不建新事件类型——写入仍走审批两段式。
 */
export const SKILL_DISTILL_SYSTEM =
  '你是技能提炼助手。回顾给定的会话记录，判断其中是否有**可复用的工作流程**（而不是一次性事实或临时细节）：' +
  '有则调用 skill_author 提交一个技能——name 用短横线小写 slug；description 一行写清“何时该用”；' +
  'body 用 markdown 写触发条件、步骤与坑（具体到可照做，不要写成泛泛原则）；把来源会话 id 放进 derivedFrom。' +
  '同一类工作已经有一个技能时，用同名提交改进版（会保留来源并递增版本），而不是另建一个近义技能。' +
  '没有可复用流程就直接回复"无需提炼"。绝不把密钥、令牌、私有数据或大段原文抄进技能。';

/** 组装提炼用户消息（会话摘要 + 来源会话 id）；摘要复用调用方的确定性截断产物 */
export function buildSkillDistillPrompt(digest: string, sessionIds: readonly string[] = []): string {
  const ids = sessionIds.length > 0 ? sessionIds.join(', ') : '(未提供)';
  return `以下是需要提炼的会话记录（来源会话: ${ids}）：\n\n${digest}`;
}

/** 提炼输入：结构化草稿（写作侧只认这一种形状，渲染与校验同一出入口） */
export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  /** 提炼来源会话 id（可选；与既有技能的来源合并） */
  derivedFrom?: readonly string[];
}

/** 来源与修订痕迹（写进 frontmatter） */
export interface SkillProvenance {
  derivedFrom: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** 一条待审批的技能写回提案（暂存 JSON 的原样形状） */
export interface SkillProposal {
  /** 文件名去 .json 后缀：<epochMs>-<rand4> */
  id: string;
  createdAt: string;
  /** create = 新技能；update = 自改进既有技能（由磁盘现状判定，不由模型声明） */
  action: 'create' | 'update';
  name: string;
  /** 目标 SKILL.md 绝对路径（恒定在 root 内） */
  file: string;
  /** 审批通过后原样落盘的全文（含 frontmatter） */
  markdown: string;
  provenance: SkillProvenance;
}

export interface SkillAuthoringResult {
  ok: boolean;
  /** 失败原因（一行；已脱敏，不带密钥片段） */
  error?: string;
  /** propose 产出 / approve 回填 */
  proposal?: SkillProposal;
  /** approve 成功后的落盘路径 */
  path?: string;
}

/** 路径围栏：p 必须等于 root 或位于 root 之下（Windows 反斜杠同样适用） */
function isInside(root: string, p: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return p === root || p.startsWith(prefix);
}

/**
 * name → 目标 SKILL.md 路径；非法名称或越界路径直接抛错。
 * 双重防御：先按 slug 白名单拒绝（本就排除分隔符与 `..`），再对 resolve 结果做前缀校验。
 */
export function resolveSkillFilePath(root: string, name: string): string {
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `技能名必须是 slug（^[a-z0-9][a-z0-9._-]*$，最长 64，禁路径分隔符与空白）: ${JSON.stringify(name)}`,
    );
  }
  const rootResolved = resolve(root);
  const file = resolve(rootResolved, name, SKILL_FILE_NAME);
  if (!isInside(rootResolved, file)) {
    throw new Error(`技能路径越界（必须落在 ${rootResolved} 内）: ${file}`);
  }
  return file;
}

/** 渲染 SKILL.md（frontmatter + 正文）：写回的唯一序列化出口 */
export function renderSkillMarkdown(draft: SkillDraft, provenance: SkillProvenance): string {
  return [
    '---',
    `name: ${draft.name}`,
    `description: ${draft.description}`,
    `derivedFrom: ${provenance.derivedFrom.join(' ')}`,
    `revision: ${provenance.revision}`,
    `createdAt: ${provenance.createdAt}`,
    `updatedAt: ${provenance.updatedAt}`,
    '---',
    '',
    draft.body.replace(/\r\n/g, '\n').trim(),
    '',
  ].join('\n');
}

/** 读取既有技能的来源与修订痕迹（非 frontmatter / 缺字段时给保守缺省） */
export function parseSkillProvenance(raw: string): SkillProvenance | null {
  const fields = parseSkillFrontmatterFields(raw);
  if (fields === null) return null;
  const derivedFrom = (fields.get('derivedFrom') ?? '').split(/\s+/).filter((s) => s.length > 0);
  const revisionRaw = fields.get('revision') ?? '';
  const createdAt = fields.get('createdAt') ?? '';
  return {
    derivedFrom,
    revision: /^\d+$/.test(revisionRaw) ? Number.parseInt(revisionRaw, 10) : 1,
    createdAt,
    updatedAt: fields.get('updatedAt') ?? createdAt,
  };
}

/** 草稿形状校验；合法返回 null，非法返回一行原因（密钥检查也在此，fail-closed） */
export function validateSkillDraft(draft: SkillDraft): string | null {
  if (typeof draft !== 'object' || draft === null) return '草稿必须是对象';
  if (typeof draft.name !== 'string' || !SKILL_NAME_PATTERN.test(draft.name)) {
    return `name 必须是 slug（^[a-z0-9][a-z0-9._-]*$，最长 64，禁路径分隔符）: ${JSON.stringify(draft.name)}`;
  }
  if (typeof draft.description !== 'string' || draft.description.trim().length === 0) return 'description 不能为空';
  if (/[\r\n]/.test(draft.description)) return 'description 必须是单行（换行请写进正文）';
  if (draft.description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    return `description 超过上限 ${SKILL_DESCRIPTION_MAX_CHARS} 字符（实际 ${draft.description.length}）`;
  }
  if (typeof draft.body !== 'string' || draft.body.trim().length === 0) return 'body（技能正文）不能为空';
  if (draft.derivedFrom !== undefined) {
    if (!Array.isArray(draft.derivedFrom)) return 'derivedFrom 必须是字符串数组';
    for (const id of draft.derivedFrom) {
      if (typeof id !== 'string' || !SKILL_SESSION_ID_PATTERN.test(id)) {
        return `derivedFrom 含非法会话 id: ${JSON.stringify(id)}`;
      }
    }
  }
  // 密钥红线：description/body 过脱敏，脱敏后不一致即拒绝（不落盘、不进暂存）
  for (const [label, text] of [
    ['description', draft.description],
    ['body', draft.body],
  ] as const) {
    if (redactSecrets(text) !== text) {
      return `${label} 含疑似密钥/令牌（脱敏规则命中），已拒绝写入——请移除敏感值后重试`;
    }
  }
  return null;
}

function mergeDerivedFrom(existing: readonly string[], incoming: readonly string[], sessionId?: string): string[] {
  const out: string[] = [];
  for (const id of [...existing, ...incoming, ...(sessionId !== undefined ? [sessionId] : [])]) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function listJsonFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.json'));
}

function parseProposal(raw: string): SkillProposal | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o['action'] !== 'create' && o['action'] !== 'update') return null;
    for (const key of ['id', 'createdAt', 'name', 'file', 'markdown']) {
      if (typeof o[key] !== 'string') return null;
    }
    const p = o['provenance'];
    if (typeof p !== 'object' || p === null) return null;
    const prov = p as Record<string, unknown>;
    if (!Array.isArray(prov['derivedFrom']) || !prov['derivedFrom'].every((v) => typeof v === 'string')) return null;
    if (typeof prov['revision'] !== 'number') return null;
    if (typeof prov['createdAt'] !== 'string' || typeof prov['updatedAt'] !== 'string') return null;
    return {
      id: o['id'] as string,
      createdAt: o['createdAt'] as string,
      action: o['action'],
      name: o['name'] as string,
      file: o['file'] as string,
      markdown: o['markdown'] as string,
      provenance: {
        derivedFrom: prov['derivedFrom'] as string[],
        revision: prov['revision'],
        createdAt: prov['createdAt'],
        updatedAt: prov['updatedAt'],
      },
    };
  } catch {
    return null;
  }
}

export interface SkillAuthoringOptions {
  /** 暂存区根；缺省 <root>/.pending */
  pendingRoot?: string;
  /** SKILL.md 全文上限（字符）；缺省 SKILL_MAX_CHARS */
  maxChars?: number;
  /** 可注入时钟（测试用） */
  now?: () => Date;
}

/**
 * 经验造技能商店：propose（暂存）/ list / approve（显式放行后原子落盘）/ reject / clearAll。
 * 同进程互斥用 promise 链串行（读-改-写无交错窗口；跨进程不做，与 MemoryStore 同口径声明）。
 * root = 项目级技能目录（生产上 = projectSkillsRoot(cwd) = <cwd>/.harness2/skills）。
 */
export class SkillAuthoringStore {
  private chain: Promise<unknown> = Promise.resolve();
  /** 上次使用的毫秒（单调）：保证同毫秒内多次 propose 的 id/createdAt 严格递增 */
  private lastMs = 0;
  private readonly pendingRoot: string;
  private readonly maxChars: number;
  private readonly now: () => Date;

  constructor(
    readonly root: string,
    options: SkillAuthoringOptions = {},
  ) {
    this.pendingRoot = options.pendingRoot ?? join(root, SKILL_PENDING_DIR_NAME);
    this.maxChars = options.maxChars ?? SKILL_MAX_CHARS;
    this.now = options.now ?? (() => new Date());
  }

  private run<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    const next = this.chain.then(fn, fn) as Promise<T>;
    this.chain = next.catch(() => {});
    return next;
  }

  /** 现有技能数（交给扫描器数——它才是「什么算技能、上限怎么算」的权威） */
  private countSkills(): number {
    return new SkillStore(this.root, undefined).scan().skills.length;
  }

  /**
   * 提交一份提炼草稿（**只暂存，不落盘**）：
   * 形状/密钥校验 → 目标路径围栏 → 判定 create/update 并合并来源与修订号 → 渲染并回读校验
   * → 体积/上限校验 → 原子写暂存 JSON。任一步失败返回 ok:false，磁盘零改动。
   */
  propose(draft: SkillDraft, meta: { sessionId?: string } = {}): Promise<SkillAuthoringResult> {
    return this.run(() => {
      const shapeError = validateSkillDraft(draft);
      if (shapeError !== null) return { ok: false, error: shapeError };
      if (meta.sessionId !== undefined && !SKILL_SESSION_ID_PATTERN.test(meta.sessionId)) {
        return { ok: false, error: `sessionId 非法: ${JSON.stringify(meta.sessionId)}` };
      }
      let file: string;
      try {
        file = resolveSkillFilePath(this.root, draft.name);
      } catch (e) {
        return { ok: false, error: (e as Error)?.message ?? String(e) };
      }
      // 同名单文件技能（<root>/<name>.md）会与文件夹型撞名 → 直接拒绝，不制造「层内重名」告警
      const singleFile = join(resolve(this.root), `${draft.name}.md`);
      const existingRaw = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
      if (existingRaw === undefined && existsSync(singleFile)) {
        return {
          ok: false,
          error: `同名单文件技能已存在（${singleFile}）：请改名，或先迁移为 <name>/SKILL.md 再自改进`,
        };
      }
      if (existingRaw === undefined && this.countSkills() >= SKILLS_MAX) {
        return { ok: false, error: `技能数已达上限 ${SKILLS_MAX}（扫描会截断新增），请先整理既有技能` };
      }
      const nowIso = this.now().toISOString();
      const prev = existingRaw !== undefined ? parseSkillProvenance(existingRaw) : null;
      const provenance: SkillProvenance = {
        derivedFrom: mergeDerivedFrom(prev?.derivedFrom ?? [], draft.derivedFrom ?? [], meta.sessionId),
        revision: (prev?.revision ?? 0) + 1,
        createdAt: prev !== null && prev.createdAt.length > 0 ? prev.createdAt : nowIso,
        updatedAt: nowIso,
      };
      const markdown = renderSkillMarkdown(draft, provenance);
      const verify = parseSkillFrontmatter(markdown);
      if (verify === null || verify.name !== draft.name || verify.description !== draft.description) {
        return { ok: false, error: '渲染后的 frontmatter 无法被技能解析器读回（description 含特殊字符？）' };
      }
      if (markdown.length > this.maxChars) {
        return {
          ok: false,
          error: `SKILL.md 体积超限：${markdown.length} 字符 > 上限 ${this.maxChars}（请拆分或精简，禁止绕过体积限制）`,
        };
      }
      if (existsSync(this.pendingRoot) && listJsonFiles(this.pendingRoot).length >= SKILL_AUTHORING_MAX_PENDING) {
        return { ok: false, error: `待审批技能提案已达上限 ${SKILL_AUTHORING_MAX_PENDING} 条，请先 approve 或 reject` };
      }
      const ms = Math.max(Date.now(), this.lastMs + 1);
      this.lastMs = ms;
      const proposal: SkillProposal = {
        id: `${ms}-${randomBytes(2).toString('hex')}`,
        createdAt: nowIso,
        action: existingRaw !== undefined ? 'update' : 'create',
        name: draft.name,
        file,
        markdown,
        provenance,
      };
      const path = join(this.pendingRoot, `${proposal.id}.json`);
      if (existsSync(path)) return { ok: false, error: `暂存文件已存在: ${proposal.id}` };
      try {
        mkdirSync(this.pendingRoot, { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(proposal, null, 2), 'utf8');
        renameSync(tmp, path);
      } catch (e) {
        return { ok: false, error: `技能提案暂存失败: ${(e as Error)?.message ?? String(e)}` };
      }
      return { ok: true, proposal };
    });
  }

  /** 全部待审批提案（createdAt 升序，先到先审） */
  list(): Promise<SkillProposal[]> {
    return this.run(() => {
      if (!existsSync(this.pendingRoot)) return [];
      const items: SkillProposal[] = [];
      for (const name of listJsonFiles(this.pendingRoot)) {
        const parsed = parseProposal(readFileSync(join(this.pendingRoot, name), 'utf8'));
        if (parsed !== null) items.push(parsed);
      }
      return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    });
  }

  get(id: string): Promise<SkillProposal | null> {
    return this.run(() => this.getSync(id));
  }

  private getSync(id: string): SkillProposal | null {
    const path = join(this.pendingRoot, `${id}.json`);
    if (!existsSync(path)) return null;
    return parseProposal(readFileSync(path, 'utf8'));
  }

  /**
   * 审批通过：**重新校验**暂存内容（暂存 JSON 视为不可信输入：路径围栏/密钥/体积全部再跑一遍）
   * 后原子写盘；成功删除暂存，失败保留暂存（只延迟不丢弃）并返回原因。
   */
  approve(id: string): Promise<SkillAuthoringResult> {
    return this.run(() => {
      const proposal = this.getSync(id);
      if (proposal === null) return { ok: false, error: `未找到待审批技能提案 ${id}` };
      let expectedFile: string;
      try {
        expectedFile = resolveSkillFilePath(this.root, proposal.name);
      } catch (e) {
        return { ok: false, error: (e as Error)?.message ?? String(e) };
      }
      if (expectedFile !== proposal.file) {
        return { ok: false, error: `提案目标路径与技能名不一致（拒绝写入）: ${proposal.file}` };
      }
      const verify = parseSkillFrontmatter(proposal.markdown);
      if (verify === null || verify.name !== proposal.name) {
        return { ok: false, error: '提案 frontmatter 不可解析（拒绝写入，暂存保留）' };
      }
      if (redactSecrets(proposal.markdown) !== proposal.markdown) {
        return { ok: false, error: '提案含疑似密钥/令牌（拒绝落盘，暂存保留）' };
      }
      if (proposal.markdown.length > this.maxChars) {
        return {
          ok: false,
          error: `提案体积超限（拒绝落盘，暂存保留）: ${proposal.markdown.length} > ${this.maxChars}`,
        };
      }
      try {
        mkdirSync(dirname(proposal.file), { recursive: true });
        const tmp = `${proposal.file}.tmp`;
        writeFileSync(tmp, proposal.markdown, 'utf8');
        renameSync(tmp, proposal.file);
      } catch (e) {
        return { ok: false, error: `技能写入失败: ${(e as Error)?.message ?? String(e)}` };
      }
      try {
        unlinkSync(join(this.pendingRoot, `${id}.json`));
      } catch {
        /* 已被并发删除 */
      }
      return { ok: true, proposal, path: proposal.file };
    });
  }

  /** 拒绝：删除暂存（用户显式丢弃） */
  reject(id: string): Promise<boolean> {
    return this.run(() => {
      const path = join(this.pendingRoot, `${id}.json`);
      if (!existsSync(path)) return false;
      unlinkSync(path);
      return true;
    });
  }

  /** 清空全部待审批提案；返回清除条数 */
  clearAll(): Promise<number> {
    return this.run(() => {
      if (!existsSync(this.pendingRoot)) return 0;
      let cleared = 0;
      for (const name of listJsonFiles(this.pendingRoot)) {
        try {
          unlinkSync(join(this.pendingRoot, name));
          cleared += 1;
        } catch {
          /* 已被并发删除：不计入 */
        }
      }
      return cleared;
    });
  }
}

/**
 * skill_author 工具（unsafe，串行）：模型只能**提交提案**，永远不能直接落盘。
 * 审批走人类入口（approve/reject），因此本工具不暴露 approve 动作——这是设计红线，不是缺口。
 * options.sessionId = 装配层绑定的当前会话 id（自动进 derivedFrom，模型无需自己知道会话 id）。
 */
export function createSkillAuthoringTool(
  store: SkillAuthoringStore,
  options: { sessionId?: string } = {},
): ToolDefinition {
  return {
    name: SKILL_AUTHORING_TOOL_NAME,
    description:
      'Distill a reusable skill from this session (or several sessions) and submit it for write-back into the ' +
      "project skill directory as <name>/SKILL.md, so it shows up in the '[Skills 可用]' block of later sessions. " +
      'This tool NEVER writes to disk directly: it only stages a proposal that a human must approve, then rejects it ' +
      'or writes it atomically. Submit the full markdown body (when to use it, the steps, the pitfalls). To improve a ' +
      'skill you already used, submit the refined text under the same name — provenance (derivedFrom) is preserved ' +
      'and the revision is bumped. Refused: non-slug names, oversized bodies, secrets/tokens, and any path outside ' +
      'the project skill directory.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'skill name: slug ^[a-z0-9][a-z0-9._-]*$ (max 64, no path separators)',
        },
        description: {
          type: 'string',
          description: 'one-line description shown in the always-on skills index (no newlines)',
        },
        body: { type: 'string', description: 'markdown body: trigger conditions, steps, pitfalls' },
        derivedFrom: {
          type: 'array',
          items: { type: 'string' },
          description: 'session ids this skill was distilled from (optional provenance trail)',
        },
      },
      required: ['name', 'description', 'body'],
    },
    // unsafe：读-改-写技能目录与暂存区，必须串行
    async execute(rawArgs): Promise<ToolOutput> {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const derivedRaw = args['derivedFrom'];
      if (derivedRaw !== undefined && (!Array.isArray(derivedRaw) || derivedRaw.some((v) => typeof v !== 'string'))) {
        return { error: 'skill_author: derivedFrom 必须是字符串数组' };
      }
      let result: SkillAuthoringResult;
      try {
        result = await store.propose(
          {
            name: args['name'] as string,
            description: args['description'] as string,
            body: args['body'] as string,
            ...(derivedRaw !== undefined ? { derivedFrom: derivedRaw as string[] } : {}),
          },
          options.sessionId !== undefined ? { sessionId: options.sessionId } : {},
        );
      } catch (e) {
        return { error: `skill_author: ${(e as Error)?.message ?? String(e)}` };
      }
      if (!result.ok || result.proposal === undefined) {
        return { error: `skill_author: ${result.error ?? 'unknown error'}` };
      }
      const p = result.proposal;
      const sources = p.provenance.derivedFrom.length > 0 ? p.provenance.derivedFrom.join(', ') : '(未记录)';
      return {
        output:
          `staged as ${p.id} (${p.action}, revision ${p.provenance.revision}, 等待人工审批后写入 ${p.file}); ` +
          `来源会话: ${sources}`,
      };
    },
  };
}
