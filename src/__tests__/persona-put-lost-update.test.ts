import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// PERSONALOSTUPDATE1109, driven through PUT /api/agents/:name.
//
// Measured on a live install, 2026-11-09: the create wizard loaded the generated
// CLAUDE.md / SOUL.md into its step-3 editors, the main agent then added a
// section to CLAUDE.md, and the wizard's "Create" PUT both stale texts back. The
// added section was gone without a trace. These cases pin the server half of
// the fix: a PUT that names the text its editor started from (claudeMdBase /
// soulMdBase) writes only while the file is still that text, and a refusal
// writes nothing at all. The first case is the incident itself.

const h = vi.hoisted(() => ({ root: '' }))

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...orig,
    agentDir: (name: string) => join(h.root, name),
    agentConfigRoot: (name: string) => join(h.root, name),
    isKnownAgent: (name: string) => existsSync(join(h.root, name)),
    writeAgentMemoryIsolation: vi.fn(),
  }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')
const { PROJECT_ROOT } = await import('../config.js')
type RouteContext = import('../web/routes/types.js').RouteContext

const NAME = 'zz-persona-lostupdate-probe'
const GENERATED_CLAUDE = '# generalt CLAUDE\n\n## Szerepkor\n- otthon\n'
const GENERATED_SOUL = '# generalt SOUL\n'
const ADDED_BY_OTHER = GENERATED_CLAUDE + '\n### HA-hozzaferes\n- sajat token, a vaultban\n'

function put(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const out = { status: 200, body: {} as Record<string, any> }
  const res = {
    setHeader() {},
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420/api/agents/${NAME}`)
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  return tryHandleAgents(
    // The owner's browser login: claudeMd/soulMd are owner fields (APIAGENTWRITE1104).
    { req, res, path: url.pathname, method: 'PUT', url, auth: { kind: 'session' } } as unknown as RouteContext,
    join(PROJECT_ROOT, 'web'),
  ).then((handled) => {
    expect(handled).toBe(true)
    return out
  })
}

const dir = () => join(h.root, NAME)
const read = (file: string) => readFileSync(join(dir(), file), 'utf8')

beforeEach(() => {
  h.root = mkdtempSync(join(tmpdir(), 'persona-put-'))
  mkdirSync(dir(), { recursive: true })
  writeFileSync(join(dir(), 'CLAUDE.md'), GENERATED_CLAUDE)
  writeFileSync(join(dir(), 'SOUL.md'), GENERATED_SOUL)
})

afterEach(() => {
  rmSync(h.root, { recursive: true, force: true })
})

describe('PUT /api/agents/:name with an editor base (PERSONALOSTUPDATE1109)', () => {
  it('refuses a write over a file another writer changed since the editor loaded it, and writes nothing', async () => {
    writeFileSync(join(dir(), 'CLAUDE.md'), ADDED_BY_OTHER)
    const r = await put({
      claudeMd: GENERATED_CLAUDE + 'operator edit\n', claudeMdBase: GENERATED_CLAUDE,
      soulMd: '# operator SOUL\n', soulMdBase: GENERATED_SOUL,
    })
    expect(r.status).toBe(409)
    expect(r.body.changed).toEqual(['claudeMd'])
    expect(read('CLAUDE.md')).toBe(ADDED_BY_OTHER)
    // SOUL.md was unchanged and its own base matched, but a refused request writes no file.
    expect(read('SOUL.md')).toBe(GENERATED_SOUL)
  })

  it('writes when the file is still the text the editor started from', async () => {
    const r = await put({ claudeMd: '# operator CLAUDE\n', claudeMdBase: GENERATED_CLAUDE })
    expect(r.status).toBe(200)
    expect(read('CLAUDE.md')).toBe('# operator CLAUDE\n')
    expect(read('SOUL.md')).toBe(GENERATED_SOUL)
  })

  it('checks each file against its own base', async () => {
    writeFileSync(join(dir(), 'SOUL.md'), '# soul changed elsewhere\n')
    const r = await put({ soulMd: '# operator SOUL\n', soulMdBase: GENERATED_SOUL })
    expect(r.status).toBe(409)
    expect(r.body.changed).toEqual(['soulMd'])
    expect(read('SOUL.md')).toBe('# soul changed elsewhere\n')
  })

  it('treats a missing file as the empty text', async () => {
    rmSync(join(dir(), 'SOUL.md'))
    const ok = await put({ soulMd: '# new SOUL\n', soulMdBase: '' })
    expect(ok.status).toBe(200)
    expect(read('SOUL.md')).toBe('# new SOUL\n')
    rmSync(join(dir(), 'SOUL.md'))
    const refused = await put({ soulMd: '# new SOUL\n', soulMdBase: GENERATED_SOUL })
    expect(refused.status).toBe(409)
    expect(existsSync(join(dir(), 'SOUL.md'))).toBe(false)
  })

  it('rejects a base without the field it guards, or a non-string base', async () => {
    const lone = await put({ claudeMdBase: GENERATED_CLAUDE })
    expect(lone.status).toBe(400)
    const typed = await put({ claudeMd: 'x', claudeMdBase: 42 })
    expect(typed.status).toBe(400)
    expect(read('CLAUDE.md')).toBe(GENERATED_CLAUDE)
  })

  it('keeps last-writer-wins for a caller that sends no base', async () => {
    writeFileSync(join(dir(), 'CLAUDE.md'), ADDED_BY_OTHER)
    const r = await put({ claudeMd: '# plain PUT\n' })
    expect(r.status).toBe(200)
    expect(read('CLAUDE.md')).toBe('# plain PUT\n')
  })
})

// The client half. The wizard is plain browser JS with no harness here, so this
// is pinned at source level: the step-3 "Create" handler must send a base with
// every persona text it sends, and must not PUT both texts unconditionally.
describe('the create wizard step 3 (PERSONALOSTUPDATE1109)', () => {
  const src = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8')
  const start = src.indexOf("getElementById('wizardCreateBtn').addEventListener")
  const handler = src.slice(start, src.indexOf('\n})\n', start))

  it('sends each persona text only with the base its editor started from', () => {
    expect(start).toBeGreaterThan(-1)
    expect(handler).toContain('update.claudeMdBase = generatedClaudeMd')
    expect(handler).toContain('update.soulMdBase = generatedSoulMd')
    expect(handler).not.toContain('JSON.stringify({ claudeMd, soulMd })')
  })
})
