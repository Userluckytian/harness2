#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ptycap.py — TUI 抓屏对照台核心引擎（ConPTY 驱动 + 屏幕网格本地重绘）。

来源：本阶段编排者原型 `.tmp-cap/ptycap.py`（已实证可用），此处**硬化**而非重写：
  * 等屏幕稳定（轮询屏幕哈希，连续 N 次不变且静默时长足够）替代固定 sleep；
  * 每次抓屏产出三件套：`.png` + `.txt`（屏幕网格纯文本）+ 追加进 `log.json`；
  * 固定画布（默认 110x30，可配 160x40）；
  * 保留已修好的 CJK 字体回退（微软雅黑等），并新增符号字体回退（避免 ⏺/✓ 变豆腐块）；
  * 整体超时强杀子进程；步骤级 `kill` 语义（抓完即杀，供 grok 额度受限场景使用）。

⚠️ 诚实边界：产出的 PNG 是「ConPTY 抓屏 + 本地重绘」，**不是系统级窗口截图**。
   字体度量、抗锯齿、光标绘制均与 Windows Terminal 真机存在差异，结论请以 `.txt`
   屏幕网格为准，PNG 仅用于快速人眼比对。

退出码语义：
  0 = 全部步骤执行完毕，所有请求的截图均已落盘；
  2 = 整体超时被强杀；
  1 = 其它异常。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
import time
import unicodedata

import pyte
import winpty
from PIL import Image, ImageDraw, ImageFont

# --------------------------------------------------------------------------- #
# 配色（Windows Terminal Campbell 近似色）
# --------------------------------------------------------------------------- #

BASE16 = {
    "black": "#0c0c0c",
    "red": "#c50f1f",
    "green": "#13a10e",
    "brown": "#c19c00",
    "yellow": "#c19c00",
    "blue": "#0037da",
    "magenta": "#881798",
    "cyan": "#3a96dd",
    "white": "#cccccc",
    "default": "#cccccc",
}
BG = "#0c0c0c"
BG16 = {
    "black": "#0c0c0c",
    "red": "#c50f1f",
    "green": "#13a10e",
    "brown": "#c19c00",
    "yellow": "#c19c00",
    "blue": "#0037da",
    "magenta": "#881798",
    "cyan": "#3a96dd",
    "white": "#cccccc",
    "default": "#0c0c0c",
}

# 主字体（**必须是等宽且有基本框线字形**；缺失字形再回退，绝不用无中文字形的主字体）
MONO_CANDIDATES = [
    r"C:\Windows\Fonts\CascadiaMono.ttf",
    r"C:\Windows\Fonts\CascadiaCode.ttf",
    r"C:\Windows\Fonts\consola.ttf",
    r"C:\Windows\Fonts\DejaVuSansMono_0.ttf",
]
# CJK 回退（已修好，勿轻易改动顺序）
CJK_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]
# 符号回退（⏺ ✓ ❯ 等 Consolas 无字形者；仅当主字体确认缺失时才用）
SYMBOL_CANDIDATES = [
    r"C:\Windows\Fonts\seguisym.ttf",
    r"C:\Windows\Fonts\seguiemj.ttf",
    r"C:\Windows\Fonts\arial.ttf",
]

_MISSING_PROBE = "\ue000"  # 私用区码点：正常字体都不会有字形，用它的 .notdef 蒙版做参照


def _load(cands, size):
    for p in cands:
        if os.path.isfile(p):
            try:
                return ImageFont.truetype(p, size), p
            except Exception:
                continue
    return None, None


def is_wide(ch: str) -> bool:
    return any(unicodedata.east_asian_width(c) in ("W", "F") for c in ch)


def color_of(name: str, default: str) -> str:
    if not name or name == "default":
        return default
    if name.startswith("#"):
        return name
    return BASE16.get(name, default)


