#!/usr/bin/env python3
"""Regenerate the standalone SVG: python3 scripts/generate_loomflow_animation.py."""

from html import escape
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs/assets/loomflow-run.svg"
DURATION = 32
STARTS = (0, 3, 8, 12, 17, 23, 26, 32)
PHASES = (
    ("Prepare", "Sync the complete feature with master.",
     "PR #157 opens. The merge has no conflicts.", "3fe566e · full review · Major"),
    ("Review 1", "Two independent reviews. One major finding.",
     "Reviewer A finds keyboard focus loss when tiles reorder.", "Reviewer B: no findings · merge stays blocked"),
    ("Fix", "Reproduce. Add a regression test. Restore focus.",
     "The test fails before the fix and passes after it.", "adce073 · Chromium proof · make check passes"),
    ("Review 2", "Both reviewers check the fix and its callers.",
     "Reviewer A: no findings. Reviewer B: no findings.", "0 open findings · no third review round"),
    ("CI", "All four checks pass on the reviewed commit.",
     "CI validates adce073 combined with the master base.", "Reuse passing coverage · no duplicate full test run"),
    ("Gate", "One merge gate checks the release conditions.",
     "Expected head. Clean worktree. Passing checks. Mergeable.", "gh pr merge 157 --merge --match-head-commit adce073…"),
    ("Merged", "Fleet overview is on master.",
     "One major defect fixed. Both final reviews are clear.", "8ce2e8e · 23 Oct 2026 · release worktree removed"),
)
COLORS = {"ink": "#ece9e2", "muted": "#949ba8", "line": "#303641",
          "blue": "#79b8ff", "purple": "#bc9cff", "orange": "#ffb86b",
          "green": "#a5df9b", "dim": "#626b7a"}
parts = []


def add(markup):
    parts.append(markup)


def text(x, y, value, size=16, color="ink", extra=""):
    add(f'<text x="{x}" y="{y}" font-size="{size}" '
        f'fill="{COLORS.get(color, color)}" {extra}>{escape(value)}</text>')


def box(x, y, w, h, color="line", fill="#11151b", radius=12):
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" '
        f'fill="{fill}" stroke="{COLORS.get(color, color)}"/>')


def timed(attribute, values):
    values = [*values, values[0]]
    times = ";".join(f"{time / DURATION:g}" for time in STARTS)
    add(f'<animate attributeName="{attribute}" values="{";".join(map(str, values))}" '
        f'keyTimes="{times}" dur="{DURATION}s" calcMode="discrete" repeatCount="indefinite"/>')


def wire(path, color="line", extra=""):
    add(f'<path d="{path}" fill="none" stroke="{COLORS[color]}" '
        f'stroke-width="1.5" {extra}/>')


def status(x, y, label, color="muted"):
    add(f'<circle cx="{x}" cy="{y - 5}" r="3.5" fill="{COLORS[color]}"/>')
    text(x + 12, y, label, 15, color)


def highlight(x, y, w, h, color):
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" '
        f'fill="none" stroke="{COLORS[color]}" stroke-width="1.8"/>')


