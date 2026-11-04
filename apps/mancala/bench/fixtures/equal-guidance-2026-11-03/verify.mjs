import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { gzipSync, gunzipSync } from "node:zlib"
import { createGame, legalMoves, sow, applyMove } from "../../../src/lib/mancala.ts"
import { buildMovePrompt } from "../../../src/lib/shared-prompt.ts"
import { orderMovesForGame } from "../../../src/lib/move-order.ts"

const dir = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(dir, "../../..")
const sha = bytes => createHash("sha256").update(bytes).digest("hex")
const normalized = value => JSON.parse(JSON.stringify(value))
const readJSON = file => JSON.parse(fs.readFileSync(file, "utf8"))
const rawGzip = file => gunzipSync(fs.readFileSync(file))
const readGzip = file => JSON.parse(rawGzip(file).toString("utf8"))
const rotate = board => [...board.slice(7), ...board.slice(0,7)]
const args = process.argv.slice(2), historical = args.includes("--historical"), full = args.includes("--full") || historical
const captureAt = args.indexOf("--capture"), capture = captureAt < 0 ? undefined : args[captureAt+1]
if (captureAt >= 0) assert.ok(capture && !capture.startsWith("--"), "Give an explicit capture directory")
const manifestRaw = fs.readFileSync(path.join(dir,"manifest.json")), manifest = JSON.parse(manifestRaw)
assert.equal(manifest.plannedGames,12)
assert.equal(manifest.schedule.length,12)
assert.equal(manifest.promptVersion,"shared-v14")
assert.equal(new Set(manifest.schedule.map(row=>row.humanSessionId)).size,12)
for (const [index,row] of manifest.schedule.entries()) {
  assert.equal(row.game,index+1)
  assert.equal(row.startingSide,index%2 ? "ai" : "human")
  assert.equal(row.firstPlayer,index%2 ? "LFM3" : "Sol")
  assert.ok(row.humanSessionId)
}
const frozenFiles={...manifest.engineSha256,...manifest.starterUiSha256},runtimeHashes={},sourceDifferences=[]
const sourceSnapshot=readJSON(path.join(dir,"frozen-v14-source/snapshot-manifest.json"))
assert.equal(sourceSnapshot.manifestSha256,sha(manifestRaw),"Frozen source snapshot manifest")
assert.equal(sourceSnapshot.files.length,Object.keys(frozenFiles).length)
for (const [file,expected] of Object.entries(frozenFiles)) {
  const snapshot=path.join(dir,"frozen-v14-source",file+".txt")
  assert.equal(sha(fs.readFileSync(snapshot)),expected,`Original source snapshot: ${file}`)
  const current=sha(fs.readFileSync(path.join(app,file)))
  runtimeHashes[file]=current
  if(current!==expected)sourceDifferences.push(file)
  if(!historical)assert.equal(current,expected,`Frozen current source: ${file}`)
}
if(historical) {
  assert.equal(capture,undefined,"Historical mode verifies a closed archive; no new game imports")
  for(const plan of manifest.schedule)assert.ok(fs.existsSync(path.join(dir,"games",`game-${String(plan.game).padStart(2,"0")}`,"game.json.gz")),"Historical mode requires all twelve archived games")
  const originalBuilder=manifest.engineSha256["src/lib/shared-prompt.ts"]
  const selected=runtimeHashes["src/lib/shared-prompt.ts"]===originalBuilder?path.join(app,"src/lib/shared-prompt.ts"):path.join(app,"src/lib/shared-prompt-v14.ts")
  assert.equal(sha(fs.readFileSync(selected)),originalBuilder,"Byte-identical selectable historical v14 builder")
  assert.equal(runtimeHashes["src/lib/mancala.ts"],manifest.engineSha256["src/lib/mancala.ts"],"Canonical rules unchanged for historical replay")
}
assert.equal(sha(fs.readFileSync(path.join(dir,"guidance-helper.mjs"))),manifest.guidanceHelperSha256,"Exact helper bytes")
const ordering = readJSON(path.join(dir,"ordering-provenance.json"))
assert.equal(ordering.analysisSourceCommit,manifest.analysisSourceCommit)
assert.equal(sha(fs.readFileSync(path.join(app,ordering.file))),ordering.sha256,"Committed ordering policy")
const rotationValidation = readJSON(path.join(dir,"rotation-validation.json"))
assert.equal(rotationValidation.rotationVerified,true)
assert.equal(rotationValidation.transitions,325)
assert.equal(rotationValidation.guidanceHelperSha256,manifest.guidanceHelperSha256)
const fingerprint = sha(Buffer.from(JSON.stringify({manifest:sha(manifestRaw),ordering:ordering.sha256,helper:manifest.guidanceHelperSha256,verifier:sha(fs.readFileSync(fileURLToPath(import.meta.url))),historical,runtimeHashes})))
const cacheFile = path.join(dir,"verification-cache.json")
const previousCache = fs.existsSync(cacheFile) ? readJSON(cacheFile) : {}
const inputCache = previousCache.fingerprint===fingerprint ? previousCache.inputs ?? {} : {}
let rebuiltInputs=0,cachedInputs=0,rotationTransitions=0

