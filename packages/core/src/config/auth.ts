// auth.json 读写：密钥唯一落盘位置（~/.harness2/auth.json），永不入 git/config/事件日志。
// 读容错：文件不存在 = 空表；损坏 = 空表 + 一行错误（错误消息经脱敏）。
// 写尽力：POSIX chmod 600（Windows 不支持 POSIX 权限位，依赖目录 ACL——文档已注明）。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactSecrets } from './redact.js';
export interface ChannelAuth {
  apiKey: string;
}

export interface AuthFile {
  channels: Record<string, ChannelAuth>;
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
  for (const [channel, v] of Object.entries(rawChannels)) {
    const apiKey =
      typeof v === 'string'
        ? v // 宽容形态：channels.deepseek = "sk-..." 直接给字符串
        : typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['apiKey'] === 'string'
          ? ((v as Record<string, unknown>)['apiKey'] as string)
          : undefined;
    if (apiKey === undefined || apiKey === '') {
      return {
        auth: emptyAuth(),
        error: `auth.json.channels.${channel} 缺少非空 apiKey 字段，已按未配置处理`,
      };
    }
    auth.channels[channel] = { apiKey };
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
