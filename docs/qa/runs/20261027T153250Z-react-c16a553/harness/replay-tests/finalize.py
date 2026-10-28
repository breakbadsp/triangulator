import json,datetime,hashlib,tarfile,subprocess
from pathlib import Path
r=Path(__file__).parent
files=['observations-initial.json','observations-settings.json','observations-pointer.json','observations-extended.json','observations-late-errors.json','observations-memory-final.json','observations-last.json']
selected={};clocks={};invalid=[]
for f in files:
 data=json.loads((r/f).read_text());clocks[f]=data['environment']['clock']
 for s in data['scenarios']:
  if s['status']=='PASSED':selected[s['name']]={**s,'source':f}
  else:invalid.append({'source':f,'name':s['name'],'rawStatus':s['status'],'classification':'INVALID_TEST_ATTEMPT','error':s.get('error','')})
raw=json.loads((r/'memory-invalid-attempt.json').read_text())
for s in raw['scenarios']:invalid.append({'source':'memory-invalid-attempt.json','name':s['name'],'rawStatus':s['status'],'classification':'INVALID_TEST_ATTEMPT','error':s.get('error','')})
reasons={
'settings-draft-revision-sent-write':'Test assumed an unrequired revision field in POST JSON. The product uses its own request guard. The corrected test checked draft retention, a delayed sent write, a stale watch read, and HTTP 409 handling.',
'pointer-focus-help-recorded-history-cutoff':'The test helper sent Escape before every click. It closed the drawer before Load. The corrected helper closes the drawer only for controls outside it.',
'last-target-retry-wrong-empty-dismissed':'Unused test placeholder referred to arguments in an ES module. Full last-target coverage ran separately.',
'late-errors-resources-layout-history-help-watch':'The open thread drawer scrim intercepted the outside recording control. The corrected test closed it with Escape before selecting the recording.',
'recorded-PID-range-counts-future-cutoff':'The test expected a thousands separator for 1000. The documented expectation concerns PID counts. Actual range count was the correct 48.',
'memory-growth-row-persists-load-earlier':'Fixture INSERT did not name its columns after an optional counter column was added. The corrected fixture uses explicit column names.'}
for i in invalid:i['reason']=reasons[i['name']]
(r/'invalid-attempts.json').write_text(json.dumps(invalid,indent=2))
assert len(selected)==14,len(selected)
compact=[]
for name,s in selected.items():
 obs=s.get('observations')
 compact.append({'caseId':s['caseId'],'name':name,'status':s['status'],'started':s['start'],'ended':s['end'],'source':s['source'],'browserErrors':s.get('browserErrors',[]),'requestCount':len(s.get('requestLog',[])),'observations':obs})
# Keep the combined observations compact. Original files retain every request.
def trim(v):
 if isinstance(v,list):return [trim(x) for x in v]
 if isinstance(v,dict):return {k:trim(x) for k,x in v.items() if k not in ['resourceRows','inputs','resourceQueries','queryCutoffs','finalRequests','liveStorage','replayStorage','afterTarget','poly']}
 return v
