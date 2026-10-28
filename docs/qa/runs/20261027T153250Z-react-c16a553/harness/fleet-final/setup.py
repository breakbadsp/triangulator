import os,subprocess,pathlib,shutil,time,json
p=pathlib.Path('/qa/fleet-final/install');shutil.copytree('/qa/package/triangulator',p,dirs_exist_ok=True)
for n in ['run','data','logs']:
 shutil.rmtree(p/n,ignore_errors=True);(p/n).mkdir()
(p/'config/collector.toml').write_text('udp_host="127.0.0.1"\nudp_port=19462\nhttp_host="127.0.0.1"\nhttp_port=19463\ndata_dir="/qa/fleet-final/install/data"\nmax_targets=64\nmax_live_samples=2000\nsampler_ips=["127.0.0.1"]\n')
ps=[subprocess.Popen(['sleep','99999']) for _ in range(2)]
(p/'config/sampler.toml').write_text('collector="127.0.0.1:19462"\nrate_hz=2\n[[target]]\nid="first"\npid='+str(ps[0].pid)+'\n[[target]]\nid="second"\npid='+str(ps[1].pid)+'\n[[target]]\nid="absent"\nprocess="qa-absent"\n')
env=dict(os.environ,TRIANGULATOR_HOME=str(p),PATH='/usr/local/bin:'+os.environ['PATH']);os.makedirs('/usr/local/bin',exist_ok=True)
try:os.symlink('/usr/bin/python3.11','/usr/local/bin/python3')
except FileExistsError:pass
for app in ['collector','sampler']:
 log=open('/qa/fleet-final/'+app+'.log','w');q=subprocess.Popen([str(p/'bin'/('triangulator-'+app)),str(p/'config'/(app+'.toml'))],env=env,stdout=log,stderr=log);(p/'run'/(app+'.pid')).write_text(str(q.pid))
pathlib.Path('/qa/fleet-final/pids.json').write_text(json.dumps([x.pid for x in ps]))
while True:time.sleep(5)
