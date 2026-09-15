#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""run.py — TUI 抓屏对照台场景运行器。

读取 `scenarios/*.json`，把占位符（`${REPO}` / `${TMP_HOME}` / `${GROK}`）注入后，
用 `ptycap.py` 的引擎跑**同一份步骤剧本**，产物落 `<outdir>/<scenario-id>/<side>/`。

额度约束：grok 侧必须显式 `--allow-grok` 才会执行，且默认单次运行最多跑
`--grok-budget 1` 个 grok 场景（超出直接报错退出），防止误耗额度。

用法示例：
  python run.py --list
  python run.py scenarios/A1-cold-start.json scenarios/B1-stream.json --side ours
  python run.py scenarios/A1-cold-start.json --side grok --allow-grok

退出码：0 = 全部成功；1 = 场景/参数错误；2 = 有场景超时被强杀；3 = 有步骤执行异常。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ptycap import Session, run_steps  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SCENARIO_DIR = os.path.join(HERE, "scenarios")

GROK_CANDIDATES = [
    os.path.join(os.path.expanduser("~"), ".grok", "bin", "grok.exe"),
    "grok.exe",
    "grok",
]


class _Opts:
    """与 ptycap.run_steps 约定的选项容器。"""

    def __init__(self, a):
        self.fontsize = a.fontsize
        self.scale = a.scale
        self.settle_timeout = a.settle_timeout
        self.stable_ticks = a.stable_ticks
        self.stable_seconds = a.stable_seconds
        self.interval = a.interval
        self.grace = a.grace
        self.exit_wait = a.exit_wait


def find_grok() -> str | None:
    for c in GROK_CANDIDATES:
        if os.path.isabs(c) and os.path.isfile(c):
            return c
        found = shutil.which(c)
        if found:
            return found
    return None


def expand(node, vars_: dict):
    """递归替换 argv / 字符串里的 ${VAR} 占位符。"""
    if isinstance(node, str):
        out = node
        for k, v in vars_.items():
            out = out.replace("${" + k + "}", v)
        return out
    if isinstance(node, list):
        return [expand(x, vars_) for x in node]
    if isinstance(node, dict):
        return {k: expand(v, vars_) for k, v in node.items()}
    return node


def load_scenarios(paths: list[str]) -> list[dict]:
    files = paths or sorted(
        os.path.join(SCENARIO_DIR, f)
        for f in os.listdir(SCENARIO_DIR)
        if f.endswith(".json")
    )
    seen: set[str] = set()
    out: list[dict] = []
    for p in files:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        items = data if isinstance(data, list) else [data]
        for sc in items:
            for key in ("id", "group", "watch", "sides", "steps"):
                if key not in sc:
                    raise SystemExit(f"[schema] {p} 缺少必填字段 {key!r}")
            if sc["id"] in seen:
                raise SystemExit(f"[schema] 场景 id 重复：{sc['id']}")
            seen.add(sc["id"])
            sc["_file"] = os.path.relpath(p, REPO).replace("\\", "/")
            out.append(sc)
    return out


