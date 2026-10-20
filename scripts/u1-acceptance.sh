#!/usr/bin/env bash
# U1 验收脚本（编排者验收 V1-V5 复跑用；证据逐段贴入验收记录）
set -uo pipefail
cd "$(dirname "$0")/.."
LOG="${1:-/tmp/u1-acceptance.log}"
: > "$LOG"
run() { echo "## $*" >>"$LOG"; "$@" >>"$LOG" 2>&1; local s=$?; echo "## EXIT=$s" >>"$LOG"; echo "[$( [ $s -eq 0 ] && echo ok || echo RED )] $*"; }

echo "=== V3 冻结区零越界 ==="
git diff main --stat -- packages/core packages/gateway | tee -a "$LOG"
git diff main --name-only -- packages/core/test/fixtures/api-surface-baseline.json | wc -l | xargs echo "baseline diff lines:"

echo "=== V4 全闸门 ==="
run pnpm -r build
for p in core gateway ui-shared web cli desktop; do run pnpm --filter "@harness2/$p" test; done
run pnpm -r typecheck

echo "=== B4 冒烟 ==="
( cd packages/desktop && run pnpm smoke )

echo "=== V1/V2 预算用例存在性（红=用例名缺失，须先派 T1-T4 实施）==="
grep -rl "resolveDefaultWorkspaceRoot\|pickFolder.*50\|interrupted.*30\|replay.*200" packages/desktop/test packages/ui-shared/test 2>/dev/null
echo "log: $LOG"
