// CoreCommandContext → SessionCapabilityContext 的同构映射（P7-B 接线缝）。
//
// 为什么单独一个模块：session/capabilities.ts 是 B 棒交付的 core 实现（禁改），
// commands/registry.ts（RUNS 表）与 commands/handlers.ts（/compact 默认路径）都要用它，
// 直接互引会形成 registry ↔ handlers 的循环 import；本文件只依赖 types + session 契约，
// 无环，两侧共享同一份映射（避免两处各写一份）。
import type { SessionCapabilityContext } from '../session/capabilities.js';
import type { CoreCommandContext } from './types.js';

/**
 * 会话能力命令（search/reindex/import/title/compact-layers）的 core 实现只依赖
 * manager/cwd/print/current/contextUsage；writer 结构兼容 SessionAppender，直接透传。
 */
export function asSessionCapabilityContext(ctx: CoreCommandContext): SessionCapabilityContext {
  return {
    manager: ctx.manager,
    cwd: ctx.cwd,
    print: ctx.print,
    current: () => {
      const c = ctx.current();
      return c === null ? null : { id: c.id, writer: c.writer };
    },
    ...(ctx.contextUsage !== undefined ? { contextUsage: ctx.contextUsage } : {}),
  };
}
