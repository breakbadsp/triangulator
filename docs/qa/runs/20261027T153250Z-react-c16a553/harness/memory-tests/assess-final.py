import json,re
from pathlib import Path
from collections import Counter
P=Path(__file__).resolve().parent
runs={k:json.loads((P/v).read_text()) for k,v in {'full':'final-observations.json','supplement':'supplement-observations.json','verify':'verify-observations.json'}.items()}
labels=[s.split(' {"facts"')[0] for s in (P/'final-run.log').read_text().splitlines() if ' {"facts"' in s]
full=[o for o in runs['full']['observations'] if 'state' in o]
assert len(labels)==len(full)
for name,o in zip(labels,full):o['selectedName']=o.get('name');o['name']=name
obs={k:{o['name']:o for o in d['observations']} for k,d in runs.items()}
def get(n,r='full'):return obs[r][n]
def fact(n,key,r='full'):return get(n,r)['facts'][key]
def count(o,cl):return sum(c['cls']==cl for c in o['cells'])
def span(o):
 m=re.search(r'grid (0x[0-9a-f]+) – (0x[0-9a-f]+)',o.get('caption',''))
 return tuple(int(x,16) for x in m.groups()) if m else None
checks=[]
def check(label,v):
 assert v,label
 checks.append(label)
for k,d in runs.items():check(k+' browser run completes without harness errors',not d['errors'] and 'end' in d)
colors={'legend [heap]':('heap (brk)','rgb(42, 120, 214)'),'legend [stack]':('stack','rgb(216, 90, 40)'),'legend anonymous':('anonymous (arenas, mmap)','rgb(27, 175, 122)'),'legend neighbor':('file mapping','rgb(196, 162, 74)'),'legend program (probably the program)':('program / library code','rgb(107, 119, 133)')}
for n,(label,color) in colors.items():
 o=get(n); sw=next(x for x in o['legend'] if x['label']==label)
 check(n+' grid and legend color agree',sw['bg']==color and any(c['bg']==color and c['cls']!='pad' for c in o['cells']))
o=get('legend guard (no access)');check('guard hatching agrees',o['legend'][0]['image']!='none' and any(c['cls']=='cell-guard' and c['image']==o['legend'][0]['image'] for c in o['cells']))
for n in ['legend [stack]','legend neighbor','legend program (probably the program)','legend guard (no access)']:
 check(n+' only visible kind in legend',len(get(n)['legend'])==1)
check('gap entry only where applicable','not mapped' in [x['label'] for x in get('legend anonymous')['legend']] and 'not mapped' not in [x['label'] for x in get('legend [stack]')['legend']])
check('new mapping entry and cell outline appear on growth',any(x['label']=='mapped since the previous layout' for x in get('heap growth 4KiB')['legend']) and count(get('heap growth 4KiB'),'cell-new')==1)
check('new mapping entry removed after contraction',all(x['label']!='mapped since the previous layout' for x in get('heap contraction 4KiB')['legend']))
for n in ['high baseline','4KiB page','late valid page']:check(n+' 4KiB metadata',fact(n,'Page size')=='4.0 KiB')
check('64KiB metadata',fact('64KiB page','Page size')=='64.0 KiB' and '64.0 KiB (1 page)' in get('64KiB page')['caption'])
for n in ['session missing page','invalid zero page','invalid negative page']:check(n+' uses bytes',fact(n,'Page size')=='Unknown' and 'bytes' in get(n)['caption'])
check('stale metadata preserves known page',fact('stale resources retain page','Page size')=='4.0 KiB' and fact('stale metadata after late valid','Page size')=='4.0 KiB')
check('new target cannot inherit stale page',fact('other target stale unknown','Page size')=='Unknown')
check('wrong session metadata excluded',fact('wrong session metadata','Page size')=='Unknown')
for k,d in runs.items():
 for o in d['observations']:
  if 'cells' in o:check(k+':'+o['name']+' <=512 actual cells',len(o['cells'])<=512)
check('heap and stack exact high address offsets','+4.0 KiB' in get('heap growth 4KiB')['charts'][0]['text'] and '−4.0 KiB' in get('stack growth 4KiB')['charts'][1]['text'])
check('stack lower start grows mapped size',fact('stack growth 4KiB','Size (mapped)')=='20.0 KiB' and fact('stack contraction 4KiB','Size (mapped)')=='16.0 KiB')
check('growth outline compares preceding layout',count(get('supplement second growth 4KiB','supplement'),'cell-new')==1)
check('growth fact uses measured window, contraction updates total',fact('supplement second growth 4KiB','Heap mapping size change','supplement').startswith('+8.0 KiB in ') and fact('supplement contraction 4KiB','Heap mapping size change','supplement').startswith('+4.0 KiB in '))
for n in ['stale','partial','truncated','hidden','delayed']:
 check(n+' no growth/gap/margin',fact(n,'Heap mapping size change')=='Unavailable' and fact(n,'Largest unmapped gap')=='Unavailable' and 'Heap display margin' not in get(n)['caption'])
