/**
 * Heuristic memory extraction.
 *
 * This module is **rule-based, not LLM-based**, and that is a deliberate
 * tradeoff rather than a shortcut:
 *
 * - it runs synchronously inside the prompt-assembly path, where an extra model
 *   call per turn would double latency and cost;
 * - it is deterministic, so a user can predict what will be remembered and
 *   audit it;
 * - a wrong guess is cheap to delete, whereas a silent LLM summariser that
 *   quietly rewrites the user's intent is not.
 *
 * The rules are therefore narrow on purpose. They claim only four kinds —
 * `preference`, `constraint`, `decision`, `fact` — and each requires an explicit
 * verbal cue. `entity`, `task` and `insight` are intentionally *not* produced
 * here; they are left to the `memory_remember` tool, where the model decides
 * with full conversational context.
 *
 * @module dsh-memory-loom/extract
 */
import { createHash } from 'node:crypto'
import { tokenize } from './rank.js'
import { userAuthoredText } from './text.js'

/**
 * Cue table, ordered by precedence: the first match wins, so a clause that both
 * states a decision and sounds like a preference is filed as the stronger one.
 */
const CUES = [
  {
    kind: 'constraint',
    salience: 0.85,
    confidence: 0.7,
    pattern: /(必须|务必|禁止|不要|不能|别再|只能|只允许|千万|绝对不)|(\bmust\b|\bnever\b|\bdo not\b|\bdon't\b|\bavoid\b|\bprohibit|\bforbidden\b|\bnot allowed\b)/iu,
  },
  {
    kind: 'preference',
    salience: 0.7,
    confidence: 0.68,
    pattern: /(我更?(喜欢|偏好|倾向|习惯|希望|想要|倾向于))|(以后(都)?(用|按|走|要))|(\bi (?:prefer|like|want)\b)|(\bprefer\b)|(\bfrom now on\b)|(\buse .{0,24} instead\b)/iu,
  },
  {
    kind: 'decision',
    salience: 0.72,
    confidence: 0.66,
    pattern: /(决定|敲定|定下来|就这么|方案(是|用)|采用|选定|最终(选|用))|(\bwe(?:'| a)?ll (?:use|go with)\b)|(\bdecided\b)|(\bgo(?:ing)? with\b)|(\bchosen\b)/iu,
  },
  {
    kind: 'fact',
    salience: 0.5,
    confidence: 0.55,
    pattern: /(记住|请记(住|下)|别忘了|备注|写下来|记一笔)|(\bremember\b)|(\bnote that\b)|(\bkeep in mind\b)|(\bdon't forget\b)|(\bfor the record\b)/iu,
  },
]

/** Entity detectors. Bare domains are excluded deliberately — `index.js` would match and it is pure noise. */
const ENTITY_PATTERNS = [
  /[A-Za-z]:\\[^\s"'`,;)]+/gu,
  /(?<![\w:])\/(?:[\w.@-]+\/)+[\w.@-]+/gu,
  /https?:\/\/[^\s"'`,)]+/gu,
  /@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/giu,
  /`([^`\n]{2,80})`/gu,
]

/** Clauses outside this length band are not worth storing. A low floor is deliberate: "不要用 npm" is a complete, useful constraint. */
const MIN_LENGTH = 6
const MAX_LENGTH = 400
/** Caps that keep one record from dominating a tokenizer pass. */
const MAX_TAGS = 12
const MAX_ENTITIES = 12

/** Filler stripped from either end so the stored statement reads as a standalone fact. */
const LEADING_FILLER = /^[\s，,。.、:：;；!！?？\-—~～]*(然后|那么|所以|另外|还有|对了|嗯|好的?|行|OK|okay|well|so|also)[\s，,。.:：;；!！]*/u
const TRAILING_FILLER = /[\s，,。.、;；!！~～]*(谢谢|多谢|thanks|thank you|please|麻烦了)[\s。.!！]*$/iu

/**
 * Split a block of text into clause candidates.
 *
 * Splitting on sentence terminators *and* newlines is what keeps a memory from
 * swallowing an entire message; a cue in one sentence must not drag the four
 * unrelated sentences around it into storage.
 *
 * @param text - raw text.
 * @returns trimmed clauses in order.
 */
function clausesOf(text) {
  return String(text)
    .normalize('NFKC')
    .split(/[。！？!?；;\n\r]+|(?<=[a-z0-9)\]"'`])\.\s+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
}

/**
 * Extract URL, path, package and quoted-literal entities from a clause.
 *
 * @param clause - one clause.
 * @returns de-duplicated entity strings, capped at {@link MAX_ENTITIES}.
 */
function entitiesOf(clause) {
  const found = new Set()
  for (const pattern of ENTITY_PATTERNS) {
    // Regexes are module-level and carry `g`, so `lastIndex` must be reset
    // before every reuse; `matchAll` clones internally, which is why it is used
    // here instead of `exec` in a loop.
    for (const match of clause.matchAll(pattern)) {
      const value = (match[1] ?? match[0]).trim()
      if (value.length < 2 || value.length > 200) continue
      found.add(value)
      if (found.size >= MAX_ENTITIES) return [...found]
    }
  }
  return [...found]
}

/**
 * Derive retrieval tags from a clause.
 *
 * @param clause - one clause.
 * @returns the most frequent distinct tokens, capped at {@link MAX_TAGS}.
 */
function tagsOf(clause) {
  const counts = new Map()
  for (const token of tokenize(clause)) counts.set(token, (counts.get(token) ?? 0) + 1)
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_TAGS)
    .map(([token]) => token)
}

/**
 * Stable identity for a memory, derived from its normalised text.
 *
 * Content addressing is what makes re-observation idempotent: seeing the same
 * preference in a later session updates the existing record (bumping its
 * counters) instead of creating a duplicate that competes with it forever.
 *
 * @param text - the memory statement.
 * @returns a 32-character hex id.
 */
export function memoryId(text) {
  const normalised = String(text).normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
  return createHash('sha256').update(normalised).digest('hex').slice(0, 32)
}

/**
 * Turn one block of text into memory candidates.
 *
 * Harness-injected text is removed first, because it reaches this function
 * inside real `user/message` payloads and reads like policy. Two vectors are
 * known from production data: the runtime-context preamble, and
 * `<system-reminder>` blocks, which is how the session's skill catalogue is
 * delivered. Without the strip, "do not …" sentences the harness wrote end up
 * stored as the user's own constraint — observed, not hypothesised.
 *
 * @param text - the text to mine (typically one user message).
 * @param options - `max` caps the returned candidates.
 * @returns partial records ready for {@link MemoryStore.upsert}.
 */
export function extractCandidates(text, options = {}) {
  const { max = 3 } = options
  if (typeof text !== 'string' || text.length === 0 || max <= 0) return []

  const candidates = []
  const claimed = new Set()

  for (const rawClause of clausesOf(userAuthoredText(text))) {
    const clause = rawClause.replace(LEADING_FILLER, '').replace(TRAILING_FILLER, '').trim()
    if (clause.length < MIN_LENGTH) continue
    if (clause.length > MAX_LENGTH) continue
    // A question is the user asking, not the user stating. Skipped before cue
    // matching, because cues appear in questions too — "你记住了吗？" contains
    // the 记住 cue and would otherwise be stored as a memory about remembering.
    if (/[?？]$/u.test(clause)) continue

    const cue = CUES.find((entry) => entry.pattern.test(clause))
    if (cue === undefined) continue

    const id = memoryId(clause)
    if (claimed.has(id)) continue
    claimed.add(id)

    candidates.push({
      id,
      text: clause,
      kind: cue.kind,
      tags: tagsOf(clause),
      entities: entitiesOf(clause),
      salience: cue.salience,
      confidence: cue.confidence,
    })

    if (candidates.length >= max) break
  }

  return candidates
}
