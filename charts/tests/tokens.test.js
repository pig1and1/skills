// Every `var(--chart-*)` referenced by a renderer must be declared in theme.css.
//
// Why this earns a test: the renderers deliberately own no colours -- they only
// reference tokens. That turns a typo or an invented token into a *silent*
// failure. `var(--chart-accent-soft)` on an undeclared name resolves to nothing,
// so the element paints with no colour at all, nothing throws, and a screenshot
// still looks plausible.
//
// This is not hypothetical. Two renderers in this repo shipped referencing
// tokens that were never declared.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'src')

/** Token names declared in theme.css, e.g. --chart-cat-1. */
function declaredTokens() {
  const css = readFileSync(join(src, 'theme.css'), 'utf8')
  const names = new Set()
  for (const m of css.matchAll(/(--chart-[a-z0-9-]+)\s*:/g)) names.add(m[1])
  return names
}

/**
 * Token names referenced from renderer source, mapped to the files using them.
 *
 * A name ending in `-` means the call site was assembled at runtime
 * (`'var(--chart-cat-' + i + ')'`), which cannot be checked statically; those
 * are skipped rather than reported, so this test never cries wolf.
 */
function referencedTokens() {
  const used = new Map()
  for (const file of readdirSync(src)) {
    if (!file.endsWith('.js')) continue
    const text = readFileSync(join(src, file), 'utf8')
    for (const m of text.matchAll(/var\((--chart-[a-z0-9-]+)/g)) {
      const name = m[1]
      if (name.endsWith('-')) continue
      if (!used.has(name)) used.set(name, new Set())
      used.get(name).add(file)
    }
  }
  return used
}

// Guard the guard: if either side of the comparison comes back empty, the real
// assertion below would pass on any input at all and prove nothing.
test('the palette and its consumers are both non-trivial', () => {
  const declared = declaredTokens()
  const used = referencedTokens()
  assert.ok(declared.size > 20, `theme.css declares only ${declared.size} tokens -- did it move?`)
  assert.ok(used.size > 10, `renderers reference only ${used.size} tokens -- are they reading theme.css at all?`)
})

test('every referenced --chart-* token is declared in theme.css', () => {
  const declared = declaredTokens()
  const missing = []
  for (const [name, files] of referencedTokens()) {
    if (!declared.has(name)) missing.push(`${name}  <- ${[...files].join(', ')}`)
  }
  assert.deepEqual(missing, [], `undeclared tokens:\n  ${missing.join('\n  ')}`)
})