class Fonts:
    """字体链：宽字符 → CJK；其余 → 主字体；主字体缺字形 → 符号字体。

    「缺字形」判据：把该字符的位图掩码与私用区码点 `U+E000` 的 `.notdef` 掩码对比，
    相同即视为缺失（Pillow 12 的 `getmask` 返回 ImagingCore，用 `bytes()` 取原始掩码）。
    实测：Consolas 对 ⏺(U+23FA) / ✓(U+2713) / ❯(U+276F) 均属缺失，而 └(U+2514) / · 正常。
    """

    def __init__(self, size: int):
        self.size = size
        self.mono, self.mono_path = _load(MONO_CANDIDATES, size)
        if self.mono is None:
            self.mono, self.mono_path = ImageFont.load_default(), "default"
        self.cjk, self.cjk_path = _load(CJK_CANDIDATES, size)
        self.symbol, self.symbol_path = _load(SYMBOL_CANDIDATES, size)
        self._cache: dict[str, object] = {}
        self._probes: dict[int, bytes] = {}

    def describe(self) -> str:
        return (
            f"mono:{self.mono_path} + cjk:{self.cjk_path} + symbol:{self.symbol_path}"
        )

    def _probe_for(self, font) -> bytes:
        if font is None:
            return b""
        key = id(font)
        if key not in self._probes:
            try:
                self._probes[key] = bytes(font.getmask(_MISSING_PROBE))
            except Exception:
                self._probes[key] = b""
        return self._probes[key]

    def _missing(self, font, ch: str) -> bool:
        if font is None:
            return True
        probe = self._probe_for(font)
        if not probe:
            return False  # 参照蒙版为空 → 无法判定，保守认为有字形
        try:
            return bytes(font.getmask(ch)) == probe
        except Exception:
            return True

    def pick(self, ch: str):
        """返回 (font, span)。span 为占用的屏幕单元格数（宽字符恒为 2）。"""
        cached = self._cache.get(ch)
        if cached is not None:
            return cached
        wide = is_wide(ch)
        if wide and self.cjk is not None and not self._missing(self.cjk, ch):
            font = self.cjk
        elif not self._missing(self.mono, ch):
            font = self.mono
        elif self.symbol is not None and not self._missing(self.symbol, ch):
            font = self.symbol
        elif self.cjk is not None and not self._missing(self.cjk, ch):
            font = self.cjk
        else:
            font = self.mono
        out = (font, 2 if wide else 1)
        self._cache[ch] = out
        return out


# --------------------------------------------------------------------------- #
# 会话
# --------------------------------------------------------------------------- #


def screen_lines(screen, cols: int, rows: int) -> list[str]:
    """屏幕网格纯文本（每行定宽，未写过的格为空格；宽字符第二格为空串）。

    直接读 pyte 的 `screen.buffer`（稀疏 defaultdict），与原型一致，行为可预期。
    """
    out = []
    for y in range(rows):
        row = screen.buffer[y]
        out.append("".join((row[x].data or " ") for x in range(cols)))
    return out


def grid_text(lines: list[str]) -> str:
    return "\n".join(lines)