function archive(source,destination) {
  const raw = fs.readFileSync(source)
  fs.mkdirSync(path.dirname(destination),{recursive:true})
  if (fs.existsSync(destination)) assert.deepEqual(rawGzip(destination),raw,`Original capture changed: ${destination}`)
  else { const temporary=destination+".tmp";fs.writeFileSync(temporary,gzipSync(raw));fs.renameSync(temporary,destination) }
}
if (capture) {
  assert.deepEqual(fs.readFileSync(path.join(capture,"manifest.json")),manifestRaw,"Schedule bytes changed after assignment")
  for (const planned of manifest.schedule) {
    const name=`game-${String(planned.game).padStart(2,"0")}`,source=path.join(capture,name),target=path.join(dir,"games",name)
    if (!["game.json","result.jpg","decisions.json"].every(file=>fs.existsSync(path.join(source,file)))) continue
    const log=readJSON(path.join(source,"game.json"))
    if (!Array.isArray(log.moves)||!log.score||!log.winner||log.partial===true) continue
    const decisions=readJSON(path.join(source,"decisions.json"))
    if(planned.game===1&&fs.existsSync(path.join(dir,"logger-recovery/recovery-provenance.json"))) {
      const provenance=readJSON(path.join(dir,"logger-recovery/recovery-provenance.json"))
      assert.equal(sha(fs.readFileSync(path.join(source,"game.json"))),provenance.sourceGame1CompletionRawSha256,`${name}: immutable completion snapshot`)
      assert.equal(sha(fs.readFileSync(path.join(source,"decisions.json"))),provenance.sourceSpilloverRawSha256,`${name}: original spillover log`)
      assert.equal(log.decisions.length,log.moves.filter(move=>move.player==="human").length)
      assert.deepEqual(decisions.slice(0,log.decisions.length),log.decisions)
    } else assert.equal(decisions.length,log.moves.filter(move=>move.player==="human").length,`${name}: complete Human decisions`)
    archive(path.join(source,"game.json"),path.join(target,"game.json.gz"))
    archive(path.join(source,"decisions.json"),path.join(target,"decisions.json.gz"))
    for(const file of fs.readdirSync(source).filter(file=>/^decisions\.pending.*\.json$/.test(file)))archive(path.join(source,file),path.join(target,"instrumentation",file+".gz"))
    for (const file of fs.readdirSync(path.join(source,"guidance")).filter(file=>/^turn-\d+\.json$/.test(file)))
      archive(path.join(source,"guidance",file),path.join(target,"guidance",file+".gz"))
    const proof=fs.readFileSync(path.join(source,"result.jpg")),destination=path.join(target,"result.jpg")
    if (fs.existsSync(destination)) assert.deepEqual(fs.readFileSync(destination),proof,`${name}: proof changed`)
    else fs.writeFileSync(destination,proof)
  }
}

