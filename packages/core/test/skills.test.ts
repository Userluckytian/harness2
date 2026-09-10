// Skills 测试（阶段 10 Task 2）：frontmatter 解析、两级扫描/覆盖/上限/坏文件、
// skill 工具按需加载、loop system 注入（含零注入与 memory 合并）、告警上报。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../src/provider/mock.js';
import { runTurn } from '../src/agent/loop.js';
import { MemoryStore } from '../src/memory/store.js';
import { loadSession } from '../src/session/reader.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionWriter } from '../src/session/writer.js';
import {
  SKILLS_MAX,
  SkillStore,
  assembleSkillsSystemBlock,
  parseSkillFrontmatter,
  type SkillEntry,
} from '../src/skills/store.js';
import { createSkillTool } from '../src/skills/tool.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-skills-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeSkill(dir: string, fileName: string, name: string, description: string, body = '步骤：照做。'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, 'utf8');
}

describe('parseSkillFrontmatter', () => {
  it('合法 frontmatter：name/description 提取，引号剥离', () => {
    const raw = '---\nname: "commit-fix"\ndescription: \'修复提交话术\'\nextra: ignored\n---\n\n正文\n';
    expect(parseSkillFrontmatter(raw)).toEqual({ name: 'commit-fix', description: '修复提交话术' });
  });

  it('坏形态一律 null：无 frontmatter / 未闭合 / 缺 name / 缺 description / name 含空白', () => {
    expect(parseSkillFrontmatter('没有 frontmatter 的普通 markdown')).toBeNull();
    expect(parseSkillFrontmatter('---\nname: x\n')).toBeNull(); // 未闭合
    expect(parseSkillFrontmatter('---\ndescription: 只有描述\n---\n正文')).toBeNull();
    expect(parseSkillFrontmatter('---\nname: x\ndescription: y\n---\n')).toEqual({ name: 'x', description: 'y' });
    expect(parseSkillFrontmatter('---\nname: two words\ndescription: y\n---\n')).toBeNull();
    expect(parseSkillFrontmatter('---\nname: \ndescription: y\n---\n')).toBeNull();
  });

  it('边界（审查 P2-6 防回归）：UTF-8 BOM 开头的 frontmatter 正确解析', () => {
    // 编辑器保存 UTF-8 with BOM 时文件以 \uFEFF 开头
    expect(parseSkillFrontmatter('\uFEFF---\nname: bom-skill\ndescription: BOM 文件\n---\n正文')).toEqual({
      name: 'bom-skill',
      description: 'BOM 文件',
    });
  });

  it('边界（审查 P2-6 防回归）：CRLF（\\r\\n）换行的 frontmatter 正确解析', () => {
    // Windows 编辑器换行
    expect(parseSkillFrontmatter('---\r\nname: crlf-skill\r\ndescription: CRLF 文件\r\n---\r\n\r\n正文\r\n')).toEqual({
      name: 'crlf-skill',
      description: 'CRLF 文件',
    });
  });
});

