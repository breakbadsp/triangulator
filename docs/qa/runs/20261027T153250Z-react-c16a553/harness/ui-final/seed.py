import json,sqlite3,sys,datetime
from pathlib import Path
root=Path(sys.argv[1]); seed=json.loads(Path(sys.argv[2]).read_text());(root/'replay').mkdir(parents=True,exist_ok=True)
for folder,table in [(root,'resource_sample'),(root/'replay','process_snapshot')]:
 for p in folder.glob('*.sqlite3'):
  with sqlite3.connect(p) as d:
   try:d.execute('DELETE FROM '+table)
   except sqlite3.OperationalError:pass
for s in seed['snapshots']:
 day=datetime.datetime.fromtimestamp(s['recorded_at'],datetime.timezone.utc).date().isoformat()
 with sqlite3.connect(root/'replay'/f'{day}.sqlite3') as d:
  d.execute('CREATE TABLE IF NOT EXISTS process_snapshot(ts REAL PRIMARY KEY NOT NULL,snapshot TEXT NOT NULL)');d.execute('INSERT OR REPLACE INTO process_snapshot VALUES (?,?)',(s['recorded_at'],json.dumps(s)))
for r in seed['resources']:
 day=datetime.datetime.fromtimestamp(r['ts'],datetime.timezone.utc).date().isoformat()
 with sqlite3.connect(root/f'{day}.sqlite3') as d:
  d.execute('CREATE TABLE IF NOT EXISTS resource_sample(ts REAL,session TEXT,sequence INTEGER,pid INTEGER,elapsed_s REAL,rss_bytes REAL,fd_open INTEGER)');d.execute('INSERT INTO resource_sample(ts,session,sequence,pid,elapsed_s,rss_bytes,fd_open) VALUES (:ts,:session,:sequence,:pid,:elapsed_s,:rss_bytes,:fd_open)',r)

for r in seed['resources']:
 if 'tcp_retrans_segs_delta' in r:
  day=datetime.datetime.fromtimestamp(r['ts'],datetime.timezone.utc).date().isoformat()
  with sqlite3.connect(root/f'{day}.sqlite3') as d:
   if 'tcp_retrans_segs_delta' not in [x[1] for x in d.execute('PRAGMA table_info(resource_sample)')]:d.execute('ALTER TABLE resource_sample ADD COLUMN tcp_retrans_segs_delta REAL')
   d.execute('UPDATE resource_sample SET tcp_retrans_segs_delta=? WHERE ts=? AND pid=?',(r['tcp_retrans_segs_delta'],r['ts'],r['pid']))