function parseHistory(history) {
  return history.map(raw=>{
    const lines=raw.split("\n"),actor=lines[1]
    assert.ok(["You","Opponent"].includes(actor))
    return {number:Number(lines[0]),player:actor==="You"?"human":"lfm",pit:Number(/^Pit (\d+)$/.exec(lines[2])?.[1]),seeds:Number(/(\d+) seeds?/.exec(lines[3])?.[1]),captured:Number(/captured (\d+)/.exec(lines[3])?.[1]??0),extraTurn:lines.includes("Go again")}
  }).sort((a,b)=>a.number-b.number)
}
function checkDOMBoard(log,board,label) {
  if(log.humanStore!==undefined)assert.equal(board[6],log.humanStore,`${label}: explicit Human store`)
  if(log.lfmStore!==undefined)assert.equal(board[13],log.lfmStore,`${label}: explicit LFM store`)
  if(log.pitCounts){assert.equal(log.pitCounts.length,12);assert.ok(log.pitCounts.every(n=>n===0),`${label}: terminal DOM pits`)}
  if (log.pits) for (const pit of log.pits) {
    const match=/^(Opponent’s|Your) pit (\d+), (\d+) seeds?$/.exec(pit.label)
    assert.ok(match,`${label}: pit label`)
    const index=match[1]==="Your"?Number(match[2])-1:Number(match[2])+6
    assert.equal(board[index],Number(match[3]),`${label}: DOM pit${index}`)
  }
  if (log.stores) for (const store of log.stores) {
    const match=/^(Opponent’s|Your) store: (\d+) seeds?$/.exec(store)
    assert.ok(match,`${label}: store label`)
    assert.equal(board[match[1]==="Your"?6:13],Number(match[2]),`${label}: DOM store`)
  }
}
function replay(moves,starter,label) {
  let game={...createGame(),turn:starter},terminalSweep={human:0,ai:0}
  const humanTurns=[]
  assert.ok(moves.length,`${label}: nonempty ledger`)
  assert.equal(moves[0].player,starter==="human"?"human":"lfm",`${label}: actual first actor`)
  for (const [index,move] of moves.entries()) {
    const key=`${label}/move${index+1}`
    assert.equal(move.number,index+1,`${key}: number`)
    assert.ok(["human","lfm"].includes(move.player),`${key}: actor`)
    const side=move.player==="human"?"human":"ai",pit=side==="human"?move.pit-1:move.pit+6
    assert.equal(game.turn,side,`${key}: turn`)
    assert.equal(game.board.reduce((a,b)=>a+b,0),48,`${key}: all seeds before`)
    assert.ok(legalMoves(game.board,side).includes(pit),`${key}: legal pit`)
    assert.equal(game.board[pit],move.seeds,`${key}: seeds`)
    if (side==="human") humanTurns.push({moveNumber:index+1,before:game.board.slice(),move})
    const next=sow(game.board,side,pit)
    assert.equal(next.captured,move.captured,`${key}: capture`)
    assert.equal(next.extraTurn,move.extraTurn,`${key}: bonus`)
    if (move.handoff!==undefined) assert.equal(move.handoff,!next.extraTurn,`${key}: handoff`)
    assert.equal(next.board.reduce((a,b)=>a+b,0),48,`${key}: all seeds after`)
    terminalSweep=next.swept
    game=applyMove(game,pit)
  }
  return {game,humanTurns,terminalSweep}
}
function checkRotation(board,label) {
  for (const pit of legalMoves(board,"human")) {
    const actual=sow(board,"human",pit),mirrored=sow(rotate(board),"ai",pit+7)
    assert.deepEqual(rotate(mirrored.board),actual.board,`${label}: rotation board`)
    assert.equal(mirrored.captured,actual.captured,`${label}: rotation capture`)
    assert.equal(mirrored.extraTurn,actual.extraTurn,`${label}: rotation bonus`)
    assert.equal((mirrored.lastPit+7)%14,actual.lastPit,`${label}: rotation landing`)
    assert.equal(mirrored.turn==="ai"?"human":"ai",actual.turn,`${label}: rotation turn`)
    assert.equal({"ai-won":"human-won","human-won":"ai-won",playing:"playing",draw:"draw"}[mirrored.status],actual.status,`${label}: rotation result`)
    rotationTransitions++
  }
}
function verifyHumanTurns(turns,decisions,folder,sessionId,pilot=false) {
  assert.equal(decisions.length,turns.length,`${folder}: every Human ply has one decision`)
  const checks=[],metadataCaveats=[]
  for (const [index,turn] of turns.entries()) {
    const ordinal=index+1,decision=decisions[index],key=`${folder}/Human${ordinal}`
    assert.equal(decision.humanTurnOrdinal??decision.humanTurn,ordinal,`${key}: ordinal`)
    const expectedName=pilot?`human-turn-${ordinal}.json`:`turn-${String(ordinal).padStart(2,"0")}.json`
    assert.equal(path.basename(decision.inputFile),expectedName,`${key}: exact input file`)
    if(!pilot) {
      const gameFolder=path.basename(folder),number=Number(gameFolder.slice(5))
      assert.equal(path.normalize(decision.inputFile),path.join("/private/tmp/sol-lfm3-matched-12",gameFolder,"guidance",expectedName),`${key}: actual per-game input path`)
      if(decision.gameNumber!==undefined)assert.equal(decision.gameNumber,number,`${key}: decision game number`)
      if(decision.sessionId!==undefined)assert.equal(decision.sessionId,sessionId,`${key}: decision session`)
      if(decision.seeds!==undefined)assert.equal(decision.seeds,turn.move.seeds,`${key}: recorded seed count`)
      if(number>=3||(number===2&&ordinal>=10)) {
        assert.ok(["explicit-game-v1","explicit-game-v2-render-wait","explicit-game-v3-index-wait"].includes(decision.controllerVersion),`${key}: documented guarded controller`)
        assert.equal(decision.executed,true,`${key}: executed, not pending`)
        assert.equal(decision.status,"executed",`${key}: execution status`)
        assert.equal(decision.actualMoveText,turn.move.raw,`${key}: actual newly rendered UI row`)
      }
    }
    const file=path.join(folder,"guidance",expectedName+".gz"),raw=rawGzip(path.join(dir,file)),record=JSON.parse(raw.toString("utf8"))
    const metadataErrors=[]
    if(decision.moveNumber!==turn.moveNumber)metadataErrors.push("moveNumber")
    if(JSON.stringify(decision.actualBoard)!==JSON.stringify(turn.before))metadataErrors.push("actualBoard")
    if(pilot&&metadataErrors.length)metadataCaveats.push({humanTurnOrdinal:ordinal,recordedMoveNumber:decision.moveNumber,derivedMoveNumber:turn.moveNumber,fields:metadataErrors,reason:"Original decisions metadata retained unchanged; mapping derived from nth Human ply and its exact guidance file."})
    else assert.deepEqual(metadataErrors,[],`${key}: raw decisions metadata does not match actual ledger`)
    assert.deepEqual(record.actualBoard,turn.before,`${key}: actual before-board`)
    assert.deepEqual(record.mirroredBoard,rotate(turn.before),`${key}: exact seven-slot rotation`)
    assert.equal(record.actualSide,"human",`${key}: role`)
    assert.equal(record.sessionId,sessionId,`${key}: preassigned session`)
    assert.equal(record.sourceCommit,manifest.analysisSourceCommit,`${key}: analysis commit`)
    assert.deepEqual(record.roleBindings,{AI:"Sol, Human/bottom row",Human:"LFM3, opponent/top row"},`${key}: role bindings`)
    assert.equal(record.uiMapping,"Prompt AI pit N means Your pit N in the game UI",`${key}: UI mapping`)
    const mirror={...createGame(),sessionId,board:rotate(turn.before),turn:"ai"}
    const order=orderMovesForGame(sessionId,legalMoves(mirror.board,"ai"))
    assert.deepEqual(record.order,order,`${key}: production ordering policy`)
    const inputKey=sha(raw)
    if(!full&&inputCache[inputKey]===true)cachedInputs++
    else {
      const input=normalized(buildMovePrompt(mirror,order,"shared-v14"))
      assert.equal(record.input.systemPrompt,input.systemPrompt,`${key}: system prompt`)
      assert.equal(record.input.prompt,input.prompt,`${key}: full position prompt`)
      assert.deepEqual(record.input.choices,input.choices,`${key}: every legal choice`)
      assert.deepEqual(record.input,input,`${key}: complete serialized production input`)
      inputCache[inputKey]=true;rebuiltInputs++
    }
    assert.deepEqual(record.input.choices.map(choice=>choice.id),order,`${key}: complete ordered schema choices`)
    assert.deepEqual(Object.keys(decision.answer),["pit"],`${key}: strict answer schema`)
    const choice=record.input.choices.find(choice=>choice.label===decision.answer.pit)
    assert.ok(choice,`${key}: actual answer must be a legal exact label`)
    assert.equal(choice.id-6,decision.uiPit,`${key}: mirrored choice maps to actual Human UI pit`)
    assert.equal(decision.uiPit,turn.move.pit,`${key}: actual played move; no substitution`)
    checkRotation(turn.before,key)
    checks.push({humanTurnOrdinal:ordinal,moveNumber:turn.moveNumber,file,rawSha256:inputKey,inputSha256:sha(Buffer.from(JSON.stringify(record.input))),chosenLabel:decision.answer.pit,uiPit:decision.uiPit,legalChoices:order.length,forced:order.length===1,followedRecommendation:decision.answer.pit===record.input.recommendedAction})
  }
  const guidanceNames=fs.readdirSync(path.join(dir,folder,"guidance")).filter(file=>file.endsWith(".json.gz"))
  assert.equal(guidanceNames.length,turns.length,`${folder}: no omitted/orphaned guidance records`)
  return {checks,metadataCaveats}
}
function prefixCommit(actual,expected,label) {
  assert.ok(typeof actual==="string"&&/^[a-f0-9]{7,40}$/.test(actual)&&expected.startsWith(actual),label)
}

