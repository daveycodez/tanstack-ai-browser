import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
// @ts-expect-error The bridge is a standalone Node ESM development tool.
import { createCakeServer } from './cake-server.mjs'

async function fixture(code: string) {
  const folder = await mkdtemp(join(tmpdir(), 'checkers-cake-test-')), executable = join(folder, 'engine')
  await writeFile(executable, `#!${process.execPath}\n${code}`); await chmod(executable, 0o700)
  const server = createCakeServer(executable); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { folder, server, url: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true }) } }
}
test('Cake bridge rejects incompatible browser origins and malformed bitboards before launching a process', async () => {
  const f = await fixture(`throw new Error('must not run')`)
  try {
    assert.equal((await fetch(`${f.url}/move`, { method: 'POST', headers: { Origin: 'https://example.com' }, body: '[]' })).status, 403)
    const invalid = await fetch(`${f.url}/move`, { method: 'POST', body: '[0,0,0,0,1,2]' })
    assert.equal(invalid.status, 500); assert.match((await invalid.json()).error, /positive odd/)
  } finally { await f.close() }
})
test('Cake bridge forwards history and native candidate-audit mode without repairing engine output', async () => {
  const f = await fixture(`let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>console.log(JSON.stringify({successor:[1,0,2,0,2],legalSuccessors:[[1,0,2,0,2]],aborted:false,input:JSON.parse(text),rootMode:process.argv.includes('--root-scores')})))`)
  try {
    const input = [1, 0, 2, 0, 1, 7, [[1, 0, 4, 0, 2]]]
    const response = await fetch(`${f.url}/rank`, { method: 'POST', headers: { Origin: 'http://localhost:3002' }, body: JSON.stringify(input) })
    const result = await response.json(); assert.deepEqual(result.input, input); assert.equal(result.rootMode, true)
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3002')
  } finally { await f.close() }
})
test('cancelling an active browser request terminates its native Cake process', async () => {
  const f = await fixture(`const fs=require('node:fs');const path=require('node:path');const base=path.dirname(process.argv[1]);fs.writeFileSync(path.join(base,'started'),'yes');process.on('SIGTERM',()=>{fs.writeFileSync(path.join(base,'stopped'),'yes');process.exit(0)});process.stdin.resume();setInterval(()=>{},1000)`)
  // The executable has no package.json and is deliberately CommonJS.
  const waitFor = async (file: string) => { for (let i = 0; i < 100; i++) { try { return await readFile(join(f.folder, file), 'utf8') } catch { await new Promise(resolve => setTimeout(resolve, 10)) } } throw new Error(`Native process did not write ${file}`) }
  try {
    const controller = new AbortController()
    const request = fetch(`${f.url}/move`, { method: 'POST', body: '[1,0,2,0,1,7]', signal: controller.signal })
    await waitFor('started'); controller.abort(); await assert.rejects(request, { name: 'AbortError' }); assert.equal(await waitFor('stopped'), 'yes')
  } finally { await f.close() }
})
