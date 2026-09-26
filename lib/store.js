/**
 * The durable memory store.
 *
 * Persistence goes through the harness's own storage-domain facility
 * (`ctx.storageDomain`), which owns the write chain, durability-before-memory
 * ordering, and the JSON backend rooted at `$DSH_HOME/storages`. This module
 * deliberately does not touch the filesystem itself: doing so would bypass the
 * single-writer guarantee and could desync reads from disk.
 *
 * Reads are served from the domain's in-memory tables (synchronous), so recall
 * inside prompt assembly costs no I/O.
 *
 * @module dsh-memory-loom/store
 */
import { RECORD_VERSION, memoryDomainSpec } from './domain.js'
import { indexRecords, recall } from './rank.js'
import { memoryId } from './extract.js'

/** Maximum outgoing association edges per record, strongest kept. */
const MAX_LINKS_PER_RECORD = 24

/** Minimum tag Jaccard overlap before two memories are auto-associated. */
const TAG_LINK_THRESHOLD = 0.5

/** Clamp helper — every 0..1 field passes through this, because the storage schema rejects out-of-range values on the next load. */
const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))

/** Never let a record's id or text reach storage in a form the schema would reject. */
const truncate = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '')

/**
 * The memory store: a validated record cache, an association graph, and a
 * lazily rebuilt inverted index over both.
 */
export class MemoryStore {
  #ctx
  #config
  #domain
  #table
  #records = new Map()
  #index = null
  #opened = false

  /**
   * @param ctx - the plugin's Cordis context.
   * @param config - the validated plugin config.
   */
  constructor(ctx, config) {
    this.#ctx = ctx
    this.#config = config
  }

