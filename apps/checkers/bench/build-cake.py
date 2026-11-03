#!/usr/bin/env python3
"""Build a pinned Cake reference executable in a temporary directory on macOS.
Search, evaluation, move generation, and coefficients remain upstream code.
Port changes: Windows API/intrinsic shims, optional book/DB disabled, conflicting
index symbol renamed, exact pattern assignments loaded as binary data. No engine
source is vendored. The wrapper exposes native fixed-depth move selection and an
optional separate native MTD(f) root-choice audit. Cake is external benchmark
infrastructure and not bundled into the browser app.
"""
import array, hashlib, json, re, subprocess, sys
from pathlib import Path
SHA="0221bfb2a625015c067e48825d6be3a6c28fa6d5"
REPO="https://github.com/martinfierz/cake.git"
out=Path(sys.argv[1] if len(sys.argv)>1 else "/private/tmp/checkers-cake-reference").resolve()
out.mkdir(parents=True,exist_ok=True)
src=out/"source"
def run(args,**kwargs): subprocess.run(args,check=True,**kwargs)
if not src.exists(): run(["git","clone","--no-checkout",REPO,str(src)])
run(["git","-C",str(src),"checkout","--detach","--force",SHA])
# Restore tracked upstream files before applying the reproducible portability edits.
run(["git","-C",str(src),"reset","--hard",SHA])
shim=src/"mac-shim";shim.mkdir(exist_ok=True)
SHIMS={'cake-core.c': '#include "../cakepp.c"\n/* External analysis entry point; calls the unchanged native fixed-depth search. */\nint cake_reference_score(SEARCHINFO *si, POSITION *p, int depth) {\n MOVE moves[MAXMOVES],best={0}; int n=getorderedmovelist(p,moves);\n if(!n) return -MATE;\n memset(iscapture,0,sizeof(iscapture)); norefresh=0; hashclear();\n absolutehashkey(p,&si->hash);countmaterial(p,&si->matcount);si->depth=depth;\n return mtdf(si,p,moves,0,depth*FRAC,&best);\n}\n', 'shlobj.h': '#include "windows.h"\n', 'app_instance.c': 'void get_app_instance(char *name,int *instance) { *instance=0; }\nvoid close_app_instance(void) {}\n', 'conio.h': 'static inline int _getch(void) { return getchar(); }\n', 'windows.h': '#pragma once\n#include <unistd.h>\n#include <sys/stat.h>\n#include <stdint.h>\n#include <stdio.h>\n#include <string.h>\n#include <time.h>\n#define CLK_TCK CLOCKS_PER_SEC\n#define MAX_PATH 4096\n#define WINAPI\n#define __int64 long long\n#define CSIDL_PERSONAL 0\n#define SUCCEEDED(x) ((x)>=0)\n#define GetCurrentDirectory(n,b) (getcwd((b),(n)) ? (int)strlen(b) : 0)\n#define SetCurrentDirectory(d) chdir(d)\n#define CreateDirectory(d,a) mkdir(d,0700)\n#define CreateDirectoryA(d,a) mkdir(d,0700)\n#define SHGetFolderPath(a,b,c,d,e) (-1)\n#define SHGetFolderPathA(a,b,c,d,e) (-1)\n#define PathAppend(a,b) (strcat((a),(b)))\n\n#define min(a,b) ((a)<(b)?(a):(b))\n#define max(a,b) ((a)>(b)?(a):(b))\n', 'intrin.h': '#pragma once\n#define __popcnt(x) __builtin_popcount((unsigned int)(x))\nstatic inline int _BitScanForward(unsigned long *out,unsigned int x) { if(!x)return 0;*out=__builtin_ctz(x);return 1; }\nstatic inline int _BitScanReverse(unsigned long *out,unsigned int x) { if(!x)return 0;*out=31-__builtin_clz(x);return 1; }\n', 'shlwapi.h': '#include "windows.h"\n', 'winbase.h': '#include "windows.h"\n', 'cake-cli.c': '#include <time.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\n#include <string.h>\n#include "structs.h"\n#include "switches.h"\n#include "cakepp.h"\n#include "move_gen.h"\nextern int usethebook,enable_wld,hashsize;\nint cake_reference_score(SEARCHINFO*,POSITION*,int);\nint main(int argc,char**argv) {\n int roots=argc>1 && strcmp(argv[1],"--root-scores")==0;\n int output=dup(STDOUT_FILENO); freopen("/dev/null","w",stdout);\n usethebook=0; enable_wld=0; hashsize=0x100000;\n char info[1024]={0}; initcake(info);\n char line[65536];\n while(fgets(line,sizeof(line),stdin)) {\n  POSITION p={0}; unsigned depth=9;\n  unsigned long long nums[256]; int count=0; char *cursor=line;\n  while(*cursor && count<256) { if(*cursor>=\'0\'&&*cursor<=\'9\') nums[count++]=strtoull(cursor,&cursor,10); else cursor++; }\n  if(count<6 || ((count-6)%5)!=0 || nums[0]>0xffffffffULL || nums[1]>0xffffffffULL || nums[2]>0xffffffffULL || nums[3]>0xffffffffULL || (nums[4]!=1&&nums[4]!=2) || nums[5]<1 || nums[5]>25) { dprintf(output,"{\\"error\\":\\"invalid input\\"}\\n");continue; }\n  p.bm=nums[0];p.bk=nums[1];p.wm=nums[2];p.wk=nums[3];p.color=nums[4];depth=nums[5];\n  POSITION original=p;\n  MOVE moves[MAXMOVES];int n=getorderedmovelist(&p,moves);\n  dprintf(output,"{\\"legalSuccessors\\":[");\n  for(int i=0;i<n;i++){POSITION q=p;togglemove((&q),moves[i]);dprintf(output,"%s[%u,%u,%u,%u,%d]",i?",":"",q.bm,q.bk,q.wm,q.wk,q.color);}\n  dprintf(output,"],");\n  if(!n){dprintf(output,"\\"terminal\\":true,\\"score\\":-1900}\\n");continue;}\n  SEARCHINFO si={0}; REPETITION history[MAXDEPTH+HISTORYOFFSET+8]={0};si.repcheck=history;\n  int supplied=(count-6)/5, kept=supplied>HISTORYOFFSET?HISTORYOFFSET:supplied;\n  POSITION prev={0};\n  for(int i=0;i<kept;i++) {\n   int j=6+5*(supplied-kept+i); POSITION h={nums[j],nums[j+1],nums[j+2],nums[j+3],(int)nums[j+4]}; HASH key;absolutehashkey(&h,&key);\n   int slot=HISTORYOFFSET-kept+i; history[slot].hash=key.key; history[slot].irreversible=(i==0 || h.bm!=prev.bm || h.wm!=prev.wm); prev=h;\n  }\n  HASH current;absolutehashkey(&p,&current);history[HISTORYOFFSET].hash=current.key;\n  history[HISTORYOFFSET].irreversible=(!kept || p.bm!=prev.bm || p.wm!=prev.wm);si.gamehistflag=1;\n  REPETITION baseHistory[MAXDEPTH+HISTORYOFFSET+8];memcpy(baseHistory,history,sizeof(history));\n  int playnow=0; double start=(double)clock()/CLOCKS_PER_SEC;\n  int result=cake_getmove(&si,&p,DEPTH_BASED,1.0,depth,0,info,&playnow,0,33);\n  double elapsed=(double)clock()/CLOCKS_PER_SEC-start;\n  dprintf(output,"\\"successor\\":[%u,%u,%u,%u,%d],\\"score\\":%d,\\"result\\":%d,\\"requestedDepth\\":%u,\\"completedDepth\\":%d,\\"nodes\\":%llu,\\"historyPositions\\":%d,\\"cpuSeconds\\":%.6f,\\"aborted\\":%s",p.bm,p.bk,p.wm,p.wk,p.color,si.value,result,depth,si.depth,si.negamax,kept,elapsed,si.aborted?"true":"false");\n  if(roots) {\n   dprintf(output,",\\"rootScores\\":[");\n   for(int i=0;i<n;i++) {\n    POSITION child=original;togglemove((&child),moves[i]);\n    SEARCHINFO cs={0};REPETITION cr[MAXDEPTH+HISTORYOFFSET+8]={0};cs.repcheck=cr;\n    for(int j=0;j<HISTORYOFFSET;j++) cr[j]=baseHistory[j+1];\n    HASH ck;absolutehashkey(&child,&ck);cr[HISTORYOFFSET].hash=ck.key;cr[HISTORYOFFSET].irreversible=(child.bm!=original.bm||child.wm!=original.wm);\n    int cp=0;char out[1024]={0};cs.play=&cp;cs.out=out;cs.searchmode=DEPTH_BASED;cs.start=clock();cs.maxtime=1;cs.aborttime=1;\n    int score=-cake_reference_score(&cs,&child,depth-1);\n    POSITION successor=original;togglemove((&successor),moves[i]);\n    dprintf(output,"%s{\\"successor\\":[%u,%u,%u,%u,%d],\\"score\\":%d,\\"childDepth\\":%u,\\"nodes\\":%llu}",i?",":"",successor.bm,successor.bk,successor.wm,successor.wk,successor.color,score,depth-1,cs.negamax);\n   }\n   dprintf(output,"]");\n  }\n  dprintf(output,"}\\n");\n\n }\n return 0;\n}\n'}
for name,contents in SHIMS.items(): shim.joinpath(name).write_text(contents)
switches=src/"switches.h"
s=switches.read_text().replace("#define USE_KR_DB","#undef USE_KR_DB").replace("#define BOOK\t","#undef BOOK\t")
switches.write_text(s)
evalfile=src/"cake_eval_parametrized.c"
evalfile.write_text(re.sub(r"\bindex\b","cake_pattern_index",evalfile.read_text()))
# Preserve every last-write-wins official pattern assignment in its zero-filled array.
sizes={1:531441,2:781250,3:781250,4:781250}
arrays={k:array.array("h",[0])*n for k,n in sizes.items()}
updates=re.findall(r"pat([1-4])\[(\d+)\]\s*=\s*(-?\d+);",src.joinpath("pattern.c").read_text())
assert len(updates)==124386, "Upstream pattern assignment layout changed"
for a,i,v in updates: arrays[int(a)][int(i)]=int(v)
parts=["#include <stdio.h>","#include <stdlib.h>"]
weights={}
for k,a in arrays.items():
 path=shim/f"pat{k}.bin"; path.write_bytes(a.tobytes()); weights[path.name]=hashlib.sha256(path.read_bytes()).hexdigest()
 parts.append(f"extern short pat{k}[{len(a)}];")
