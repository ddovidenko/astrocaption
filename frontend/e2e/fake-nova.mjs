// A fake nova.astrometry.net that replays the recorded fixtures, so the browser smoke test
// never contacts nova (CLAUDE.md). Standard library only; started by Playwright's webServer.
//
//   FAKE_NOVA_PORT   default 8901
//   FAKE_NOVA_HOST   default 127.0.0.1 (0.0.0.0 in CI so a container can reach it)
//   NOVA_FIXTURES    default ../backend/tests/fixtures/nova relative to this file
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = process.env.NOVA_FIXTURES ?? join(here, '..', '..', 'backend', 'tests', 'fixtures', 'nova')
const port = Number(process.env.FAKE_NOVA_PORT ?? 8901)
const host = process.env.FAKE_NOVA_HOST ?? '127.0.0.1'

const fixture = (name) => readFileSync(join(fixtures, name))
const json = (name) => ({ type: 'application/json', body: fixture(name) })

// How many times each poll endpoint has been asked since the last upload: the first answer
// is "not yet", every later one is "done", which is the shortest path through the worker.
let submissionPolls = 0
let jobPolls = 0

function route(method, path) {
  if (method === 'GET' && path === '/') return { type: 'application/json', body: '{"ok": true}' }
  if (method === 'POST' && path === '/api/login') return json('login.json')
  if (method === 'POST' && path === '/api/upload') {
    submissionPolls = 0
    jobPolls = 0
    return json('upload.json')
  }
  if (method === 'GET' && /^\/api\/submissions\/\d+$/.test(path)) {
    return json(submissionPolls++ === 0 ? 'submission_pending.json' : 'submission_ready.json')
  }
  if (method === 'GET' && /^\/api\/jobs\/\d+\/annotations\/$/.test(path)) return json('annotations.json')
  if (method === 'GET' && /^\/api\/jobs\/\d+\/info\/$/.test(path)) return json('job_info.json')
  if (method === 'GET' && /^\/api\/jobs\/\d+$/.test(path)) {
    return json(jobPolls++ === 0 ? 'job_solving.json' : 'job_success.json')
  }
  if (method === 'GET' && /^\/wcs_file\/\d+$/.test(path)) {
    return { type: 'application/octet-stream', body: fixture('wcs.fits') }
  }
  if (method === 'GET' && /^\/(status|joblog)\/\d+$/.test(path)) {
    return { type: 'text/html', body: '<html><body>fake nova</body></html>' }
  }
  return null
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake-nova')
  // Drain the request body (uploads are multipart) before answering.
  req.on('data', () => undefined)
  req.on('end', () => {
    const hit = route(req.method ?? 'GET', url.pathname)
    console.log(`${req.method} ${url.pathname} -> ${hit ? 200 : 404}`)
    if (!hit) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"status": "error", "errormessage": "not in the fixtures"}')
      return
    }
    res.writeHead(200, { 'content-type': hit.type })
    res.end(hit.body)
  })
})

server.listen(port, host, () => console.log(`fake nova listening on http://${host}:${port} (fixtures: ${fixtures})`))
