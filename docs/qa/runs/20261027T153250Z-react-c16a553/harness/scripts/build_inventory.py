import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path

SCRATCH = Path("/home/daksh/.local/state/triangulator/qa-c16a553")
ARTIFACTS = SCRATCH / "artifacts"
BASELINE = SCRATCH / "baseline"
LAB = Path("/home/daksh/src/triangulator-qa-react-full-c16a553/docs/qa/bug-lab-cases.md")
CASES = Path("/home/daksh/src/triangulator-qa-react-full-c16a553/docs/qa/test-cases.md")
OUT = SCRATCH / "package-inventory.json"
REQUESTED = "c16a55383c4bc6a219c270aa4f7cf9b55c97e45a"
RUN_URL = "https://github.com/breakbadsp/triangulator/actions/runs/40505148793"
ARTIFACT_IDS = {"el8": "12734178592", "el9": "12734158544"}


def sha256_file(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_version(path):
    with tarfile.open(path, "r:gz") as tar:
        member = tar.getmember("triangulator/VERSION")
        return tar.extractfile(member).read().decode().strip()


def package(archive, platform, baseline):
    name = archive.name
    parts = name.removesuffix(".tar.gz").split("-")
    sha_file = archive.with_name(name + ".sha256")
    listed_hash, listed_name = sha_file.read_text().split()[:2]
    actual = sha256_file(archive)
    component = parts[1]
    return {
        "filename": name,
        "path": str(archive),
        "sha256": actual,
        "checksum_file_match": listed_hash == actual and listed_name == name,
        "version": read_version(archive),
        "component": component,
        "platform": platform,
        "baseline": baseline,
        "source_url": None if baseline else f"{RUN_URL}/artifacts/{ARTIFACT_IDS[platform]}",
    }


def case_map(text):
    table_ids = re.findall(r"^\| (QA-\d{3}) \| (\S+) \|", text, re.M)
    sections = re.split(r"^## ", text, flags=re.M)
    heads = {}
    for sec in sections:
        m = re.match(r"(QA-\d{3}): ", sec)
        if not m:
            continue
        revs = re.findall(r"^- (?:Case revision|Revision): (\d+)\.?$", sec, re.M)
        if len(revs) > 1:
            raise SystemExit(f"{m.group(1)} has {len(revs)} revision lines")
        heads[m.group(1)] = int(revs[0]) if revs else 1
    ids = [i for i, _ in table_ids]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate table IDs")
    statuses = {i: s for i, s in table_ids}
    lab_ids = set(re.findall(r"^\| (QA-\d{3}) \|", LAB.read_text(encoding="utf-8"), re.M))
    out = {}
    for i in ids:
        if i in heads:
            out[i] = {"revision": heads[i], "source": "test-cases.md"}
        elif i in lab_ids:
            # bug-lab-cases.md states: "Case revision: 1 for every row."
            out[i] = {"revision": 1, "source": "bug-lab-cases.md"}
        else:
            raise SystemExit(f"{i} has no case definition")
        out[i]["status"] = statuses[i]
    missing = set(heads) - set(ids)
    if missing:
        raise SystemExit(f"headings without result row: {sorted(missing)}")
    return out


packages = []
for plat in ("el8", "el9"):
    for archive in sorted((ARTIFACTS / f"packages-{plat}").glob("*.tar.gz")):
        packages.append(package(archive, plat, False))
for archive in sorted(BASELINE.glob("*.tar.gz")):
    packages.append(package(archive, "el9", True))

cases = case_map(CASES.read_text(encoding="utf-8"))
out = {
    "requested_revision": REQUESTED,
    "packages": packages,
    "case_count": len(cases),
    "cases": cases,
}
OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
print(f"wrote {OUT} packages={len(packages)} cases={len(cases)}")