class Session:
    """一个 ConPTY 会话：后台线程喂 pyte，主线程发键/抓屏。"""

    def __init__(
        self,
        argv: list[str],
        cols: int = 110,
        rows: int = 30,
        cwd: str | None = None,
        env: dict | None = None,
    ):
        self.argv = list(argv)
        self.cols, self.rows = cols, rows
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.lock = threading.Lock()
        self.alive = True
        self._err: str | None = None
        self.proc = winpty.PtyProcess.spawn(
            self.argv, cwd=cwd, env=env, dimensions=(rows, cols)
        )
        self.thread = threading.Thread(target=self._reader, daemon=True)
        self.thread.start()

    # -- 内部 ---------------------------------------------------------------- #

    def _reader(self) -> None:
        while True:
            try:
                data = self.proc.read(4096)
            except EOFError:
                break
            except Exception as exc:  # 进程被杀后 read 会抛，属正常路径
                self._err = f"{type(exc).__name__}: {exc}"
                break
            if not data:
                break
            raw = data.encode("utf-8", "replace") if isinstance(data, str) else data
            with self.lock:
                self.stream.feed(raw)
        self.alive = False

    # -- 公共 ---------------------------------------------------------------- #

    def send(self, keys: str) -> None:
        self.proc.write(keys)

    def lines(self) -> list[str]:
        with self.lock:
            return screen_lines(self.screen, self.cols, self.rows)

    def screen_hash(self) -> str:
        return hashlib.md5(grid_text(self.lines()).encode("utf-8")).hexdigest()

    def wait_stable(
        self,
        timeout: float = 15.0,
        stable_ticks: int = 3,
        stable_seconds: float = 1.2,
        interval: float = 0.2,
        grace: float = 0.35,
        require_content: bool = True,
    ) -> dict:
        """等屏幕稳定：连续 `stable_ticks` 次哈希不变，且静默时长 ≥ `stable_seconds`。

        `require_content=True`（默认）时不接受「全空白屏」为稳定态——否则冷启动早期
        （node/grok 首帧前）会误判为已稳定而抓到空屏。
        """
        start = time.time()
        if grace > 0:
            time.sleep(grace)
        last: str | None = None
        same = 0
        changed_at = time.time()
        while True:
            h = self.screen_hash()
            blank = not any(ln.strip() for ln in self.lines())
            now = time.time()
            if h == last:
                same += 1
            else:
                same = 1 if last is None else 0
                changed_at = now
                last = h
            quiet = now - changed_at
            if same >= stable_ticks and quiet >= stable_seconds and not (require_content and blank):
                return {
                    "settled": True,
                    "elapsed": round(now - start, 3),
                    "quiet": round(quiet, 3),
                    "ticks": same,
                }
            if now - start >= timeout:
                return {
                    "settled": False,
                    "elapsed": round(now - start, 3),
                    "quiet": round(quiet, 3),
                    "ticks": same,
                    "reason": "timeout",
                }
            time.sleep(interval)

    def wait_exit(self, timeout: float = 5.0) -> None:
        """等子进程自行退出（供 /exit 后取真实 exit status），超时不报错。"""
        end = time.time() + timeout
        while time.time() < end:
            try:
                if not self.proc.isalive():
                    return
            except Exception:
                return
            time.sleep(0.1)

    def exitstatus(self):
        """pywinpty 3.x 的 `exitstatus` 是 int 属性（旧版是方法），两兼容。"""
        try:
            v = self.proc.exitstatus
        except Exception:
            return None
        if callable(v):
            try:
                return v()
            except Exception:
                return None
        return v

    def kill(self) -> None:
        try:
            if self.proc.isalive():
                self.proc.terminate(force=True)
        except Exception:
            pass
        try:
            self.proc.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# 渲染
# --------------------------------------------------------------------------- #


