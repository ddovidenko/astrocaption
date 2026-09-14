// A fake nova.astrometry.net that replays the recorded fixtures, so the browser smoke test
// never contacts nova (CLAUDE.md). Standard library only; started by Playwright's webServer.
//
// `POST /_fake/mode` with {"job": "success"|"failure"|"timeout"} switches how job polls are
// answered from then on, so a spec can drive a failed solve and a solve nova never finishes;
// `GET /_fake/mode` reports the mode and how many uploads the fake has received.
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

// Load every fixture the server can serve once at startup, so a missing or unreadable
// fixture fails fast with a plain message instead of crashing mid-request.
const FIXTURE_NAMES = [
  'login.json',
  'upload.json',
  'submission_pending.json',
  'submission_ready.json',
  'job_solving.json',
  'job_success.json',
  'job_failure.json',
  'annotations.json',
  'job_info.json',
  'wcs.fits',
]

const files = new Map()
for (const name of FIXTURE_NAMES) {
  const path = join(fixtures, name)
  try {
    files.set(name, readFileSync(path))
  } catch (err) {
    console.error(
      `fake nova: cannot read ${path} (${err.code}); set NOVA_FIXTURES to the directory holding the recorded nova responses`
    )
    process.exit(2)
  }
}

const fixture = (name) => files.get(name)
const json = (name) => ({ type: 'application/json', body: fixture(name) })

// A poll endpoint answers "not yet" once after each upload and "done" from then on: the
// shortest path through the worker. Ids are not tracked; the fixtures carry fixed ones.
const firstThenRest = () => {
  let n = 0
  return (first, rest) => (n++ === 0 ? first : rest)
}
let submission = firstThenRest()
let job = firstThenRest()

// How job polls are answered: 'success' replays the solved fixtures, 'failure' reports a job
// nova gave up on, 'timeout' never finishes (the client's own deadline has to end the solve).
// `uploads` counts POST /api/upload, which is how a spec proves Check again uploaded nothing.
const MODES = ['success', 'failure', 'timeout']
let mode = 'success'
let uploads = 0
const modeBody = () => JSON.stringify({ job: mode, uploads })

/** Applies a POST /_fake/mode body. Returns the status and body to answer with. */
function setMode(body) {
  let wanted
  try {
    wanted = JSON.parse(body).job
  } catch {
    wanted = undefined
  }
  if (!MODES.includes(wanted)) {
    return { status: 400, body: '{"status": "error", "errormessage": "unknown mode"}' }
  }
  if (wanted !== mode) console.log(`mode -> ${wanted}`)
  mode = wanted
  return { status: 200, body: modeBody() }
}

function route(method, path) {
  if ((method === 'GET' || method === 'HEAD') && path === '/') return { type: 'application/json', body: '{"ok": true}' }
  if (method === 'POST' && path === '/api/login') return json('login.json')
  if ((method === 'GET' || method === 'HEAD') && path === '/_fake/mode') {
    return { type: 'application/json', body: modeBody() }
  }
  if (method === 'POST' && path === '/api/upload') {
    uploads += 1
    submission = firstThenRest()
    job = firstThenRest()
    return json('upload.json')
  }
  if (method === 'GET' && /^\/api\/submissions\/\d+$/.test(path)) {
    return json(submission('submission_pending.json', 'submission_ready.json'))
  }
  if (method === 'GET' && /^\/api\/jobs\/\d+\/annotations\/$/.test(path)) return json('annotations.json')
  if (method === 'GET' && /^\/api\/jobs\/\d+\/info\/$/.test(path)) return json('job_info.json')
  if (method === 'GET' && /^\/api\/jobs\/\d+$/.test(path)) {
    // 'timeout' never leaves "solving", so the caller's deadline is the only thing that ends it.
    if (mode === 'timeout') return json('job_solving.json')
    return json(job('job_solving.json', mode === 'failure' ? 'job_failure.json' : 'job_success.json'))
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
  const method = req.method ?? 'GET'
  // Drain the request body (uploads are multipart) before answering. Nova bodies are never
  // parsed or validated: a malformed upload still gets upload.json; this is a replay, not
  // a protocol check. A client that drops the connection mid-body fails only this request.
  // The one body that is read is the mode switch below, which is the fake's own endpoint.
  const switching = method === 'POST' && url.pathname === '/_fake/mode'
  const chunks = []
  req.on('data', (chunk) => {
    if (switching) chunks.push(chunk)
  })
  req.on('error', (err) => {
    console.error(`fake nova: ${req.method} ${url.pathname} aborted (${err.message})`)
    res.destroy()
  })
  req.on('end', () => {
    if (switching) {
      const answer = setMode(Buffer.concat(chunks).toString('utf8'))
      console.log(`${method} ${url.pathname} -> ${answer.status}`)
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(answer.body)
      return
    }
    const hit = route(method, url.pathname)
    console.log(`${method} ${url.pathname} -> ${hit ? 200 : 404}`)
    if (!hit) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"status": "error", "errormessage": "not in the fixtures"}')
      return
    }
    res.writeHead(200, { 'content-type': hit.type })
    res.end(method === 'HEAD' ? undefined : hit.body)
  })
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`fake nova: port ${port} on ${host} is already in use; stop the other process or set FAKE_NOVA_PORT`)
  } else {
    console.error(`fake nova: ${err.message}`)
  }
  process.exit(2)
})

server.listen(port, host, () => console.log(`fake nova listening on http://${host}:${port} (fixtures: ${fixtures})`))
