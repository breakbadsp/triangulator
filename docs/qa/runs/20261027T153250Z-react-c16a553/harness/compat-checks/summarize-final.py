from pathlib import Path
import json, hashlib, datetime
r=Path('/home/daksh/.local/state/triangulator/qa-c16a553'); c=r/'compat-checks'
read=lambda name:json.loads((c/name).read_text())
phases={}
for phase,expected in [('list-and-omitted',(200,2,30)),('baseline-corrected',(1000,5,60)),('upgraded-corrected',(1000,5,60)),('restarted-both-corrected',(1000,5,60))]:
 d=read('browser-'+phase+'.json'); rows=d['responses']; last=rows[-1]['body']; h=last['health']
 actual=(h['sample_interval_ms'],last['resources']['interval_s'],last['memory']['interval_s'])
 assert actual==expected and h['pid']==38 and not h['sampler_silent'] and not h['target_absent']
 assert all(row['status']==200 for row in rows) and not d['errors']
 assert rows[-1]['body']['health']['raw_samples']>rows[0]['body']['health']['raw_samples']
 phases[phase]={'at':d['at'],'sample_interval_ms':actual[0],'resource_interval_s':actual[1],'memory_interval_s':actual[2],'pid':h['pid'],'session':h['session'],'fresh_samples':True,'http_status':200,'page_errors':d['errors'],'browser':d['browser'],'evidence':'compat-checks/browser-'+phase+'.json'}
assert phases['upgraded-corrected']['session']!=phases['restarted-both-corrected']['session']
config_hashes={}
for app in ['collector','sampler']:
 actual=(r/'upgrade/triangulator/config'/f'{app}.toml').read_bytes()
 assert actual==(c/f'corrected-explicit-{app}.toml').read_bytes()
 config_hashes[app]=hashlib.sha256(actual).hexdigest()
prior=json.loads((r/'browser-continuation.json').read_text())['observations']
selected=[{'index':i,**prior[i]} for i in [31,32,33,34,35] if i<len(prior)]
(c/'inherited-browser-selected.json').write_text(json.dumps(selected,indent=2))
invalid=read('config-results.json')
for n,k in [('capacity-zero','max_targets'),('capacity65','max_targets'),('sample-capacity','max_live_samples')]:
 item=next(x for x in invalid if x['name']==n)
 assert item['exit']==2 and k in item['stderr']
