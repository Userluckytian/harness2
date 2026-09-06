// auth.json 读写：密钥唯一落盘位置（~/.harness2/auth.json），永不入 git/config/事件日志。
// 读容错：文件不存在 = 空表；损坏 = 空表 + 一行错误（错误消息经脱敏）。
// 写尽力：POSIX chmod 600（Windows 不支持 POSIX 权限位，依赖目录 ACL——文档已注明）。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactSecrets } from './redact.js';
export interface ChannelAuth {
  apiKey: string;
}

/** IM 网关凭据（阶段 9）：appId 非密钥但为对称起见与 appSecret 一起存 gateways 段 */
export interface GatewayAuth {
  appId: string;
  appSecret: string;
}

export interface AuthFile {
  channels: Record<string, ChannelAuth>;
  /** 网关凭据（阶段 9；键 = 渠道名 'qq' | 'feishu'）。缺省/损坏 = undefined（按未配置处理） */
  gateways?: Record<string, GatewayAuth>;
}

export function emptyAuth(): AuthFile {
  return { channels: {} };
}

export interface ReadAuthResult {
  auth: AuthFile;
  /** 文件损坏/非法时的单行错误（auth 仍为空表，调用方决定是否告警） */
  error?: string;
}

/** 读取 auth.json：不存在 = 空表；损坏/形状非法 = 空表 + 脱敏的一行错误 */
export function readAuthFile(path: string): ReadAuthResult {
  if (!existsSync(path)) return { auth: emptyAuth() };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { auth: emptyAuth(), error: `auth.json 读取失败: ${redactSecrets((e as Error).message)}` };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { auth: emptyAuth(), error: `auth.json 格式非法（应为 JSON 对象），已按未配置处理` };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { auth: emptyAuth(), error: `auth.json 顶层必须是对象，已按未配置处理` };
  }
  const auth = emptyAuth();
  const rawChannels = (obj as Record<string, unknown>)['channels'];
  if (rawChannels === undefined) return { auth }; // 允许空对象
  if (typeof rawChannels !== 'object' || rawChannels === null || Array.isArray(rawChannels)) {
    return { auth: emptyAuth(), error: `auth.json.channels 必须是对象，已按未配置处理` };
  }
  // P2-7：缺/空 apiKey 的渠道全部收集，错误消息一次列全（只报第一个会让用户修一个错跑一次）
  const brokenChannels: string[] = [];
  for (const [channel, v] of Object.entries(rawChannels)) {
    const apiKey =
      typeof v === 'string'
        ? v // 宽容形态：channels.deepseek = "sk-..." 直接给字符串
        : typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['apiKey'] === 'string'
          ? ((v as Record<string, unknown>)['apiKey'] as string)
          : undefined;
    if (apiKey === undefined || apiKey === '') {
      brokenChannels.push(channel);
      continue;
    }
    auth.channels[channel] = { apiKey };
  }
  if (brokenChannels.length > 0) {
    return {
      auth: emptyAuth(),
      error: `auth.json.channels 缺少非空 apiKey 字段的渠道：${brokenChannels.join('、')}（已按未配置处理）`,
    };
  }
  // —— gateways 段（阶段 9）：appId+appSecret 双字段必填；缺/空 = 该段整体按未配置处理
  const rawGateways = (obj as Record<string, unknown>)['gateways'];
  if (rawGateways !== undefined) {
    if (typeof rawGateways !== 'object' || rawGateways === null || Array.isArray(rawGateways)) {
      return { auth, error: `auth.json.gateways 必须是对象，已按未配置处理` };
    }
    const brokenGateways: string[] = [];
    const gateways: Record<string, GatewayAuth> = {};
    for (const [name, v] of Object.entries(rawGateways)) {
      const appId =
        typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['appId'] === 'string'
          ? ((v as Record<string, unknown>)['appId'] as string)
          : undefined;
      const appSecret =
        typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['appSecret'] === 'string'
          ? ((v as Record<string, unknown>)['appSecret'] as string)
          : undefined;
      if (!appId || !appSecret) {
        brokenGateways.push(name);
        continue;
      }
      gateways[name] = { appId, appSecret };
    }
    if (brokenGateways.length > 0) {
      return {
        auth,
        error: `auth.json.gateways 缺少非空 appId/appSecret 字段的渠道：${brokenGateways.join('、')}（已按未配置处理）`,
      };
    }
    auth.gateways = gateways;
  }
  return { auth };
}

/** 写 auth.json：目录不存在则创建；写后尽力 chmod 600；写入内容全量覆盖 */
export function writeAuthFile(path: string, auth: AuthFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows 不支持 POSIX 权限位：尽力而为，安全性依赖目录 ACL（文档注明）
  }
}
