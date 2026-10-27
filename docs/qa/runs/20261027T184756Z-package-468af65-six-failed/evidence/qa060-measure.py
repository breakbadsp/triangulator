import json,os,re,signal,subprocess,sys,time,urllib.request
H='/tmp/qa-pkg/home';CFG=H+'/config/sampler.toml'
spid=int(open(H+'/run/sampler.pid').read())
tck=os.sysconf('SC_CLK_TCK')
def cpu():
    f=open(f'/proc/{spid}/stat').read().rsplit(')',1)[1].split();return (int(f[11])+int(f[12]))/tck
def targets():
    return json.load(urllib.request.urlopen('http://127.0.0.1:51353/api/targets',timeout=5))['targets']
def setcfg(rate,budget):
    t=open(CFG).read()
    t=re.sub(r'^rate_hz = .*$',f'rate_hz = {rate}',t,flags=re.M);t=re.sub(r'^cpu_budget_pct = .*$',f'cpu_budget_pct = {budget}',t,flags=re.M)
    open(CFG,'w').write(t);os.kill(spid,signal.SIGHUP)
busy=[int(l.split()[0]) for l in subprocess.check_output(['pgrep','-a','-x','qa-a|qa-c|qa-f'] if False else ['bash','-c','pgrep -a . | grep -E " \\./qa-[acf] " | cut -d" " -f1']).decode().split()]
def sig(s):
    for p in busy:
        try: os.kill(p,s)
        except ProcessLookupError: pass
def phase(name,rate,budget,secs,idle=False,out=[]):
    sig(signal.SIGSTOP if idle else signal.SIGCONT)
    setcfg(rate,budget);time.sleep(2)
    rows=[];c0=cpu();t0=time.time();last=(c0,t0)
    while time.time()-t0<secs:
        time.sleep(10)
        c1,t1=cpu(),time.time();ts=targets();x=ts[0]
        rows.append({'t':round(t1-t0),'eff':x['effective_rate_hz'],'cfg':x['configured_rate_hz'],'thr':x['throttled'],'rep_cpu':x['sampler_cpu_pct'],'proc_cpu':round(100*(c1-last[0])/(t1-last[1]),3),'budget':x['cpu_budget_pct'],'sess':len({y['session'] for y in ts})})
        last=(c1,t1)
    r={'phase':name,'rate':rate,'budget':budget,'idle_workload':idle,'rows':rows};out.append(r)
    print(json.dumps(r),flush=True);open('/tmp/qa-pkg/qa060.ndjson','a').write(json.dumps(r)+'\n')
if __name__=='__main__':
    open('/tmp/qa-pkg/qa060.ndjson','w').close()
    print('busy pids',busy,flush=True)
    phase('E1 default 5Hz budget1 busy',5,1.0,80)
    phase('E2 1Hz budget1 busy',1,1.0,40)
    phase('E3 10Hz budget3 busy',10,3.0,60)
    phase('E4 5Hz budget0.3 busy',5,0.3,80)
    phase('E5 5Hz budget0.3 idle (recovery)',5,0.3,100,idle=True)
    phase('E6 5Hz budget0.1 busy',5,0.1,60)
    phase('E7 5Hz budget0.1 idle (recovery)',5,0.1,120,idle=True)
    sig(signal.SIGCONT);phase('E8 restore default 5Hz budget1 busy',5,1.0,40)
