import hashlib,json,os,pathlib,socket,subprocess,tarfile,urllib.request
root=pathlib.Path('/tmp/triangulator-qa-phase11-923ba96')
root.mkdir(exist_ok=False)
pkg=root/'downloads';pkg.mkdir()
version='qa-react-923ba96567f7e7729434763e043bb60ee2fa3cc5'
expected={'sampler':'694a4295cdd5c65c6d161b53836013f2309790a6a1e79a16b55f6826e2a6df13','collector':'646b01f349d29aa213e100c496ca1101b84a084bcc3eb2efdae8ad8e397a470e'}
archives=[]
for component,checksum in expected.items():
 name=f'triangulator-{component}-{version}-local-linux-x86_64-gcc16.tar.gz'
 url=f'http://127.0.0.1:45269/{name}'
 for suffix in ('','.sha256'): urllib.request.urlretrieve(url+suffix,pkg/(name+suffix))
 subprocess.run(['sha256sum','-c',name+'.sha256'],cwd=pkg,check=True)
 actual=hashlib.sha256((pkg/name).read_bytes()).hexdigest();assert actual==checksum
 with tarfile.open(pkg/name) as archive:archive.extractall(root,filter='data')
 archives.append({'component':component,'url':url,'checksum_url':url+'.sha256','filename':name,'sha256':actual})
home=root/'triangulator';config=home/'config';config.mkdir()
socks=[]
for kind in (socket.SOCK_STREAM,socket.SOCK_DGRAM):
 s=socket.socket(socket.AF_INET,kind);s.bind(('127.0.0.1',0));socks.append(s)
http,udp=[s.getsockname()[1] for s in socks]
fixture=subprocess.Popen(['sleep','86400'],start_new_session=True)
second=subprocess.Popen(['sleep','86400'],start_new_session=True)
collector=(home/'templates/collector.toml').read_text().replace('udp_host = "0.0.0.0"','udp_host = "127.0.0.1"').replace('udp_port = 9400',f'udp_port = {udp}').replace('http_port = 9401',f'http_port = {http}').replace('sampler_ip = "10.0.0.10"','sampler_ip = "127.0.0.1"').replace('max_live_samples = 1000000','max_live_samples = 10000')
sampler=(home/'templates/sampler.toml').read_text().replace('target_process = "ghostty"',f'target_pid = {fixture.pid}').replace('10.0.0.5:9400',f'127.0.0.1:{udp}').replace('127.0.0.1:9400',f'127.0.0.1:{udp}')
(config/'collector.toml').write_text(collector);(config/'sampler.toml').write_text(sampler)
for s in socks:s.close()
env=dict(os.environ,TRIANGULATOR_HOME=str(home))
subprocess.run([str(home/'scripts/start.sh')],env=env,check=True)
state={'version':version,'root':str(root),'home':str(home),'http_port':http,'udp_port':udp,'url':f'http://127.0.0.1:{http}','fixture_pids':[fixture.pid,second.pid],'archives':archives,'processes':{p.stem:int(p.read_text()) for p in (home/'run').glob('*.pid')}}
(root/'state.json').write_text(json.dumps(state,indent=2))
print(json.dumps(state,indent=2))