def render_png(session: Session, path: str, fontsize: int = 16, scale: int = 2):
    """按 `scale` 倍超采样渲染后缩回 1x，得到平滑的「终端截图」。返回 (path, fonts)。"""
    fs = fontsize * scale
    fonts = Fonts(fs)
    font = fonts.mono
    bbox = font.getbbox("M")
    cw = max(8, bbox[2] - bbox[0] + 2)
    ch = fontsize * scale + 6
    pad = 8 * scale
    w = session.cols * cw + pad * 2
    h = session.rows * ch + pad * 2
    img = Image.new("RGB", (w, h), BG)
    draw = ImageDraw.Draw(img)
    with session.lock:
        for y in range(session.rows):
            row = session.screen.buffer[y]
            x = 0
            while x < session.cols:
                cell = row[x]
                s = cell.data or ""
                if s == "":
                    x += 1
                    continue
                use, span = fonts.pick(s)
                fg = color_of(cell.fg, BASE16["default"])
                bg = color_of(cell.bg, BG)
                if cell.reverse:
                    fg, bg = bg, fg
                px, py = pad + x * cw, pad + y * ch
                if bg != BG:
                    draw.rectangle([px, py, px + cw * span - 1, py + ch - 1], fill=bg)
                if s != " ":
                    draw.text((px, py), s, font=use, fill=fg)
                x += span
    out = img.resize((w // scale, h // scale), Image.LANCZOS)
    out.save(path)
    return path, fonts.describe()


def dump_text(session: Session, path: str) -> str:
    lines = [ln.rstrip() for ln in session.lines()]
    while lines and not lines[-1]:
        lines.pop()
    txt = "\n".join(lines)
    with open(path, "w", encoding="utf-8") as f:
        f.write(txt + "\n")
    return txt


# --------------------------------------------------------------------------- #
# 步骤执行（CLI 与场景运行器共用）
# --------------------------------------------------------------------------- #


def decode_keys(raw: str) -> str:
    return (
        raw.replace("\\r", "\r")
        .replace("\\n", "\n")
        .replace("\\x1b", "\x1b")
        .replace("\\t", "\t")
        .replace("\\x03", "\x03")
        .replace("\\x04", "\x04")
    )


def run_steps(session: Session, steps, outdir, log_path, opts) -> tuple[bool, list]:
    """执行步骤剧本。返回 (整体是否完成, 截图记录列表)。

    单步字段：
      keys    : str   —— 要发送的按键（支持 \\r \\n \\x1b \\t \\x03 \\x04）
      wait    : float —— 固定等待秒数（**不做稳定判定**，供「流式中截图」）
      settle  : bool  —— 是否等屏幕稳定；给了 wait 时默认 false，否则默认 true
      timeout : float —— 本步等稳定的上限秒数
      stable_seconds : float —— 本步要求的静默窗口（覆盖全局，冷启动首帧宜调大）
      stable_ticks   : int   —— 本步要求的连续不变次数（覆盖全局）
      require_content : bool —— 等稳定时是否拒绝「全空白屏」（默认 true，防冷启动误判）
      shot    : str   —— 截图名（落 <outdir>/<shot>.png + .txt）
      kill    : bool  —— 截图后立刻强杀并结束剧本（额度受限场景用）
    """
    os.makedirs(outdir, exist_ok=True)
    records: list = []
    completed = True

    def write_log() -> None:
        payload = {
            "engine": "scripts/tui-parity/ptycap.py",
            "boundary": "PNG 为 ConPTY 抓屏 + 本地重绘，非系统级窗口截图",
            "argv": session.argv,
            "cols": session.cols,
            "rows": session.rows,
            "shots": records,
        }
        with open(log_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

    write_log()

    def take_shot(name: str, extra: dict) -> None:
        png = os.path.join(outdir, name + ".png")
        txt = os.path.join(outdir, name + ".txt")
        _, font_desc = render_png(session, png, opts.fontsize, opts.scale)
        text = dump_text(session, txt)
        lines = session.lines()
        rec = {
            "shot": name,
            "png": png,
            "txt": txt,
            "font": font_desc,
            "cols": session.cols,
            "rows": session.rows,
            "bytes_png": os.path.getsize(png),
            "text_preview": text[:400],
            **extra,
        }
        records.append(rec)
        write_log()
        print(f"[shot] {name} -> {png} ({rec['bytes_png']} B)", flush=True)

    for i, st in enumerate(steps, 1):
        label = st.get("shot") or f"#step{i}"
        keys = st.get("keys")
        if keys:
            session.send(decode_keys(keys))
        info: dict = {"step": i, "settled": None}
        if st.get("wait") is not None:
            time.sleep(float(st["wait"]))
            info["waited"] = float(st["wait"])
        elif st.get("settle", True):
            res = session.wait_stable(
                timeout=float(st.get("timeout", opts.settle_timeout)),
                stable_ticks=int(st.get("stable_ticks", opts.stable_ticks)),
                stable_seconds=float(st.get("stable_seconds", opts.stable_seconds)),
                interval=opts.interval,
                grace=opts.grace,
                require_content=bool(st.get("require_content", True)),
            )
            info.update(res)
            if not res["settled"]:
                print(f"[warn] {label} 未在 {res['elapsed']}s 内稳定，仍按现状抓屏", flush=True)
        if st.get("shot"):
            take_shot(st["shot"], info)
        if st.get("kill"):
            print(f"[kill] {label} 抓屏后强杀（额度受限场景）", flush=True)
            break
    return completed, records


# --------------------------------------------------------------------------- #
# CLI（单会话）
# --------------------------------------------------------------------------- #


class _Opts:
    def __init__(self, a):
        self.fontsize = a.fontsize
        self.scale = a.scale
        self.settle_timeout = a.settle_timeout
        self.stable_ticks = a.stable_ticks
        self.stable_seconds = a.stable_seconds
        self.interval = a.interval
        self.grace = a.grace
        self.exit_wait = a.exit_wait


def main() -> int:
    # 中文证据输出走 UTF-8，避免 Windows 管道下变乱码
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="ConPTY 抓屏对照台（单会话）")
    ap.add_argument("--cmd", help="命令行字符串（按空格切分）")
    ap.add_argument("--argv", help="命令行 JSON 数组（需要精确控制时用）")
    ap.add_argument("--cwd", default=None)
    ap.add_argument("--env", action="append", default=[], help="附加环境变量 KEY=VAL，可重复")
    ap.add_argument("--cols", type=int, default=110)
    ap.add_argument("--rows", type=int, default=30)
    ap.add_argument("--steps", required=True, help="JSON 步骤数组")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--fontsize", type=int, default=16)
    ap.add_argument("--scale", type=int, default=2)
    ap.add_argument("--timeout", type=float, default=120.0, help="整体超时（秒），到点强杀")
    ap.add_argument("--settle-timeout", type=float, default=15.0)
    ap.add_argument("--stable-ticks", type=int, default=3)
    ap.add_argument("--stable-seconds", type=float, default=1.2)
    ap.add_argument("--interval", type=float, default=0.2)
    ap.add_argument("--grace", type=float, default=0.35)
    ap.add_argument("--exit-wait", type=float, default=5.0, help="步骤跑完后等子进程自行退出的秒数")
    a = ap.parse_args()

    if a.argv:
        argv = json.loads(a.argv)
    elif a.cmd:
        argv = a.cmd.split(" ")
    else:
        ap.error("必须给 --cmd 或 --argv")

    env = dict(os.environ)
    for kv in a.env:
        k, _, v = kv.partition("=")
        env[k] = v

    os.makedirs(a.outdir, exist_ok=True)
    steps = json.loads(a.steps)
    opts = _Opts(a)

    sess = Session(argv, a.cols, a.rows, a.cwd, env)
    timed_out = threading.Event()

    def watchdog():
        if not timed_out.wait(a.timeout):
            print(f"[timeout] 超 {a.timeout}s，强杀子进程", flush=True)
            timed_out.set()
            sess.kill()

    wd = threading.Thread(target=watchdog, daemon=True)
    wd.start()

    try:
        _, records = run_steps(sess, steps, a.outdir, os.path.join(a.outdir, "log.json"), opts)
        if timed_out.is_set():
            return 2
        sess.wait_exit(opts.exit_wait)
        print(f"[done] {len(records)} 张截图 -> {a.outdir}；子进程 exit={sess.exitstatus()}", flush=True)
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"[error] {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        return 1
    finally:
        sess.kill()


if __name__ == "__main__":
    raise SystemExit(main())
