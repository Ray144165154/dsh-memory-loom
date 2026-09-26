/**
 * HTTP routes backing the settings card.
 *
 * These are registered on the optional `connection` service, which only exists
 * on the browser-facing surface. A headless or CLI profile simply never
 * provides it, so the plugin loads without a card rather than failing — that is
 * why the whole module is reached through `ctx.inject(['connection'], ...)`
 * instead of a hard `inject` entry.
 *
 * Every handler is read-only except `backfill` and `forget`, which the user
 * triggers explicitly from the card.
 *
 * @module dsh-memory-loom/routes
 */

/** Bound request bodies: the card never sends more than a record id. */
const MAX_BODY_BYTES = 4_096

/** Serialise a handler result, converting a thrown error into a JSON failure rather than a 500 page. */
function json(handler) {
  return async (request) => {
    try {
      return Response.json(await handler(request), { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'memory-loom request failed'
      return Response.json({ error: message }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
  }
}

/** Read and parse a small JSON request body, rejecting an oversized one before parsing. */
async function readJson(request) {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new Error('request body too large')
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/**
 * Register the card's routes.
 *
 * @param ctx - a context that carries `connection`.
 * @param options - `store`, `config`, `backfill` (the backfill function), `logger`.
 */
export function registerRoutes(ctx, options) {
  const { store, config, backfill, logger } = options

  const register = (path, methods, handler) => ctx.connection.fetch.register({
    path,
    methods,
    requestBody: 'buffered',
    fetch: handler,
  })

  const disposers = [
    register('/api/memory-loom.stats', ['GET'], json(async () => {
      const stats = store.stats()
      // The most recently updated live records, not the best-scoring ones: the
      // card is an inventory ("what do you remember?"), so a stable newest-first
      // list is more legible than a ranking that depends on a query nobody typed.
      const recent = store.live()
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 50)
        .map((record) => ({
          id: record.id,
          text: record.text,
          kind: record.kind,
          workspace: record.workspace,
          sessionId: record.sessionId,
          source: record.source,
          links: record.links.length,
          useCount: record.useCount,
          updatedAt: record.updatedAt,
        }))
      return {
        stats: {
          total: stats.total,
          live: stats.live,
          superseded: stats.superseded,
          links: stats.links,
          workspaces: stats.workspaces,
          byKind: stats.byKind,
        },
        recent,
        config: {
          enabled: config.enabled,
          recallLimit: config.recallLimit,
          minScore: config.minScore,
          autoExtract: config.autoExtract,
          workspaceScoped: config.workspaceScoped,
          maxRecords: config.maxRecords,
          associationHops: config.associationHops,
          associationDecay: config.associationDecay,
          halfLifeDays: config.halfLifeDays,
          backfillSessions: config.backfillSessions,
        },
      }
    })),

    register('/api/memory-loom.backfill', ['POST'], json(async () => {
      const result = await backfill({
        // The card has no session, so it scans across every workspace.
        workspace: '',
        limit: config.backfillSessions,
      })
      await store.evict()
      logger.info('memory-loom: card backfill added %d, strengthened %d', result.added, result.strengthened)
      return result
    })),

    register('/api/memory-loom.forget', ['POST'], json(async (request) => {
      const body = await readJson(request)
      const id = typeof body.id === 'string' ? body.id : ''
      if (id.length === 0) throw new Error('an id is required')
      const record = store.all().find((candidate) => candidate.id === id)
      if (record === undefined) return { removed: false, id }
      const removed = await store.forget(id, { hard: body.hard === true })
      logger.info('memory-loom: card forgot %s', id)
      return { removed, id, text: record.text }
    })),

    register('/api/memory-loom.evict', ['POST'], json(async () => {
      const evicted = await store.evict()
      return { evicted, live: store.stats().live }
    })),
  ].filter((disposer) => typeof disposer === 'function')

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'memory-loom.routes')
}
