/**
 * The model-facing tool surface.
 *
 * Six tools, deliberately asymmetric in cost:
 *
 * - `memory_recall` and `memory_stats` are **reads** the model may call freely.
 * - `memory_remember`, `memory_link` and `memory_forget` are **writes**; the
 *   system prompt tells the model to use them only for durable facts.
 * - `memory_backfill` is the expensive one (it reads past session logs) and is
 *   marked not concurrency-safe so two invocations cannot interleave writes.
 *
 * Schema vocabulary is held to `object`/`array`/`string`/`number`/`integer`/
 * `boolean` with `required` and `additionalProperties`, and every
 * domain-constrained value (memory kind, link kind) is validated in code rather
 * than expressed as a schema `enum`. That is intentional: a schema feature the
 * compiler rejects throws at `defineTool` time, which during plugin load means a
 * harness that refuses to boot. A hand-validated string degrades to a sane
 * default instead.
 *
 * @module dsh-memory-loom/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { LINK_KINDS, MEMORY_KINDS } from './domain.js'
import { memoryId } from './extract.js'

/** Every tool's output is a single JSON text part — the harness renders it from the declared schema. */
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

/** Resolve the calling session's scope from the execution context. */
function scopeOf(exec) {
  const session = exec?.agent?.session
  return {
    workspace: session?.header?.cwd ?? '',
    sessionId: session?.id ?? '',
  }
}

/** Split a comma/、/whitespace separated user string into a clean list. */
function splitList(value, cap = 12) {
  if (typeof value !== 'string' || value.length === 0) return []
  return [...new Set(value.split(/[,，、;；\s]+/gu).map((item) => item.trim()).filter((item) => item.length > 0))].slice(0, cap)
}

/** Clamp a model-supplied integer into range, falling back when absent or malformed. */
function clampInt(value, minimum, maximum, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)))
}

/** Clamp a model-supplied number into range, falling back when absent or malformed. */
function clampNumber(value, minimum, maximum, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value))
}

/** Project a scored candidate into the shape declared by the recall output schema. */
function presentMemory(candidate) {
  return {
    id: candidate.record.id,
    text: candidate.record.text,
    kind: candidate.record.kind,
    score: Math.round(candidate.score * 1000) / 1000,
    // `association` means the memory surfaced through the link graph rather than
    // by matching the query itself — worth showing, because it is exactly the
    // recall the model would not have thought to ask for.
    via: candidate.lexical > 0 ? 'lexical' : 'association',
    workspace: candidate.record.workspace,
    session_id: candidate.record.sessionId,
    updated_at: candidate.record.updatedAt,
  }
}

/**
 * Build the tool set for one plugin instance.
 *
 * The tools close over the store rather than looking it up per call, so a
 * hot-reloaded plugin cannot leave a stale tool pointing at a closed domain.
 *
 * @param options - `ctx`, `store`, `config`, `logger`, and `backfill` (a
 *   function taking `{ workspace, limit, currentSessionId, signal }`; it throws
 *   when the profile provides no `sessionQuery`, which is reported to the model
 *   as a normal tool failure rather than costing the plugin its activation).
 * @returns registry-ready tool definitions.
 */
