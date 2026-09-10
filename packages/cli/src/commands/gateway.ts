// packages/cli/src/commands/gateway.ts
// B3-1 拆分产物：原 index.ts 第 826–921 行逐字搬入，零逻辑改动。
// gateway 命令（阶段 9）：IM 网关常驻进程（QQ/飞书 → 本地 serve）。
// 依赖 @harness2/gateway 与 serve 均动态加载，避免拖慢 chat/serve 等所有命令的启动。
import { Command } from 'commander';
import type { PlatformAdapter } from '@harness2/gateway';
import { defaultConfigPaths, loadConfig, readAuthFile } from '@harness2/core';

export function registerGatewayCommand(program: Command): void {
  // —— gateway（阶段 9）：IM 网关常驻进程（QQ/飞书 → 本地 serve）——
  program
    .command('gateway')
    .description('启动 IM 网关：把 QQ/飞书消息桥接到本地会话（需先配置 config.gateways 与 auth.json.gateways 凭据）')
    .option('--root <dir>', 'serve 工作根目录（工具执行 cwd + 会话分组）', process.cwd())
    .option('--home <dir>', '用户数据根（默认 ~/.harness2）')
    .option('--port <n>', 'serve 监听端口（0 = 随机）', '0')
    .option('--platform <list>', '启用的平台（逗号分隔，缺省 = 配置里的全部）')
    .action(async (opts: { root: string; home?: string; port: string; platform?: string }) => {
      const { startServe } = await import('@harness2/core');
      const { startGateway, QqAdapter, FeishuAdapter } = await import('@harness2/gateway');
      const home = opts.home;
      const paths = defaultConfigPaths(opts.root, home);
      const loaded = loadConfig({ root: opts.root, ...(home !== undefined ? { home } : {}) });
      const auth = readAuthFile(paths.globalAuth);
      // P1-6（审查）：配置/凭据错误如实输出（对齐 config check 口径），排障不再被「凭据缺失」一言蔽之
      for (const err of loaded.errors) console.error(`config 错误: ${err}`);
      if (auth.error !== undefined) console.error(`auth 警告: ${auth.error}`);
      const gwConfig = loaded.config?.gateways ?? {};
      const gwAuth = auth.auth.gateways ?? {};

      const wanted = (opts.platform ?? 'qq,feishu')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const adapters: PlatformAdapter[] = [];
      const credFor = (name: string, envKey: string | undefined): { appId: string; appSecret: string } | null => {
        const fromAuth = gwAuth[name];
        if (fromAuth !== undefined) return fromAuth;
        const secret = envKey !== undefined ? process.env[envKey] : undefined;
        return typeof secret === 'string' && secret.length > 0
          ? { appId: gwConfig[name as keyof typeof gwConfig]!.appId, appSecret: secret }
          : null;
      };

      if (wanted.includes('qq')) {
        const qq = gwConfig.qq;
        if (qq === undefined || !qq.enabled) {
          console.error('提示: config.gateways.qq 未配置或 enabled=false，跳过 QQ');
        } else {
          const cred = gwAuth.qq ?? credFor('qq', qq.appSecretEnvKey);
          if (cred === null) {
            console.error(
              `error: QQ 网关凭据缺失——请在 auth.json.gateways.qq 配置 appId/appSecret（或设 ${qq.appSecretEnvKey ?? '对应环境变量'}）`,
            );
            process.exitCode = 1;
            return;
          }
          adapters.push(new QqAdapter({ config: qq, auth: cred }));
        }
      }
      if (wanted.includes('feishu')) {
        const fs = gwConfig.feishu;
        if (fs === undefined || !fs.enabled) {
          console.error('提示: config.gateways.feishu 未配置或 enabled=false，跳过飞书');
        } else {
          const cred = gwAuth.feishu ?? credFor('feishu', fs.appSecretEnvKey);
          if (cred === null) {
            console.error(
              `error: 飞书网关凭据缺失——请在 auth.json.gateways.feishu 配置 appId/appSecret（或设 ${fs.appSecretEnvKey ?? '对应环境变量'}）`,
            );
            process.exitCode = 1;
            return;
          }
          adapters.push(
            new FeishuAdapter({ config: fs, auth: cred, verificationToken: process.env['FEISHU_VERIFICATION_TOKEN'] }),
          );
        }
      }
      if (adapters.length === 0) {
        console.error('error: 没有可启用的平台（检查 --platform 与 config.gateways 配置）');
        process.exitCode = 1;
        return;
      }

      const serve = await startServe({
        port: Number(opts.port) || 0,
        root: opts.root,
        ...(home !== undefined ? { home } : {}),
      });
      const gw = await startGateway({
        root: opts.root,
        ...(home !== undefined ? { home } : {}),
        serve: { baseUrl: `http://127.0.0.1:${serve.port}`, wsUrl: `ws://127.0.0.1:${serve.port}/ws` },
        adapters,
      });
      console.log(JSON.stringify({ gateway: true, platforms: adapters.map((a) => a.channel), port: serve.port }));
      const shutdown = async (): Promise<void> => {
        await gw.stop();
        await serve.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
    });
}
