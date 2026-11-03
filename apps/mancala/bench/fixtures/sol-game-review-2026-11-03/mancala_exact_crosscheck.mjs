import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createGame,applyMove,legalMoves,sow} from '/Users/david/.codex/worktrees/mancala/tanstack-ai-browser/apps/mancala/src/lib/mancala.ts';
let seed=20261103;const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
const input=[],expected=[];
for(let gameId=0;gameId<100;gameId++){
 let game=createGame();
 for(let ply=0;ply<200&&game.status==='playing';ply++){
  const moves=legalMoves(game.board,game.turn);
  for(const pit of moves){
   const b=game.board.slice();b[6]=b[13]=0;
   const n=sow(b,game.turn,pit),delta=n.board[13]-n.board[6];n.board[6]=n.board[13]=0;
   input.push([game.turn==='ai'?1:0,pit,...b].join(' '));
   expected.push([n.turn==='ai'?1:0,delta,n.captured,Number(n.extraTurn),Number(n.status!=='playing'),...n.board]);
  }
  game=applyMove(game,moves[random()%moves.length]);
 }
}
const result=spawnSync('/private/tmp/mancala_exact_independent',['sow'],{input:input.join('\n')+'\n',encoding:'utf8',maxBuffer:100_000_000});
assert.equal(result.status,0,result.stderr);
const actual=result.stdout.trim().split('\n').map(line=>line.split(' ').map(Number));assert.equal(actual.length,expected.length);
for(let i=0;i<actual.length;i++)assert.deepEqual(actual[i],expected[i],'mismatch '+i+' input '+input[i]);
console.log(JSON.stringify({transitions:actual.length,games:100,seed:20261103,match:true}));
