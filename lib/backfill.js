/**
 * Seed the memory store from sessions that already happened.
 *
 * This is what makes the memory genuinely *cross-session* on the first day:
 * without it a fresh install remembers nothing until the current conversation
 * happens to state something durable.
 *
 * Historical logs are read through `ctx.sessionQuery` rather than off disk. The
 * on-disk form is `session.jsonl.zstd` (zstd frames under a
 * `sessions/<slug>/<id>/` tree), and reading it directly would mean owning a
 * decompressor, a slug derivation, and a format version — three things the
 * harness already owns and exposes. `listSessions()` and `readSession()` work
 * regardless of the full-text index setting, which matters because the Web
 * profile ships `session-query-sqlite` with `openAt: never` (search disabled).
 *
 * @module dsh-memory-loom/backfill
 */
import { extractCandidates } from './extract.js'
import { collectText, userAuthoredText } from './text.js'

/**
 * Mine past sessions for durable memories.
 *
 * Every session that cannot be read is skipped rather than aborting the run:
 * one corrupt or half-written log must not cost the whole backfill. The counts
 * returned let the caller report partial progress honestly.
 *
 * @param ctx - the plugin context, which must carry `sessionQuery`.
 * @param store - the memory store to write into.
 * @param options - `workspace` to filter on, `limit` sessions, `maxPerSession` candidates per message, `signal`.
 * @returns counts of sessions read, messages scanned, and records added versus strengthened.
 */
export async function backfillFromSessions(ctx, store, options = {}) {
  const {
    workspace = '',
    limit = 50,
    maxPerSession = 2,
    signal,
    currentSessionId = '',
  } = options

  const listed = await ctx.sessionQuery.listSessions(signal)
  const selected = listed
    .filter((record) => typeof record?.header?.id === 'string')
    .filter((record) => record.header.id !== currentSessionId)
    // A session with no recorded cwd is kept when nothing else is known about
    // it: skipping it outright would silently shrink the corpus on older logs.
    .filter((record) => workspace === '' || record.header.cwd === undefined || record.header.cwd === workspace)
    .slice(0, Math.max(0, limit))

  let sessions = 0
  let messages = 0
  let added = 0
  let strengthened = 0
  let unreadable = 0

  for (const record of selected) {
    signal?.throwIfAborted()

    let events
    try {
      ({ events } = await ctx.sessionQuery.readSession(record.header.id))
    } catch {
      unreadable += 1
      continue
    }
    if (!Array.isArray(events)) {
      unreadable += 1
      continue
    }

    sessions += 1
    for (const event of events) {
      if (event?.type !== 'user/message') continue
      // Count only human messages: a `<system-reminder>` arrives as a
      // `user/message` too, so counting raw events would overstate the corpus.
      const text = userAuthoredText(collectText(event.data))
      if (text.length === 0) continue
      messages += 1

      for (const candidate of extractCandidates(text, { max: maxPerSession })) {
        const existed = store.has(candidate.id)
        const stored = await store.upsert(candidate, {
          workspace: record.header.cwd ?? workspace,
          sessionId: record.header.id,
          seq: typeof event.seq === 'number' ? event.seq : -1,
          source: 'backfill',
        })
        if (stored === undefined) continue
        if (existed) strengthened += 1
        else added += 1
      }
    }
  }

  return { sessions, messages, added, strengthened, unreadable, considered: selected.length, available: listed.length }
}
