// StatusBar：常驻顶部一行，显示模式别名、角色名、cwd（含 git 分支）、上下文占用。
// 上下文占用数据源 = core getContextUsage（唯一实现，禁止三套算法）。
import React, { useEffect, useState, type ReactElement } from 'react';
import { Box, Text } from 'ink';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getContextUsage } from '@harness2/core';
import type { ApprovalMode } from '@harness2/core';
import { CORE_MODE_TO_ALIAS } from '../mode-alias.js';
import type { ChatRuntime } from '../chat-setup.js';

const execFileAsync = promisify(execFile);

interface StatusBarProps {
  runtime: ChatRuntime;
}

function useGitBranch(cwd: string): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 2000 })
      .then(({ stdout }) => {
        if (!cancelled) setBranch(stdout.trim());
      })
      .catch(() => {
        // 非 git 仓库或 git 不可用，静默
      });
    return () => { cancelled = true; };
  }, [cwd]);
  return branch;
}

function useContextUsage(dir: string | null): number | undefined {
  const [usage, setUsage] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (dir === null) { setUsage(undefined); return; }
    setUsage(getContextUsage(dir));
  }, [dir]);
  return usage;
}

function formatPercent(ratio: number | undefined): string {
  if (ratio === undefined) return '—';
  return `${Math.round(ratio * 100)}%`;
}

export function StatusBar({ runtime }: StatusBarProps): ReactElement {
  const mode = runtime.mode();
  const alias = CORE_MODE_TO_ALIAS[mode];
  const current = runtime.getCurrent();
  const cwd = runtime.root;
  const branch = useGitBranch(cwd);
  const usage = useContextUsage(current?.dir ?? null);

  return (
    <Box borderStyle="single" paddingX={1} justifyContent="space-between">
      <Box gap={1}>
        <Text color="cyan" bold>[{alias}]</Text>
        <Text color="gray">|</Text>
        <Text>{cwd}{branch ? ` (${branch})` : ''}</Text>
      </Box>
      <Box>
        <Text color="gray">ctx </Text>
        <Text color={usage !== undefined && usage > 0.8 ? 'red' : undefined}>{formatPercent(usage)}</Text>
      </Box>
    </Box>
  );
}