import json,subprocess,time,re
from pathlib import Path
p=Path('/private/tmp/sol-lfm3-independent-review-2026-11-03.json');d=json.loads(p.read_text())
for row in d['decisions']:
 if row['remainingSeeds']>31:continue
 matrix=[]
 for pit in row['legal']:
  t=time.perf_counter()
  try:
   r=subprocess.run(['/private/tmp/mancala_exact_judgment','position'],input=' '.join(map(str,[1,pit,*row['before']]))+'\n',text=True,capture_output=True,timeout=20)
   m=re.search(r'margin (-?\d+) finalAI (\d+) finalHuman (\d+) nodes (\d+) states (\d+)',r.stdout)
   if r.returncode!=0 or not m:result={'pit':pit,'displayPit':pit-6,'complete':False,'reason':r.stderr.strip() or r.stdout.strip()}
   else:result={'pit':pit,'displayPit':pit-6,'complete':True,'finalMargin':int(m[1]),'aiStore':int(m[2]),'humanStore':int(m[3]),'nodes':int(m[4]),'states':int(m[5])}
  except subprocess.TimeoutExpired:result={'pit':pit,'displayPit':pit-6,'complete':False,'reason':'20-second-limit'}
  result['seconds']=time.perf_counter()-t;matrix.append(result)
  print('move',row['move'],result,flush=True)
 row['independentTerminalMargins']=matrix
 if all(r['complete'] for r in matrix):
  best=max(r['finalMargin'] for r in matrix);selected=next(r for r in matrix if r['pit']==row['pit']);row['exactJudgment']={'selectedMargin':selected['finalMargin'],'bestMargin':best,'bestPits':[r['pit'] for r in matrix if r['finalMargin']==best],'marginLoss':best-selected['finalMargin'],'selectedWDL':(selected['finalMargin']>0)-(selected['finalMargin']<0),'bestWDL':(best>0)-(best<0)}
 p.write_text(json.dumps(d,indent=2)+'\n')
