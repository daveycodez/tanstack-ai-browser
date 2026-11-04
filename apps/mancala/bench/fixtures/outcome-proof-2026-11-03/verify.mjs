import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { gzipSync, gunzipSync } from "node:zlib"
import { createGame, legalMoves, sow, applyMove } from "../../../src/lib/mancala.ts"
import { buildMovePrompt, SHARED_PROMPT_VERSION } from "../../../src/lib/shared-prompt.ts"
import { solveGameOutcomes } from "../../../src/lib/outcome-proof.ts"
import { CASES, SUITE_VERSION } from "../../cases.ts"
import { terminalMarginValues } from "../../endgame-reference.ts"
const dir=path.dirname(fileURLToPath(import.meta.url)),app=path.resolve(dir,"../../..")
const sha=raw=>createHash("sha256").update(raw).digest("hex")
const json=file=>JSON.parse(fs.readFileSync(file,"utf8"))
const ungzip=file=>gunzipSync(fs.readFileSync(file))
const jsonGzip=file=>JSON.parse(ungzip(file).toString("utf8"))
const normalized=value=>JSON.parse(JSON.stringify(value))
const stable=value=>JSON.stringify(sortKeys(value))
function sortKeys(value){if(Array.isArray(value))return value.map(sortKeys);if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortKeys(value[key])]));return value}
const args=process.argv.slice(2),captureAt=args.indexOf("--capture"),capture=captureAt<0?undefined:args[captureAt+1],full=args.includes("--full")
const rootFiles=["src/lib/shared-prompt.ts","src/lib/outcome-proof.ts","src/lib/mancala.ts","src/lib/move-outcomes.ts","src/lib/endgame-ties.ts","src/lib/tie-refinement.ts","src/lib/move-order.ts","src/lib/ai.ts","src/lib/analysis-worker.ts","src/lib/analysis.worker.ts","bench/cases.ts","bench/reference.ts","bench/endgame-reference.ts","src/components/benchmark.tsx",...fs.readdirSync(path.join(app,"src/lib")).filter(name=>/^shared-prompt-v\d+\.ts$/.test(name)).map(name=>`src/lib/${name}`)].sort()
const freezeDir=path.join(dir,"source-freezes"),freezeFile=path.join(freezeDir,SHARED_PROMPT_VERSION+".json")
fs.mkdirSync(freezeDir,{recursive:true})
if(args.includes("--freeze-source")){
 const hashes=Object.fromEntries(rootFiles.map(file=>[file,sha(fs.readFileSync(path.join(app,file)))]))
 const freeze={promptVersion:SHARED_PROMPT_VERSION,suiteVersion:SUITE_VERSION,baseAppCommit:"5b9d15769cfad51c08e79013cb5d9f711256ffb2",frozenHistoricalV14Commit:"3dc6daa1625191529738777b240a99901e491644",scope:"Source fixed for this post-study capture phase; preserves actual bytes before later prompt tuning. No claim that these model runs were part of the closed v14 twelve-game study.",sha256:hashes}
 if(fs.existsSync(freezeFile))assert.deepEqual(json(freezeFile).sha256,hashes,"Same-version source changed: retain the old freeze and create a new prompt version")
 else fs.writeFileSync(freezeFile,JSON.stringify(freeze,null,2)+"\n")
 for(const file of rootFiles){const target=path.join(freezeDir,SHARED_PROMPT_VERSION,file+".txt"),raw=fs.readFileSync(path.join(app,file));fs.mkdirSync(path.dirname(target),{recursive:true});if(fs.existsSync(target))assert.deepEqual(fs.readFileSync(target),raw);else fs.writeFileSync(target,raw)}
}
assert.ok(fs.existsSync(freezeFile),`Freeze current ${SHARED_PROMPT_VERSION} source before archiving reports`)
const freeze=json(freezeFile)
for(const[file,expected]of Object.entries(freeze.sha256))assert.equal(sha(fs.readFileSync(path.join(app,file))),expected,`Current capture source: ${file}`)
const fingerprint=sha(Buffer.from(stable({source:freeze.sha256,verifier:sha(fs.readFileSync(fileURLToPath(import.meta.url)))})))
const reportsDir=path.join(dir,"reports");fs.mkdirSync(reportsDir,{recursive:true})
if(capture)for(const name of fs.readdirSync(capture).filter(name=>name.endsWith(".json"))){const raw=fs.readFileSync(path.join(capture,name)),report=JSON.parse(raw);if(!Array.isArray(report.results)||!report.config||!report.summary)continue;const target=path.join(reportsDir,name+".gz");if(fs.existsSync(target))assert.deepEqual(ungzip(target),raw,`Original report changed: ${name}`);else fs.writeFileSync(target,gzipSync(raw))}
const cacheFile=path.join(dir,"verification-cache.json"),previous=fs.existsSync(cacheFile)?json(cacheFile):{},cache=previous.fingerprint===fingerprint?previous:{fingerprint,inputs:{},proofs:false}
let rebuiltInputs=0,cachedInputs=0
const candidates=json(path.join(dir,"candidate-proofs.json")),review=jsonGzip(path.join(dir,"matched12-lfm3-blunders-review.json.gz")),compat=jsonGzip(path.join(dir,"matched12-wdl-21case-compatibility.json.gz"))
assert.equal(candidates.length,2);assert.equal(CASES.length,23);assert.equal(SUITE_VERSION,"mancala-tactics-v6")
// candidate-proofs is the compact immutable subset; review adds classification and diagnostics.
assert.equal(candidates.length,review.recommendedNewCases.length)
for(const candidate of candidates){const detailed=review.recommendedNewCases.find(row=>row.game===candidate.game&&row.move===candidate.move);assert.ok(detailed);for(const field of Object.keys(candidate))assert.deepEqual(candidate[field],detailed[field],`Candidate proof field ${candidate.game}/${candidate.move}/${field}`)}
assert.equal(compat.rows.length,21)
for(const row of compat.rows){const current=CASES.find(testCase=>testCase.id===row.id);assert.ok(current);for(const field of["board","expectedPits","objective","partition"])assert.deepEqual(current[field],row[field],`${row.id}: old grading unchanged`)}
const ids=["matched-win-over-three-seed-capture","matched-win-over-draw-and-capture"]
function permutations(list){return list.length?list.flatMap((value,index)=>permutations([...list.slice(0,index),...list.slice(index+1)]).map(rest=>[value,...rest])):[[]]}
if(full||!cache.proofs){
 const proofs=[]
 for(const[index,candidate]of candidates.entries()){
  const fixture=CASES.find(testCase=>testCase.id===ids[index]);assert.ok(fixture);assert.deepEqual(fixture.board,candidate.before);assert.deepEqual(fixture.expectedPits,candidate.expectedPits);assert.equal(fixture.objective,"best-final-margin")
  const gameFile=path.join(dir,"../equal-guidance-2026-11-03/games",`game-${String(candidate.game).padStart(2,"0")}`,"game.json.gz"),gameRaw=ungzip(gameFile),actualLog=JSON.parse(gameRaw)
  const judged=review.games.find(game=>game.game===candidate.game);assert.equal(sha(gameRaw),judged.sourceSha256)
  let reached={...createGame(),turn:actualLog.startingSide}
  assert.equal(candidate.opening.length,candidate.move-1)
  for(const[index,move]of candidate.opening.entries()){const logged=actualLog.moves[index],side=logged.player==="human"?"human":"ai",pit=side==="human"?logged.pit-1:logged.pit+6;assert.equal(move.side,side);assert.equal(move.pit,pit);assert.equal(reached.turn,side);reached=applyMove(reached,pit)}
  assert.deepEqual(reached.board,candidate.before);assert.equal(reached.turn,"ai");assert.equal(actualLog.moves[candidate.move-1].pit+6,candidate.chosenPit)
  const values=terminalMarginValues(candidate.before);assert.deepEqual(values,candidate.values);const best=Math.max(...values.map(row=>row.value));assert.deepEqual(values.filter(row=>row.value===best).map(row=>row.pit),candidate.expectedPits)
  for(const line of candidate.lines){let position={...reached,history:[]};assert.equal(line.line[0].pit,line.root);for(const step of line.line){assert.equal(position.turn,step.side);assert.equal(position.board[step.pit],step.seeds);const next=sow(position.board,position.turn,step.pit);assert.equal(next.captured,step.captured);assert.equal(next.extraTurn,step.extraTurn);assert.deepEqual(next.board,step.boardAfter);position=applyMove(position,step.pit)}assert.notEqual(position.status,"playing");assert.equal(position.board[13],line.finalAI);assert.equal(position.board[6],line.finalHuman);assert.equal(position.board[13]-position.board[6],values.find(row=>row.pit===line.root).value)}
  const orders=[]
  for(const order of permutations(legalMoves(reached.board,"ai"))){const old=buildMovePrompt(reached,order,"shared-v14"),current=buildMovePrompt(reached,order,"shared-v15"),outcomes=solveGameOutcomes(reached,order);assert.equal(old.finalComparison.complete,false);assert.equal(old.finalComparison.reason,"node-limit");assert.deepEqual(old.priorityPits,[11]);assert.equal(old.choices.find(choice=>choice.label===old.recommendedAction).id,11);assert.equal(outcomes.complete,true);assert.deepEqual(outcomes.bestPits,[10]);assert.ok(outcomes.nodes<=1_000_000&&outcomes.maxTableEntriesUsed<=75_000);assert.deepEqual(current.priorityPits,[10]);assert.equal(current.choices.find(choice=>choice.label===current.recommendedAction).id,10);assert.deepEqual(current.choices.map(choice=>[choice.id,choice.label]),old.choices.map(choice=>[choice.id,choice.label]));orders.push({order,oldRecommendedPit:11,currentRecommendedPit:10,outcomeProofNodes:outcomes.nodes,maxTableEntriesUsed:outcomes.maxTableEntriesUsed,classes:outcomes.moves})}
  proofs.push({caseId:fixture.id,game:candidate.game,move:candidate.move,sourceGameRawSha256:sha(gameRaw),board:candidate.before,actualChosenPit:candidate.chosenPit,expectedPits:candidate.expectedPits,terminalValues:values,nodeOracleGlobalCap:5_000_000,recordedInstrumentedNodeVisits:candidate.nodeReferenceStats.nodes,fullScoreOracleVerified:true,recordedLinesReplayVerified:true,allSixOrdersVerified:orders})
 }
 fs.writeFileSync(path.join(dir,"proof-verification.json"),JSON.stringify({scope:"Reachable recorded positions; separate full-margin five-million-visit oracle; continuation replays; all six legal presentation orders under actual v14 and v15 source. Production outcome proof classifies W/D/L, not final scores.",fingerprint,proofs},null,2)+"\n");cache.proofs=true
}
const reports=[]
for(const name of fs.readdirSync(reportsDir).filter(name=>name.endsWith(".json.gz")).sort()){
 const compressed=fs.readFileSync(path.join(reportsDir,name)),raw=gunzipSync(compressed),report=JSON.parse(raw)
 assert.equal(report.suiteVersion,SUITE_VERSION,name);assert.equal(report.config.sampling,"model defaults",name);assert.equal(typeof report.config.opponent.thinking,"boolean",name);const expectedReasoning=report.config.opponent.thinking?(["prompt-api","apple-foundationmodel"].includes(report.config.opponent.model)?"emulated-working-notes":"native"):"off";assert.equal(report.config.reasoningMode,expectedReasoning,name);assert.equal(report.results.length,report.summary.total,name)
 assert.equal(new Set(report.config.caseIds).size,report.config.caseIds.length,`${name}: distinct requested cases`)
 for(const id of report.config.caseIds)assert.ok(CASES.some(fixture=>fixture.id===id),`${name}: actual suite case`)
 const expectedTrials=report.config.caseIds.length*report.config.repetitions;assert.ok(report.partial?report.results.length<=expectedTrials:report.results.length===expectedTrials,name)
 const slots=new Set(report.results.map(row=>`${row.caseId}:${row.repetition}`));assert.equal(slots.size,report.results.length,`${name}: no duplicate case/repetition`)
 if(!report.partial)for(const id of report.config.caseIds)for(let repetition=1;repetition<=report.config.repetitions;repetition++)assert.ok(slots.has(`${id}:${repetition}`),`${name}: every requested case/repetition present`)
 let legalCount=0,scored=0,passed=0,followed=0
 for(const row of report.results){
  const key=`${name}/${row.caseId}/${row.repetition}`,fixture=CASES.find(testCase=>testCase.id===row.caseId);assert.ok(fixture,key);assert.deepEqual(row.position.board,fixture.board,key);assert.deepEqual(row.expectedPits,fixture.expectedPits,key)
  const legal=legalMoves(row.position.board,"ai");assert.deepEqual(row.order.slice().sort((a,b)=>a-b),legal.slice().sort((a,b)=>a-b),`${key}: every legal choice`)
  if(row.input){const inputHash=sha(Buffer.from(stable(row.input)));if(!full&&cache.inputs[inputHash]===true)cachedInputs++;else{const expected=normalized(buildMovePrompt(row.position,row.order,report.promptVersion));assert.equal(row.input.systemPrompt,expected.systemPrompt,`${key}: system`);assert.equal(row.input.prompt,expected.prompt,`${key}: user prompt`);assert.deepEqual(row.input.choices,expected.choices,`${key}: choices`);assert.deepEqual(row.input,expected,`${key}: full serialized input`);cache.inputs[inputHash]=true;rebuiltInputs++}assert.equal(row.input.version,report.promptVersion,key)}else assert.ok(row.error,`${key}: missing input requires recorded error`)
  const valid=legal.includes(row.pit),pass=fixture.expectedPits===null?null:valid&&fixture.expectedPits.includes(row.pit);assert.equal(row.legal,valid,key);assert.equal(row.passed,pass,key)
  if(valid){legalCount++;const selected=row.input.choices.find(choice=>choice.id===row.pit);assert.ok(selected,key);const answer=JSON.parse(row.rawAnswer);assert.deepEqual(Object.keys(answer),["pit"],`${key}: strict raw answer`);assert.equal(answer.pit,selected.label,`${key}: actual raw model answer`);if(answer.pit===row.input.recommendedAction)followed++}
  if(pass!==null)scored++;if(pass===true)passed++
 }
 assert.equal(report.summary.legal,legalCount,name);assert.equal(report.summary.scored,scored,name);assert.equal(report.summary.passed,passed,name)
 reports.push({file:`reports/${name}`,rawSha256:sha(raw),gzipSha256:sha(compressed),promptVersion:report.promptVersion,suiteVersion:report.suiteVersion,startedAt:report.startedAt,finishedAt:report.finishedAt,config:report.config,partial:report.partial,summary:report.summary,followedRecommendation:followed,allPositions:report.config.caseIds.length===23&&new Set(report.config.caseIds).size===23,misses:report.results.filter(row=>row.passed===false||row.error).map(row=>({caseId:row.caseId,repetition:row.repetition,pit:row.pit,expectedPits:row.expectedPits,error:row.error})),rows:report.results.map(row=>({caseId:row.caseId,repetition:row.repetition,order:row.order,fullInput:row.input??null,modelInput:row.input?{systemPrompt:row.input.systemPrompt,prompt:row.input.prompt,choices:row.input.choices,outputSchema:{type:"object",properties:{pit:{type:"string",enum:row.input.choices.map(choice=>choice.label)}},required:["pit"],additionalProperties:false}}:null}))})
}
const fullRuns=reports.filter(report=>report.allPositions&&!report.partial&&!report.config.opponent.thinking),crossModel=[]
for(const version of [...new Set(fullRuns.map(report=>report.promptVersion))]){
 const versionRuns=fullRuns.filter(report=>report.promptVersion===version)
 if(new Set(versionRuns.map(report=>report.config.opponent.model)).size<2)continue
 const reference=versionRuns[0]
 for(const compared of versionRuns.slice(1)){
  const comparisons=[]
  for(const row of reference.rows){const other=compared.rows.find(other=>other.caseId===row.caseId&&other.repetition===row.repetition);assert.ok(other,`${version}: matching case/repetition`);assert.deepEqual(other.order,row.order,`${version}: same presentation order`);assert.deepEqual(other.modelInput,row.modelInput,`${version}/${row.caseId}/${row.repetition}: model-agnostic system/user/choices/schema`);assert.deepEqual(other.fullInput,row.fullInput,`${version}/${row.caseId}/${row.repetition}: complete deterministic input`);comparisons.push([row.caseId,row.repetition])}
  crossModel.push({promptVersion:version,reference:reference.file,compared:compared.file,verifiedCaseRepetitions:comparisons.length,systemPromptPositionPromptAllChoicesExactlyEqual:true,orderedLegalOutputSchemaExactlyEqual:true,completeSerializedInputExactlyEqual:true})
 }
}
const modelOrder=["LiquidAI/LFM3-1.7B-GGUF","prompt-api","unsloth/Qwen3.5-2B-GGUF"]
const finalGoals=modelOrder.map(model=>fullRuns.filter(report=>report.promptVersion===SHARED_PROMPT_VERSION&&report.config.opponent.model===model&&report.config.repetitions===2&&report.summary.total===46&&report.summary.scored===40&&report.summary.passed===40&&report.summary.legal===46).sort((a,b)=>Date.parse(b.finishedAt)-Date.parse(a.finishedAt))[0]).filter(Boolean)
let sequenceVerified=false
if(finalGoals.length===3){assert.ok(Date.parse(finalGoals[0].finishedAt)<=Date.parse(finalGoals[1].startedAt),"LFM complete before Nano goal run");assert.ok(Date.parse(finalGoals[1].finishedAt)<=Date.parse(finalGoals[2].startedAt),"Nano complete before Qwen goal run");sequenceVerified=true}
const proofImages=fs.readdirSync(dir).filter(name=>name.endsWith(".jpg")).sort().map(file=>({file,sha256:sha(fs.readFileSync(path.join(dir,file)))}))
for(const[file,expected]of Object.entries(freeze.sha256))assert.equal(sha(fs.readFileSync(path.join(app,file))),expected,`Source remained fixed through verification: ${file}`)
const summary={schemaVersion:1,currentPromptVersion:SHARED_PROMPT_VERSION,suiteVersion:SUITE_VERSION,sourceFreeze:`source-freezes/${SHARED_PROMPT_VERSION}.json`,currentSourceHashesVerified:true,proofsVerified:true,verifiedReports:reports.length,verifiedTrials:reports.reduce((sum,report)=>sum+report.summary.total,0),verification:{fullRebuild:full,rebuiltInputs,cachedInputs,fingerprint},suite:{positions:23,calibrationPositions:20,scoredCalibration:17,neutralDiagnostics:3,holdoutPositions:3,gradedObjectives:20,twoRepetitionFullRun:{trials:46,scored:40,neutral:6}},reports:reports.map(({rows,...report})=>report),crossModel,goal:{allThreePassed:finalGoals.length===3,thinking:false,requiredOrder:modelOrder,sequenceVerified,reports:finalGoals.map(report=>report.file),perModel:{positions:23,gradedObjectives:20,neutralPositions:3,repetitions:2,objectivePasses:40,legalReplies:46}},proofImages,sampleSeparation:"The completed twelve-game equal-guidance study used frozen v14 and remains unchanged. These are separate post-study v15 (or later) tactical model evaluations; no improved full-game win-rate claim follows from them."}
fs.writeFileSync(cacheFile,JSON.stringify(cache,null,2)+"\n");fs.writeFileSync(path.join(dir,"summary.json"),JSON.stringify(summary,null,2)+"\n")
console.log(JSON.stringify({source:SHARED_PROMPT_VERSION,reports:reports.length,trials:summary.verifiedTrials,rebuiltInputs,cachedInputs,crossModelComparisons:crossModel.length,results:reports.map(report=>({file:report.file,version:report.promptVersion,model:report.config.opponent.model,passed:report.summary.passed,scored:report.summary.scored,legal:report.summary.legal,total:report.summary.total,partial:report.partial}))}))
