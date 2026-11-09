import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteFileSync } from './atomic-write.js'

// PERSONANOCLOBBER923: the personality step of POST /api/agents must never
// overwrite a CLAUDE.md / SOUL.md that someone else wrote while it was running.
//
// Measured on a live install, 2026-09-21: the agent directory exists (and the
// agent shows on the dashboard) from scaffoldAgentDir() on, but the LLM
// generation that follows can run for a long time. An operator hand-wrote both
// files in the ~25 minutes before it finished; generation then FAILED, and the
// fallback path unconditionally wrote the "FIGYELEM: ez egy SABLON" template
// over both -- the agent's safety constraints wiped from disk, silently.
//
// The mechanism is a baseline snapshot: the handler records each file's bytes
// (or its absence) right before generation starts, and the completion writes
// only while the file is still exactly that. Anything else means a writer
// other than this handler touched it, and that writer wins.

/** The file's bytes at snapshot time, or null when it did not exist. */
export type PersonaBaseline = Buffer | null

export function snapshotPersonaFile(path: string): PersonaBaseline {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path)
  } catch {
    // Unreadable is not "absent": an empty buffer can never equal a later
    // successful read of real content, so a guarded write will skip rather
    // than clobber a file we could not look at.
    return Buffer.alloc(0)
  }
}

/** True when the file is still exactly what the baseline recorded. */
export function isPersonaFileUnchanged(path: string, baseline: PersonaBaseline): boolean {
  const current = snapshotPersonaFile(path)
  if (baseline === null) return current === null
  if (current === null) return false
  return current.equals(baseline)
}

/** `agents/x/CLAUDE.md` -> `agents/x/CLAUDE.generated.md`. */
export function generatedSidecarPath(path: string): string {
  return path.replace(/\.md$/i, '') + '.generated.md'
}

export interface GuardedPersonaWrite {
  written: boolean
  /** Set when the write was skipped and the content was saved next to it. */
  sidecarPath: string | null
}

/**
 * Write `content` to `path` only if the file is unchanged since `baseline`.
 *
 * On a skip, `saveSidecarOnSkip` stores the content as `<NAME>.generated.md`
 * so a successful generation is not thrown away. Pass false for the template
 * fallback: a placeholder has nothing worth keeping.
 *
 * Not atomic against a writer racing the check itself (check-then-rename);
 * the window is microseconds, against the minutes-long generation it guards.
 */
export function writePersonaFileIfUnchanged(
  path: string,
  baseline: PersonaBaseline,
  content: string,
  opts: { saveSidecarOnSkip: boolean },
): GuardedPersonaWrite {
  if (isPersonaFileUnchanged(path, baseline)) {
    atomicWriteFileSync(path, content)
    return { written: true, sidecarPath: null }
  }
  if (!opts.saveSidecarOnSkip) return { written: false, sidecarPath: null }
  const sidecar = generatedSidecarPath(path)
  try {
    atomicWriteFileSync(sidecar, content)
  } catch {
    // Best-effort. The skip itself is what protects the operator's file; a
    // failed sidecar must not turn into a throw that reaches the fallback path.
    return { written: false, sidecarPath: null }
  }
  return { written: false, sidecarPath: sidecar }
}

// PERSONALOSTUPDATE1109: the same lost update, one request later.
//
// Measured on a live install, 2026-11-09: the wizard's step 2 created an agent
// (generation wrote CLAUDE.md and SOUL.md at 20:01:40) and loaded both texts
// into its step-3 editors. At 20:01:58 the main agent added an access section
// to CLAUDE.md. At 20:03:20 the operator pressed "Create", which PUT both
// step-2 texts back unconditionally: the added section was gone, no sidecar,
// no notice. PERSONANOCLOBBER923 could not see it -- it guards the POST's own
// writes, and generation had long finished.
//
// So a PUT may now say which text its editor started from (`claudeMdBase`,
// `soulMdBase`). When it does, the write happens only while the file on disk is
// still exactly that text; otherwise the whole request is refused with 409
// before anything is written. Callers that send no base keep the old
// last-writer-wins behaviour, so existing API users are not broken.

export const PERSONA_PUT_BASE_FIELDS = { claudeMd: 'claudeMdBase', soulMd: 'soulMdBase' } as const

export interface PersonaPutTarget {
  field: keyof typeof PERSONA_PUT_BASE_FIELDS
  path: string
}

export type PersonaPutBaseCheck =
  | { ok: true }
  | { ok: false; status: 400 | 409; error: string; changed?: string[] }

/**
 * Check the optional `<field>Base` values of a PUT body against the files on
 * disk. Call it BEFORE the first write of the request: a refusal must leave
 * every file as it was. A missing file counts as the empty text.
 */
export function checkPersonaPutBases(body: Record<string, unknown>, targets: PersonaPutTarget[]): PersonaPutBaseCheck {
  const changed: string[] = []
  for (const { field, path } of targets) {
    const baseField = PERSONA_PUT_BASE_FIELDS[field]
    const base = body[baseField]
    if (base === undefined) continue
    if (typeof base !== 'string') {
      return { ok: false, status: 400, error: `${baseField} must be a string (the text the editor started from).` }
    }
    if (body[field] === undefined) {
      return { ok: false, status: 400, error: `${baseField} was sent without ${field}: a base only guards a write.` }
    }
    let current = ''
    if (existsSync(path)) {
      try {
        current = readFileSync(path, 'utf8')
      } catch {
        // Unreadable is not "unchanged": refuse rather than overwrite a file we
        // could not compare, same direction as snapshotPersonaFile.
        changed.push(field)
        continue
      }
    }
    if (current !== base) changed.push(field)
  }
  if (changed.length === 0) return { ok: true }
  return {
    ok: false,
    status: 409,
    error: `${changed.join(', ')} changed on disk since the editor loaded it; nothing was written. Reload the agent and apply the edit again.`,
    changed,
  }
}
