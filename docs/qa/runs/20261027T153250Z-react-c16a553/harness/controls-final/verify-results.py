#!/usr/bin/env python3
"""Check saved browser observations and the final result index. No runtime edits."""
import json,hashlib
from pathlib import Path
from collections import Counter
P=Path(__file__).resolve().parent
j=lambda n:json.loads((P/n).read_text())
r=j('results-final.json')
expected={'QA-'+n for n in '034 035 049 058 059 060 062 063 064 065 071 072 073 074 076 077 078 080 099 100'.split()}
assert {x['id']for x in r['cases']}==expected
assert Counter(x['status']for x in r['cases'])=={'PASSED':19,'FAILED':1}
assert next(x for x in r['cases']if x['id']=='QA-074')['status']=='FAILED'
for case in r['cases']:
 for evidence in case['evidence']:assert (P/evidence).is_file(),evidence
for script in r['scripts']:assert (P/script).is_file(),script
assert hashlib.sha256((P/'bugbench').read_bytes()).hexdigest()=='52f9421c6f67876a346d77b9b22eb93044025e56f6b267ed2fdb234219cfa237'
control=j('controls-observations.json');assert control['capacityConfigUnchanged'];assert control['helpInside']==[True];assert control['escapeGuide']=={'dialog':True,'cards':0}
t=j('targets-observations.json');assert any(not x['accept']for x in t['dialogs']);assert any(x['accept']for x in t['dialogs']);assert len(t['before']['targets'])==5 and len(t['removed']['targets'])==4 and len(t['added']['targets'])==5
w=j('watch-observations.json');assert w['doubleSaveWrites']==w['doubleResetWrites']==1;assert w['conflictControls']=={'saveDisabled':True,'resetDisabled':True,'reload':True};assert all(x['focused']for x in w['steps']if x['label'].startswith('099-typing'))
h=j('health-budget-observations.json');assert h['frozenStart']==h['frozenEnd'] and h['afterLeave']!=h['frozenEnd'];assert h['sessionBefore']!=h['sessionAfter'];assert h['sessionHelp'] and not h['helpAfterRestart'];assert len(h['budget'])==4
ha=j('health-auto-open-observations.json');assert ha['beforeOpen'] is None and ha['silentOpen']=='' and ha['userClosed'] is None
f=j('finish-proof-observations.json');assert len(f['samples'])==10
sessions=lambda x:{t['key']:t['session']for t in x['targets']['targets']}
assert all(sessions(s)==sessions(f['samples'][0])for s in f['samples'])
assert {(x['theme'],x['topic'])for x in f['help']if x['text'] and x['focus']==x['topic']}=={(t,k)for t in ['light','dark']for k in ['target-access','sampler-budget']}
for target,data in f['apis']['explicit'].items():
 live=data['live']['data'];assert live['target']==target
 assert all(x['pid']==live['health']['pid']for x in data['resources']['data']['rows'])
 assert data['replay']['data']['snapshot']['health']['pid']==live['health']['pid']
assert all(x['status']==404 for x in f['apis']['unknown'].values())
assert f['apis']['default']['data']['target']=='omarchy/control'
b=j('badges-observations.json');assert b['lastDisabled'] and b['observerLastDisabled'];assert b['selectorFocus']['before']==b['selectorFocus']['after']=='target-select';assert b['unavailable']['present']
s=j('three-six-observations.json');assert s['cancelUnchanged'] and s['duplicateUnchanged'];assert any(x['accept']for x in s['confirmations'])and any(not x['accept']for x in s['confirmations']);steps={x['label']:x for x in s['steps']};assert len(steps['071-three-active-before']['targets']['targets'])==3;assert len(steps['076-sixth-confirmed']['targets']['targets'])==6;assert len({x['samplerPid']for x in s['steps']})==1
rate=j('rate-command-observations.json');assert {t['id']for t in rate['before']['targets']}=={t['id']for t in rate['after']['targets']};assert all(t['configured_rate_hz']==10 for t in rate['after']['targets'])
c=j('colors-observations.json');assert [t['selectedTheme']for t in c['themes']]==['auto','light','dark'];assert 'qa-other' in c['otherFilter'][0] and 'qa-no-access' in c['noAccessFilter'][0];assert c['help']
hc=j('history-colors-observations.json');assert hc['controlledResponses'];assert all(all(state in t['text']for state in ['Running','Sleep','Stopped','Other','No access'])for t in hc['themes'])
failed=j('final-controls-observations.json');assert failed['nameRetry']['health']['target_absent'];assert '(bb-deadlock) Z' in failed['failure074']['processes'] and '(bb-deadlock) S' in failed['failure074']['processes'];assert (P/'QA-074-name-replacement-failure.png').stat().st_size>0
assert r['measurements']['five_target_observation_seconds']>=70
print('Verified 20 case verdicts, browser evidence, confirmations, package fixture identity, measurements, and the QA-074 failure.')
