/**
 * Defensive text recovery from session event payloads.
 *
 * The message payload shape is owned by the session format and may carry text
 * in more than one place depending on the producer (a plain user turn, a
 * command, a tool result, a delegated subagent turn). Rather than pin a shape
 * that a format bump could invalidate, this walks the value and collects the
 * strings it finds, skipping keys that are structurally noise.
 *
 * The tradeoff is explicit: a looser collector occasionally includes a little
 * framing text, while a stricter one silently drops the sentence the user
 * actually wanted remembered. For memory extraction the first failure is
 * recoverable (delete the record) and the second is not (the fact is lost).
 *
 * @module dsh-memory-loom/text
 */

/** Keys whose values are never conversational text. */
const SKIP_KEYS = new Set([
  'id', 'type', 'role', 'source', 'sha256', 'base64', 'dataUrl', 'dataURL',
  'mimeType', 'mediaType', 'signature', 'provider', 'model', 'callId',
  'toolCallId', 'toolName', 'seq', 'version', 'createdAt', 'updatedAt',
])

/** Stop before a pathological payload can allocate unbounded memory. */
const DEFAULT_BUDGET = 20_000

/** The exact opener of the harness's injected runtime-context preamble. */
const PREAMBLE_OPENER = /^\s*Current runtime context\./iu

/**
 * Markers identifying one paragraph of that preamble.
 *
 * The list is deliberately about *shape* ("a policy paragraph the harness
 * generated"), not about any particular policy sentence, so it does not go
 * stale when a deployment changes its wording.
 */
const PREAMBLE_BLOCK = /(runtime[- ]context snapshot|file policy|approval policy|session workspace|fails closed|answerers?|sandbox may modify)/iu

/**
 * Remove the harness's injected runtime-context preamble from a message payload.
 *
 * This exists because of an observed false positive, not a hypothetical one: a
 * real `user/message` event carried 447 characters of preamble, and injected
 * text is indistinguishable from user speech once it reaches the extractor.
 * Any deployment whose preamble wording includes a policy sentence ("you must
 * …", "do not …") would otherwise have that boilerplate stored as the *user's*
 * durable constraint — permanently, and with the user's name on it.
 *
 * The strip is conservative by construction: it requires the exact documented
 * opener, removes only leading paragraphs that look like preamble blocks, and
 * returns everything after them untouched. If the opener is absent the text is
 * returned unchanged, so ordinary user speech can never be truncated by
 * accident.
 *
 * @param text - the recovered message text.
 * @returns the text with a leading runtime-context preamble removed.
 */
export function stripHarnessPreamble(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  if (!PREAMBLE_OPENER.test(text)) return text
  const blocks = text.split(/\n{2,}/u)
  let index = 0
  while (index < blocks.length && PREAMBLE_BLOCK.test(blocks[index])) index += 1
  return blocks.slice(index).join('\n\n').trim()
}

/**
 * Harness control blocks that the harness delivers **as ordinary
 * `user/message` events**.
 *
 * This vector was found in production data, not by reading the code: a real
 * session's third `user/message` event was an 852-character `<system-reminder>`
 * carrying the session's skill catalogue and the sentence "do not infer or
 * follow a skill's instructions until it has been loaded". At the event level it
 * is indistinguishable from something the user typed. It produced two stored
 * "constraints" that were pure harness prose, which a later recall then served
 * back to the model as the user's own long-term memory.
 *
 * An earlier revision of this module asserted that injected *prompt sections*
 * never reach a `user/message` payload. That assertion was wrong; matching on
 * the wrapper tag — a structural marker rather than a guess at wording — is the
 * correction.
 */
const INJECTED_BLOCK = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/giu

/**
 * Remove harness-injected control blocks from a message payload.
 *
 * An unterminated block is removed through the end of the payload rather than
 * left behind: a truncated reminder would otherwise leak exactly the tail this
 * guards against.
 *
 * @param text - the recovered message text.
 * @returns the text with `<system-reminder>` blocks removed.
 */
export function stripInjectedBlocks(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text.replace(INJECTED_BLOCK, ' ').trim()
}

/**
 * Reduce a recovered payload to the text a human actually authored.
 *
 * The single entry point every consumer should use. Two vectors are known and
 * both are handled here: the runtime-context preamble and `<system-reminder>`
 * blocks. A message that is entirely injected reduces to an empty string, which
 * callers treat as "no user text" rather than as empty speech.
 *
 * @param text - the recovered message text.
 * @returns the user-authored remainder, possibly empty.
 */
export function userAuthoredText(text) {
  return stripHarnessPreamble(stripInjectedBlocks(text))
}

/**
 * Collect conversational text from an arbitrary session payload.
 *
 * @param value - the payload to walk.
 * @param budget - maximum characters to collect.
 * @returns the recovered text, joined with newlines.
 */
export function collectText(value, budget = DEFAULT_BUDGET) {
  const parts = []
  let used = 0

  const visit = (node) => {
    if (used >= budget || node === null || node === undefined) return
    if (typeof node === 'string') {
      if (node.length === 0) return
      const slice = node.slice(0, budget - used)
      parts.push(slice)
      used += slice.length
      return
    }
    if (typeof node === 'number' || typeof node === 'boolean') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node !== 'object') return
    for (const [key, item] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue
      visit(item)
    }
  }

  visit(value)
  return parts.join('\n').trim()
}

/**
 * Read the most recent user-authored message from a session's event list.
 *
 * Used by the prompt-assembly hook: at the moment a model call is assembled, the
 * newest *human* message is the request memory should be relevant to.
 *
 * Skipping matters as much as stripping here. A harness-injected
 * `<system-reminder>` is delivered as the newest `user/message` in a turn, so
 * taking the newest non-empty payload verbatim would make the injected skill
 * catalogue the recall query — searching long-term memory for harness prose.
 * Empty after sanitising therefore means "keep looking further back", not
 * "empty speech".
 *
 * @param events - session events in ascending `seq` order.
 * @returns the recovered request text, or an empty string when there is none.
 */
export function latestUserText(events) {
  if (!Array.isArray(events)) return ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const text = userAuthoredText(collectText(event.data))
    if (text.length > 0) return text
  }
  return ''
}
