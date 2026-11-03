import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { buildMovePrompt } from "../../../src/lib/shared-prompt.ts";
const dir = path.dirname(fileURLToPath(import.meta.url));
const reports=[];
let verified=0;
for (const name of fs.readdirSync(dir).filter(n=>n.endsWith(".json.gz"))) {
 const r=JSON.parse(gunzipSync(fs.readFileSync(path.join(dir,name))).toString("utf8"));
 assert.equal(r.partial,false,name);
 assert.equal(r.suiteVersion,"mancala-tactics-v3",name);
 for (const row of r.results) {
  const input=buildMovePrompt(row.position,row.order,r.promptVersion);
  assert.equal(input.systemPrompt,row.input.systemPrompt,`${name}/${row.trial}: system`);
  assert.equal(input.prompt,row.input.prompt,`${name}/${row.trial}: prompt`);
  assert.deepEqual(input.choices,row.input.choices,`${name}/${row.trial}: all legal choices`);
  if (r.promptVersion==="shared-v12") {
   assert.ok(input.report.preferredActions.includes(input.recommendedAction));
   assert.equal(input.choices.length,row.order.length);
  }
  verified++;
 }
 reports.push({file:name,promptVersion:r.promptVersion,model:r.config.opponent,reasoningMode:r.config.reasoningMode,summary:r.summary,misses:r.results.filter(t=>t.passed===false).map(t=>({caseId:t.caseId,repetition:t.repetition,pit:t.pit,expectedPits:t.expectedPits}))});
}
const output={scope:"DOM-read full inference reports, verified against frozen prompt versions and recorded boards/orders",verifiedTrials:verified,reports};

console.log(JSON.stringify({verifiedTrials:verified,reports:reports.length,results:reports.map(r=>[r.file,r.summary.passed,r.summary.scored])}));