check('missing memory no growth',not get('missing memory')['facts'])
check('separated gap exact 4096 above 2^53',fact('separated anonymous gap','Largest unmapped gap')=='4.0 KiB')
check('contiguous gap zero',fact('contiguous anonymous zero gap','Largest unmapped gap')=='0 B')
check('partial anonymous coverage unavailable',fact('anonymous incomplete gap','Largest unmapped gap','supplement')=='Unavailable')
for topic,phrase in [('memgap','not an allocator free block'),('heapend','page-aligned'),('threadstacks','Residency does not measure current stack depth')]:check(topic+' help specific',phrase in get('help '+topic)['text'])
for d in runs.values():
 for o in d['observations']:
  for c in o.get('charts',[]):
   for line in c['segments']:
    points=[tuple(map(float,p.split(','))) for p in line.split()]
    check('step polyline '+o['name'],all(x1==x2 or y1==y2 for (x1,y1),(x2,y2) in zip(points,points[1:])))
check('stale chart gap',len(get('recovery')['charts'][0]['segments'])==2)
for n,r in [('identity reset session','full'),('target omarchy/default page 4096','verify')]:check(n+' resets boundary offset', 'Offset: 0 B → 0 B' in get(n,r)['charts'][0]['text'] and not any(c['cls']=='cell-new' for c in get(n,r)['cells']))
check('late metadata retains boundary offset','Offset: 0 B → +4.0 KiB' in get('memory growth before metadata')['charts'][0]['text'] and 'Offset: 0 B → +4.0 KiB' in get('late valid page')['charts'][0]['text'])
for width in [390,1440]:
 o=get('readable viewport '+str(width),'verify')
 check('readable '+str(width),all(x['rect']['x']>=0 and x['rect']['x']+x['rect']['width']<=width and x['rect']['y']>=0 and x['rect']['y']+x['rect']['height']<=900 and all(c['scroll']<=c['client'] for c in x['children']) for x in o['read']))
 check('member disclosure opens '+str(width),any(x['id']=='memory-region-details' and x['open'] for x in get('members open '+str(width),'verify')['details']))
