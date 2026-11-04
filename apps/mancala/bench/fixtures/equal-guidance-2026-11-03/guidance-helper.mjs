import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createGame, legalMoves, sow } from "/Users/david/.codex/worktrees/mancala/tanstack-ai-browser/apps/mancala/src/lib/mancala.ts";
import { buildMovePrompt } from "/Users/david/.codex/worktrees/mancala/tanstack-ai-browser/apps/mancala/src/lib/shared-prompt.ts";
import { orderMovesForGame } from "/Users/david/.codex/worktrees/mancala/tanstack-ai-browser/apps/mancala/src/lib/move-order.ts";
const rotate = board => [...board.slice(7), ...board.slice(0,7)];
const sourceCommit = "3dc6daa1625191529738777b240a99901e491644";
if (process.argv[2] === "--validate-rotation") {
 let transitions=0;
 for (const file of ["/private/tmp/sol-vs-lfm3-game.json", ...[1,2,3].map(i=>`/private/tmp/sol-lfm3-v14-game-${i}.json`)]) {
  const log=JSON.parse(fs.readFileSync(file,"utf8")); let game=createGame();
  for (const move of log.moves) {
   if(game.turn === "human") for(const pit of legalMoves(game.board,"human")) {
    const actual=sow(game.board,"human",pit), mirrored=sow(rotate(game.board),"ai",pit+7);
    assert.deepEqual(rotate(mirrored.board), actual.board);
    assert.equal(mirrored.captured,actual.captured); assert.equal(mirrored.extraTurn,actual.extraTurn);
    assert.equal((mirrored.lastPit+7)%14,actual.lastPit);
    assert.equal(mirrored.turn === "ai" ? "human" : "ai",actual.turn);
    const status={"ai-won":"human-won","human-won":"ai-won",playing:"playing",draw:"draw"}[mirrored.status];
    assert.equal(status,actual.status);transitions++;
   }
   const human=move.player === "human" || move.player.startsWith("GPT");
   assert.equal(game.turn,human?"human":"ai");
   const next=sow(game.board,game.turn,human?move.pit-1:move.pit+6);
   game={...game,...next};
  }
 }
 console.log(JSON.stringify({rotationVerified:true,transitions,sourceCommit}));
 process.exit(0);
}
const [boardText, file, sessionId] = process.argv.slice(2);
if(!boardText||!file||!sessionId)throw new Error("Usage: node --experimental-strip-types mancala-equal-guidance.mjs '[14 actual board counts]' /private/tmp/.../turn-N.json stable-human-session");
assert.ok(path.resolve(file).startsWith("/private/tmp/"),"Guidance records must stay in task temporary storage.");
const actualBoard=JSON.parse(boardText);
assert.equal(actualBoard.length,14);assert.ok(actualBoard.every(n=>Number.isSafeInteger(n)&&n>=0));assert.equal(actualBoard.reduce((a,b)=>a+b,0),48);
assert.ok(legalMoves(actualBoard,"human").length>0 && legalMoves(actualBoard,"ai").length>0,"Only analyze a settled live Human turn.");
const game={...createGame(),sessionId,board:rotate(actualBoard),turn:"ai"};
const order=orderMovesForGame(sessionId,legalMoves(game.board,"ai"));
const input=buildMovePrompt(game,order,"shared-v14");
const record={schemaVersion:1,method:"Same unmodified production v14 analyzer, roles mirrored for the Human player; no extra search or independent solver",sourceCommit,actualSide:"human",actualBoard,mirroredBoard:game.board,sessionId,order,roleBindings:{AI:"Sol, Human/bottom row",Human:"LFM3, opponent/top row"},uiMapping:"Prompt AI pit N means Your pit N in the game UI",input};
fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(record,null,2)+"\n");
console.log(JSON.stringify({record:file,roleBindings:record.roleBindings,uiMapping:record.uiMapping,systemPrompt:input.systemPrompt,prompt:input.prompt,outputSchema:{type:"object",properties:{pit:{type:"string",enum:input.choices.map(c=>c.label)}},required:["pit"],additionalProperties:false}},null,2));
