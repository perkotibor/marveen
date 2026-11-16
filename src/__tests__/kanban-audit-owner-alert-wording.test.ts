// The kanban-audit task decides WHEN the owner is alerted. WHERE the alert goes is
// decided outside the skill, by the channel the install has, so the text that tells
// the agent to alert the owner must not name one. The verdict line of step 7 already
// says "OWNER ALERT" (kanban-audit-telegram-gate.test.ts pins that label); this file
// pins the sentences around it: the heading and prose of step 7, the two steps that
// send the reader there (6 and 6a), and the autonomy levels that say whom to ask.
//
// The code blocks are not read here (their verdict label has its own test, named
// above). One mention of a channel stays in the skill on purpose and is outside
// these sections: the dated incident in step 4c, where the owner asked on Telegram.
// That is a fact about that day, not a route the task takes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const HU = readFileSync(join(ROOT, 'seed-scheduled-tasks', 'kanban-audit', 'SKILL.md'), 'utf-8')
const EN = readFileSync(join(ROOT, 'i18n', 'en', 'seed-scheduled-tasks', 'kanban-audit', 'SKILL.md'), 'utf-8')

// A channel name at the start of a word, so the Hungarian case endings match too ("Telegramon", "Slacken").
const CHANNEL = /\b(telegram|slack|discord|teams)/i

const LANGS = [
  {
    lang: 'hu', skill: HU,
    heading: 'Csak akkor riaszd a tulajdonost, ha',
    step6: 'log + tulajdonosi riasztás csak akkor ha 3+ ilyen van',
    step6a: /tulajdonosi riasztásként is\s+menjen ki \(7\. pont\)/,
    hardBlocker: 'akkor kimegy tulajdonosi riasztásként.',
    propose: 'javasold a tulajdonosnak',
  },
  {
    lang: 'en', skill: EN,
    heading: 'Alert the owner only if',
    step6: 'log + owner alert only if there are 3+ of them',
    step6a: /goes out as an owner alert \(point 7\)/,
    hardBlocker: 'then it goes out as an owner alert.',
    propose: 'propose it to the owner',
  },
] as const

/** A numbered step ("7", "6a") of the procedure: from its bold title to the next step or section. */
function step(skill: string, id: string): string {
  const start = skill.search(new RegExp(`^${id}\\. \\*\\*`, 'm'))
  if (start < 0) throw new Error(`step ${id} not found in kanban-audit SKILL.md`)
  const rest = skill.slice(start + 1)
  const end = rest.search(/^(\d+[a-z]?\. \*\*|## )/m)
  return skill.slice(start, end < 0 ? undefined : start + 1 + end)
}

/** The "## " section that holds the two autonomy bullets. */
function autonomySection(skill: string): string {
  const found = skill.split(/^(?=## )/m).filter((s) => s.includes('**`kanban_archive_done`**'))
  if (found.length !== 1) throw new Error(`expected one section with the autonomy bullets, found ${found.length}`)
  return found[0]
}

/** The text without its fenced code blocks. */
function prose(text: string): string {
  return text.replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm, '')
}

for (const L of LANGS) {
  describe(`kanban-audit (${L.lang}): the text that alerts the owner does not name a channel`, () => {
    const s7 = step(L.skill, '7')

    it('the helpers read what they claim: step 7 has its two code blocks, and prose() drops them', () => {
      expect(s7.match(/python3 -c "/g)).toHaveLength(2)
      expect(prose(s7)).not.toContain('python3 -c')
      expect(prose(s7)).not.toContain('```')
      // the last bullet of the step is still there, so the cut ended where the step ends
      expect(prose(s7)).toMatch(/heartbeat/)
    })

    it('the heading of step 7 says who is alerted, not where the message is written', () => {
      const heading = s7.match(/^7\. \*\*(.+?)\*\*/)?.[1]
      expect(heading).toBe(L.heading)
    })

    it('the prose of step 7 names no channel, and the hard-blocker rule ends in the owner alert', () => {
      expect(prose(s7)).not.toMatch(CHANNEL)
      expect(prose(s7)).toContain(L.hardBlocker)
    })

    it('steps 6 and 6a, which hand their finding to step 7, name no channel', () => {
      const s6 = prose(step(L.skill, '6'))
      const s6a = prose(step(L.skill, '6a'))
      expect(s6).not.toMatch(CHANNEL)
      expect(s6).toContain(L.step6)
      expect(s6a).not.toMatch(CHANNEL)
      expect(s6a).toMatch(L.step6a)
    })

    it('the autonomy levels say whom to propose to, not on which channel', () => {
      const section = prose(autonomySection(L.skill))
      expect(section).not.toMatch(CHANNEL)
      const bullets = section.split('\n').filter((line) => /^- \*\*`kanban_(archive_done|stuck_nudge)`\*\*/.test(line))
      expect(bullets).toHaveLength(2)
      for (const bullet of bullets) expect(bullet).toContain(L.propose)
    })
  })
}