check('anonymous mapping grows without heap/residency change',fact('valid anonymous mapping growth','Heap mapping size change','supplement').startswith('0 B ') and '192.0 KiB → 192.0 KiB' in get('valid anonymous mapping growth','supplement')['charts'][2]['text'])
check('anonymous residency independent',fact('valid anonymous resident growth','Heap mapping size change','supplement').startswith('0 B ') and '192.0 KiB → 256.0 KiB' in get('valid anonymous resident growth','supplement')['charts'][2]['text'])
check('heap growth independent of anonymous residency',fact('valid heap growth isolated','Heap mapping size change','supplement').startswith('+4.0 KiB ') and '192.0 KiB → 256.0 KiB' in get('valid heap growth isolated','supplement')['charts'][2]['text'])
check('small span and cells stable',span(get('span growth','verify'))==span(get('span contraction retains old span','verify')) and len(get('span growth','verify')['cells'])==len(get('span contraction retains old span','verify')['cells']))
check('target resets actual span',span(get('target reset shrinks span','verify'))[1]<span(get('span contraction retains old span','verify'))[1])
check('recovery restores same span',span(get('stable span recovery'))==span(get('stable span new baseline')))
check('neighbor removal does not change span',span(get('neighbor removed'))==span(get('stable span new baseline')))
o=get('valid growth beyond span','supplement');h=next(r for r in o['state']['regions'] if r['kind']=='heap');check('large span margin <=1MiB',0<span(o)[1]-int(h['end'],16)<=1048576)
failures=[{'id':'F1','cases':['QA-011','QA-017'],'expected':'Exclude metadata from another target. Keep Unknown page size for a selected target with no valid metadata.','actual':'Selected omarchy/default accepted a live response with target=omarchy/second and resources.limits.page_size=65536. It displayed 64.0 KiB and retained it after correct-target missing metadata returned.','reproduction':['Run node supplement-run.js for the first observation.','Run node verify-run.js for the one limited retry.','Select omarchy/default with a new session and no page_size. Observe Unknown.','Fulfill its live request with target=omarchy/second, the same health/resource session and PID, and page_size=65536. Refresh all timestamps and match memory.layout_id to layout.id.','Observe Page size 64.0 KiB. Return target=omarchy/default with page_size missing. The incorrect cached size persists.'],'attempts':[{'run':'supplement','observations':['target omarchy/default page null','wrong-target live metadata','correct-target unknown restored']},{'run':'verify','observations':['fresh session unknown page','wrong-target retry','wrong-target cache persists retry']}],'screenshot':'QA-011-QA-017-wrong-target-retry.png'}, {'id':'F2','cases':['QA-014'],'expected':'Boundary charts break at missing data.','actual':'After memory.available=false and recovery, each boundary chart contains one continuous polyline. It connects the earlier sample to the recovery sample across the unavailable interval. Stale coverage does create separate segments.','reproduction':['Run node final-run.js for the first observation, or node supplement-run.js for the one limited retry.','Supply matching fresh high-address heap and stack layouts. Grow the heap by 4096 bytes.','Set memory.available=false for at least two live polls. Observe that memory facts and charts disappear.','Restore memory.available=true with the heap end another 4096 bytes higher.','Observe a continuous step line across the missing interval. Read the rendered SVG: one polyline, with x positions spanning that interval.'],'attempts':[{'run':'full','observations':['missing memory','memory recovery']},{'run':'supplement','observations':['missing memory retry','missing memory recovery retry']}],'screenshot':'QA-014-missing-recovery-retry.png'}]
# Assert that each recorded failure is present in both browser observations.
for n,r in [('wrong-target live metadata','supplement'),('wrong-target retry','verify')]:check('F1 confirmed '+r,fact(n,'Page size',r)=='64.0 KiB' and get(n,r)['state']['responseTarget']=='omarchy/second' and get(n,r)['state']['target']=='omarchy/default')
for n,r in [('memory recovery','full'),('missing memory recovery retry','supplement')]:check('F2 confirmed '+r,all(len(c['segments'])==1 for c in get(n,r)['charts'][:2]))
C={
'QA-008':('PASSED',['Heap blue, stack orange, anonymous green, file yellow, and code gray match the rendered grid and legend.','Guard cells and legend use the same hatch. Only visible kinds appear. Gap and previous-layout entries appear only when applicable.','Consecutive 4 KiB growth outlines only the newly mapped cell. Contraction removes that entry.']),
'QA-011':('FAILED',['4 KiB and 64 KiB metadata set binary page counts. Zero, negative, and missing metadata use bytes. All observed grids have at most 512 cells.','Known page size survives stale resources. Target and session changes clear cached size. Wrong-session metadata is excluded.','F1: A wrong-target live response supplies and caches its page size.']),
'QA-012':('PASSED',['Heap and stack unchanged, growth, and contraction sequences update sizes and measured intervals. Help confirms that size change uses the observation window; contraction reduces the window total.','Stale, incomplete, delayed, and missing samples provide no growth value.','Target and session changes reset comparisons. Consecutive growth outlines compare with the previous layout, not the first layout.']),
'QA-013':('PASSED',['Separated anonymous regions above 2^53 show an exact 4.0 KiB largest gap. Contiguous regions show 0 B.','Partial, truncated, hidden, stale, and delayed coverage show Unavailable.','Opened Largest unmapped gap help. It distinguishes address gaps from allocator free blocks.']),
'QA-014':('FAILED',['Heap and stack charts preserve exact 4 KiB offsets above 2^53. Stack growth lowers the start; contraction reverses it. Unchanged samples remain level.','Rendered polylines use horizontal/vertical steps. Target and session changes reset offsets. Stale coverage breaks lines. Heap help explains page alignment and sampled boundaries.','F2: memory.available=false does not leave a break after recovery. The one limited retry reproduces the continuous line.']),
'QA-015':('PASSED',['At 390 and 1440 px, facts, legends, and each chart were scrolled into view. All fit within the viewport and all measured labels fit their containers.','Member regions remain in a native disclosure. It opens and closes through the browser at both widths.','Thread-stack help opens at both widths. It distinguishes fixed reserved address range, resident pages, and current stack depth.']),
'QA-016':('BLOCKED',['Observed bounded margin, mapped-heap-only facts, neighbor file colors, invalid-coverage margin removal, recovery, target reset, and at most 512 cells.','Requirement conflict R1 prevents a verdict on “avoids neighbors.” All actions are complete.']),
'QA-017':('FAILED',['Memory growth is recorded before page metadata. Delivering valid late metadata preserves the +4 KiB boundary history and changes byte cells to page cells.','Stale resource metadata does not erase the known page size.','F1: Wrong-target metadata is accepted and cached.']),
'QA-018':('PASSED',['Separate valid sequences grow anonymous mappings, anonymous residency, and brk heap. Each changes its own displayed facts/chart.','Anonymous mapping growth leaves the heap boundary and resident-anonymous value unchanged. Resident-anonymous growth leaves the heap boundary unchanged. Heap growth leaves anonymous residency unchanged.','Opened Resident anonymous and Heap size help. The UI names mappings and RssAnon separately. It does not present them as allocator usage or proof of a heap leak.']),
'QA-019':('PASSED',['Small heap growth and contraction retain grid bounds and cell count. Facts and previous-layout outlines update.','Stale and delayed coverage hide margin. Recovery restores its previous span. Neighbor removal preserves the span and removes its legend kind.','A nonoverlapping large-growth fixture creates a bounded span with exactly 1 MiB of margin, 485 represented cells, and 512 total cells including padding.','A real target selection resets the retained grid end from 0x20000000034000 to 0x20000000033000.'])}
prior=json.loads((P/'results-v2.json').read_text())
result={'package':'dev-c16a553','head':'c16a55383c4bc6a219c270aa4f7cf9b55c97e45a','tier':'Full, selected cases only','url':'http://127.0.0.1:19401/?target=omarchy%2Fsecond','browser':runs['full']['browser'],'viewports':[[1440,1000],[1440,900],[390,900]],'start':runs['full']['start'],'end':runs['verify']['end'],'method':'Downloaded runtime, real owned Chromium browser, controlled network responses only; DOM evaluation was read-only. Actual processes, configuration, targets, and product files were not changed.','cases':{k:{'status':s,'observed_expectations':o} for k,(s,o) in C.items()},'counts':dict(Counter(s for s,o in C.values())),'failures':failures,'requirements_blockers':[{'id':'R1','case':'QA-016','source':'/home/daksh/src/triangulator-qa-react-full-c16a553/docs/qa/test-cases.md:208','expected_quote':'Display margin is capped and avoids neighbors.','browser_help_quote':'The grid includes a small margin above the page-aligned heap mapping end. Neighboring mappings keep their own colors.','evidence':'supplement-observations.json: help heapmargin; final-observations.json: high baseline','observed':'Heap ends at 0x20000000024000. Neighbor file occupies 0x20000000026000–0x20000000028000. Grid ends at 0x20000000034000 and renders neighbor cells yellow, not blue.','needed_resolution':'Specify whether avoids neighbors means the grid must stop before the next mapping, or must preserve neighboring mappings and their colors. The first interpretation fails; the second passes.'}],'invalid_attempts':prior['invalidAttempts']+['invalid-final-attempt1.json: wrong visible anonymous-row locator. No product failure.','The full run stored the selected region in its name field. assess-final.py restores scenario names from final-run.log without rewriting the original evidence.','The full-run anonymous-mapping-growth sample overlapped adjacent anonymous ranges. Excluded; replaced by supplement valid anonymous mapping growth.','The full-run large-growth layout overlapped other regions. Excluded; replaced by supplement valid growth beyond span with only the earlier program mapping and heap.','Controlled map layouts retain baseline aggregate process metrics. Aggregate process totals and Share of VmSize were not used to establish map-boundary or span expectations.','Earlier page_size=3 observations are preserved. They are not a failure because the invalid boundary is not specified. Zero, negative, and missing metadata were tested instead.'],'proof':{'script':'assess-final.py','checks_passed':len(checks),'raw_evidence':{'full':'final-observations.json','supplement':'supplement-observations.json','verify':'verify-observations.json'},'rerun':['node final-run.js','node supplement-run.js','node verify-run.js','python3 assess-final.py'],'console_errors':{k:d['console'] for k,d in runs.items()}},'samples':{k:[{key:o[key] for key in ['name','selectedName','state','facts','caption','charts','text'] if key in o} for o in d['observations']] for k,d in runs.items()}}
(P/'results-final.json').write_text(json.dumps(result,indent=2)+'\n')
for f in ['results-final.json','QA-011-QA-017-wrong-target-retry.png','QA-014-missing-recovery-retry.png']:assert (P/f).stat().st_size>0
print(json.dumps({'counts':result['counts'],'checks':len(checks),'failures':[f['id'] for f in failures],'blockers':['R1'],'result':str(P/'results-final.json')}))
