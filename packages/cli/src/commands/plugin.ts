// packages/cli/src/commands/plugin.ts
// B3-1 拆分产物：原 index.ts 第 634–765 行逐字搬入，零逻辑改动。
// plugin 命令（阶段 8）：插件查看与装载审批（manifest 权限 + plugins.allow 名单）。
// v1 插件与主进程同进程运行（非隔离），批准即授予 API 层权限——enable 确认文案如实声明。
import { Command } from 'commander';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  defaultConfigPaths,
  defaultPluginsRoot,
  describePermissions,
  loadConfig,
  scanPluginSources,
} from '@harness2/core';

export function registerPluginCommand(program: Command): void {
  /** plugin 命令（阶段 8）：插件查看与装载审批。插件在 ~/.harness2/plugins/<name>；
   *  审批结果记录在全局 config 的 plugins.allow（manifest 合法 + 名单内才会装载）。 */
  const pluginCmd = new Command('plugin').description('插件管理（manifest 权限 + 装载审批）');

  interface PluginHomeOptions {
    home?: string;
  }

  pluginCmd
    .command('list')
    .description('列出插件目录中的插件：manifest 权限与审批状态')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .action((opts: PluginHomeOptions) => {
      const sources = scanPluginSources(defaultPluginsRoot(opts.home));
      if (sources.length === 0) {
        console.log('（无插件）');
        return;
      }
      const allow = readPluginsAllow(opts.home);
      // B4-3：如实声明 v1 插件同进程非隔离边界——manifest 权限只是 API 层约束，不是沙箱
      console.log('注意：v1 插件与主进程同进程运行（非隔离），manifest 权限仅为 API 层约束，不提供沙箱。');
      for (const s of sources) {
        if (s.manifest === null) {
          console.log(`${s.name}  [manifest 非法] ${s.error ?? ''}`);
          continue;
        }
        const approved = allow.has(s.manifest.name);
        console.log(
          `${s.manifest.name}  v${s.manifest.version}  ${approved ? '已批准（重启会话/serve 后装载）' : '未批准（plugin enable 启用）'}`,
        );
        console.log(`  权限: ${describePermissions(s.manifest)}`);
      }
    });

  pluginCmd
    .command('enable')
    .description('装载审批：打印权限清单，确认后写入全局 config 的 plugins.allow')
    .argument('<name>', '插件名（目录名）')
    .option('--yes', '跳过交互确认（脚本/自动化用）', false)
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .action(async (name: string, opts: PluginHomeOptions & { yes: boolean }) => {
      const sources = scanPluginSources(defaultPluginsRoot(opts.home));
      const src = sources.find((s) => s.name === name);
      if (src === undefined || src.manifest === null) {
        console.error(`error: 插件 ${name} 不存在或 manifest 非法${src?.error ? `（${src.error}）` : ''}`);
        process.exit(1);
      }
      const manifest = src.manifest;
      console.log(`插件 ${manifest.name} v${manifest.version} 权限清单：`);
      console.log(`  ${describePermissions(manifest)}`);
      console.log(
        '注意：v1 插件与主进程同进程运行（非隔离），manifest 权限仅为 API 层约束，不提供沙箱；批准即授予上述 API 层权限。',
      );
      if (!opts.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => rl.question('确认批准装载? [y/N] ', resolve));
        rl.close();
        if (answer.trim().toLowerCase() !== 'y') {
          console.log('已取消（未写入 config）');
          return;
        }
      }
      try {
        mutatePluginsAllow(opts.home, (allow) => {
          if (!allow.includes(manifest.name)) allow.push(manifest.name);
        });
        console.log(`已批准：plugins.allow += ${manifest.name}（重启 chat/serve 后生效）`);
      } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  pluginCmd
    .command('disable')
    .description('撤销装载审批：从全局 config 的 plugins.allow 移除该插件')
    .argument('<name>', '插件名（目录名）')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .action((name: string, opts: PluginHomeOptions) => {
      try {
        let removed = false;
        mutatePluginsAllow(opts.home, (allow) => {
          const i = allow.indexOf(name);
          if (i >= 0) {
            allow.splice(i, 1);
            removed = true;
          }
        });
        console.log(
          removed
            ? `已撤销：plugins.allow -= ${name}（重启 chat/serve 后生效）`
            : `plugins.allow 中没有 ${name}（本就未批准）`,
        );
      } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  program.addCommand(pluginCmd);

  /** 读取全局 config 的 plugins.allow（config 不可用时返回空名单，不阻塞 list 展示） */
  function readPluginsAllow(home?: string): Set<string> {
    const loaded = loadConfig({ home });
    return new Set(loaded.config?.plugins.allow ?? []);
  }

  /** 原子改写全局 config 的 plugins.allow（严格 JSON；含注释的 JSONC 拒绝改写，避免静默丢注释） */
  function mutatePluginsAllow(home: string | undefined, mutate: (allow: string[]) => void): void {
    const paths = defaultConfigPaths(undefined, home);
    let raw: Record<string, unknown> = {};
    if (existsSync(paths.globalConfig)) {
      const text = readFileSync(paths.globalConfig, 'utf8');
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('config 根节点必须是对象');
        }
        raw = parsed as Record<string, unknown>;
      } catch {
        throw new Error(`全局 config（${paths.globalConfig}）不是严格 JSON（可能含注释）——请手工编辑 plugins.allow`);
      }
    }
    const plugins = (raw['plugins'] ?? {}) as Record<string, unknown>;
    const allow = Array.isArray(plugins['allow'])
      ? [...(plugins['allow'] as unknown[]).filter((x): x is string => typeof x === 'string')]
      : [];
    mutate(allow);
    raw['plugins'] = { ...plugins, allow };
    // P2-5③：temp + rename 原子写（对齐 write/edit 工具与 MemoryStore 口径）——写入中途崩溃
    // 不留半截 config；同目录 rename 保证同盘原子性
    const tmpPath = `${paths.globalConfig}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, paths.globalConfig);
  }
}
