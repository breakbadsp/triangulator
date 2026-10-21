import json, sys, time, urllib.request
TID = int(open("/tmp/tri-qa/msgp-fast.tid").read())
for i in range(5):
    d = json.load(urllib.request.urlopen("http://127.0.0.1:19401/api/live?target=omarchy%2Fdefault", timeout=5))
    th = {t["tid"]: t for t in d["threads"]}
    t = th.get(TID)
    peers = [x["last_ran"] for x in d["threads"] if x["name"] == "MsgP-peer"]
    print(f"view{i} wall={time.time():.2f} last_sample={d['health']['last_seen']:.2f} MsgP-fast tid={TID} present={t is not None} wake={t and t.get('wake_ms')} stale={t and t['stale']} state={t and t['state']} wchan={t and t.get('wchan')} last_ran={t and round(t['last_ran'],2)} MsgP-peer_last_ran={round(peers[0],2) if peers else None}")
    time.sleep(3)