describe('SkillStore.scan', () => {
  it('两级扫描合并（名称排序），source 标注 project/global', () => {
    const project = tmpDir();
    const global = tmpDir();
    writeSkill(project, 'z-project.md', 'z-project', '项目级');
    writeSkill(global, 'a-global.md', 'a-global', '全局级');
    const store = new SkillStore(project, global);
    const scan = store.scan();
    expect(scan.skills.map((s) => [s.name, s.source])).toEqual([
      ['a-global', 'global'],
      ['z-project', 'project'],
    ]);
  });

  it('同名：项目级覆盖全局级 + 告警（只出现一次，内容为项目版）', () => {
    const project = tmpDir();
    const global = tmpDir();
    writeSkill(project, 'dup.md', 'dup', '项目版描述', '项目版正文');
    writeSkill(global, 'dup.md', 'dup', '全局版描述', '全局版正文');
    const scan = new SkillStore(project, global).scan();
    expect(scan.skills).toHaveLength(1);
    expect(scan.skills[0]!.source).toBe('project');
    expect(scan.skills[0]!.description).toBe('项目版描述');
    expect(scan.skills[0]!.content).toContain('项目版正文');
    expect(scan.warnings.some((w) => w.includes('覆盖全局同名'))).toBe(true);
  });

  it('层内重名（审查 P2-2 防回归）：同层两个文件 frontmatter 同名 → 保留先文件，单独告警指明被丢弃路径', () => {
    const project = tmpDir();
    writeSkill(project, 'a-dup.md', 'dup', '先文件');
    writeSkill(project, 'b-dup.md', 'dup', '后文件');
    const scan = new SkillStore(project, undefined).scan();
    expect(scan.skills).toHaveLength(1);
    expect(scan.skills[0]!.description).toBe('先文件'); // 文件名排序在前者保留
    expect(
      scan.warnings.some((w) => w.includes('层内重名 "dup"') && w.includes('b-dup.md') && w.includes('a-dup.md')),
    ).toBe(true);
    expect(scan.warnings.some((w) => w.includes('覆盖全局同名'))).toBe(false); // 不再误用跨级文案
  });

  it('上限 50：超出按名称排序截断 + 告警列出被忽略项', () => {
    const project = tmpDir();
    for (let i = 0; i < SKILLS_MAX + 3; i++) {
      writeSkill(project, `s${String(i).padStart(2, '0')}.md`, `s${String(i).padStart(2, '0')}`, `描述 ${i}`);
    }
    const scan = new SkillStore(project, undefined).scan();
    expect(scan.skills).toHaveLength(SKILLS_MAX);
    expect(scan.warnings.some((w) => w.includes(`超出上限 ${SKILLS_MAX}`) && w.includes('s50'))).toBe(true);
  });

  it('坏文件跳过 + 告警；非 .md 文件静默忽略', () => {
    const project = tmpDir();
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'bad.md'), '---\nname: bad\n---\n缺 description', 'utf8');
    writeFileSync(join(project, 'plain.txt'), '不是 markdown', 'utf8');
    writeSkill(project, 'good.md', 'good', '好文件');
    const scan = new SkillStore(project, undefined).scan();
    expect(scan.skills.map((s) => s.name)).toEqual(['good']);
    expect(scan.warnings).toHaveLength(1);
    expect(scan.warnings[0]).toContain('bad.md');
  });

  it('目录缺失 = 空 skills 零告警；load 未知名返回 undefined', () => {
    const store = new SkillStore(join(tmpDir(), 'missing-project'), join(tmpDir(), 'missing-global'));
    expect(store.scan()).toEqual({ skills: [], warnings: [] });
    expect(store.load('anything')).toBeUndefined();
  });

  it('scan/load 现读磁盘：中途新增/修改即时可见', () => {
    const project = tmpDir();
    const store = new SkillStore(project, undefined);
    expect(store.scan().skills).toHaveLength(0);
    writeSkill(project, 'late.md', 'late', '后来加的');
    expect(store.scan().skills.map((s) => s.name)).toEqual(['late']);
    writeSkill(project, 'late.md', 'late', '改过的描述');
    expect(store.load('late')!.description).toBe('改过的描述');
  });
});

describe('assembleSkillsSystemBlock', () => {
  it('格式：[Skills 可用] 头 + 每行 `- name: description`；空列表 → null（零注入）', () => {
    const entries: SkillEntry[] = [
      { name: 'a', description: 'A 描述', content: '', file: '/x/a.md', source: 'project' },
      { name: 'b', description: 'B 描述', content: '', file: '/x/b.md', source: 'global' },
    ];
    expect(assembleSkillsSystemBlock(entries)).toBe('[Skills 可用]\n- a: A 描述\n- b: B 描述');
    expect(assembleSkillsSystemBlock([])).toBeNull();
  });
});

describe('skill 工具', () => {
  it('按名加载全文（含 frontmatter）；未知名/空名报 error', async () => {
    const project = tmpDir();
    writeSkill(project, 'guide.md', 'guide', '指南', '全文正文在这里');
    const tool = createSkillTool(new SkillStore(project, undefined));
    const ok = await tool.execute({ name: 'guide' }, { signal: new AbortController().signal, cwd: project });
    expect(ok.output).toContain('name: guide');
    expect(ok.output).toContain('全文正文在这里');
    const unknown = await tool.execute({ name: 'nope' }, { signal: new AbortController().signal, cwd: project });
    expect(unknown.error).toContain('未找到 "nope"');
    const empty = await tool.execute({ name: '' }, { signal: new AbortController().signal, cwd: project });
    expect(empty.error).toContain('name 必须是非空字符串');
  });
});

