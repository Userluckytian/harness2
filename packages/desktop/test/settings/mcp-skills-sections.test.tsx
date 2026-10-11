// A07/A08 设置分区测试（Z6 批次4）：
//   A07 MCP 服务器分区 —— 独立分区（Z-89 对齐）：服务器列表只读展示（stdio/http）、空态、
//     红线⑩（无状态数据面不摆状态点/状态列）、CLI 指引文案；
//   A08 技能分区 —— 两级扫描只读列表（settings:getSkills 主进程 fs，core 同一实现）、
//     空态、有数据展示（名称/描述/层级/路径）、告警展示、读取失败态。
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { Harness2Api, SettingsConfigShape, SettingsSkillsShape } from '../../src/shared/protocol.js';
import { McpServersSection, describeMcpServer } from '../../src/renderer/settings/mcp/McpServersSection.js';
import { SkillsSection } from '../../src/renderer/settings/skills/SkillsSection.js';
import { SettingsPage } from '../../src/renderer/components/SettingsPage.js';

const CFG: SettingsConfigShape = {
  providers: {},
  roles: { main: { channel: 'ch', model: 'm' } },
  approval: { mode: 'default' },
  memory: { mode: 'off', nudgeInterval: 10 },
  browser: { enabled: true, idleDestroyMs: 300_000, maxConcurrent: 2 },
  plugins: { enabled: true, allow: [] },
  mcpServers: {
    'local-tools': { command: 'node', args: ['server.js', '--port', '9'] },
    'remote-http': { url: 'https://mcp.example.com/stream' },
  },
  subagent: { maxDepth: 1, maxTurns: 25 },
  sources: { global: true, project: false },
  warnings: [],
  errors: [],
};

const SKILLS: SettingsSkillsShape = {
  skills: [
    { name: 'commit-help', description: '写提交说明', file: '/r/.harness2/skills/commit-help.md', source: 'project' },
    { name: 'deploy', description: '发布流程', file: '/h/.harness2/skills/deploy/SKILL.md', source: 'global' },
  ],
  warnings: ['skills: 项目层内重名 "dup"，丢弃 /x.md（保留 /y.md）'],
  roots: { project: '/r/.harness2/skills', global: '/h/.harness2/skills' },
};

function pageApi(over: Partial<Harness2Api> = {}): Harness2Api {
  return {
    settingsGetConfig: vi.fn(async () => CFG),
    settingsGetSkills: vi.fn(async () => SKILLS),
    settingsUpdateConfig: vi.fn(async () => ({ ok: true })),
    settingsGetAuthMasked: vi.fn(async () => ({ channels: [], gateways: [] })),
    settingsGetPreferences: vi.fn(async () => ({
      theme: 'system',
      defaultPaneCount: 1,
      showWelcome: true,
      notifyDetails: 'minimal',
    })),
    settingsSetPreferences: vi.fn(async (p: unknown) => p),
    settingsGetDoctorReport: vi.fn(async () => ({ checks: [], exitCode: 0 as const })),
    settingsGetCrashReports: vi.fn(async () => []),
    settingsUpdateAuth: vi.fn(async () => ({ ok: true })),
    ...over,
  } as unknown as Harness2Api;
}

beforeEach(() => {
  cleanup();
});
afterEach(() => {
  cleanup();
});

