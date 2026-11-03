from pathlib import Path
import json,subprocess,time,re
p=Path('/private/tmp/sol-lfm3-independent-review-2026-11-03.json');d=json.loads(p.read_text());row=next(r for r in d['decisions'] if r['move']==12);row['independentWDL']=[]
for pit in [9,10,11,12]:
 t=time.perf_counter()
 try:
  r=subprocess.run(['/private/tmp/mancala_wdl39',str(pit),'20','stdin'],input=' '.join(map(str,row['before']))+'\n',text=True,capture_output=True,timeout=23)
  m=re.search(r'complete (true|false).*?(?:wdl (-?\d+)|reason (\S+)).*?nodes (\d+) states (\d+).*?maxDepth (\d+) seconds ([\d.]+)',r.stdout)
  result={'pit':pit,'displayPit':pit-6,'complete':bool(m and m[1]=='true'),'stdout':r.stdout.strip(),'seconds':time.perf_counter()-t}
  if m:
   result.update(nodes=int(m[4]),states=int(m[5]),maxDepth=int(m[6]))
   if m[2] is not None:result['wdl']=int(m[2])
 except subprocess.TimeoutExpired:result={'pit':pit,'displayPit':pit-6,'complete':False,'reason':'external23secondguard','seconds':time.perf_counter()-t}
 row['independentWDL'].append(result);p.write_text(json.dumps(d,indent=2)+'\n');print('move12',result,flush=True)
