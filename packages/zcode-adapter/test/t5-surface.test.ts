/**
 * ZS4-T5 轨迹降级 + 周边读面对账测试。
 * 红线⑩：core 无 model-io → 轨迹必须如实 available:false + 空 records（不造假）；
 * skills/memory 接 core 真盘；off-peak fail-closed（读空态、写必炸）。
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModelTrajectory } from '../src/real/trajectory-service.js';
import { createSkillsService, createMemoryService } from '../src/a-class-stubs.js';
import { offPeakTaskServiceStub } from '../src/root-mount-stubs.js';
import { createTaskService } from '../src/real/task-service.js';
import { SessionManager, defaultSessionsRoot } from '../src/real/core-bridge.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'h2-t5-'));
}

describe('getModelTrajectory 降级（ZS4-T5）', () => {
  it('会话存在 → available:false + 空 records + 真实 sourceFiles；limit 不改变形状', () => {
    const home = tmpHome();
    const root = defaultSessionsRoot(home);
    const manager = new SessionManager(root);
    const cwd = tmpHome();
    const { id, writer } = manager.create(cwd, { fsync: false });
    writer.append('user/message', { text: 'hi' });
    writer.close();

    const t = buildModelTrajectory(manager, id);
    expect(t.taskId).toBe(id);
    expect(t.available).toBe(false);
    expect(t.records).toEqual([]);
    expect(t.truncated).toBe(false);
    expect(t.sourceFiles.length).toBe(1);
    expect(t.sourceFiles[0]).toContain(id);
    // limit 收下不使用
    expect(buildModelTrajectory(manager, id, 5)).toEqual(t);
    rmSync(home, { recursive: true, force: true });
  });

  it('会话不存在 → sourceFiles 空、不抛错（UI 空态兜底）', () => {
    const home = tmpHome();
    const manager = new SessionManager(defaultSessionsRoot(home));
    const t = buildModelTrajectory(manager, 'no-such-session');
    expect(t.available).toBe(false);
    expect(t.sourceFiles).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });

  it('task-service 接线：createTask 后 getModelTrajectory 返回降级对象', async () => {
    const home = tmpHome();
    const svc: any = createTaskService({ home, useMock: true });
    const created: any = await svc.createTask({ workspacePath: process.cwd() });
    const traj: any = await svc.getModelTrajectory({ taskId: created.taskId });
    expect(traj.available).toBe(false);
    expect(traj.records).toEqual([]);
    expect(traj.taskId).toBe(created.taskId);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('skills 接 core SkillStore（ZS4-T5）', () => {
  it('project 级 SKILL.md 被扫描映射；无效文件转 diagnostics；空目录空列表', async () => {
    const home = tmpHome();
    const ws = mkdtempSync(join(tmpdir(), 'h2-t5-ws-'));
    const skillsDir = join(ws, '.harness2', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'demo.md'), '---\nname: demo\ndescription: demo skill\n---\n# body\n', 'utf8');
    writeFileSync(join(skillsDir, 'broken.md'), 'no frontmatter here\n', 'utf8');

    const svc: any = createSkillsService({ home });
    const res: any = await svc.list({ workspacePath: ws });
    const demo = res.skills.find((s: any) => s.name === 'demo');
    expect(demo).toBeDefined();
    expect(demo.id).toBe('demo');
    expect(demo.scope).toBe('workspace');
    expect(demo.enabled).toBe(true);
    expect(demo.body).toContain('# body');
    expect(demo.path).toContain('demo.md');
    // 无效文件 → warning diagnostics（不静默吞）
    expect(res.diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(res.diagnostics.every((d: any) => d.severity === 'warning')).toBe(true);
    expect(res.capability.userScopeAvailable).toBe(false);

    // 写路径保持 throw（fail-closed）
    await expect(svc.setEnabled({ skillId: 'demo', enabled: false })).rejects.toThrow(/not implemented/);

    const empty: any = await svc.list({ workspacePath: mkdtempSync(join(tmpdir(), 'h2-t5-ws2-')) });
    expect(empty.skills).toEqual([]);
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });
});

describe('memory loadMemory 接 core MemoryStore（ZS4-T5）', () => {
  it('有内容 → {memory:{content,enabled:true}}；无文件 → null；listProjectMemories 恒空', async () => {
    const home = tmpHome();
    const svc: any = createMemoryService({ home });
    let r: any = await svc.loadMemory({ workspacePath: process.cwd(), agentId: 'anything' });
    expect(r.memory).toBeNull();

    const memDir = join(home, '.harness2', 'memories');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'MEMORY.md'), 'fact one\n§\nfact two\n', 'utf8');
    r = await svc.loadMemory({ workspacePath: process.cwd(), agentId: 'anything' });
    expect(r.memory).not.toBeNull();
    expect(r.memory.content).toContain('fact one');
    expect(r.memory.enabled).toBe(true);

    expect(await svc.listProjectMemories()).toEqual([]);
    await expect(svc.saveMemory({})).rejects.toThrow(/not implemented/);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('off-peak fail-closed 桩（ZS4-T5）', () => {
  it('list→[]、get→null、support/额度不可用、写路径全部 throw', async () => {
    const svc: any = offPeakTaskServiceStub;
    expect(await svc.list()).toEqual([]);
    expect(await svc.get('x')).toBeNull();
    const support: any = await svc.getCodingPlanSupport();
    expect(support.supported).toBe(false);
    const take: any = await svc.getTakeNumberAvailability();
    expect(take.canTakeNumber).toBe(false);
    await expect(svc.createTask({})).rejects.toThrow(/not implemented|ZS/);
    await expect(svc.cancelTask('x')).rejects.toThrow();
    await expect(svc.deleteTask('x')).rejects.toThrow();
  });
});
