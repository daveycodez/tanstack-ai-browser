/** CPU-only counts with the production tokenizer; never loads a model or reads environment files. */
import {readFile,writeFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {createHash} from 'node:crypto';
import {loadTokenizer} from '../../../packages/webgl/src/tokenizer.ts';
import {buildMovePrompt,SHARED_V7_SYSTEM_PROMPT,SHARED_V8_SYSTEM_PROMPT} from '../src/lib/shared-prompt.ts';
import {CASES,gameForCase} from './cases.ts';
import {legalMoves} from '../src/lib/checkers.ts';
const [tokenizerPath,templatePath,outputPath]=process.argv.slice(2);
if(!tokenizerPath||!templatePath)throw Error('Usage: node apps/checkers/bench/measure-prompt.mjs <tokenizer.json> <chat_template.jinja> [output.json]');
for(const path of [tokenizerPath,templatePath,outputPath].filter(Boolean))if(basename(path).startsWith('.env'))throw Error('Environment files are not permitted');
const tokenizerBytes=await readFile(tokenizerPath),template=await readFile(templatePath,'utf8');
const tokenizer=loadTokenizer({tokenizerJson:JSON.parse(tokenizerBytes.toString()),chatTemplate:template});
const count=text=>tokenizer.encode(text,{addSpecialTokens:false}).length;
const sections=['Policy','American rules','Outcome heading','Outcome interpretation'].map((name,i)=>({name,before:count(SHARED_V7_SYSTEM_PROMPT.split('\n')[i]),after:count(SHARED_V8_SYSTEM_PROMPT.split('\n')[i])}));
const rows=CASES.map(c=>{const game=gameForCase(c),moves=legalMoves(game.board,'ai'),before=buildMovePrompt(game,moves,'shared-v7'),after=buildMovePrompt(game,moves,'shared-v8');return {caseId:c.id,inference:moves.length!==1,beforeUser:count(before.prompt),afterUser:count(after.prompt),savedUser:count(before.prompt)-count(after.prompt)}});
const result={scope:'LFM3 raw app-authored system/user text; native schema guidance and chat-template framing excluded',tokenizerSha256:createHash('sha256').update(tokenizerBytes).digest('hex'),system:{before:count(SHARED_V7_SYSTEM_PROMPT),after:count(SHARED_V8_SYSTEM_PROMPT),saved:count(SHARED_V7_SYSTEM_PROMPT)-count(SHARED_V8_SYSTEM_PROMPT)},sections,rows,dynamicSaved:rows.reduce((n,row)=>n+row.savedUser,0)};
if(outputPath)await writeFile(outputPath,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({scope:result.scope,system:result.system,sections:result.sections,dynamicSaved:result.dynamicSaved,positions:rows.length},null,2));
