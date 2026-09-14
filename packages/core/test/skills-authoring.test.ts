// H-22 经验造技能（P7-A）：提炼渲染 / 审批写回 / 自改进来源痕迹 / 违规防护（密钥、体积、
// 路径围栏、技能总数上限）/ 工具面 skill_author。
// 红线：全部用临时目录；技能是用户磁盘上的持久化产物，写入必须经 approve——用例逐条留证据。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SKILL_AUTHORING_TOOL_NAME,
  SKILL_DISTILL_SYSTEM,
  SKILL_MAX_CHARS,
  SKILL_PENDING_DIR_NAME,
  SkillAuthoringStore,
  buildSkillDistillPrompt,
  createSkillAuthoringTool,
  parseSkillProvenance,
  renderSkillMarkdown,
  resolveSkillFilePath,
  validateSkillDraft,
  type SkillDraft,
} from '../src/skills/authoring.js';
import {
  SKILLS_MAX,
  SKILL_FILE_NAME,
  SkillStore,
  assembleSkillsSystemBlock,
  parseSkillFrontmatter,
} from '../src/skills/store.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-skill-author-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-02T00:00:00.000Z';

function draft(over: Partial<SkillDraft> = {}): SkillDraft {
  return {
    name: 'commit-fix',
    description: '修复提交话术的步骤',
    body: '## 何时用\nCI 报提交信息不合规时。\n\n## 步骤\n1. 读 CODE_REVIEW.md\n2. 改写标题',
    ...over,
  };
}

/** 可注入单调时钟：每次调用前进一格（用例内时间线确定） */
function makeStore(root: string, times: readonly string[] = [T0, T1]): SkillAuthoringStore {
  let n = 0;
  return new SkillAuthoringStore(root, {
    now: () => new Date(times[Math.min(n++, times.length - 1)] ?? T0),
  });
}

/** 直接落一个既有技能文件（模拟历史技能），返回其原文 */
function writeExistingSkill(root: string, raw: string): string {
  mkdirSync(join(root, 'commit-fix'), { recursive: true });
  writeFileSync(join(root, 'commit-fix', SKILL_FILE_NAME), raw, 'utf8');
  return raw;
}