result={
 'at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'tested_package':'dev-c16a553','baseline':'0.1.0','platform':'EL9 x86_64',
 'scope':['QA-030','QA-070'],'counts':{'PASSED':2,'FAILED':0,'BLOCKED':0,'NOT_RUN':0},
 'environment':{'container':'triangulator-qa-c16-runtime','TRIANGULATOR_HOME':'/qa/upgrade/triangulator','url':'http://127.0.0.1:19411/','udp_port':19410,'browser':'Chromium via Playwright','viewport':{'width':1280,'height':800},'browser_fallback':'Parent authorized fallback after two T3 snapshot timeouts of 15 s.'},
 'packages':read('package-checks-final.json'),
 'cases':{
  'QA-030':{'status':'PASSED','revision':1,'observations':[
   'Parent evidence: no active configuration generated defaults. After port isolation, the browser showed 200 ms thread ticks, 2 s resources, and 30 s memory.',
   'Omitted rate_hz, resource_interval_s, and memory_interval_s used 200 ms, 2 s, and 30 s. A fresh browser read confirmed PID 38 and increasing samples.',
   'Corrected actual saved configuration contains rate_hz = 1.0, resource_interval_s = 5, and uncommented memory_interval_s = 60.',
   'Installed exact 0.1.0 sampler and collector archives. Both started with the earlier scalar sampler_ip configuration and the corrected saved sampler configuration. Browser observed 1000 ms, 5 s, and 60 s.',
   'Stopped only the upgrade processes. Installed exact dev-c16a553 sampler and collector archives in the same installation. Configuration files stayed byte-for-byte unchanged. Browser observed 1000 ms, 5 s, and 60 s with fresh PID 38 samples.',
   'Restarted the dev collector and sampler in separate sequential commands. The browser completed before each external mutation. The new sampler session retained 1000 ms, 5 s, and 60 s. Both configuration files remain unchanged.'
  ],'evidence':['compat-checks/browser-list-and-omitted.json','compat-checks/browser-baseline-corrected.json','compat-checks/browser-upgraded-corrected.json','compat-checks/browser-restarted-corrected.json','compat-checks/browser-restarted-both-corrected.json','compat-checks/corrected-explicit-sampler.toml','compat-checks/corrected-explicit-collector.toml','compat-checks/dev-start-final.log','compat-checks/dev-restart-final.log','compat-checks/dev-sampler-restart-final.log','compat-checks/inherited-browser-selected.json','browser-continuation.json','upgrade/config-before-defaults','compat-checks/generated-sampler.toml','compat-checks/generated-collector.toml']},
  'QA-070':{'status':'PASSED','revision':1,'observations':[
   'Parent evidence: generated shipped configurations and scalar sampler_ip configurations started successfully in the isolated installation after required target and port selection.',
   'Parent evidence: list sampler_ips configuration started successfully. Fresh browser continuation confirmed live PID 38, 200 ms ticks, 2 s resources, 30 s memory, and increasing samples.',
   'Earlier 0.1.0 configuration was used for actual baseline startup and actual dev upgrade startup. It retained scalar sampler_ip, target_pid, and saved sampling values unchanged. Both browsers showed fresh PID 38 samples.',
   'Actual collector startup with max_targets = 0 exited 2 and named max_targets. max_targets = 65 exited 2 and named max_targets. Eight targets with 2000000 samples each exited 2 and named max_live_samples and max_targets.',
   'Parent invalid sampler reload mixed a top-level target and a target table. The sampler logged: use target tables or a top-level target, not both. Browser before and after retained session 10477831749339094975 and active PID 38. The first failure is preserved; no repeat was needed.'
  ],'evidence':['compat-checks/config-results.json','compat-checks/scalar.toml','compat-checks/list.toml','compat-checks/capacity-zero.toml','compat-checks/capacity65.toml','compat-checks/sample-capacity.toml','compat-checks/invalid-reload.toml','compat-checks/inherited-browser-selected.json','browser-continuation.json','compat-checks/browser-list-and-omitted.json','compat-checks/browser-baseline-corrected.json','compat-checks/browser-upgraded-corrected.json','upgrade/triangulator/logs/sampler.log']}
 },
 'browser_phases':phases,'config_sha256_unchanged_after_upgrade_and_restart':config_hashes,
 'setup_corrections':[
  'Initial generated collector port 9400 was occupied. Parent corrected the fixture to UDP 19410 and HTTP 19411. Existing logs are retained. This is not a product failure.',
  'The earlier explicit-saved-sampler.toml used commented # memory_interval_s = 60. Its observed 30 s memory interval is invalid fixture evidence, not a product failure. Original files remain intact. The corrected fixture passed baseline, upgrade, and restart checks.',
  'A parent baseline setup attempt used a latest sampler configuration containing cpu_budget_pct, which 0.1.0 does not support. The valid old template/configuration was used for the completed baseline. Prior evidence remains intact.',
  'This continuation first tried Docker and then sudo Docker. Access was unavailable. The existing runtime uses rootless Podman. No container or product state changed in these attempts.',
  'The first dev restart command restarted the collector only, as documented by restart.sh. The sampler was then explicitly restarted. The intermediate read had not received a new memory snapshot. Final evidence after the sampler restart contains all three saved values.'
 ],
 'product_failures':[], 'cleanup':{'state':'pending verification','process_scope':'Only upgrade installation sampler and collector. Primary installation and other agents were not changed.'},
 'evidence_root':str(r)
}
(c/'results-final.json').write_text(json.dumps(result,indent=2)+'\n')
print('Validated both requested cases. Saved compat-checks/results-final.json.')