const pilotLog=readGzip(path.join(dir,"pilot/partial-game.json.gz")),pilotDecisions=readGzip(path.join(dir,"pilot/decisions.json.gz"))
assert.equal(pilotLog.partial,true)
assert.equal(pilotLog.pilotScopeChangedTo12,true)
assert.deepEqual(pilotLog.decisions,pilotDecisions,"Original embedded pilot decisions")
const pilotReplay=replay(parseHistory(pilotLog.history),"human","excluded pilot")
assert.equal(pilotReplay.game.status,"playing")
assert.equal(pilotReplay.game.history.length,11)
assert.equal(pilotReplay.game.board[6],10)
assert.equal(pilotReplay.game.board[13],6)
checkDOMBoard(pilotLog,pilotReplay.game.board,"excluded pilot")
const pilotHuman=verifyHumanTurns(pilotReplay.humanTurns,pilotDecisions,"pilot","matched-human-game-1",true)
assert.deepEqual(pilotHuman.metadataCaveats.map(row=>row.humanTurnOrdinal),[3,4,5],"Known pilot metadata caveat must remain visible")
const pilot={excluded:true,exclusionReason:"User expanded to twelve games after eleven pilot moves; no completed outcome was available or selected.",partial:true,moves:11,provisionalStores:{sol:10,lfm:6},finalOutcome:null,ledgerReplayVerified:true,correctGuidanceInputsVerified:5,metadataCaveat:"Decisions 3–5 retain stale actualBoard and moveNumber metadata from Human turn2. Exact guidance files and nth-Human-ply mapping verify the actual treatment and answers. Originals were not rewritten.",metadataMismatches:pilotHuman.metadataCaveats,humanInputs:pilotHuman.checks,partialFile:"pilot/partial-game.json.gz",partialRawSha256:sha(rawGzip(path.join(dir,"pilot/partial-game.json.gz"))),decisionsRawSha256:sha(rawGzip(path.join(dir,"pilot/decisions.json.gz"))),proof:"pilot/result.jpg",proofSha256:sha(fs.readFileSync(path.join(dir,"pilot/result.jpg")))}
const introductionFile=path.join(dir,"logger-recovery/controller-introduction.json")
if(fs.existsSync(introductionFile)) {
  const introduction=readJSON(introductionFile)
  assert.equal(sha(fs.readFileSync(path.join(dir,"logger-recovery/guarded-controller.txt"))),introduction.guardedControllerSha256,"Exact guarded-controller bytes")
  assert.deepEqual(introduction.introducedAfter,{gameNumber:2,humanTurnOrdinal:9,completedPly:19})
}
const controllerHistoryFile=path.join(dir,"instrumentation/controller-history.json")
if(fs.existsSync(controllerHistoryFile))for(const change of readJSON(controllerHistoryFile).changes)if(change.source)assert.equal(sha(fs.readFileSync(path.join(dir,"instrumentation",change.source))),change.sha256,`Pinned controller ${change.version}`)
const games=[]
for (const planned of manifest.schedule) {
  const folder=`games/game-${String(planned.game).padStart(2,"0")}`,file=path.join(dir,folder,"game.json.gz")
  if(!fs.existsSync(file))continue
  const raw=rawGzip(file),log=JSON.parse(raw.toString("utf8")),decisionRaw=rawGzip(path.join(dir,folder,"decisions.json.gz")),observedDecisions=JSON.parse(decisionRaw.toString("utf8"))
  let decisions=observedDecisions,decisionProvenance={source:"external completion log",metadataRecovery:false}
  if(planned.game>=2) {
    assert.ok(Array.isArray(log.decisions),`${folder}: embedded completion decisions`)
    assert.deepEqual(log.decisions,observedDecisions,`${folder}: explicit disk read matches embedded completion records`)
    assert.equal(log.controllerVersion,"explicit-game-v1",`${folder}: guarded completion controller`)
  }
  const recoveryFile=path.join(dir,"logger-recovery/recovery-provenance.json")
  if(planned.game===1&&fs.existsSync(recoveryFile)) {
    const provenance=readJSON(recoveryFile)
    assert.equal(sha(raw),provenance.sourceGame1CompletionRawSha256)
    assert.equal(sha(decisionRaw),provenance.sourceSpilloverRawSha256)
    assert.equal(observedDecisions.length,37)
    assert.equal(log.decisions.length,28)
    assert.deepEqual(observedDecisions.slice(0,28),log.decisions)
    decisions=log.decisions
    decisionProvenance={source:"Authentic 28 decisions embedded in immutable completed game.json at /decisions",metadataRecovery:false,externalLogContaminatedAfterCompletion:true,observedExternalRecords:37,rawExternalLogRetained:true,reference:"logger-recovery/recovery-provenance.json"}
  }
  if(planned.game===2&&fs.existsSync(recoveryFile)) {
    const provenance=readJSON(recoveryFile),recoveredRaw=rawGzip(path.join(dir,"logger-recovery/decisions.recovered.json.gz")),recovered=JSON.parse(recoveredRaw.toString("utf8"))
    assert.equal(sha(recoveredRaw),provenance.recoveredRawSha256)
    assert.deepEqual(decisions.slice(0,9),recovered,`${folder}: exact recovered prefix`)
    const pause=readGzip(path.join(dir,"logger-recovery/paused-game-02.json.gz")),prefix=parseHistory(pause.history)
    for(const [index,move] of prefix.entries())for(const field of ["number","player","pit","seeds","captured","extraTurn"])assert.equal(log.moves[index][field],move[field],`${folder}: same resumed game before logger repair`)
    decisionProvenance={source:"External game2 log, first nine metadata records explicitly recovered from their actual guidance and paused UI ledger",metadataRecovery:true,recoveredHumanTurns:9,answersAndUiPitsUnchanged:true,rawOriginalRetained:true,reference:"logger-recovery/recovery-provenance.json"}
  }
  assert.equal(log.gameNumber??log.game,planned.game,`${folder}: scheduled game number`)
  assert.equal(log.startingSide,planned.startingSide,`${folder}: declared starter`)
  if(log.firstPlayer)assert.equal(log.firstPlayer,planned.firstPlayer,`${folder}: first-player metadata`)
  assert.ok([14,"shared-v14"].includes(log.promptVersion),`${folder}: prompt version`)
  assert.equal(log.opponentThinking??log.thinking,false,`${folder}: LFM thinking off`)
  assert.equal(log.human,manifest.humanModel,`${folder}: Human model`)
  assert.ok([manifest.opponent,"LFM3-1.7B-GGUF"].includes(log.opponent),`${folder}: opponent`)
  assert.ok(typeof log.sourceCommit==="string"&&[manifest.analysisSourceCommit,manifest.appSourceCommit].some(commit=>log.sourceCommit.length>=7&&commit.startsWith(log.sourceCommit)),`${folder}: recorded source commit`)
  if(log.analysisSourceCommit)prefixCommit(log.analysisSourceCommit,manifest.analysisSourceCommit,`${folder}: analysis commit`)
  if(log.engineSourceCommit)prefixCommit(log.engineSourceCommit,manifest.analysisSourceCommit,`${folder}: engine commit`)
  if(log.appSourceCommit)prefixCommit(log.appSourceCommit,manifest.appSourceCommit,`${folder}: app commit`)
  if(log.humanSessionId)assert.equal(log.humanSessionId,planned.humanSessionId,`${folder}: session metadata`)
  assert.notEqual(log.partial,true,`${folder}: completed outcome only`)
  const replayed=replay(log.moves,planned.startingSide,folder)
  assert.notEqual(replayed.game.status,"playing",`${folder}: terminal`)
  assert.ok(log.moves.every(move=>typeof move.handoff==="boolean"),`${folder}: complete handoff facts`)
  assert.equal(replayed.game.board[6],log.score.human,`${folder}: Human final score`)
  assert.equal(replayed.game.board[13],log.score.lfm,`${folder}: LFM final score`)
  assert.equal(log.score.human+log.score.lfm,48,`${folder}: final seeds`)
  assert.ok(replayed.game.board.every((n,index)=>index===6||index===13||n===0),`${folder}: empty terminal pits`)
  const winner=replayed.game.status==="ai-won"?"lfm":replayed.game.status==="human-won"?"human":"draw"
  assert.equal(log.winner,winner,`${folder}: winner`)
  checkDOMBoard(log,replayed.game.board,folder)
  const instrumentationSnapshots=[]
  const instrumentationDir=path.join(dir,folder,"instrumentation")
  if(fs.existsSync(instrumentationDir))for(const name of fs.readdirSync(instrumentationDir).filter(name=>name.endsWith(".json.gz"))) {
    const originalRaw=rawGzip(path.join(instrumentationDir,name)),original=JSON.parse(originalRaw.toString("utf8"))
    assert.ok(original.length<=decisions.length)
    for(const [index,row]of original.entries()) {
      const actual=decisions[index]
      for(const field of ["gameNumber","humanTurnOrdinal","moveNumber","inputFile","sessionId","actualBoard","answer","uiPit","seeds","recordedAt","controllerVersion"])assert.deepEqual(actual[field],row[field],`${folder}/${name}: immutable choice field ${field}`)
      assert.equal(actual.executed,true)
      assert.equal(actual.status,"executed")
    }
    const pending=original.filter(row=>row.executed===false||row.status==="pending")
    assert.equal(pending.length,1)
    instrumentationSnapshots.push({file:`${folder}/instrumentation/${name}`,rawSha256:sha(originalRaw),pendingHumanOrdinal:pending[0].humanTurnOrdinal,choiceFieldsUnchanged:true,finalExecutionVerified:true})
  }
  const human=verifyHumanTurns(replayed.humanTurns,decisions,folder,planned.humanSessionId)
  assert.deepEqual(human.metadataCaveats,[])
  const proof=path.join(dir,folder,"result.jpg")
  assert.ok(fs.existsSync(proof),`${folder}: final proof`)
  games.push({game:planned.game,startingSide:planned.startingSide,firstPlayer:planned.firstPlayer,actualFirstActor:log.moves[0].player,humanSessionId:planned.humanSessionId,score:{sol:log.score.human,lfm:log.score.lfm},winner:winner==="human"?"sol":winner,moves:log.moves.length,terminalSweep:replayed.terminalSweep,all48SeedsVerified:true,legalReplayVerified:true,humanInputChecks:human.checks,humanDecisions:human.checks.length,forcedHumanTurns:human.checks.filter(row=>row.forced).length,followedRecommendation:human.checks.filter(row=>row.followedRecommendation).length,lfmActualInputBytesVerified:false,decisionProvenance,instrumentationSnapshots,files:{game:`${folder}/game.json.gz`,gameRawSha256:sha(raw),decisions:`${folder}/decisions.json.gz`,decisionsRawSha256:sha(decisionRaw),proof:`${folder}/result.jpg`,proofSha256:sha(fs.readFileSync(proof))}})
}
assert.equal(new Set(games.map(game=>game.game)).size,games.length)
function scoreRows(rows,model,planned) {
  return {planned,played:rows.length,wins:rows.filter(game=>game.winner===model).length,losses:rows.filter(game=>game.winner!==model&&game.winner!=="draw").length,draws:rows.filter(game=>game.winner==="draw").length}
}
const byStarter={solStarts:{planned:6,played:games.filter(game=>game.startingSide==="human").length,solWins:games.filter(game=>game.startingSide==="human"&&game.winner==="sol").length,lfmWins:games.filter(game=>game.startingSide==="human"&&game.winner==="lfm").length,draws:games.filter(game=>game.startingSide==="human"&&game.winner==="draw").length},lfmStarts:{planned:6,played:games.filter(game=>game.startingSide==="ai").length,solWins:games.filter(game=>game.startingSide==="ai"&&game.winner==="sol").length,lfmWins:games.filter(game=>game.startingSide==="ai"&&game.winner==="lfm").length,draws:games.filter(game=>game.startingSide==="ai"&&game.winner==="draw").length}}
const byModelAndOrder={sol:{first:scoreRows(games.filter(game=>game.startingSide==="human"),"sol",6),second:scoreRows(games.filter(game=>game.startingSide==="ai"),"sol",6)},lfm:{first:scoreRows(games.filter(game=>game.startingSide==="ai"),"lfm",6),second:scoreRows(games.filter(game=>game.startingSide==="human"),"lfm",6)}}
const summary={schemaVersion:1,study:manifest.study,manifestSha256:sha(manifestRaw),analysisSourceCommit:manifest.analysisSourceCommit,appSourceCommit:manifest.appSourceCommit,promptVersion:manifest.promptVersion,plannedGames:12,completedGames:games.length,complete:games.length===12,sourceHashesVerified:true,frozenSourceSnapshotsVerified:true,currentSourceMatchesManifest:sourceDifferences.length===0,currentSourceDifferences:sourceDifferences,historicalReplay:historical,helperBytesVerified:true,orderingPolicyVerified:true,verification:{mode:historical?"historical shared-v14 full input rebuild":full?"full input rebuild":"source-and-input-fingerprint cache",builderVersionSelection:manifest.promptVersion,fingerprint,rebuiltInputs,cachedInputs,helperPriorRotationTransitions:325,observedRotationTransitions:rotationTransitions,scope:"Every Human full serialized production input, exact board/rotation/order/session, raw answer label and played move verified. LFM live session IDs and actual per-turn prompt bytes are not captured; only frozen source, protocol metadata and legal game replay are established for that side."},overall:{sol:scoreRows(games,"sol",12),lfm:scoreRows(games,"lfm",12)},byModelAndOrder,byStarter,humanGuidanceTurns:games.reduce((sum,game)=>sum+game.humanDecisions,0),humanFollowedRecommendation:games.reduce((sum,game)=>sum+game.followedRecommendation,0),pilot,games,bookkeepingRecovery:fs.existsSync(path.join(dir,"logger-recovery/recovery-provenance.json"))?{reference:"logger-recovery/recovery-provenance.json",game1DecisionSource:"Authentic embedded completion snapshot, external post-completion spillover retained",game2RecoveredMetadataRecords:9,rawAnswersAndPlayedMovesUnchanged:true}:null,sampleSeparation:"This preregistered alternating-starter equal-guidance experiment excludes the pilot and the earlier three assisted-LFM versus unassisted-Sol games. Both models now receive production recommendations; interfaces, reasoning settings, hidden LFM ordering seeds and game trajectories still differ."}
function resultsMarkdown() {
  const lines=[`**${games.length}/12 completed; ${summary.complete?"series complete":"series in progress"}.** Only completed games enter the counts.`,"", "| Model | Wins | Losses | Draws | Played |", "| --- | --- | --- | --- | --- |"]
  for(const [model,label] of [["sol","GPT-6.1 Sol high"],["lfm","LFM3 GGUF"]]) {
    const row=summary.overall[model];lines.push(`| ${label} | ${row.wins} | ${row.losses} | ${row.draws} | ${row.played}/12 |`)
  }
  lines.push("","| Model / order | Wins | Losses | Draws | Played |","| --- | --- | --- | --- | --- |")
  for(const [model,label] of [["sol","Sol"],["lfm","LFM3"]])for(const order of ["first","second"]) {
    const row=byModelAndOrder[model][order];lines.push(`| ${label} plays ${order} | ${row.wins} | ${row.losses} | ${row.draws} | ${row.played}/6 |`)
  }
  lines.push("","| Assigned starter | Sol wins | LFM3 wins | Draws | Played |","| --- | --- | --- | --- | --- |")
  for(const [key,label] of [["solStarts","Sol starts"],["lfmStarts","LFM3 starts"]]) {const row=byStarter[key];lines.push(`| ${label} | ${row.solWins} | ${row.lfmWins} | ${row.draws} | ${row.played}/6 |`)}
  lines.push("","| Game | First player | Sol seeds | LFM3 seeds | Result | Evidence |","| --- | --- | --- | --- | --- | --- |")
  for(const planned of manifest.schedule) {
    const game=games.find(game=>game.game===planned.game)
    if(!game){lines.push(`| ${planned.game} | ${planned.firstPlayer} | — | — | Pending | — |`);continue}
    const winner=game.winner==="draw"?"Draw":game.winner==="sol"?"Sol win":"LFM3 win"
    lines.push(`| ${game.game} | ${game.firstPlayer} | ${game.score.sol} | ${game.score.lfm} | ${winner} | [Ledger](${game.files.game}), [proof](${game.files.proof}) |`)
  }
  lines.push("",`Completed games contain **${summary.humanGuidanceTurns} verified Human guidance turns**; Sol followed the emitted recommendation on **${summary.humanFollowedRecommendation}/${summary.humanGuidanceTurns}**. Forced single-choice turns are retained and identified in the JSON.`,"",`Latest verification: ${historical?"historical shared-v14 full input rebuild":full?"full input rebuild":"source/input-fingerprint cache"}; ${rebuiltInputs} inputs rebuilt and ${cachedInputs} reused after hash checks. The excluded pilot is never counted in these outcomes.`)
  return lines.join("\n")
}
// Finish strict live-study verification with a second source check, after all rebuilds.
if(!historical)for(const[file,expected]of Object.entries(frozenFiles))assert.equal(sha(fs.readFileSync(path.join(app,file))),expected,`Source remained frozen during verification: ${file}`)
const readmeFile=path.join(dir,"README.md")
if(fs.existsSync(readmeFile))fs.writeFileSync(readmeFile,fs.readFileSync(readmeFile,"utf8").replace(/<!-- results:start -->[\s\S]*?<!-- results:end -->/,`<!-- results:start -->\n${resultsMarkdown()}\n<!-- results:end -->`))
fs.writeFileSync(cacheFile,JSON.stringify({fingerprint,inputs:inputCache},null,2)+"\n")
fs.writeFileSync(path.join(dir,"summary.json"),JSON.stringify(summary,null,2)+"\n")
console.log(JSON.stringify({completedGames:summary.completedGames,plannedGames:12,complete:summary.complete,overall:summary.overall,byModelAndOrder,byStarter,humanGuidanceTurns:summary.humanGuidanceTurns,humanFollowedRecommendation:summary.humanFollowedRecommendation,rebuiltInputs,cachedInputs,pilotMetadataCaveats:pilotHuman.metadataCaveats.map(row=>row.humanTurnOrdinal),sourceHashesVerified:true,currentSourceMatchesManifest:summary.currentSourceMatchesManifest,historicalReplay:historical}))