describe('H-22-1 提炼产出格式合法（渲染 = 校验同出入口）', () => {
  it('renderSkillMarkdown 产出可被技能解析器读回的 frontmatter，并带来源/修订痕迹', () => {
    const markdown = renderSkillMarkdown(draft(), {
      derivedFrom: ['sess-a', 'sess-b'],
      revision: 2,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(parseSkillFrontmatter(markdown)).toEqual({
      name: 'commit-fix',
      description: '修复提交话术的步骤',
    });
    expect(parseSkillProvenance(markdown)).toEqual({
      derivedFrom: ['sess-a', 'sess-b'],
      revision: 2,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(markdown).toContain('2. 改写标题'); // 正文原样保留
    expect(markdown.startsWith('---\nname: commit-fix\n')).toBe(true);
  });

  it('validateSkillDraft：合法草稿零错误；缺字段/坏形状一律返回原因', () => {
    expect(validateSkillDraft(draft())).toBeNull();
    expect(validateSkillDraft(draft({ name: 'Bad Name' }))).toMatch(/name 必须是 slug/);
    expect(validateSkillDraft(draft({ name: '' }))).toMatch(/name 必须是 slug/);
    expect(validateSkillDraft(draft({ description: '  ' }))).toMatch(/description 不能为空/);
    expect(validateSkillDraft(draft({ description: 'a\nb' }))).toMatch(/单行/);
    expect(validateSkillDraft(draft({ body: '   ' }))).toMatch(/body/);
  });

  it('提炼提示词：系统提示含写作纪律（skill_author/derivedFrom/密钥红线）；用户消息带摘要与来源会话', () => {
    expect(SKILL_DISTILL_SYSTEM).toContain(SKILL_AUTHORING_TOOL_NAME);
    expect(SKILL_DISTILL_SYSTEM).toContain('derivedFrom');
    expect(SKILL_DISTILL_SYSTEM).toContain('绝不把密钥');
    expect(SKILL_DISTILL_SYSTEM).toContain('无需提炼');
    const prompt = buildSkillDistillPrompt('USER: 修提交\nASSISTANT: 改了标题', ['sess-a', 'sess-b']);
    expect(prompt).toContain('USER: 修提交');
    expect(prompt).toContain('sess-a, sess-b');
    expect(buildSkillDistillPrompt('（对话为空）')).toContain('(未提供)');
  });
});

describe('H-22-2/3 审批两段式：propose 不写盘 → approve 才落盘', () => {
  it('propose 只暂存：磁盘无 SKILL.md、暂存在 .pending、扫描不把暂存当技能（零告警）', async () => {
    const root = tmpDir();
    const store = makeStore(root);
    const result = await store.propose(draft(), { sessionId: 'sess-a' });
    expect(result.ok).toBe(true);
    expect(result.proposal!.action).toBe('create');
    expect(existsSync(join(root, 'commit-fix', SKILL_FILE_NAME))).toBe(false);
    expect(existsSync(join(root, SKILL_PENDING_DIR_NAME, `${result.proposal!.id}.json`))).toBe(true);
    expect(await store.list()).toHaveLength(1);
    const scan = new SkillStore(root, undefined).scan();
    expect(scan.skills).toEqual([]);
    expect(scan.warnings).toEqual([]);
  });

  it('approve 落盘：内容 = 提案全文，可被技能扫描发现并进 [Skills 可用]，无 .tmp 残留', async () => {
    const root = tmpDir();
    const store = makeStore(root);
    const proposed = await store.propose(draft(), { sessionId: 'sess-a' });
    const id = proposed.proposal!.id;
    const approved = await store.approve(id);
    expect(approved.ok).toBe(true);
    expect(approved.path).toBe(join(root, 'commit-fix', SKILL_FILE_NAME));
    expect(readFileSync(approved.path!, 'utf8')).toBe(proposed.proposal!.markdown);
    expect(existsSync(`${approved.path!}.tmp`)).toBe(false);
    expect(await store.list()).toEqual([]); // 审批后暂存清除
    const scan = new SkillStore(root, undefined).scan();
    expect(scan.skills.map((s) => [s.name, s.description])).toEqual([['commit-fix', '修复提交话术的步骤']]);
    expect(scan.warnings).toEqual([]);
    expect(assembleSkillsSystemBlock(scan.skills)).toBe('[Skills 可用]\n- commit-fix: 修复提交话术的步骤');
  });

  it('reject 零写入；未知 id 的 approve/reject 如实报错', async () => {
    const root = tmpDir();
    const store = makeStore(root);
    const id = (await store.propose(draft())).proposal!.id;
    expect(await store.reject(id)).toBe(true);
    expect(existsSync(join(root, 'commit-fix', SKILL_FILE_NAME))).toBe(false);
    expect(await store.list()).toEqual([]);
    expect((await store.approve(id)).ok).toBe(false);
    expect((await store.approve(id)).error).toMatch(/未找到待审批技能提案/);
    expect(await store.reject('nope-1')).toBe(false);
  });

  it('clearAll 清空全部待审批；路径与计数如实返回', async () => {
    const root = tmpDir();
    const store = makeStore(root);
    await store.propose(draft({ name: 'a-skill' }));
    await store.propose(draft({ name: 'b-skill' }));
    expect(await store.clearAll()).toBe(2);
    expect(await store.list()).toEqual([]);
    expect(await store.clearAll()).toBe(0);
  });
});

describe('H-22-4 违规防护：密钥 fail-closed', () => {
  it('body 含 api_key 形态密钥 → 拒绝，且错误消息与磁盘/暂存都不含密钥', async () => {
    const root = tmpDir();
    const store = makeStore(root);
    const result = await store.propose(draft({ body: '配置：api_key: sk-abcdef123456\n然后调用接口' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/密钥/);
    expect(result.error).not.toContain('sk-abcdef123456');
    expect(existsSync(join(root, 'commit-fix', SKILL_FILE_NAME))).toBe(false);
    const pendingRoot = join(root, SKILL_PENDING_DIR_NAME);
    if (existsSync(pendingRoot)) {
      for (const name of readdirSync(pendingRoot)) {
        expect(readFileSync(join(pendingRoot, name), 'utf8')).not.toContain('sk-abcdef123456');
      }
    }
    expect(await store.list()).toEqual([]);
  });

  it('description 含 Bearer 令牌同样拒绝；正常文本不误伤', async () => {
    const root = tmpDir();
    const store = makeStore(root);
    const bad = await store.propose(draft({ description: 'Authorization: Bearer abcdef1234567890' }));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/description 含疑似密钥/);
    const good = await store.propose(draft({ description: '令牌该怎么读的排版约定（不含真值）' }));
    expect(good.ok).toBe(true);
  });

  it('approve 重校验：篡改暂存 JSON 塞入密钥 → 拒绝落盘且暂存保留', async () => {
    const root = tmpDir();
    const store = makeStore(root);
    const id = (await store.propose(draft())).proposal!.id;
    const path = join(root, SKILL_PENDING_DIR_NAME, `${id}.json`);
    const tampered = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    tampered['markdown'] = '---\nname: commit-fix\ndescription: 修复提交话术的步骤\n---\n\ntoken: sk-tampered123456\n';
    writeFileSync(path, JSON.stringify(tampered, null, 2), 'utf8');
    const approved = await store.approve(id);
    expect(approved.ok).toBe(false);
    expect(approved.error).toMatch(/密钥/);
    expect(existsSync(join(root, 'commit-fix', SKILL_FILE_NAME))).toBe(false);
    expect(await store.list()).toHaveLength(1); // 只延迟不丢弃
  });
});

describe('H-22-5 违规防护：形状 / 体积 / 上限', () => {
  it('体积上限不可绕过（含 frontmatter 的整份 SKILL.md 计长）', async () => {
    const root = tmpDir();
    const store = new SkillAuthoringStore(root, { maxChars: 200 });
    const tooBig = await store.propose(draft({ body: 'x'.repeat(300) }));
    expect(tooBig.ok).toBe(false);
    expect(tooBig.error).toMatch(/体积超限/);
    expect(existsSync(join(root, 'commit-fix', SKILL_FILE_NAME))).toBe(false);
    expect(SKILL_MAX_CHARS).toBe(100_000); // 缺省上限（对照 hermes MAX_SKILL_CONTENT_CHARS 同量级）
  });

  it('技能总数上限：已有 SKILLS_MAX 个技能时新增被拒，自改进既有技能不受限', async () => {
    const root = tmpDir();
    for (let i = 0; i < SKILLS_MAX; i++) {
      const name = `bulk-${String(i).padStart(2, '0')}`;
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(
        join(root, name, SKILL_FILE_NAME),
        `---\nname: ${name}\ndescription: 批量 ${i}\n---\n\n正文\n`,
        'utf8',
      );
    }
    const store = makeStore(root);
    const rejected = await store.propose(draft({ name: 'one-more' }));
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(new RegExp(`上限 ${SKILLS_MAX}`));
    const update = await store.propose(draft({ name: 'bulk-00', description: '自改进批量 0' }));
    expect(update.ok).toBe(true);
    expect(update.proposal!.action).toBe('update');
  });

  it('待审批提案上限：堆积到上限后拒绝新增（提示先 approve/reject）', async () => {
    const root = tmpDir();
    const pendingRoot = join(root, 'staged');
    mkdirSync(pendingRoot, { recursive: true });
    for (let i = 0; i < 50; i++) writeFileSync(join(pendingRoot, `fake-${i}.json`), '{}', 'utf8');
    const store = new SkillAuthoringStore(root, { pendingRoot });
    const result = await store.propose(draft());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/待审批技能提案已达上限 50/);
  });

  it('description 含成对引号导致渲染回读不一致 → 拒绝（不落盘坏 frontmatter）', async () => {
    const root = tmpDir();
    const store = makeStore(root);
    const result = await store.propose(draft({ description: '"quoted description"' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/无法被技能解析器读回/);
  });
});

describe('H-22-6 违规防护：路径围栏（禁任意路径写入）', () => {
  it('resolveSkillFilePath 拒绝路径分隔符 / 上跳 / 绝对路径 / 大写 / 空白', () => {
    const root = tmpDir();
    expect(resolveSkillFilePath(root, 'ok-name')).toBe(join(root, 'ok-name', SKILL_FILE_NAME));
    for (const bad of ['../evil', 'a/b', 'a\\b', '..', '.', 'OK', 'has space', '', 'x'.repeat(65)]) {
      expect(() => resolveSkillFilePath(root, bad)).toThrow(/slug/);
    }
  });

  it('propose 的非法名称零副作用（暂存区都不创建）', async () => {
    const root = tmpDir();
    const store = makeStore(root);
    const result = await store.propose(draft({ name: '../../etc/passwd' }));
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, SKILL_PENDING_DIR_NAME))).toBe(false);
  });

  it('同名单文件技能存在 → 拒绝（不制造「层内重名」扫描告警）', async () => {
    const root = tmpDir();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'commit-fix.md'), '---\nname: commit-fix\ndescription: 旧单文件\n---\n正文\n', 'utf8');
    const store = makeStore(root);
    const result = await store.propose(draft());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/同名单文件技能已存在/);
  });
});

