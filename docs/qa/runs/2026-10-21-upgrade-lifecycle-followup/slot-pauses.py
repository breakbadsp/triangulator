"""Run QA-072 on this run's isolated, already-started package runtime."""
import json,os,signal,time,urllib.request
from pathlib import Path
r=Path('/tmp/triangulator-upgrade-lifecycle/install/triangulator')
out=Path(__file__).resolve().parent/'slot-pauses.json'
observations=[]
def observe(stage):
 try:
  x=json.load(urllib.request.urlopen('http://127.0.0.1:19681/api/targets',timeout=3))
  observations.append(dict(stage=stage,elapsed=round(time.monotonic()-start,2),targets=[{k:t[k] for k in ['key','pid','session','status']} for t in x['targets']],capacity_drops=x['capacity_drops']))
 except Exception as e: observations.append(dict(stage=stage,error=str(e)))
 out.write_text(json.dumps(observations,indent=2))
start=time.monotonic();observe('before-rename')
p=r/'config/sampler.toml';p.write_text(p.read_text().replace('id = "b"','id = "c"'))
pid=int((r/'run/sampler.pid').read_text());os.kill(pid,signal.SIGHUP)
for _ in range(24):time.sleep(5);observe('rename')
for seconds in [30,90]:
 os.kill(pid,signal.SIGSTOP);observe('pause-'+str(seconds))
 time.sleep(seconds);observe('before-resume-'+str(seconds));os.kill(pid,signal.SIGCONT)
 time.sleep(8);observe('resumed-'+str(seconds))
print(out)
