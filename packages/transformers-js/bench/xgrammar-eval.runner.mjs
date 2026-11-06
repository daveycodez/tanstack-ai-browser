const encoder=new TextEncoder();
const median=a=>{a=[...a].sort((a,b)=>a-b);return a.length%2?a[a.length>>1]:(a[a.length/2-1]+a[a.length/2])/2};
export async function evaluateXGrammar(x,{hf=null,hfEncode=null}={}){
 const report={startedAt:new Date().toISOString(),package:'@mlc-ai/web-xgrammar@0.1.27',generation:false,sampling:false,results:[],performance:{},gaps:[]};
 const memory=()=>typeof process!=='undefined'&&typeof process.memoryUsage==='function'?process.memoryUsage():null;const memBefore=memory();
 const vocab=Array.from({length:256},(_,i)=>'<0x'+i.toString(16).padStart(2,'0').toUpperCase()+'>').concat('<eos>');const EOS=256;
 let at=performance.now();const info=await x.TokenizerInfo.createTokenizerInfo(vocab,'byte_fallback',false,257,[EOS]);report.performance.byteTokenizerInitMs=performance.now()-at;
 const compiler=await x.GrammarCompiler.createGrammarCompiler(info,true);
 const schemaFor=value=>({type:'object',properties:{value:{type:'string',const:value}},required:['value'],additionalProperties:false});
 const canonical=value=>JSON.stringify(value).replaceAll('/','\\/');
 const allowed=(mask,t)=>!!(mask[t>>>5]&(1<<(t&31)));
 const compile=s=>compiler.compileJSONSchema(JSON.stringify(s),false,-1,[',',':'],false);
 async function acceptRaw(grammar,raw){const m=await x.GrammarMatcher.createGrammarMatcher(grammar,[EOS]);let accepted=true,failedByte=null;for(const b of encoder.encode(raw)){if(!m.acceptToken(b)){accepted=false;failedByte=b;break}}const mask=await m.getNextTokenBitmask();const complete=accepted&&allowed(mask,EOS);const terminatedBefore=m.isTerminated();const eosAccepted=complete?m.acceptToken(EOS):false;const terminatedAfter=m.isTerminated();m.dispose();return {accepted,complete,failedByte,eosAccepted,terminatedBefore,terminatedAfter}}
 async function check(name,schema,raw,want,{lexical=false}={}){let grammar;try{grammar=await compile(schema);const result=await acceptRaw(grammar,raw);const pass=result.complete===want;report.results.push({name,schema,raw,expectedComplete:want,...result,pass,lexical});return result}catch(e){report.results.push({name,schema,raw,error:String(e?.message??e),pass:false,lexical})}finally{grammar?.dispose()}}
 for(const value of ['Paris','Paris</think>Paris','Paris</think>Paris <think>tag</think> héllo 👑','quoted "text" \\ slash / newline\n\t\u0001']){
  const raw=canonical({value});await check('canonical finite literal '+JSON.stringify(value),schemaFor(value),raw,true);
 }
 await check('alternative unescaped slash spelling',schemaFor('Paris</think>Paris'),JSON.stringify({value:'Paris</think>Paris'}),true,{lexical:true});
 await check('equivalent Unicode escape spelling',schemaFor('Paris</think>Paris'),'{"value":"Paris\\u003c/think>Paris"}',true,{lexical:true});
 await check('equivalent Unicode surrogate spelling',schemaFor('héllo 👑'),'{"value":"h\\u00e9llo \\ud83d\\udc51"}',true,{lexical:true});
 const grammar=await compile(schemaFor('Paris</think>Paris'));
 for(const [name,prefix,candidate]of [['reject wrong escaped quote','{"value":"Paris\\',34],['reject impossible partial Unicode escape','{"value":"Paris\\u',51],['reject incompatible UTF8 lead','{"value":"Paris',194]]){
  const m=await x.GrammarMatcher.createGrammarMatcher(grammar,[EOS]);let prefixAccepted=true;for(const b of encoder.encode(prefix))if(!m.acceptToken(b)){prefixAccepted=false;break}const mask=await m.getNextTokenBitmask();const candidateAllowed=prefixAccepted&&allowed(mask,candidate);report.results.push({name,prefix,candidate,prefixAccepted,candidateAllowed,pass:!candidateAllowed,rejectedEarlier:!prefixAccepted});m.dispose();
 }
 grammar.dispose();
 const tool={type:'object',properties:{city:{type:'string',enum:['Paris','Tokyo']},unit:{type:'string',enum:['C','F']}},required:['city','unit'],additionalProperties:false};
 await check('tool arguments valid enum',tool,'{"city":"Paris","unit":"C"}',true);
 await check('tool arguments invalid enum',tool,'{"city":"London","unit":"C"}',false);
 await check('tool arguments extra property',tool,'{"city":"Paris","unit":"C","extra":1}',false);
 await check('tool arguments missing property',tool,'{"city":"Paris"}',false);
 const nested={type:'object',properties:{items:{type:'array',items:{type:'object',properties:{value:{enum:['héllo','☃']}},required:['value'],additionalProperties:false},minItems:1,maxItems:2}},required:['items'],additionalProperties:false};
 await check('nested array Unicode valid',nested,'{"items":[{"value":"héllo"},{"value":"☃"}]}',true);
 await check('nested array maxItems rejected',nested,'{"items":[{"value":"héllo"},{"value":"héllo"},{"value":"héllo"}]}',false);
 const features=[
  ['minimum/maximum',{type:'number',minimum:42,maximum:43},'42.5','99'],
  ['minLength/maxLength',{type:'string',minLength:2,maxLength:3},'"AB"','"ABCDE"'],
  ['pattern',{type:'string',pattern:'^[A-Z]{2}$'},'"AB"','"ab"'],
  ['multipleOf',{type:'integer',multipleOf:3},'6','7'],
  ['anyOf',{anyOf:[{const:'a'},{type:'integer',minimum:2,maximum:3}]},'"a"','true'],
  ['allOf',{allOf:[{type:'integer',minimum:2},{maximum:3}]},'2','4'],
  ['not',{type:'string',not:{const:'bad'}},'"good"','"bad"'],
  ['default additionalProperties allowed',{type:'object',properties:{value:{type:'string'}},required:['value']},'{"value":"ok","extra":1}', '{"extra":1}']
 ];
 for(const[name,schema,yes,no]of features){await check(name+' valid',schema,yes,true);await check(name+' invalid',schema,no,false)}
 // Rollback and independent replay forks use public API only.
 const choice={type:'object',properties:{moveId:{enum:['b6-a5','d6-c5']}},required:['moveId'],additionalProperties:false};const cg=await compile(choice),m=await x.GrammarMatcher.createGrammarMatcher(cg,[EOS]);const prefix=encoder.encode('{"moveId":"');for(const b of prefix)m.acceptToken(b);const before=(await m.getNextTokenBitmask()).slice();const suffix=encoder.encode('b6-a5"}');for(const b of suffix)m.acceptToken(b);m.rollBack(suffix.length);const after=await m.getNextTokenBitmask();report.results.push({name:'rollback restores exact mask',pass:before.length===after.length&&before.every((v,i)=>v===after[i]),maxRollback:m.getMaxRollbackTokens()});
 const clone=await x.GrammarMatcher.createGrammarMatcher(cg,[EOS]);for(const b of prefix)clone.acceptToken(b);for(const b of encoder.encode('d6-c5"}'))clone.acceptToken(b);for(const b of suffix)m.acceptToken(b);report.results.push({name:'replay fork independence',pass:allowed(await m.getNextTokenBitmask(),EOS)&&allowed(await clone.getNextTokenBitmask(),EOS)});clone.dispose();m.dispose();cg.dispose();
 // Matching CPU timings, no LLM/model inference.
 const unbounded=await compile({type:'string'});report.performance.replay=[];
 for(const length of[64,512]){const accepted=encoder.encode('"'+'a'.repeat(length-1));const timings=[];for(let run=0;run<5;run++){const begin=performance.now();const fork=await x.GrammarMatcher.createGrammarMatcher(unbounded,[EOS]);for(const b of accepted)fork.acceptToken(b);await fork.getNextTokenBitmask();timings.push(performance.now()-begin);fork.dispose()}report.performance.replay.push({acceptedTokens:length,medianMs:median(timings),samples:timings})}
 const maskTimes=[];const perf=await x.GrammarMatcher.createGrammarMatcher(unbounded,[EOS]);for(let i=0;i<30;i++){const begin=performance.now();await perf.getNextTokenBitmask();maskTimes.push(performance.now()-begin)}report.performance.byteMaskCachedMedianMs=median(maskTimes);perf.dispose();unbounded.dispose();
 if(hf){const entries=Object.entries(hf.model.vocab),size=Math.max(entries.reduce((max,[,id])=>Math.max(max,id),-1),hf.added_tokens.reduce((max,t)=>Math.max(max,t.id),-1))+1;const tokens=Array(size).fill('');for(const[token,id]of entries)tokens[id]=token;for(const t of hf.added_tokens)tokens[t.id]=t.content;const eos=hf.added_tokens.find(t=>t.content==='<|im_end|>').id;at=performance.now();const hi=await x.TokenizerInfo.createTokenizerInfo(tokens,'byte_level',false,size,[eos]);const hc=await x.GrammarCompiler.createGrammarCompiler(hi,true);report.performance.hfTokenizerInitMs=performance.now()-at;at=performance.now();const hg=await hc.compileJSONSchema(JSON.stringify(schemaFor('Paris</think>Paris <think>tag</think> héllo 👑')),false,-1,[',',':'],false);report.performance.hfCompileMs=performance.now()-at;const hm=await x.GrammarMatcher.createGrammarMatcher(hg,[eos]);report.hf={vocabSize:hi.getVocabSize(),eos,maskType:(await hm.getNextTokenBitmask()).constructor.name};const hmTimes=[];for(let i=0;i<20;i++){at=performance.now();await hm.getNextTokenBitmask();hmTimes.push(performance.now()-at)}report.performance.hfMaskMedianMs=median(hmTimes);hm.dispose();hg.dispose();
 if(hfEncode){report.hf.literalChecks=[];for(const value of ['Paris</think>Paris','Paris</think>Paris <think>tag</think> héllo 👑']){const raw=canonical({value}),ids=hfEncode(raw),g=await hc.compileJSONSchema(JSON.stringify(schemaFor(value)),false,-1,[',',':'],false),m=await x.GrammarMatcher.createGrammarMatcher(g,[eos]);let failed=null;const times=[];for(const id of ids){const begin=performance.now(),mask=await m.getNextTokenBitmask();times.push(performance.now()-begin);if(!allowed(mask,id)||!m.acceptToken(id)){failed=id;break}}const finalMask=await m.getNextTokenBitmask();report.hf.literalChecks.push({value,raw,tokenCount:ids.length,accepted:failed===null,complete:failed===null&&allowed(finalMask,eos),failedTokenId:failed,maskMedianMs:median(times),maskMaxMs:Math.max(...times),tokens:ids});m.dispose();g.dispose()}}
 hc.dispose();hi.dispose()}
 compiler.dispose();info.dispose();report.memory={before:memBefore,after:memory(),scope:'whole Node process incl application/JIT/WASM; not isolated live grammar memory; WASM heap need not shrink after disposal'};report.summary={passed:report.results.filter(r=>r.pass&&!r.lexical).length,failed:report.results.filter(r=>!r.pass&&!r.lexical).length,lexicalRestrictions:report.results.filter(r=>r.lexical&&!r.pass).map(r=>r.name)};report.finishedAt=new Date().toISOString();return report;
}
