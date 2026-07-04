import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { SKILL_MD, SKILL_NAME } from './skill-content'

// SKILL_MD is generated from glance-cli/SKILL.md by `bun run build:skill` and embedded so
// `glance skill install` can ship the skill INSIDE the binary. These pins guard the
// "edited the source but forgot to regenerate" seam.
describe('skill-content (build:skill regen)', () => {
  const source = readFileSync(join(import.meta.dir, '..', '..', 'glance-cli', 'SKILL.md'), 'utf8')

  test('SKILL-regen-matches: embedded SKILL_MD is in sync with the source SKILL.md', () => {
    expect(SKILL_MD).toBe(source)
  })

  test('SKILL-regen-matches: covers the reply command', () => {
    expect(SKILL_MD).toContain('### reply')
    expect(SKILL_MD).toContain('glance reply <space/slug> <threadId>')
  })

  test('skill name is glance-cli', () => {
    expect(SKILL_NAME).toBe('glance-cli')
  })
})