def run_side(sc: dict, side: str, side_cfg: dict, opts, outdir: str, tmp_home: str, grok: str | None) -> int:
    canvas = sc.get("canvas", {})
    cols = int(canvas.get("cols", 110))
    rows = int(canvas.get("rows", 30))

    # 每个场景独立临时目录（home + work），保证「冷启动」确定且互不污染
    sc_tmp = os.path.join(tmp_home, sc["id"])
    for sub in ("home", "work"):
        os.makedirs(os.path.join(sc_tmp, sub), exist_ok=True)

    if side == "grok" and not grok:
        print(f"[skip] {sc['id']}: 找不到 grok 可执行文件", flush=True)
        return 1

    vars_ = {"REPO": REPO.replace("\\", "/"), "TMP_HOME": sc_tmp.replace("\\", "/"), "GROK": grok or "grok"}
    argv = [str(x) for x in expand(side_cfg["argv"], vars_)]
    cwd = expand(side_cfg.get("cwd", sc_tmp), vars_)

    env = dict(os.environ)
    if side_cfg.get("isolate_home", side == "ours"):
        # 隔离会话/配置目录（node os.homedir() 在 Windows 读 USERPROFILE）
        iso_home = os.path.join(sc_tmp, "home")
        env["USERPROFILE"] = iso_home
        env["HOME"] = iso_home
        env["HOMEDRIVE"], env["HOMEPATH"] = os.path.splitdrive(iso_home)
    env.update({k: str(v) for k, v in expand(side_cfg.get("env", {}), vars_).items()})

    steps = sc["steps"]
    sdir = os.path.join(outdir, sc["id"], side)
    os.makedirs(sdir, exist_ok=True)

    print(f"[run] {sc['id']} / {side} @ {cols}x{rows}\n      argv={argv}\n      cwd={cwd}", flush=True)
    sess = Session(argv, cols, rows, cwd, env)
    timeout = float(sc.get("timeout", 120.0))
    timed_out = threading.Event()

    def watchdog():
        if not timed_out.wait(timeout):
            print(f"[timeout] {sc['id']}/{side} 超 {timeout}s，强杀", flush=True)
            timed_out.set()
            sess.kill()

    threading.Thread(target=watchdog, daemon=True).start()
    try:
        _, records = run_steps(sess, steps, sdir, os.path.join(sdir, "log.json"), opts)
        sess.wait_exit(opts.exit_wait)
        print(
            f"[done] {sc['id']}/{side}: {len(records)} 张截图 -> {sdir}；exit={sess.exitstatus()}",
            flush=True,
        )
        return 2 if timed_out.is_set() else 0
    except Exception as exc:  # noqa: BLE001
        print(f"[error] {sc['id']}/{side}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        return 3
    finally:
        sess.kill()


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="TUI 抓屏对照台场景运行器")
    ap.add_argument("scenarios", nargs="*", help="场景 JSON 路径（默认全部）")
    ap.add_argument("--side", choices=["ours", "grok", "both"], default="ours")
    ap.add_argument("--only", help="只跑 id 匹配该前缀的场景")
    ap.add_argument("--list", action="store_true", help="列出场景后退出")
    ap.add_argument("--allow-grok", action="store_true", help="允许执行 grok 侧（消耗额度）")
    ap.add_argument("--grok-budget", type=int, default=1, help="本次运行允许的 grok 场景数上限")
    ap.add_argument(
        "--include-defined-only",
        action="store_true",
        help="连同 defined_only（mock 无法复现、只定义不执行）的场景一起跑",
    )
    ap.add_argument("--outdir", default=os.path.join(HERE, "out"))
    ap.add_argument("--tmp-home", default=None, help="复用指定临时 HOME（默认新建）")
    ap.add_argument("--fontsize", type=int, default=16)
    ap.add_argument("--scale", type=int, default=2)
    ap.add_argument("--settle-timeout", type=float, default=15.0)
    ap.add_argument("--stable-ticks", type=int, default=3)
    ap.add_argument("--stable-seconds", type=float, default=1.2)
    ap.add_argument("--interval", type=float, default=0.2)
    ap.add_argument("--grace", type=float, default=0.35)
    ap.add_argument("--exit-wait", type=float, default=5.0, help="步骤跑完后等子进程自行退出的秒数")
    a = ap.parse_args()

    scenarios = load_scenarios(a.scenarios)
    if a.only:
        scenarios = [s for s in scenarios if s["id"].startswith(a.only)]

    if a.list:
        print(f"共 {len(scenarios)} 个场景：")
        for s in scenarios:
            sides = "+".join(sorted(s["sides"]))
            flag = " [defined_only]" if s.get("defined_only") else ""
            print(f"  [{s['group']}] {s['id']:<28} sides={sides:<10}{flag} {s['watch']}")
        return 0

    skipped = [s["id"] for s in scenarios if s.get("defined_only")]
    if skipped and not a.include_defined_only:
        scenarios = [s for s in scenarios if not s.get("defined_only")]
        print(f"[skip] defined_only 场景共 {len(skipped)} 个（mock 无法复现）：{', '.join(skipped)}", flush=True)
        print("       需要时加 --include-defined-only 强制执行。", flush=True)

    if not scenarios:
        print("[warn] 没有匹配的场景", file=sys.stderr)
        return 1

    sides = ["ours", "grok"] if a.side == "both" else [a.side]
    grok = find_grok()
    if "grok" in sides:
        if not a.allow_grok:
            print(
                "[guard] grok 侧会消耗额度，必须显式加 --allow-grok 才会执行。\n"
                "        （额度约束：只允许跑 1 个最小场景做冒烟，其余只定义不执行）",
                file=sys.stderr,
            )
            return 1
        n_grok = sum(1 for s in scenarios if "grok" in s["sides"])
        if n_grok > a.grok_budget:
            print(
                f"[guard] 本次要跑 {n_grok} 个 grok 场景，超过 --grok-budget={a.grok_budget}；"
                "请用 --only/指定文件收窄，或显式调大预算。",
                file=sys.stderr,
            )
            return 1

    tmp_home = a.tmp_home or os.path.join(a.outdir, "_tmp-home", time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(tmp_home, exist_ok=True)
    print(f"[env] REPO={REPO}\n      TMP_HOME={tmp_home}\n      GROK={grok}", flush=True)

    opts = _Opts(a)
    rc = 0
    for sc in scenarios:
        for side in sides:
            cfg = sc["sides"].get(side)
            if not cfg:
                continue
            r = run_side(sc, side, cfg, opts, a.outdir, tmp_home, grok)
            rc = max(rc, r)
    print(f"[summary] 完成，最高退出码={rc}；产物：{a.outdir}", flush=True)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
