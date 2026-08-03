#!/usr/bin/env python3
"""Assemble the integration evidence run into one self-contained HTML report.

Usage: build-report.py <evidence-dir>

Reads NN-slug/ step directories (meta.json + output.txt + *.png) and writes
<evidence-dir>/report.html with every screenshot base64-inlined, so the file
can be copied or shared on its own.
"""

import base64
import html
import json
import re
import sys
from pathlib import Path

MAX_OUTPUT_LINES = 120

VERDICT_COLORS = {"pass": "#2da44e", "warn": "#d4a72c", "fail": "#cf222e"}

CSS = """
body { font-family: -apple-system, "Helvetica Neue", sans-serif; margin: 0;
       background: #0d1117; color: #e6edf3; }
.wrap { max-width: 980px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
h1 { font-size: 1.5rem; margin-bottom: .25rem; }
.meta { color: #8b949e; font-size: .85rem; margin-bottom: 1.5rem; }
.counts span { display: inline-block; padding: .15rem .6rem; border-radius: 1rem;
       font-size: .8rem; font-weight: 600; margin-right: .5rem; color: #fff; }
.step { border: 1px solid #30363d; border-radius: 8px; margin: 1.25rem 0;
       overflow: hidden; }
.step > header { display: flex; align-items: center; gap: .75rem;
       padding: .75rem 1rem; background: #161b22; }
.step h2 { font-size: 1rem; margin: 0; flex: 1; }
.badge { padding: .1rem .55rem; border-radius: 1rem; font-size: .75rem;
       font-weight: 700; color: #fff; text-transform: uppercase; }
.body { padding: 1rem; }
.notes { margin: 0 0 .75rem; color: #c9d1d9; }
pre { background: #161b22; border: 1px solid #30363d; border-radius: 6px;
       padding: .75rem; overflow-x: auto; font-size: .78rem; line-height: 1.45;
       white-space: pre-wrap; word-break: break-word; }
pre.cmd { border-left: 3px solid #58a6ff; }
img.shot { max-width: 100%; border: 1px solid #30363d; border-radius: 6px;
       margin: .5rem 0; display: block; }
.compare { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem;
       margin: .5rem 0; }
.compare figure { margin: 0; }
.compare figcaption { color: #8b949e; font-size: .75rem; margin-bottom: .25rem; }
.compare img.shot { margin: 0; }
.truncated { color: #8b949e; font-size: .75rem; font-style: italic; }
"""


def b64_img(path: Path) -> str:
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f'<img class="shot" src="data:image/png;base64,{data}" alt="{html.escape(path.name)}">'


def render_step(step_dir: Path, prev_run: Path | None) -> tuple[str, str]:
    meta = {}
    meta_path = step_dir / "meta.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
        except json.JSONDecodeError:
            pass
    title = meta.get("title") or step_dir.name
    verdict = meta.get("verdict", "warn")
    color = VERDICT_COLORS.get(verdict, VERDICT_COLORS["warn"])

    parts = [f'<section class="step" id="{html.escape(step_dir.name)}">']
    parts.append(
        f'<header><h2>{html.escape(step_dir.name.split("-", 1)[0])} · '
        f'{html.escape(title)}</h2>'
        f'<span class="badge" style="background:{color}">{html.escape(verdict)}</span></header>'
    )
    parts.append('<div class="body">')
    if meta.get("notes"):
        parts.append(f'<p class="notes">{html.escape(meta["notes"])}</p>')
    for cmd in meta.get("commands", []):
        parts.append(f'<pre class="cmd">$ {html.escape(cmd)}</pre>')
    out = step_dir / "output.txt"
    if out.exists():
        lines = out.read_text(errors="replace").splitlines()
        text = "\n".join(lines[:MAX_OUTPUT_LINES])
        parts.append(f"<pre>{html.escape(text)}</pre>")
        if len(lines) > MAX_OUTPUT_LINES:
            parts.append(
                f'<p class="truncated">output truncated to {MAX_OUTPUT_LINES} '
                f"of {len(lines)} lines - full text in {out.name}</p>"
            )
    for png in sorted(step_dir.glob("*.png")):
        prev_png = prev_run / step_dir.name / png.name if prev_run else None
        if prev_png and prev_png.exists():
            parts.append(
                '<div class="compare">'
                f'<figure><figcaption>last run · {html.escape(png.name)}</figcaption>'
                f"{b64_img(prev_png)}</figure>"
                f'<figure><figcaption>this run · {html.escape(png.name)}</figcaption>'
                f"{b64_img(png)}</figure></div>"
            )
        else:
            parts.append(b64_img(png))
    parts.append("</div></section>")
    return "".join(parts), verdict


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    evidence = Path(sys.argv[1])
    step_dirs = sorted(
        d for d in evidence.iterdir()
        if d.is_dir() and re.match(r"^\d\d[a-z]?-", d.name)
    )
    if not step_dirs:
        print(f"no NN-slug step directories under {evidence}", file=sys.stderr)
        return 1

    run = {}
    run_path = evidence / "run.json"
    if run_path.exists():
        try:
            run = json.loads(run_path.read_text())
        except json.JSONDecodeError:
            pass

    # Previous run (if any) provides "last run" screenshots for side-by-side
    # comparison: the latest run-* sibling that sorts before this one.
    prev_run = None
    if re.match(r"^run-", evidence.name):
        siblings = sorted(
            d for d in evidence.parent.iterdir()
            if d.is_dir() and re.match(r"^run-", d.name) and d.name < evidence.name
        )
        prev_run = siblings[-1] if siblings else None

    sections, counts = [], {"pass": 0, "warn": 0, "fail": 0}
    for d in step_dirs:
        section, verdict = render_step(d, prev_run)
        sections.append(section)
        counts[verdict if verdict in counts else "warn"] += 1

    meta_bits = " · ".join(
        s for s in (
            run.get("started"),
            f'{run.get("branch")} @ {run.get("commit")}' if run.get("commit") else None,
            f"compared against {prev_run.name}" if prev_run else None,
        ) if s
    )
    count_spans = "".join(
        f'<span style="background:{VERDICT_COLORS[v]}">{counts[v]} {v}</span>'
        for v in ("pass", "warn", "fail")
    )

    report = (
        "<!doctype html><meta charset=\"utf-8\">"
        "<title>signalbox integration run</title>"
        f"<style>{CSS}</style><div class=\"wrap\">"
        "<h1>signalbox integration run</h1>"
        f'<p class="meta">{html.escape(meta_bits)}</p>'
        f'<p class="counts">{count_spans}</p>'
        + "".join(sections) + "</div>"
    )
    out = evidence / "report.html"
    out.write_text(report)
    print(f"{out} ({out.stat().st_size // 1024} KB, {len(step_dirs)} steps: "
          f"{counts['pass']} pass / {counts['warn']} warn / {counts['fail']} fail)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