export function createMemoryTools({ ctx, store, config, logger, backfill }) {
  const recallTool = defineTool({
    name: 'memory_recall',
    description: 'Search long-term cross-session memory for durable facts, preferences, constraints and decisions recorded in earlier sessions. Use this when the user refers to something you may have been told before, when starting work in a familiar project, or before asking the user to repeat a preference. Results include memories reached by association, not only literal keyword matches.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to search for. Natural language or keywords; the query is tokenised, so word order and stopwords do not matter.' },
      limit: { type: 'integer', description: 'Maximum memories to return. Defaults to the configured recallLimit.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          memories: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                text: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                score: { type: 'number', required: true },
                via: { type: 'string', required: true },
                workspace: { type: 'string', required: true },
                session_id: { type: 'string', required: true },
                updated_at: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: renderJson,
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', kind: 'search', title: `Recall memory: ${String(args.query).slice(0, 60)}`, rawInput: args }),
    async execute(args, exec) {
      const scope = scopeOf(exec)
      const limit = clampInt(args.limit, 1, 25, config.recallLimit)
      const candidates = store.recallFrom(args.query, {
        limit,
        minScore: config.minScore,
        hops: config.associationHops,
        decay: config.associationDecay,
        halfLifeDays: config.halfLifeDays,
        workspace: scope.workspace,
        workspaceScoped: config.workspaceScoped,
      })
      // Usage is counted only for explicit recalls, never for prompt injection:
      // an automatically injected memory was not "used" by anyone's decision,
      // and counting it would let injection feedback-loop its own ranking.
      await store.touch(candidates.map((candidate) => candidate.record.id))
      logger.info('memory-loom: recall returned %d of %d live records', candidates.length, store.stats().live)
      return { query: args.query, count: candidates.length, memories: candidates.map(presentMemory) }
    },
  })

  const rememberTool = defineTool({
    name: 'memory_remember',
    description: 'Write one durable fact to long-term cross-session memory. Use this only for information worth carrying into future sessions: a stated preference, a constraint, a decision and its reason, a stable fact about the codebase or environment, or an entity the user will refer to again. Do NOT use it for transient task state, for anything already visible in the current conversation, or for restating the user\'s message back to them.',
    parameters: {
      text: { type: 'string', required: true, description: 'The durable statement, written as a standalone sentence that will still make sense months later without this conversation as context. Resolve pronouns.' },
      kind: { type: 'string', description: `One of: ${MEMORY_KINDS.join(', ')}. Defaults to fact.` },
      tags: { type: 'string', description: 'Comma-separated retrieval keywords, lowercase.' },
      entities: { type: 'string', description: 'Comma-separated paths, URLs, package names or identifiers this memory is about.' },
      salience: { type: 'number', description: 'Importance from 0 to 1. Use 0.8+ only for hard constraints and explicit user preferences.' },
      links: { type: 'string', description: 'Comma-separated ids of existing memories to associate this one with, from a prior memory_recall.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          created: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          linked: { type: 'integer', required: true },
        },
      },
      render: renderJson,
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', kind: 'execute', title: `Remember: ${String(args.text).slice(0, 60)}`, rawInput: args }),
    async execute(args, exec) {
      const scope = scopeOf(exec)
      const text = String(args.text ?? '').trim()
      if (text.length === 0) throw new Error('memory_remember requires non-empty text')

      const kind = MEMORY_KINDS.includes(args.kind) ? args.kind : 'fact'
      const id = memoryId(text)
      const existed = store.has(id)
      const record = await store.upsert(
        {
          id,
          text,
          kind,
          tags: splitList(args.tags, 12),
          entities: splitList(args.entities, 12),
          salience: clampNumber(args.salience, 0, 1, kind === 'constraint' ? 0.85 : 0.6),
          confidence: 1,
          source: 'explicit',
        },
        { ...scope, source: 'explicit', seq: -1 },
      )
      if (record === undefined) throw new Error('memory_remember could not store the record')

      let linked = 0
      for (const target of splitList(args.links, 24)) {
        if (await store.link(record.id, target, 'related', 0.7, { symmetric: true, skipAssociate: true })) linked += 1
      }
      await store.evict()
      logger.info('memory-loom: remembered %s (%s, %d links)', record.id, record.kind, linked)
      return { id: record.id, created: !existed, text: record.text, kind: record.kind, linked }
    },
  })

  const forgetTool = defineTool({
    name: 'memory_forget',
    description: 'Remove a memory that is wrong, outdated or no longer wanted. Identify it either by exact id (from memory_recall) or by a query, in which case the single best match is removed. Prefer this over silently ignoring a memory that has become false. By default the memory is superseded rather than deleted, which keeps the association graph intact and leaves an auditable trace.',
    parameters: {
      id: { type: 'string', description: 'Exact memory id to remove.' },
      query: { type: 'string', description: 'Used only when id is omitted: the best-matching memory for this query is removed.' },
      hard: { type: 'boolean', description: 'When true, delete the record outright instead of marking it superseded.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          text: { type: 'string', required: true },
          hard: { type: 'boolean', required: true },
        },
      },
      render: renderJson,
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', kind: 'execute', title: 'Forget memory', rawInput: args }),
    async execute(args, exec) {
      const scope = scopeOf(exec)
      let targetId = typeof args.id === 'string' && args.id.length > 0 ? args.id : ''
      let text = ''

      if (targetId === '') {
        const query = typeof args.query === 'string' ? args.query : ''
        if (query.length === 0) throw new Error('memory_forget requires either an id or a query')
        const [best] = store.recallFrom(query, {
          limit: 1,
          minScore: 0,
          hops: 0,
          workspace: scope.workspace,
          workspaceScoped: config.workspaceScoped,
        })
        if (best === undefined) return { removed: false, id: '', text: '', hard: args.hard === true }
        targetId = best.record.id
        text = best.record.text
      }

      const record = store.all().find((candidate) => candidate.id === targetId)
      if (record === undefined) return { removed: false, id: targetId, text: '', hard: args.hard === true }

      const hard = args.hard === true
      const removed = await store.forget(targetId, { hard })
      logger.info('memory-loom: forgot %s (hard=%s)', targetId, hard)
      return { removed, id: targetId, text: record.text, hard }
    },
  })

  const linkTool = defineTool({
    name: 'memory_link',
    description: 'Create an association between two memories that the automatic entity/tag association would not have found — for example a decision and the constraint that motivated it, or two facts from different projects that contradict each other. Associations are what let a later search surface a memory that shares no keywords with it.',
    parameters: {
      from: { type: 'string', required: true, description: 'Source memory id.' },
      to: { type: 'string', required: true, description: 'Target memory id.' },
      kind: { type: 'string', description: `One of: ${LINK_KINDS.join(', ')}. Defaults to related.` },
      weight: { type: 'number', description: 'Association strength from 0 to 1. Defaults to 0.7.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          linked: { type: 'boolean', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          kind: { type: 'string', required: true },
        },
      },
      render: renderJson,
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', kind: 'execute', title: 'Link memories', rawInput: args }),
    async execute(args) {
      const kind = LINK_KINDS.includes(args.kind) ? args.kind : 'related'
      const weight = clampNumber(args.weight, 0, 1, 0.7)
      const linked = await store.link(String(args.from), String(args.to), kind, weight, { symmetric: true })
      return { linked, from: String(args.from), to: String(args.to), kind }
    },
  })

  const backfillTool = defineTool({
    name: 'memory_backfill',
    description: 'Seed long-term memory by mining earlier sessions in this workspace. Run this once when memory looks empty but the user has clearly worked in this project before. It is read-heavy and may take a while, so do not call it routinely.',
    parameters: {
      limit: { type: 'integer', description: 'How many recent sessions to scan. Defaults to the configured backfillSessions.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'integer', required: true },
          considered: { type: 'integer', required: true },
          sessions: { type: 'integer', required: true },
          messages: { type: 'integer', required: true },
          added: { type: 'integer', required: true },
          strengthened: { type: 'integer', required: true },
          unreadable: { type: 'integer', required: true },
        },
      },
      render: renderJson,
    },
    timeoutMs: 240_000,
    // Writes through the same store as every other tool; two concurrent
    // backfills would interleave upserts and double-count nothing useful.
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', kind: 'execute', title: 'Backfill memory from past sessions', rawInput: args }),
    async execute(args, exec) {
      const scope = scopeOf(exec)
      const limit = clampInt(args.limit, 1, 500, config.backfillSessions)
      const result = await backfill({
        workspace: config.workspaceScoped ? scope.workspace : '',
        limit,
        currentSessionId: scope.sessionId,
        signal: exec.signal,
      })
      await store.evict()
      logger.info('memory-loom: backfill scanned %d sessions, added %d, strengthened %d', result.sessions, result.added, result.strengthened)
      return result
    },
  })

  const statsTool = defineTool({
    name: 'memory_stats',
    description: 'Report how much long-term memory is stored and what kinds it contains. Useful before deciding whether a backfill is worthwhile, or to answer a user asking what you remember.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          live: { type: 'integer', required: true },
          superseded: { type: 'integer', required: true },
          links: { type: 'integer', required: true },
          workspaces: { type: 'integer', required: true },
          by_kind: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                count: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: renderJson,
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', kind: 'read', title: 'Memory statistics' }),
    async execute() {
      const stats = store.stats()
      return {
        total: stats.total,
        live: stats.live,
        superseded: stats.superseded,
        links: stats.links,
        workspaces: stats.workspaces,
        by_kind: Object.entries(stats.byKind)
          .map(([kind, count]) => ({ kind, count }))
          .sort((left, right) => right.count - left.count),
      }
    },
  })

  return [recallTool, rememberTool, forgetTool, linkTool, backfillTool, statsTool]
}