def scene(index):
    phase, heading, detail, evidence = PHASES[index]
    color = ("blue", "orange", "orange", "purple", "green", "green", "green")[index]
    # These counters describe the run at this point, not invented test totals.
    for x, value, tint in ((40, ("0", "1", "1 → 0", "0", "0", "0", "0")[index],
                            "orange" if index in (1, 2) else "green"),
                           (284, "0" if index == 0 else "1" if index < 3 else "2", "ink"),
                           (528, "4 / 4" if index >= 4 else "pending", "green" if index >= 4 else "muted"),
                           (772, "8ce2e8e" if index == 6 else "adce073" if index >= 2 else "3fe566e", "ink")):
        text(x, 130, value, 25, tint, 'class="mono"')

    for row in range(5):
        tint = "green" if index >= 4 else "orange" if index == 2 and row in (0, 2) else "dim"
        add(f'<rect x="42" y="{246 + row * 44}" width="6" height="6" rx="1" fill="{COLORS[tint]}"/>')
    if index == 0:
        highlight(24, 180, 210, 326, "blue")

    a = ("waiting", "1 major", "finding sent", "no findings", "clear", "clear", "clear")[index]
    b = ("waiting", "no findings", "review complete", "no findings", "clear", "clear", "clear")[index]
    status(298, 273, a, "orange" if index == 1 else "green" if index >= 3 else "muted")
    status(298, 415, b, "green" if index >= 1 else "muted")
    if index in (1, 3):
        highlight(280, 202, 182, 90, "blue")
        highlight(280, 344, 182, 90, "purple")
    text(371, 321, "ROUND 2" if index >= 3 else "ROUND 1", 12, "purple" if index >= 3 else "muted",
         'text-anchor="middle" class="mono"')

    fix = ("waiting", "queued", "fix + test", "fixed", "fixed", "fixed", "fixed")[index]
    status(546, 345, fix, "orange" if index == 2 else "green" if index >= 3 else "muted")
    if index == 2:
        highlight(528, 273, 164, 90, "orange")
    if index == 3:
        wire("M610 273 V178 Q610 166 598 166 H383 Q371 166 371 178 V202", "purple")

    for row in range(4):
        passed = index >= 4
        text(954, 263 + row * 56, "PASS" if passed else "WAIT", 13,
             "green" if passed else "dim", 'text-anchor="end" class="mono"')
        if passed:
            add(f'<path d="M764 {256 + row * 56} l4 4 8 -9" stroke="{COLORS["green"]}" '
                'stroke-width="1.7" fill="none"/>')
    if index == 4:
        highlight(748, 180, 228, 326, "green")

    text(44, 560, f"{index + 1:02d} / {phase.upper()}", 12, color, 'class="mono" letter-spacing="1.4"')
    text(44, 591, heading, 23)
    text(44, 619, detail, 17, "muted")
    text(44, 645, evidence, 14, color, 'class="mono"')
    if index == 5:
        highlight(24, 534, 952, 126, "green")
    if index == 6:
        box(844, 546, 112, 24, "green", "#17241b", 12)
        text(900, 563, "MERGED", 12, "green", 'text-anchor="middle" class="mono"')
    for step in range(7):
        add(f'<rect x="{24 + step * 137}" y="682" width="130" height="3" rx="1.5" '
            f'fill="{COLORS[color] if step <= index else COLORS["line"]}"/>')


def packet(path, start, end, color):
    add('<g class="motion" opacity="0">')
    # One packet per leg per cycle; it cannot move before its stage starts.
    add(f'<animate attributeName="opacity" values="0;1;0;0" '
        f'keyTimes="0;{start / DURATION:g};{end / DURATION:g};1" '
        f'dur="{DURATION}s" calcMode="discrete" repeatCount="indefinite"/>')
    add(f'<rect x="-4" y="-4" width="8" height="8" rx="2" fill="{COLORS[color]}"/>')
    add(f'<animateMotion path="{path}" keyPoints="0;0;1;1" '
        f'keyTimes="0;{start / DURATION:g};{end / DURATION:g};1" '
        f'dur="{DURATION}s" calcMode="linear" repeatCount="indefinite"/>')
    add('</g>')


