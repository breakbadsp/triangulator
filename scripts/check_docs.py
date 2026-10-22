#!/usr/bin/env python3
"""Check local Markdown links and preserve README files and visual assets."""
import argparse
import re
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
MEDIA = {".svg", ".gif", ".webm", ".mp4", ".html", ".png"}
CODE_DOC = re.compile(r"<code>(docs/[\w./-]+\.\w+)</code>|`(docs/[\w./-]+\.\w+)`")
HTML_LINK = re.compile(r'(?:href|src)="([^"<>]+)"')
LINK = re.compile(r"\[[^\]\n]*\]\(([^)\n]+)\)")


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def anchors(path):
    text = re.sub(r"^```.*?^```[^\n]*", "", path.read_text(), flags=re.M | re.S)
    result = set(re.findall(r'(?:id|name)=[\"\']([^\"\']+)', text))
    for heading in re.findall(r"^#{1,6} (.+)", text, re.M):
        heading = re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-")
        result.add(heading)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="origin/master")
    args = parser.parse_args()
    errors = []
    files = git("ls-files", "--cached", "--others", "--exclude-standard").decode().splitlines()
    for name in files:
        path = ROOT / name
        if not path.is_file() or path.suffix not in {".md", ".html"} or name.startswith("docs/qa/runs/"):
            continue
        text = re.sub(r"^```.*?^```[^\n]*", "", path.read_text(), flags=re.M | re.S)
        for match in CODE_DOC.findall(text):
            raw = match[0] or match[1]
            if not (ROOT / raw).exists():
                errors.append(f"{name}: missing code reference {raw}")
        if path.suffix == ".html" and not name.startswith("docs/"):
            continue
        for raw in (HTML_LINK if path.suffix == ".html" else LINK).findall(text):
            target = urlsplit(raw.strip("<>"))
            if target.scheme or target.netloc:
                continue
            dest = path.parent / unquote(target.path) if target.path else path
            if not dest.exists():
                errors.append(f"{name}: missing {raw}")
            elif target.fragment and dest.suffix == ".md" and unquote(target.fragment) not in anchors(dest):
                errors.append(f"{name}: missing anchor {raw}")
    for name in git("ls-tree", "-r", "--name-only", args.base).decode().splitlines():
        path = ROOT / name
        if path.name.lower().startswith("readme") and not path.is_file():
            errors.append(f"removed README: {name}")
        if path.suffix.lower() in MEDIA:
            if not path.is_file() or path.read_bytes() != git("show", f"{args.base}:{name}"):
                errors.append(f"changed or removed visual: {name}")
    for error in errors:
        print(error)
    print(f"Documentation check: {len(errors)} error(s)")
    return bool(errors)


if __name__ == "__main__":
    raise SystemExit(main())
