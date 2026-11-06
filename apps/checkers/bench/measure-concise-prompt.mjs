/** CPU-only prompt counts. Public tokenizer assets only; never loads a model. */
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { loadTokenizer } from '../../../packages/webgllm/node_modules/webgllm/dist/advanced.js';
import { buildMovePrompt, PREVIOUS_PROMPT_VERSION, SHARED_PROMPT_VERSION } from '../src/lib/shared-prompt.ts';
import { legalMoves } from '../src/lib/checkers.ts';
import { CASES, gameForCase } from './cases.ts';

const [tokenizerPath, templatePath, outputPath] = process.argv.slice(2);
if (!tokenizerPath || !templatePath) throw Error('Usage: node --experimental-strip-types apps/checkers/bench/measure-concise-prompt.mjs <tokenizer.json> <chat_template.jinja> [output.json]');
for (const path of [tokenizerPath, templatePath, outputPath].filter(Boolean)) if (basename(path).startsWith('.env')) throw Error('Environment files are not permitted');
const bytes = await readFile(tokenizerPath), template = await readFile(templatePath, 'utf8');
const tokenizer = loadTokenizer({ tokenizerJson: JSON.parse(bytes.toString()), chatTemplate: template });
const textTokens = text => tokenizer.encode(text, { addSpecialTokens: false }).length;
function counts(input) {
  // Same schema contract and guidance as production WebGL structured output.
  const schema = { type: 'object', properties: { move: { type: 'string', enum: input.choices.map(choice => choice.label) } }, required: ['move'], additionalProperties: false };
  const chat = [{ role: 'system', content: `${input.systemPrompt}\n\nAnswer with only a JSON value matching this JSON Schema:\n${JSON.stringify(schema)}` }, { role: 'user', content: input.prompt }];
  return { system: textTokens(input.systemPrompt), user: textTokens(input.prompt), fullInput: tokenizer.encodeChat(chat, { addGenerationPrompt: true, enableThinking: false }).length };
}
const rows = CASES.map(fixture => {
  const game = gameForCase(fixture), moves = legalMoves(game.board, 'ai');
  const before = counts(buildMovePrompt(game, moves, PREVIOUS_PROMPT_VERSION)), after = counts(buildMovePrompt(game, moves, SHARED_PROMPT_VERSION));
  return { caseId: fixture.id, inference: moves.length !== 1, before, after, savedFullInput: before.fullInput - after.fullInput };
});
const inferred = rows.filter(row => row.inference);
const before = inferred.reduce((total, row) => total + row.before.fullInput, 0), after = inferred.reduce((total, row) => total + row.after.fullInput, 0);
const summary = { positions: rows.length, inferredPositions: inferred.length, meanFullInputBefore: before / inferred.length, meanFullInputAfter: after / inferred.length, meanSavedTokens: (before - after) / inferred.length, reductionPercent: 100 * (1 - after / before) };
const result = { scope: 'Full input, including strict legal-action schema guidance and chat framing; thinking off. Fixture legal order; native browser usage remains authoritative.', before: PREVIOUS_PROMPT_VERSION, after: SHARED_PROMPT_VERSION, tokenizerSha256: createHash('sha256').update(bytes).digest('hex'), templateSha256: createHash('sha256').update(template).digest('hex'), summary, rows };
if (outputPath) await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ scope: result.scope, before: result.before, after: result.after, ...summary }, null, 2));
