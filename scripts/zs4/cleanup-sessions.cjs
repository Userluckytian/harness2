#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function parseArgs(argv) {
  const args = { apply: false, yes: false };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLocked(sessionDir) {
  const lockPath = path.join(sessionDir, 'lock');
  if (!fs.existsSync(lockPath)) return false;
  try {
    const content = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (typeof content?.pid === 'number' && isPidAlive(content.pid)) return true;
  } catch {
    // corrupted lock → treat as stale, not locked
  }
  return false;
}

function collectSessions(root) {
  const sessionsRoot = path.join(root, '.harness2', 'sessions');
  const result = [];
  if (!fs.existsSync(sessionsRoot)) return { sessionsRoot, result };
  let groups;
  try {
    groups = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return { sessionsRoot, result };
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const groupDir = path.join(sessionsRoot, g.name);
    let entries;
    try {
      entries = fs.readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sessionDir = path.join(groupDir, e.name);
      const logFile = path.join(sessionDir, 'session.v1.jsonl');
      if (!fs.existsSync(logFile)) continue;
      result.push({ id: e.name, dir: sessionDir, locked: isLocked(sessionDir) });
    }
  }
  return { sessionsRoot, result };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node scripts/zs4/cleanup-sessions.cjs [--apply --yes]');
    console.log('Default: dry-run. Only operates under HARNESS2_HOME (default ~/.harness2).');
    process.exit(0);
  }
  const home = process.env.HARNESS2_HOME || os.homedir();
  const { sessionsRoot, result } = collectSessions(home);

  const willDelete = result.filter((s) => !s.locked);
  const skippedLocked = result.filter((s) => s.locked);

  console.log(`HARNESS2_HOME=${home}`);
  console.log(`sessions root: ${sessionsRoot}`);
  console.log(`total sessions: ${result.length}`);
  console.log(`will delete: ${willDelete.length}`);
  console.log(`skipped (locked): ${skippedLocked.length}`);

  if (!args.apply) {
    console.log('dry-run: no changes. Pass --apply --yes to execute.');
    for (const s of willDelete) console.log(`  DEL ${s.id} ${s.dir}`);
    process.exit(0);
  }
  if (!args.yes) {
    console.error('refusing to apply without --yes');
    process.exit(2);
  }

  let deleted = 0;
  let failed = 0;
  for (const s of willDelete) {
    try {
      fs.rmSync(s.dir, { recursive: true, force: true });
      deleted += 1;
    } catch (e) {
      failed += 1;
      console.error(`  FAIL ${s.id}: ${e && e.message ? e.message : e}`);
    }
  }
  console.log(`deleted: ${deleted}`);
  console.log(`failed: ${failed}`);
  console.log(`skipped (locked): ${skippedLocked.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