describe('H-22-7 自改进：保留来源与修订痕迹', () => {
  it('同名再提交 = update：revision 递增、derivedFrom 合并去重、createdAt 保留、正文替换后扫描可见', async () => {
    const root = tmpDir();
    const store = makeStore(root);
    const first = await store.propose(draft(), { sessionId: 'sess-a' });
    expect(first.proposal!.provenance).toMatchObject({ revision: 1, derivedFrom: ['sess-a'], createdAt: T0 });
    expect((await store.approve(first.proposal!.id)).ok).toBe(true);

    const second = await store.propose(
      draft({ body: '## 步骤\n1. 只保留这一条', description: '修复提交话术（精简版）' }),
      {
        sessionId: 'sess-b',
      },
    );
    expect(second.proposal!.action).toBe('update');
    expect(second.proposal!.provenance.revision).toBe(2);
    expect(second.proposal!.provenance.derivedFrom).toEqual(['sess-a', 'sess-b']);
    expect(second.proposal!.provenance.createdAt).toBe(T0); // 首版创建时间保留
    expect(second.proposal!.provenance.updatedAt).toBe(T1);
    expect((await store.approve(second.proposal!.id)).ok).toBe(true);

    const entry = new SkillStore(root, undefined).load('commit-fix');
    expect(entry!.description).toBe('修复提交话术（精简版）');
    expect(entry!.content).toContain('1. 只保留这一条');
    expect(entry!.content).not.toContain('改写标题');
    expect(parseSkillProvenance(entry!.content)).toMatchObject({ revision: 2, derivedFrom: ['sess-a', 'sess-b'] });
  });

  it('既有技能的 revision/derivedFrom 被继承（外部来源也不丢）', async () => {
    const root = tmpDir();
    writeExistingSkill(
      root,
      '---\nname: commit-fix\ndescription: 旧版\nderivedFrom: sess-old\nrevision: 7\ncreatedAt: 2025-12-01T00:00:00.000Z\n---\n\n旧正文\n',
    );
    const store = makeStore(root);
    const result = await store.propose(draft({ description: '新版' }), { sessionId: 'sess-new' });
    expect(result.proposal!.provenance).toEqual({
      derivedFrom: ['sess-old', 'sess-new'],
      revision: 8,
      createdAt: '2025-12-01T00:00:00.000Z',
      updatedAt: T0,
    });
  });
});