  /**
   * Open the domain and load every record into memory.
   *
   * Registration is idempotent with respect to Cordis disposal: the returned
   * disposer closes the domain when the plugin unloads, which is what lets a
   * hot reload swap the plugin without leaking a writer.
   *
   * @returns this store, opened.
   */
  async open() {
    this.#domain = await this.#ctx.storageDomain.open(memoryDomainSpec)
    this.#ctx.effect(() => () => this.#domain.close(), 'memory-loom.domainClose')
    this.#table = this.#domain.table('memories')
    for (const [key, value] of this.#table.entries()) this.#records.set(key, value)
    this.#opened = true
    return this
  }

  /** @returns whether the underlying domain is currently writable. */
  get opened() {
    return this.#opened
  }

  /**
   * Every stored record, including superseded ones.
   *
   * Superseded records are retained rather than deleted so that a recall never
   * silently forgets that a decision was revised; {@link live} is what filters
   * them out.
   *
   * @returns record array.
   */
  all() {
    return [...this.#records.values()]
  }

  /** @returns records eligible for recall (not superseded). */
  live() {
    return this.all().filter((record) => record.supersededBy === undefined)
  }

  /**
   * Whether a record with this id is already stored.
   *
   * Used by callers that need to distinguish "new fact learned" from "known fact
   * confirmed again" without paying for two round trips.
   *
   * @param id - the content-addressed record id.
   * @returns true when the record exists.
   */
  has(id) {
    return this.#records.has(id)
  }

  /**
   * The inverted index, rebuilt only when the record set changed.
   *
   * @returns an index over the live record set.
   */
  index() {
    if (this.#index === null) this.#index = indexRecords(this.live())
    return this.#index
  }

  /**
   * Rank this store against a query.
   *
   * The single call site every consumer goes through (prompt injection, the
   * `memory_recall` tool, the status routes), so recall semantics cannot drift
   * between surfaces.
   *
   * @param query - retrieval query text.
   * @param options - ranking overrides, forwarded to {@link recall}.
   * @returns scored candidates in descending score order.
   */
  recallFrom(query, options = {}) {
    return recall(this.live(), this.index(), query, options)
  }

  #invalidate() {
    this.#index = null
  }

  /**
   * Insert or update one memory.
   *
   * Re-observing an existing memory does not overwrite it: counters survive,
   * salience and confidence ratchet upward to the strongest observation, and
   * tags and entities merge. That keeps a fact confirmed five times stronger
   * than one seen once, which is exactly what the ranking term expects.
   *
   * @param candidate - a partial record (`text`, `kind`, and optional `tags`, `entities`, `salience`, `confidence`).
   * @param context - provenance: `workspace`, `sessionId`, `seq`, `source`.
   * @returns the stored record, or `undefined` when the candidate is unusable.
   */
  async upsert(candidate, context = {}) {
    const text = truncate(candidate?.text, 400).trim()
    if (text.length < 2) return undefined

    const id = truncate(candidate.id ?? memoryId(text), 64)
    const now = Date.now()
    const existing = this.#records.get(id)
    const source = ['explicit', 'auto', 'backfill'].includes(candidate.source)
      ? candidate.source
      : (context.source ?? 'auto')

    const record = existing === undefined
      ? {
          id,
          text,
          kind: candidate.kind ?? 'fact',
          tags: [...new Set(candidate.tags ?? [])].slice(0, 12),
          entities: [...new Set(candidate.entities ?? [])].slice(0, 12),
          workspace: truncate(context.workspace, 260),
          sessionId: truncate(context.sessionId, 80),
          seq: Number.isInteger(context.seq) ? context.seq : -1,
          source,
          salience: clamp01(candidate.salience ?? 0.5),
          confidence: clamp01(candidate.confidence ?? 0.6),
          createdAt: now,
          updatedAt: now,
          lastUsedAt: now,
          useCount: 0,
          links: [],
          version: RECORD_VERSION,
        }
      : {
          ...existing,
          kind: candidate.kind ?? existing.kind,
          tags: [...new Set([...existing.tags, ...(candidate.tags ?? [])])].slice(0, 12),
          entities: [...new Set([...existing.entities, ...(candidate.entities ?? [])])].slice(0, 12),
          salience: Math.max(existing.salience, clamp01(candidate.salience ?? existing.salience)),
          confidence: Math.max(existing.confidence, clamp01(candidate.confidence ?? existing.confidence)),
          updatedAt: now,
          // Re-observation outranks the superseded marker: the fact is live again.
          supersededBy: undefined,
        }

    this.#records.set(id, record)
    this.#invalidate()
    await this.#table.put(id, record)
    await this.#autoAssociate(record)
    return record
  }

  /**
   * Associate a freshly written record with existing ones.
   *
   * Without this the link graph stays empty and the association term in the
   * ranking function contributes nothing, which would make "联想" a claim
   * rather than a behaviour. Two signals create edges: a shared entity is a
   * strong signal (`same-entity`), and high tag overlap is a weaker one
   * (`related`).
   *
   * @param record - the record just written.
   */
  async #autoAssociate(record) {
    const recordTags = new Set(record.tags)
    const recordEntities = new Set(record.entities)
    const scored = []

    for (const other of this.#records.values()) {
      if (other.id === record.id || other.supersededBy !== undefined) continue
      const sharedEntities = other.entities.filter((entity) => recordEntities.has(entity)).length
      if (sharedEntities > 0) {
        const union = new Set([...recordEntities, ...other.entities]).size || 1
        scored.push({ to: other.id, kind: 'same-entity', weight: clamp01(0.5 + 0.4 * (sharedEntities / union)) })
        continue
      }
      const union = new Set([...recordTags, ...other.tags])
      if (union.size === 0) continue
      const intersection = [...recordTags].filter((tag) => other.tags.includes(tag)).length
      const jaccard = intersection / union.size
      if (jaccard >= TAG_LINK_THRESHOLD) scored.push({ to: other.id, kind: 'related', weight: clamp01(jaccard) })
    }

    if (scored.length === 0) return
    scored.sort((left, right) => right.weight - left.weight)

    for (const edge of scored.slice(0, MAX_LINKS_PER_RECORD)) {
      await this.link(record.id, edge.to, edge.kind, edge.weight, { symmetric: true, skipAssociate: true })
    }
  }

  /**
   * Add or strengthen one association edge.
   *
   * @param from - source record id.
   * @param to - target record id.
   * @param kind - one of {@link LINK_KINDS}.
   * @param weight - 0..1 edge weight; an existing edge keeps the stronger value.
   * @param options - `symmetric` also writes the reverse edge, `skipAssociate` suppresses re-running auto-association.
   * @returns whether both endpoints existed.
   */
  async link(from, to, kind = 'related', weight = 0.5, options = {}) {
    const source = this.#records.get(from)
    const target = this.#records.get(to)
    if (source === undefined || target === undefined || from === to) return false

    const apply = async (owner, other, linkKind, linkWeight) => {
      const links = [...owner.links]
      const index = links.findIndex((link) => link.to === other)
      if (index === -1) links.push({ to: other, kind: linkKind, weight: clamp01(linkWeight) })
      else links[index] = { ...links[index], weight: Math.max(links[index].weight, clamp01(linkWeight)) }
      links.sort((left, right) => right.weight - left.weight)
      const next = { ...owner, links: links.slice(0, MAX_LINKS_PER_RECORD), updatedAt: Date.now() }
      this.#records.set(owner.id, next)
      await this.#table.put(owner.id, next)
    }

    await apply(this.#records.get(from), to, kind, weight)
    if (options.symmetric === true) await apply(this.#records.get(to), from, kind, weight * 0.9)
    if (options.skipAssociate !== true) this.#invalidate()
    this.#invalidate()
    return true
  }

  /**
   * Mark a record as replaced by another, or delete it outright.
   *
   * Superseding is the default because a deleted memory leaves a hole in the
   * link graph; callers wanting a hard delete pass `hard: true`.
   *
   * @param id - record to remove.
   * @param options - `hard` deletes instead of superseding, `by` names the replacement.
   * @returns whether anything was removed.
   */
  async forget(id, options = {}) {
    const record = this.#records.get(id)
    if (record === undefined) return false

    if (options.hard === true) {
      this.#records.delete(id)
      this.#invalidate()
      await this.#table.delete(id)
      return true
    }

    const next = {
      ...record,
      supersededBy: truncate(options.by, 64) || 'forgotten',
      updatedAt: Date.now(),
    }
    this.#records.set(id, next)
    this.#invalidate()
    await this.#table.put(id, next)
    return true
  }

  /**
   * Record that a set of memories was actually served.
   *
   * Writes are awaited by the caller rather than fire-and-forget: the domain's
   * write chain is the durability boundary, and swallowing its rejection would
   * let the in-memory counters drift past what disk holds.
   *
   * @param ids - served record ids.
   */
  async touch(ids) {
    const now = Date.now()
    for (const id of ids) {
      const record = this.#records.get(id)
      if (record === undefined) continue
      const next = { ...record, lastUsedAt: now, useCount: record.useCount + 1 }
      this.#records.set(id, next)
      await this.#table.put(id, next)
    }
  }

  /**
   * Enforce the record ceiling by dropping the weakest memories.
   *
   * "Weakest" is salience × confidence × recency, so an old, low-confidence
   * memory is evicted before a recent high-confidence one. Superseded records
   * are always evicted first — they are history, not knowledge.
   *
   * @param limit - the ceiling; defaults to the configured `maxRecords`.
   * @returns how many records were evicted.
   */
  async evict(limit = this.#config.maxRecords) {
    const records = this.all()
    if (records.length <= limit) return 0

    const now = Date.now()
    const ranked = records.map((record) => {
      const ageDays = Math.max(0, (now - record.updatedAt) / 86_400_000)
      const recency = Math.exp(-ageDays / 90)
      const superseded = record.supersededBy === undefined ? 1 : 0
      return { record, weight: superseded * record.salience * record.confidence * recency }
    }).sort((left, right) => left.weight - right.weight)

    let evicted = 0
    for (const entry of ranked) {
      if (records.length - evicted <= limit) break
      this.#records.delete(entry.record.id)
      await this.#table.delete(entry.record.id)
      evicted += 1
    }
    if (evicted > 0) this.#invalidate()
    return evicted
  }

  /**
   * Summary counts for the settings card and the `memory_stats` tool.
   *
   * @returns totals plus a per-kind breakdown.
   */
  stats() {
    const records = this.all()
    const live = records.filter((record) => record.supersededBy === undefined)
    const byKind = {}
    for (const record of live) byKind[record.kind] = (byKind[record.kind] ?? 0) + 1
    const edgeCount = live.reduce((total, record) => total + record.links.length, 0)
    return {
      total: records.length,
      live: live.length,
      superseded: records.length - live.length,
      links: edgeCount,
      workspaces: [...new Set(live.map((record) => record.workspace).filter((value) => value !== ''))].length,
      byKind,
    }
  }
}
