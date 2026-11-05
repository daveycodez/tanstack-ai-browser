import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const CAKE_METADATA = {
  name: 'Cake', repository: 'https://github.com/martinfierz/cake',
  revision: '0221bfb2a625015c067e48825d6be3a6c28fa6d5',
  configuration: 'Native fixed-depth search; official evaluation/pattern weights; opening book and external tablebases disabled',
  history: 'Stock search receives its most recent 10 prior positions; application adjudicates final threefold repetition and 80-ply quiet-clock draws'
}
export function createCakeServer(executable) {
  const children = new Set()
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) { response.writeHead(403); response.end(); return }
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
    if (request.method === 'GET' && request.url === '/metadata') { response.end(JSON.stringify(CAKE_METADATA)); return }
    if (request.method !== 'POST' || !['/move', '/rank'].includes(request.url)) { response.writeHead(404); response.end(); return }
    let child
    const disconnect = () => { if (!response.writableEnded) child?.kill() }
    response.on('close', disconnect)
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      if (!Array.isArray(input) || (input.length !== 6 && input.length !== 7) || input.slice(0, 4).some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff) || ![1, 2].includes(input[4]) || !Number.isSafeInteger(input[5]) || input[5] < 1 || input[5] % 2 !== 1) throw new Error('Expected four unsigned bitboards, side 1/2, and a positive odd search depth.')
      if (input[6] !== undefined && (!Array.isArray(input[6]) || input[6].some(position => !Array.isArray(position) || position.length !== 5 || position.slice(0, 4).some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff) || ![1, 2].includes(position[4])))) throw new Error('Invalid prior position history.')
      child = spawn(executable, request.url === '/rank' ? ['--root-scores'] : [], { stdio: ['pipe', 'pipe', 'pipe'] }); children.add(child)
      let output = '', errors = ''
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { errors += chunk })
      child.stdin.on('error', () => { /* Cancellation can close the pipe before stdin finishes. */ })
      child.stdin.end(`${JSON.stringify(input)}\n`)
      await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(errors || `Cake exited ${code}.`))) })
      const result = JSON.parse(output.trim())
      if (!Array.isArray(result.successor) || !Array.isArray(result.legalSuccessors) || result.aborted) throw new Error('Cake did not complete a legal search.')
      if (!response.destroyed) response.end(JSON.stringify({ ...result, provenance: CAKE_METADATA }))
    } catch (error) { if (!response.destroyed) { response.writeHead(500); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })) } }
    finally { if (child) children.delete(child); response.off('close', disconnect) }
  })
  server.on('close', () => { for (const child of children) child.kill() })
  return server
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const executable = process.argv[2] ?? '/private/tmp/checkers-cake-reference/cake-cli'
  const server = createCakeServer(executable)
  server.listen(3013, '127.0.0.1', () => console.log('Cake benchmark bridge: http://127.0.0.1:3013'))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close())
}
