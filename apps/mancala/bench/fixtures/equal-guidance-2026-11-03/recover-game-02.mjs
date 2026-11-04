import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { gzipSync, gunzipSync } from "node:zlib"
import { createGame, legalMoves, sow, applyMove } from "../../../src/lib/mancala.ts"
import { buildMovePrompt } from "../../../src/lib/shared-prompt.ts"
import { orderMovesForGame } from "../../../src/lib/move-order.ts"
const dir=path.dirname(fileURLToPath(import.meta.url)),app=path.resolve(dir,"../../.."),capture=process.argv[2]??"/private/tmp/sol-lfm3-matched-12",source=path.join(capture,"game-02"),archive=path.join(dir,"logger-recovery")
const sha=raw=>createHash("sha256").update(raw).digest("hex"),manifest=JSON.parse(fs.readFileSync(path.join(dir,"manifest.json"))),planned=manifest.schedule[1]
for(const[file,hash]of Object.entries({...manifest.engineSha256,...manifest.starterUiSha256}))assert.equal(sha(fs.readFileSync(path.join(app,file))),hash,file)
const spillRaw=fs.readFileSync(path.join(source,"logger-spillover-original.json")),spill=JSON.parse(spillRaw),pauseRaw=fs.readFileSync(path.join(source,"logger-pause-partial.json")),pause=JSON.parse(pauseRaw),completionRaw=fs.readFileSync(path.join(capture,"game-01/game.json")),completion=JSON.parse(completionRaw)
assert.equal(spill.length,37);assert.equal(completion.decisions.length,28);assert.deepEqual(spill.slice(0,28),completion.decisions)
assert.deepEqual(spill.slice(0,33),JSON.parse(gunzipSync(fs.readFileSync(path.join(dir,"anomalies/game-01-decisions-spillover-33.json.gz")))))
assert.equal(pause.partial,true);assert.equal(pause.pausedForDecisionLoggerRepair,true)
const moves=pause.history.map(raw=>{const lines=raw.split("\n");assert.ok(["You","Opponent"].includes(lines[1]));return{number:Number(lines[0]),player:lines[1]==="You"?"human":"lfm",pit:Number(/^Pit (\d+)$/.exec(lines[2])?.[1]),seeds:Number(/(\d+) seeds?/.exec(lines[3])?.[1]),captured:Number(/captured (\d+)/.exec(lines[3])?.[1]??0),extraTurn:lines.includes("Go again")}}).sort((a,b)=>a.number-b.number)
assert.equal(moves.length,19);assert.equal(moves[0].player,"lfm");assert.equal(planned.startingSide,"ai")
let game={...createGame(),turn:"ai"};const human=[]
for(const[index,m]of moves.entries()){
 assert.equal(m.number,index+1);const side=m.player==="human"?"human":"ai",pit=side==="human"?m.pit-1:m.pit+6
 assert.equal(game.turn,side);assert.ok(legalMoves(game.board,side).includes(pit));assert.equal(game.board[pit],m.seeds)
 if(side==="human")human.push({move:m,before:game.board.slice()})
 const next=sow(game.board,side,pit);assert.equal(next.captured,m.captured);assert.equal(next.extraTurn,m.extraTurn);assert.equal(next.board.reduce((a,b)=>a+b,0),48);game=applyMove(game,pit)
}
assert.equal(human.length,9);assert.equal(game.status,"playing");assert.equal(game.board[6],7);assert.equal(game.board[13],15)
fs.mkdirSync(path.join(archive,"guidance"),{recursive:true})
function preserve(raw,file){if(fs.existsSync(file))assert.deepEqual(gunzipSync(fs.readFileSync(file)),raw,file);else fs.writeFileSync(file,gzipSync(raw))}
preserve(spillRaw,path.join(archive,"original-spillover-37.json.gz"));preserve(pauseRaw,path.join(archive,"paused-game-02.json.gz"));preserve(completionRaw,path.join(archive,"game-01-completion.json.gz"))
const proof=fs.readFileSync(path.join(source,"logger-pause-partial.jpg"));fs.writeFileSync(path.join(archive,"paused-game-02.jpg"),proof)
const recovered=[],rows=[]
for(const[index,turn]of human.entries()){
 const ordinal=index+1,originalIndex=28+index,original=spill[originalIndex],file=path.join(source,"guidance",`turn-${String(ordinal).padStart(2,"0")}.json`),raw=fs.readFileSync(file),record=JSON.parse(raw)
 assert.equal(original.humanTurnOrdinal,ordinal);assert.equal(original.moveNumber,turn.move.number);assert.equal(original.uiPit,turn.move.pit)
 assert.deepEqual(record.actualBoard,turn.before);const rotated=[...turn.before.slice(7),...turn.before.slice(0,7)];assert.deepEqual(record.mirroredBoard,rotated)
 assert.equal(record.sessionId,planned.humanSessionId);assert.equal(record.sourceCommit,manifest.analysisSourceCommit);assert.equal(record.actualSide,"human")
 assert.deepEqual(record.roleBindings,{AI:"Sol, Human/bottom row",Human:"LFM3, opponent/top row"})
 const mirrored={...createGame(),board:rotated,turn:"ai",sessionId:planned.humanSessionId},order=orderMovesForGame(planned.humanSessionId,legalMoves(rotated,"ai"))
 assert.deepEqual(record.order,order);const expected=JSON.parse(JSON.stringify(buildMovePrompt(mirrored,order,"shared-v14")));assert.deepEqual(record.input,expected)
 assert.deepEqual(Object.keys(original.answer),["pit"]);const choice=record.input.choices.find(choice=>choice.label===original.answer.pit);assert.ok(choice);assert.equal(choice.id-6,turn.move.pit)
 const corrected={...original,inputFile:file,actualBoard:record.actualBoard.slice(),gameNumber:2};assert.deepEqual(corrected.answer,original.answer);assert.equal(corrected.uiPit,original.uiPit);assert.equal(corrected.moveNumber,original.moveNumber)
 const correctedFields=["inputFile","actualBoard","gameNumber"].filter(field=>JSON.stringify(corrected[field])!==JSON.stringify(original[field]))
 preserve(raw,path.join(archive,"guidance",path.basename(file)+".gz"))
 recovered.push(corrected);rows.push({humanTurnOrdinal:ordinal,moveNumber:turn.move.number,originalArrayIndexZeroBased:originalIndex,originalArrayIndexOneBased:originalIndex+1,originalRowSha256:sha(Buffer.from(JSON.stringify(original))),correctedFields,originalInputFile:original.inputFile,authoritativeInputFile:file,guidanceRawSha256:sha(raw),answerUnchanged:true,uiPitUnchanged:true,moveNumberUnchanged:true,fullInputVerified:true,actualBeforeBoardVerified:true})
}
const recoveredRaw=Buffer.from(JSON.stringify(recovered,null,2)+"\n"),out=path.join(source,"decisions.recovered.json")
fs.writeFileSync(out,recoveredRaw);preserve(recoveredRaw,path.join(archive,"decisions.recovered.json.gz"))
const provenance={schemaVersion:1,reason:"Game2 controller appended nine records to game1 external decisions log and read game1 guidance paths/board metadata. Actual game2 guidance and raw answers remained correct.",method:"Replay actual paused19-move UI ledger from scheduled AI start; map nth Human ply to its exact game2 helper input. Correct only inputFile/actualBoard/gameNumber metadata, never answers, played pits or recorded move numbers.",gameNumber:2,partialAtMove:19,provisionalStores:{sol:7,lfm:15},sourceHashesVerified:true,manifestSha256:sha(fs.readFileSync(path.join(dir,"manifest.json"))),sourceSpilloverFile:path.join(source,"logger-spillover-original.json"),sourceSpilloverRawSha256:sha(spillRaw),sourcePausedLedgerFile:path.join(source,"logger-pause-partial.json"),sourcePausedLedgerRawSha256:sha(pauseRaw),sourceGame1CompletionRawSha256:sha(completionRaw),preservedGame1EmbeddedDecisions:28,originalSpilloverRecords:37,recoveredRecords:9,recoveredRawSha256:sha(recoveredRaw),allTreatmentInputsVerified:true,allActualAnswerMappingsVerified:true,originalProducerFilesRewritten:false,recoveryRows:rows}
const provenanceRaw=JSON.stringify(provenance,null,2)+"\n";fs.writeFileSync(path.join(source,"decisions-recovery-provenance.json"),provenanceRaw);fs.writeFileSync(path.join(archive,"recovery-provenance.json"),provenanceRaw)
console.log(JSON.stringify({readyForParentReview:true,output:out,provenance:path.join(source,"decisions-recovery-provenance.json"),recoveredRecords:9,allInputAndAnswerMappingsVerified:true,actualFirstActor:"lfm",movesReplayed:19,provisionalStores:{sol:7,lfm:15},originalSpilloverRawSha256:sha(spillRaw),recoveredRawSha256:sha(recoveredRaw)}))