describe('A07 MCP 服务器分区', () => {
  it('有配置 → stdio 与 http 都按字段展示（只读，无编辑控件）', () => {
    render(<McpServersSection cfg={CFG} />);
    expect(screen.getByText('local-tools')).toBeTruthy();
    expect(screen.getByText('stdio: node server.js --port 9')).toBeTruthy();
    expect(screen.getByText('remote-http')).toBeTruthy();
    expect(screen.getByText('http: https://mcp.example.com/stream')).toBeTruthy();
  });

  it('空配置 → 空态文案（不摆假列表）', () => {
    render(<McpServersSection cfg={{ ...CFG, mcpServers: {} }} />);
    expect(screen.getByText('未配置 MCP 服务器')).toBeTruthy();
  });

  it('红线⑩：无状态数据面 → 不渲染连接状态列/状态点，如实指引 CLI（harness2 mcp list）', () => {
    render(<McpServersSection cfg={CFG} />);
    const text = document.body.textContent ?? '';
    // 伪状态 UI 会用的中文状态标签零出现（英文词出现在指引文案里属如实说明，不算状态展示）
    for (const fake of ['已连接', '重连中', '已下线', '运行中']) {
      expect(text).not.toContain(fake);
    }
    expect(text).toContain('harness2 mcp list');
    expect(text).toContain('当前无查询端点');
    // 列表行只有两列（名称 + 启动形态），没有第三个状态格
    const rows = document.querySelectorAll('[data-mcp-server-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.children).toHaveLength(2);
    expect(rows[1]!.children).toHaveLength(2);
  });

  it('describeMcpServer：非法形态如实标注（不臆造）', () => {
    expect(describeMcpServer(undefined)).toContain('非法配置项');
    expect(describeMcpServer({})).toContain('既无 command 也无 url');
    expect(describeMcpServer({ command: 'uvx', args: ['mcp-server'] })).toBe('stdio: uvx mcp-server');
  });
});

describe('A08 技能分区', () => {
  it('有数据 → 名称/描述/层级/路径逐条展示 + 告警展示', async () => {
    const getSkills = vi.fn(async () => SKILLS);
    (window as unknown as { harness2: Partial<Harness2Api> }).harness2 = { settingsGetSkills: getSkills };
    render(<SkillsSection />);
    await waitFor(() => expect(document.querySelector('[data-skills-list]')).not.toBeNull());
    expect(getSkills).toHaveBeenCalled();
    expect(screen.getByText('commit-help')).toBeTruthy();
    expect(screen.getByText('写提交说明')).toBeTruthy();
    expect(screen.getByText('deploy')).toBeTruthy();
    expect(screen.getAllByText('项目级').length).toBeGreaterThan(0);
    expect(screen.getAllByText('全局级').length).toBeGreaterThan(0);
    expect(screen.getByText('/r/.harness2/skills/commit-help.md')).toBeTruthy();
    expect(screen.getByText(/项目层内重名 "dup"/)).toBeTruthy();
    // 扫描根口径展示（与 core projectSkillsRoot/defaultSkillsRoot 同语义）
    expect(document.body.textContent).toContain('/r/.harness2/skills');
    expect(document.body.textContent).toContain('/h/.harness2/skills');
  });

  it('空扫描 → 空态（不摆假技能）', async () => {
    (window as unknown as { harness2: Partial<Harness2Api> }).harness2 = {
      settingsGetSkills: vi.fn(async () => ({ skills: [], warnings: [], roots: { project: '/r', global: '/h' } })),
    };
    render(<SkillsSection />);
    await waitFor(() => expect(screen.getByText('未扫描到技能')).toBeTruthy());
  });

  it('读取失败 → 明确错误态（不空转也不假装有数据）', async () => {
    (window as unknown as { harness2: Partial<Harness2Api> }).harness2 = {
      settingsGetSkills: vi.fn(async () => Promise.reject(new Error('IPC 断了'))),
    };
    render(<SkillsSection />);
    await waitFor(() => expect(screen.getByText(/技能列表读取失败/)).toBeTruthy());
    expect(screen.getByText(/IPC 断了/)).toBeTruthy();
  });
});

describe('设置页集成：A07/A08 分区经导航可达', () => {
  it('导航含 MCP 服务器与技能分区；点击渲染对应正文', async () => {
    const api = pageApi();
    (window as unknown as { harness2: Harness2Api }).harness2 = api;
    render(<SettingsPage open onClose={() => {}} onThemeChange={() => {}} />);

    const navs = [...document.querySelectorAll('[data-section-nav]')].map((n) => n.getAttribute('data-section-nav'));
    expect(navs).toContain('mcp');
    expect(navs).toContain('skill');

    fireEvent.click(document.querySelector('[data-section-nav="mcp"]') as HTMLElement);
    // 分区标题在导航与正文各出现一次 → 用 getAllByText 断言 ≥1 即正文已挂载
    await waitFor(() => expect(screen.getAllByText('MCP 服务器').length).toBeGreaterThanOrEqual(1));
    expect(await screen.findByText('stdio: node server.js --port 9')).toBeTruthy();

    fireEvent.click(document.querySelector('[data-section-nav="skill"]') as HTMLElement);
    await waitFor(() => expect(screen.getByText('commit-help')).toBeTruthy());
    expect(api.settingsGetSkills).toHaveBeenCalled();
  });
});