describe('loop system 注入', () => {
  it('有 skills：system 追加 [Skills 可用] 列表（本轮内冻结，所有 step 同一 system）', async () => {
    const project = tmpDir();
    writeSkill(project, 'guide.md', 'guide', '指南');
    const dir = join(tmpDir(), 'sess');
    const provider = new MockProvider([{ text: '好的' }]);
    const tools = new ToolRegistry();
    tools.register(createSkillTool(new SkillStore(project, undefined)));
    const result = await runTurn(dir, {
      provider,
      tools,
      cwd: dir,
      userText: '用 skill',
      skills: new SkillStore(project, undefined),
    });
    expect(result.stopReason).toBe('end_turn');
    const system = provider.requests[0]?.system;
    expect(system).toContain('[Skills 可用]');
    expect(system).toContain('- guide: 指南');
  });

  it('空 skills（目录缺失）：零注入（system 无 [Skills 可用]）', async () => {
    const dir = join(tmpDir(), 'sess');
    const provider = new MockProvider([{ text: '好的' }]);
    await runTurn(dir, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: '你好',
      skills: new SkillStore(join(tmpDir(), 'no-such'), undefined),
    });
    expect(provider.requests[0]?.system).toBeUndefined();
  });

  it('memory + skills 同装：system = 记忆快照 + 空行 + skills 列表（只追加内容段）', async () => {
    const project = tmpDir();
    writeSkill(project, 'guide.md', 'guide', '指南');
    const memRoot = tmpDir();
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(join(memRoot, 'MEMORY.md'), '记住：用户偏好中文回复', 'utf8');
    const memoryStore = new MemoryStore(memRoot);

    const dir = join(tmpDir(), 'sess');
    const provider = new MockProvider([{ text: '好的' }]);
    const w = SessionWriter.create(dir, { sessionId: 'skills-mem', cwd: dir }, { fsync: false });
    await runTurn(w, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: '你好',
      memory: memoryStore,
      skills: new SkillStore(project, undefined),
    });
    w.close();
    const system = provider.requests[0]?.system ?? '';
    expect(system).toContain('记住：用户偏好中文回复'); // memory/snapshot 冻结内容在前
    expect(system.indexOf('记住：用户偏好中文回复')).toBeLessThan(system.indexOf('[Skills 可用]'));
    expect(system).toMatch(/\n\n\[Skills 可用\]/); // skills 作为追加内容段（空行分隔）
    // memory/snapshot 事件只含记忆快照，不含 skills 列表（零新增事件类型红线）
    const snapshot = loadSession(dir).events.find((e) => e.event.type === 'memory/snapshot');
    expect(snapshot).toBeDefined();
    expect(JSON.stringify(snapshot!.event.payload)).not.toContain('[Skills 可用]');
  });

  it('扫描告警（坏文件）并入 TurnResult.warning', async () => {
    const project = tmpDir();
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'bad.md'), '无 frontmatter', 'utf8');
    const dir = join(tmpDir(), 'sess');
    const provider = new MockProvider([{ text: '好的' }]);
    const result = await runTurn(dir, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: '你好',
      skills: new SkillStore(project, undefined),
    });
    expect(result.warning).toContain('bad.md');
  });

  it('每 turn 重扫：turn 之间新增的 skill 文件在下一 turn 注入', async () => {
    const project = tmpDir();
    const dir = join(tmpDir(), 'sess');
    const provider = new MockProvider([{ text: '第一轮' }, { text: '第二轮' }]);
    const skills = new SkillStore(project, undefined);
    const w = SessionWriter.create(dir, { sessionId: 'skills-rescan', cwd: dir }, { fsync: false });
    await runTurn(w, { provider, tools: new ToolRegistry(), cwd: dir, userText: '一', skills });
    expect(provider.requests[0]?.system).toBeUndefined();
    writeSkill(project, 'late.md', 'late', '后来加的');
    await runTurn(w, { provider, tools: new ToolRegistry(), cwd: dir, userText: '二', skills });
    w.close();
    expect(provider.requests[1]?.system).toContain('- late: 后来加的');
  });
});