describe('H-22-8 工具面 skill_author（只提案，绝不直接落盘）', () => {
  it('工具名/参数 schema 正确；create 只暂存并回报来源', async () => {
    const root = tmpDir();
    const store = makeStore(root);
    const tool = createSkillAuthoringTool(store, { sessionId: 'sess-tool' });
    expect(tool.name).toBe(SKILL_AUTHORING_TOOL_NAME);
    expect(tool.concurrencySafe).toBeUndefined(); // unsafe：串行
    const params = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(params.properties).sort()).toEqual(['body', 'derivedFrom', 'description', 'name']);
    expect(params.required).toEqual(['name', 'description', 'body']);
    const result = await tool.execute(
      { name: 'commit-fix', description: '修复提交话术的步骤', body: '步骤：读 CODE_REVIEW.md' },
      { signal: new AbortController().signal, cwd: root },
    );
    expect(result.error).toBeUndefined();
    expect(result.output).toMatch(/staged as .*create, revision 1/);
    expect(result.output).toContain('sess-tool');
    expect(existsSync(join(root, 'commit-fix', SKILL_FILE_NAME))).toBe(false); // 工具绝不直接写盘
  });

  it('非法输入走 error 通道（坏 slug / 密钥 / derivedFrom 非数组）', async () => {
    const root = tmpDir();
    const tool = createSkillAuthoringTool(makeStore(root));
    const ctx = { signal: new AbortController().signal, cwd: root };
    const badName = await tool.execute({ name: '../x', description: 'd', body: 'b' }, ctx);
    expect(badName.error).toMatch(/name 必须是 slug/);
    const secret = await tool.execute({ name: 'ok', description: 'd', body: 'api_key: sk-abcdef123456' }, ctx);
    expect(secret.error).toMatch(/密钥/);
    const badDerived = await tool.execute({ name: 'ok', description: 'd', body: 'b', derivedFrom: 'sess-a' }, ctx);
    expect(badDerived.error).toMatch(/derivedFrom 必须是字符串数组/);
    expect(existsSync(join(root, 'ok', SKILL_FILE_NAME))).toBe(false);
  });
});