parts.append("int patterns_set(void) { FILE *f;")
for k,a in arrays.items():
 path=shim/f"pat{k}.bin"
 parts.append(f'f=fopen({json.dumps(str(path))},"rb"); if(!f || fread(pat{k},sizeof(short),{len(a)},f)!={len(a)}) abort(); fclose(f);')
parts.append("return 0;}");shim.joinpath("pattern-loader.c").write_text("\n".join(parts))
flags=["-O2","-D_WIN64","-D__int64=long long","-DCLK_TCK=CLOCKS_PER_SEC","-I",str(shim),"-fms-extensions","-Wno-format-security","-Wno-implicit-function-declaration","-Wno-incompatible-pointer-types","-Wno-int-conversion"]
sources=["mac-shim/cake-core.c","cake_book.c","cake_eval_parametrized.c","move_gen.c","initcake.c","boolean.c","cake_misc.c","mac-shim/pattern-loader.c","mac-shim/app_instance.c"]
run(["clang",*flags,"-c",*sources],cwd=src)
objects=[Path(p).stem+".o" for p in sources]
exe=out/"cake-cli"
run(["clang",*flags,"-I",str(src),"mac-shim/cake-cli.c",*objects,"-o",str(exe)],cwd=src)
provenance={"name":"Cake","repository":REPO,"revision":SHA,"nativeVersion":"1.89g","platform":"macOS arm64 portability build","book":False,"tablebases":False,"hashEntries":1048576,"patternWeightsSha256":weights,"executable":str(exe)}
out.joinpath("provenance.json").write_text(json.dumps(provenance,indent=2)+"\n")
print(json.dumps(provenance,indent=2))