(r/'observations-compact.json').write_text(json.dumps({'scenarios':trim(compact),'clocksByEvidenceFile':clocks},indent=2))
owned_bin=r.parent/'package/triangulator/bin/triangulator-collector'
binary_hash=hashlib.file_digest(owned_bin.open('rb'),'sha256').hexdigest()
artifact=r.parent/'artifacts/packages-el9/triangulator-collector-dev-c16a553-el9-x86_64.tar.gz'
with tarfile.open(artifact) as t: assert hashlib.file_digest(t.extractfile('triangulator/bin/triangulator-collector'),'sha256').hexdigest()==binary_hash
processes=subprocess.check_output(['ps','-eo','pid,args'],text=True)
left=[line for line in processes.splitlines() if str(r)+'/fixture/collector.toml' in line and 'triangulator-collector' in line]
assert not left,left
port=subprocess.check_output(['ss','-ltn','( sport = :19440 )'],text=True)
assert len(port.strip().splitlines())==1,port
cases=[]
for cid,rev in [('QA-122',1),('QA-081',2)]:cases.append({'id':cid,'revision':rev,'status':'PASSED','scenarioCount':sum(s['caseId']==cid for s in selected.values()),'scenarios':[n for n,s in selected.items() if s['caseId']==cid]})
result={
 'completedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'package':{'version':'dev-c16a553','head':'c16a55383c4bc6a219c270aa4f7cf9b55c97e45a','workflow':'40505148793','artifact':artifact.name,'artifactURL':'https://github.com/breakbadsp/triangulator/actions/runs/40505148793/artifacts/12734158544','artifactSha256':'fabf26222bc9168a6e81a6c82e413de13cbbe8b6a0cc6094385b65ae1a60e2e6','binarySha256':binary_hash,'binaryMatchesDownloadedEL9Artifact':True,'sourceBuildUsed':False},
 'scope':'Full execution of QA-122 and QA-081 only',
 'counts':{'PASSED':2,'FAILED':0,'BLOCKED':0,'NOT_RUN':0},'subscenarioCounts':{'PASSED':14,'FAILED':0},'cases':cases,'failures':[],'blockers':[],
 'environment':{'collector':'Downloaded static EL9 x86_64 collector; host Linux 7.2.8-9-omarchy','containerDeviation':'Docker socket access denied; sudo required a password. The same static downloaded binary ran directly on the host. Its SHA-256 matches the EL9 archive.','browser':'Chromium 155.0.8059.84 via isolated Playwright contexts','viewport':[1440,1000],'browserTimezone':'UTC','url':'http://127.0.0.1:19440/?target=','httpPort':19440,'udpPort':19449,'data':str(r/'fixture/data'),'clock':'Real browser wall clock, no Date.now override. Each evidence file records exact Unix seed times.','storageSimulation':{'full':'A fixture page filled real sessionStorage with 1 KiB entries until native QuotaExceededError at 5061 KiB; a real link opened the dashboard in the same tab.','blocked':'The fixture delivered CSP sandbox allow-scripts without allow-same-origin; real sessionStorage access raised SecurityError. API replies permitted the opaque origin. No Storage prototype patch was used.'}},
 'fixtureInputs':{'basic':'Two SQLite recordings, session 100/PID 42 at first=now-600 and last=now-500. Live input session 200/PID 42. Exact per-run times are in observations-compact.json.','memoryGrowth':'Session 100/PID 7: 48 resource rows at last-240+5*i, i=0..47. RSS=(100+8*5*i) MiB. Growth spans 235 seconds. The recording is at last; no later PID 7 growth is generated. This substitutes controlled recorded mem-leak input for a three-minute wall-clock wait.','pidBoundary':'An extra session 100/PID 8 row at last-6 has RSS null, fd_open=88 and retransmission delta 100000. It lies between PID 7 rows at last-10 and last-5.','futureRow':'A session 100/PID 8 row at last+1 has RSS=999999999999 and retransmission delta 100000; recorded reads exclude it.','rangeCounts':'Each PID 7 row has retransmission delta 1. The displayed recorded counter totals 48; RSS, open-files and retransmission charts each have 48 points in both variants.','earlierPeriods':'A second recording and 48-row growth run are shifted exactly 3600 seconds earlier. Load earlier preserves the first row and adds the older row. Both selected assessments agree.','files':['pid-range-false-seed.json','pid-range-true-seed.json','earlier-period-seed.json'],'fixtureRevision':'Recipe adapted from tests/replay_fixture.py and tests/prove_replay.mjs at c16a55383c4bc6a219c270aa4f7cf9b55c97e45a; owned adaptation files are common.mjs, seed.py, run.mjs, extended.mjs, memory-final.mjs and last.mjs.'},
 'execution':{'interaction':'Playwright clicks, keyboard actions, pointer holds, input fills, select controls, real reloads and navigation. Evaluation only read DOM and storage. Controlled network replies supplied input and delays.','coverage':'Late snapshot/resource/layout/history/watch successes and errors; recording/Live/target/page-close transitions; missing/invalid recordings; held Help and focus; ten-second empty-session settling; absence during replay; Show live dismissal; final-view restart protection; matching/unrelated exits; reload; blocked/full storage; last-target retry/wrong-session/empty/dismissal; settings draft/conflict guards; recorded read cutoffs; real pagehide storage; recorded PID boundaries and earlier memory findings.','invalidTestAttempts':len(invalid),'invalidTestAttemptDetails':'invalid-attempts.json','confirmedProductFailureRetries':0,'failureScreenshots':[]},
 'evidence':{'compact':'observations-compact.json','full':files,'rerunnableScripts':['run.mjs','extended.mjs','memory-final.mjs','last.mjs'],'results':'results-final.json'},'cleanup':{'ownedCollectorStopped':True,'ownedBrowserStopped':True,'port19440Released':True,'parentProcessesAndFilesTouched':False,'repoOrDocEdits':False}}
(r/'results-final.json').write_text(json.dumps(result,indent=2))
print(json.dumps({'counts':result['counts'],'subscenarios':result['subscenarioCounts'],'cases':cases,'invalidTestAttempts':len(invalid),'cleanup':result['cleanup']},indent=2))
