import json, time, urllib.request
names = ["MsgP-fast", "MsgP-peer", "PrdDist-main", "PrdDist-peer", "Control-idle"]
seen = {n: [] for n in names}; wake = {}; interval_ms = None
for _ in range(9):
    d = json.load(urllib.request.urlopen("http://127.0.0.1:19401/api/live?target=omarchy%2Fdefault", timeout=5))
    interval_ms = d["health"]["sample_interval_ms"]
    for t in d["threads"]:
        if t["name"] in seen:
            seen[t["name"]].append(round(t["last_ran"], 2)); wake[t["name"]] = t.get("wake_ms")
    time.sleep(1.0)
for n in names:
    vals = sorted(set(seen[n]))
    gaps = [round(b - a, 2) for a, b in zip(vals, vals[1:])]
    print(f"{n:14s} wake_ms={wake.get(n)} distinct_last_ran={len(vals)} gaps_s={gaps}")
print("sample_interval_ms", interval_ms)
