import urllib.request,json,subprocess,os,signal,time
r='/tmp/triangulator-memory-api-followup';home=r+'/install/triangulator';out={};env=dict(os.environ,TRIANGULATOR_HOME=home)
def get(path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:19671'+path) as f:return {'status':f.status,'body':json.load(f)}
 except urllib.error.HTTPError as e:return {'status':e.code,'body':e.read().decode()}
def targets():return get('/api/targets')
def command(args):
 p=subprocess.run([home+'/scripts/'+args[0]]+args[1:],env=env,capture_output=True,text=True);return dict(args=args,code=p.returncode,stdout=p.stdout,stderr=p.stderr,config=open(home+'/config/sampler.toml').read())
out['initial']=targets();out['threads']=open('/proc/'+open(home+'/run/sampler.pid').read().strip()+'/status').read().split('Threads:')[1].splitlines()[0]
for key in ['default','beta']:
 out[key]={path:get('/api/'+path+'?target=omarchy/'+key) for path in ['live','resources','replay','memory-map']}
out['unknown']=get('/api/live?target=omarchy/missing')
pids=json.load(open(r+'/pids.json'))
out['add']=command(['set-target.sh','--add','gamma',str(pids['mem-c'])]);time.sleep(2);out['after_add']=targets()
p=home+'/config/sampler.toml';s=open(p).read();parts=s.split('[[target]]');open(p,'w').write(parts[0]+''.join('[[target]]'+x for x in reversed(parts[1:])));os.kill(int(open(home+'/run/sampler.pid').read()),signal.SIGHUP);time.sleep(2);out['after_reorder']=targets()
out['rate']=command(['set-rate.sh','4']);time.sleep(2);out['after_rate']=targets()
out['selector']=command(['set-target.sh','gamma',str(pids['mem-b'])]);time.sleep(2);out['after_selector']=targets()
for label,args in [('invalid',['set-target.sh','--add','bad/id',str(pids['mem-a'])]),('duplicate',['set-target.sh','--add','beta',str(pids['mem-a'])]),('help',['set-target.sh','--help'])]:out[label]=command(args)
out['remove']=command(['set-target.sh','--remove','gamma']);time.sleep(2);out['after_remove']=targets()
s=open(p).read();open(p,'w').write(s+'\n[[target]]\nid="beta"\npid=1\n');os.kill(int(open(home+'/run/sampler.pid').read()),signal.SIGHUP);time.sleep(2);out['duplicate_reload']=targets();open(p,'w').write(s)
# Target death and replacement use an exact process-name selector.
out['name_selector']=command(['set-target.sh','beta','mem-b']);time.sleep(2);out['before_replacement']=targets();os.kill(pids['mem-b'],signal.SIGTERM);time.sleep(3);out['absent']=targets();f=open(r+'/mem-b-replacement.log','w');x=subprocess.Popen([r+'/fixture','mem-b',r+'/mem-b.fifo'],stdout=f,stderr=f,start_new_session=True);pids['mem-b']=x.pid;json.dump(pids,open(r+'/pids.json','w'));time.sleep(3);out['replacement']=targets()
# Last-target removal validation, then restore two targets.
out['remove_beta']=command(['set-target.sh','--remove','beta']);out['remove_last']=command(['set-target.sh','--remove','default']);out['restore_beta']=command(['set-target.sh','--add','beta',str(x.pid)])
json.dump(out,open(r+'/api-observations.json','w'),indent=2)
print(json.dumps({k:v for k,v in out.items() if k in ['threads','unknown','invalid','duplicate','remove_last']},indent=2))
