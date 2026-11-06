// Diagnostic for installed llguidance@0.2.1, not an automated passing test.
// Run: node packages/transformers-js/bench/review-const-bug.mjs
// Expected on the affected dependency: JSON evidence on stdout, exit status 1.
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {build} from 'esbuild'

const temporary = await mkdtemp(join(tmpdir(), 'constraint-const-review-'))
try {
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
  const outfile = join(temporary, 'constraint.mjs')
  await build({entryPoints:[entry], outfile, bundle:true, format:'esm', platform:'node', logLevel:'error'})
  const {createConstraint, tokenAllowed} = await import(pathToFileURL(outfile).href)
  const EOS = 256
  // An exact one-byte vocabulary eliminates HF decoding, WebGL kernels,
  // model sampling, KV cache and reasoning-envelope parsing from this repro.
  const tokenizer = {tokens:Array.from({length:257}, (_, id) => id===EOS ? [] : [id]), eos_token_id:EOS, special_token_ids:[EOS]}
  const literal = 'Paris</think>Paris'
  const schemaFor = value => ({type:'object', properties:{value:{type:'string', const:value}}, required:['value'], additionalProperties:false})
  const bytes = text => new TextEncoder().encode(text)
  const cases = []
  async function withConstraint(value, run) {
    const constraint = await createConstraint({schema:schemaFor(value), tokenizer})
    try {return await run(constraint)} finally {constraint.dispose()}
  }
  function accept(constraint, sequence) {
    for(const token of sequence) {
      assert.equal(tokenAllowed(constraint.computeMask(), token), true, `control byte ${token} must be accepted`)
      constraint.accept(token)
    }
  }
  function observe(name, expected, actual, detail={}) {
    cases.push({name, expected, actual, desiredBehavior:actual===expected, ...detail})
  }
  for(const value of ['Paris', literal, 'Paris</think>Paris <think>tag</think> héllo 👑', 'quoted "text" \\ slash / newline\n\t\u0001']) {
    await withConstraint(value, constraint => {
      const raw = JSON.stringify({value})
      accept(constraint, bytes(raw))
      observe('valid literal control: '+JSON.stringify(value), true, constraint.complete, {raw, roundTrip:JSON.parse(raw).value===value})
    })
  }
  // Equivalent legal JSON spellings must remain supported.
  for(const [value, raw] of [[literal, '{"value":"Paris\\u003c/think>Paris"}'], ['héllo 👑', '{"value":"h\\u00e9llo \\ud83d\\udc51"}']]) {
    await withConstraint(value, constraint => {
      accept(constraint, bytes(raw))
      observe('valid Unicode-escape control: '+JSON.stringify(value), true, constraint.complete, {raw, roundTrip:JSON.parse(raw).value===value})
    })
  }
  await withConstraint(literal, constraint => {
    accept(constraint, bytes('{"value":"Paris\\'))
    observe('escaped quote must not extend finite string Paris</think>Paris', false, tokenAllowed(constraint.computeMask(), 34), {prefix:'{"value":"Paris\\', candidateByte:34, candidateMeaning:'an escaped quote, not the required <'})
  })
  await withConstraint(literal, constraint => {
    accept(constraint, bytes('{"value":"Paris\\u'))
    observe('impossible partial Unicode escape must be rejected', false, tokenAllowed(constraint.computeMask(), 51), {prefix:'{"value":"Paris\\u', candidateByte:51, candidateMeaning:'3xxx cannot encode the required U+003C'})
  })
  await withConstraint(literal, constraint => {
    accept(constraint, bytes('{"value":"Paris'))
    const allowed = tokenAllowed(constraint.computeMask(), 0xc2)
    observe('non-ASCII UTF-8 lead cannot encode the required ASCII <', false, allowed, {candidateByte:0xc2})
    if(allowed) {
      constraint.accept(0xc2)
      try {constraint.computeMask(); observe('false-positive UTF-8 lead reaches a dead end', true, false)}
      catch(error) {observe('false-positive UTF-8 lead reaches a dead end', true, error.code==='constraint-dead-end', {error:error.message})}
    }
  })
  await withConstraint(literal, constraint => {
    const sequence = [...bytes('{"value":"Paris'), 92, 34, 0xc2]
    const accepted = []
    for(const token of sequence) {
      if(!tokenAllowed(constraint.computeMask(), token)) break
      constraint.accept(token);accepted.push(token)
    }
    let error = null
    try {constraint.computeMask()} catch(failure) {error={code:failure.code, message:failure.message}}
    cases.push({name:'traced semantic path: wrong escaped quote, incomplete UTF-8, dead end', acceptedBytes:accepted, acceptedAllBytes:accepted.length===sequence.length, error, diagnosticOnly:true})
  })
  const failures = cases.filter(result => result.desiredBehavior===false)
  const report = {dependency:'llguidance@0.2.1', entry:'@tanstack-ai-browser/structured-output createConstraint()', schema:schemaFor(literal), tokenizer:'IDs 0..255 equal raw byte; EOS 256', modelUsed:false, samplingUsed:false, cases, desiredBehaviorFailures:failures.length}
  console.log(JSON.stringify(report, null, 2))
  assert.equal(failures.length, 0, 'Installed constraint compiler accepts impossible escaped/UTF-8 string prefixes. This diagnostic is expected to fail until the dependency is fixed.')
} finally {
  await rm(temporary, {recursive:true, force:true})
}