def generate():
    add('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 746" '
        'width="1000" height="746" role="img" aria-labelledby="title description">')
    add('<title id="title">LoomFlow: the Fleet overview release</title>')
    add('<desc id="description">A 32-second loop of PR 157. Sync the feature with master. '
        'GPT 6.1 Sol and Sonnet 5.5 review in parallel. One major keyboard-focus defect '
        'is fixed and tested. Both second reviews have no findings. All four CI checks '
        'pass. One merge gate merges commit 8ce2e8e to master. Timing is compressed.</desc>')
    add('<metadata>Run: https://github.com/breakbadsp/triangulator/pull/157. '
        'Visual reference: https://bun.sh/blog/bun-in-rust#compiler-errors-as-a-work-queue. '
        'Original diagram; timing is illustrative, not a recording.</metadata>')
    add('''<style>
text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.mono{font-family:ui-monospace,"SFMono-Regular",Consolas,monospace}
.reduced{display:none}
@media(prefers-reduced-motion:reduce){.motion{display:none}.reduced{display:inline}}
</style>''')
    box(0.5, 0.5, 999, 745, "#252b34", "#0b0d11", 18)
    text(24, 34, "TRIANGULATOR / LOOMFLOW", 12, "muted", 'letter-spacing="2" class="mono"')
    text(24, 70, "Fleet overview → master", 30)
    text(976, 36, "PR #157", 14, "muted", 'text-anchor="end" class="mono"')
    text(976, 66, "ACTUAL RUN · COMPRESSED TIME", 10, "muted", 'text-anchor="end" class="mono"')
    for x, label in ((24, "OPEN FINDINGS"), (268, "REVIEW ROUND"), (512, "CI CHECKS"), (756, "COMMIT")):
        box(x, 88, 220, 60, "#252b34", "#101319", 8)
        text(x + 16, 105, label, 10, "muted", 'letter-spacing="1.2" class="mono"')

    # Fixed nodes make the feedback path easy to follow throughout the loop.
    box(24, 180, 210, 326)
    text(42, 207, "CHANGE SET", 11, "muted", 'class="mono" letter-spacing="1.4"')
    text(42, 230, "32 files · full review", 16)
    for i, name in enumerate(("dashboard.html", "sampler_control.py", "dashboard_test.js", "Help + QA cases", "Docs + evidence")):
        text(58, 255 + i * 44, name, 14, "ink", 'class="mono"' if i < 3 else '')
        wire(f"M42 {269 + i * 44} H216", "line")
    text(42, 493, "feature/fleet-overview", 12, "muted", 'class="mono"')

    for x, y, heading, model, tint in ((280, 202, "REVIEWER A", "GPT 6.1 Sol · high", "blue"),
                                       (280, 344, "REVIEWER B", "Sonnet 5.5 · high", "purple"),
                                       (528, 273, "ANALYZER", "Sonnet 5.5 · high", "orange")):
        box(x, y, 182 if x == 280 else 164, 90)
        text(x + 18, y + 24, heading, 12, tint, 'class="mono" letter-spacing="1"')
        text(x + 18, y + 46, model, 13, "ink")
    text(610, 403, "One fix, then", 14, "muted", 'text-anchor="middle"')
    text(610, 424, "review the change.", 14, "muted", 'text-anchor="middle"')

    box(748, 180, 228, 326)
    text(766, 207, "RELEASE CHECKS", 11, "muted", 'class="mono" letter-spacing="1.4"')
    text(766, 230, "Reviewed head: adce073", 12, "muted", 'class="mono"')
    for i, label in enumerate(("CI inputs", "QA results", "C++ format", "AlmaLinux 8")):
        text(784, 263 + i * 56, label, 15)
        wire(f"M766 {280 + i * 56} H958", "line")
    text(766, 493, "Gate: Haiku 5.5 · low", 12, "muted", 'class="mono"')

    paths = ("M234 343 H251 Q264 343 264 330 V259 Q264 247 276 247 H280",
             "M264 330 V377 Q264 389 276 389 H280",
             "M462 247 H486 Q498 247 498 259 V306 Q498 318 510 318 H528",
             "M462 389 H486 Q498 389 498 377 V330 Q498 318 510 318",
             "M692 318 H748")
    for path in paths:
        wire(path)
    wire("M610 273 V178 Q610 166 598 166 H383 Q371 166 371 178 V202", extra='stroke-dasharray="3 5"')
    text(490, 159, "FIX → REVIEW AGAIN", 10, "muted", 'text-anchor="middle" class="mono"')
    box(24, 534, 952, 126, fill="#101319")

    for index in range(7):
        add(f'<g class="motion" data-phase="{index}" opacity="0">')
        timed("opacity", [int(phase == index) for phase in range(7)])
        scene(index)
        add('</g>')
    add('<g class="reduced">')
    scene(6)
    add('</g>')

    for args in ((paths[0], 3, 4.4, "blue"),
                 ("M234 343 H251 Q264 343 264 355 V377 Q264 389 276 389 H280", 3.2, 4.6, "purple"),
                 (paths[2], 6, 7.7, "orange"),
                 ("M462 389 H486 Q498 389 498 377 V330 Q498 318 510 318 H528", 6.2, 7.9, "green"),
                 ("M610 273 V178 Q610 166 598 166 H383 Q371 166 371 178 V202", 12, 13.8, "purple"),
                 (paths[0], 13.8, 15, "blue"),
                 (paths[2] + " H692 H748", 16, 18, "green"),
                 (paths[4], 21, 22.5, "green")):
        packet(*args)

    for i, (label, *_) in enumerate(PHASES):
        text(24 + i * 137, 705, label, 12, "muted", 'class="mono"')
    text(24, 731, "2 review rounds maximum · 1 merge gate · no open blocker or major at merge", 12, "muted")
    add('</svg>')
    OUTPUT.write_text("\n".join(parts) + "\n")
    print(f"Generated {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    generate()
