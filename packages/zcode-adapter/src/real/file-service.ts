import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { createStubService } from '../stub-factory.js';
import { resolveHarness2Home } from './core-bridge.js';
import type { IFileService } from '@zcode/services';

export interface FileServiceOptions {
  dataRoot?: string;
  home?: string;
}

export function createFileService(opts: FileServiceOptions = {}): IFileService {
  const home = opts.home ?? resolveHarness2Home();
  const root = opts.dataRoot ?? join(home, '.harness2');
  const impl: Record<string, unknown> = {
    async ensureConversationWorkspace(): Promise<unknown> {
      const p = join(root, '.zcode', 'workspace', 'default');
      const created = !existsSync(p);
      if (created) mkdirSync(p, { recursive: true });
      return { path: p, created, workspacePurpose: 'conversation' };
    },
    async createDefaultWorkspace(): Promise<unknown> {
      const p = join(root, '.zcode', 'workspace', 'default');
      const created = !existsSync(p);
      if (created) mkdirSync(p, { recursive: true });
      return { path: p, created };
    },
    async readdir(params: unknown): Promise<unknown> {
      const p = (params as { path: string }).path;
      try {
        return readdirSync(p, { withFileTypes: true }).map((d) => ({
          name: d.name,
          isDirectory: d.isDirectory(),
          path: join(p, d.name),
        }));
      } catch {
        return [];
      }
    },
    async stat(params: unknown): Promise<unknown> {
      const p = (params as { path: string }).path;
      try {
        const s = statSync(p);
        return { size: s.size, isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs };
      } catch {
        return null;
      }
    },
    async readTextFile(params: unknown): Promise<unknown> {
      const p = (params as { path: string }).path;
      return readFileSync(p, 'utf8');
    },
    async checkFilesExist(params: unknown): Promise<unknown> {
      const out: { path: string; exists: boolean }[] = [];
      for (const p of (params as { paths: string[] }).paths ?? []) out.push({ path: p, exists: existsSync(p) });
      return out;
    },
    async resolvePath(params: unknown): Promise<unknown> {
      const p = (params as { path: string }).path;
      return isAbsolute(p) ? p : resolve(p);
    },
  };
  return createStubService<IFileService>({
    channelName: 'file',
    classification: 'B',
    impl: impl as Record<string, unknown>,
  });
}
