/**
 * Retrieval scoring — the "联想" (association) half of the plugin.
 *
 * Three signals are combined:
 *
 * 1. **Lexical** — a BM25-flavoured score over `text`, `tags` and `entities`,
 *    with field weights. This is what makes an exact term ("PowerShell",
 *    "pnpm", a file path) find its memory.
 * 2. **Association** — spreading activation over the directed link graph. A
 *    memory that is not lexically similar to the query still surfaces when it
 *    is *linked* to one that is, decayed by hop count and edge weight. This is
 *    the part that produces recall the query never literally asked for.
 * 3. **Recency and usage** — exponential decay with a configurable half-life,
 *    plus a damped term for how often a memory has actually been served.
 *
 * The lexical and association terms are normalised against the strongest
 * candidate in the current result set, so the score is a *relative* ranking
 * within one query rather than an absolute relevance — which is why `minScore`
 * is a tuning dial rather than a probability.
 *
 * Pure functions only: no I/O, no DSH API. That is deliberate, so the ranking
 * can be tested without booting a harness.
 *
 * @module dsh-memory-loom/rank
 */

/** Latin/digit tokens, keeping the punctuation that appears inside real identifiers (`@scope/pkg`, `dsh-tools`, `C++`). */
const LATIN_RUN = /[a-z0-9][a-z0-9_+.#@/-]*/g

/** CJK, kana and hangul code points — segmented by bigram rather than by word, since there are no word boundaries to exploit. */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

/**
 * Deliberately short: an aggressive stopword list costs more recall than the
 * noise it removes, and BM25's idf term already discounts ubiquitous tokens.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'this', 'that',
  'have', 'has', 'had', 'was', 'were', 'will', 'would', 'can', 'could', 'should',
  'from', 'they', 'them', 'their', 'there', 'here', 'what', 'when', 'where', 'which',
  'how', 'why', 'who', 'all', 'any', 'some', 'into', 'out', 'use', 'using', 'used',
  'get', 'got', 'make', 'made', 'let', 'its', 'it\'s', 'been', 'being', 'about',
])

/** BM25 term-frequency saturation and length-normalisation constants. */
const K1 = 1.2
const B = 0.6

/** Per-field term weights: an entity hit is a stronger signal than a body-text hit. */
const FIELD_WEIGHTS = { text: 1, tags: 1.6, entities: 1.8 }

/**
 * Segment text into retrieval tokens.
 *
 * Latin runs are lowercased whole words; CJK runs are emitted as overlapping
 * bigrams (with a unigram fallback for a one-character run). Bigrams are the
 * standard cheap approximation for languages without spaces and behave well
 * under BM25.
 *
 * @param input - arbitrary text; non-strings yield no tokens.
 * @returns the token list, with duplicates preserved (term frequency is the caller's business).
 */
export function tokenize(input) {
  if (typeof input !== 'string' || input.length === 0) return []
  const text = input.normalize('NFKC').toLowerCase()
  const tokens = []

  for (const match of text.matchAll(LATIN_RUN)) {
    const token = match[0]
    if (token.length < 2 || STOPWORDS.has(token)) continue
    tokens.push(token)
  }

  let run = ''
  const flush = () => {
    if (run.length === 0) return
    if (run.length === 1) tokens.push(run)
    else for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2))
    run = ''
  }
  for (const character of text) {
    if (CJK_RUN.test(character)) run += character
    else flush()
  }
  flush()

  return tokens
}

/**
 * Build the inverted index for a record set.
 *
 * Rebuilt wholesale on change rather than maintained incrementally: the store
 * is bounded by `maxRecords` and memory is small, so an incremental index would
 * buy complexity and a class of staleness bugs for no measurable gain.
 *
 * @param records - the records to index.
 * @returns the index consumed by {@link lexicalScores}.
 */
export function indexRecords(records) {
  const index = {
    df: new Map(),
    postings: new Map(),
    tf: new Map(),
    lengths: new Map(),
    size: 0,
    totalLength: 0,
    averageLength: 1,
  }

  for (const record of records) {
    const tf = new Map()
    let length = 0
    const fields = [
      { text: record.text ?? '', weight: FIELD_WEIGHTS.text },
      { text: (record.tags ?? []).join(' '), weight: FIELD_WEIGHTS.tags },
      { text: (record.entities ?? []).join(' '), weight: FIELD_WEIGHTS.entities },
    ]
    for (const field of fields) {
      const fieldTokens = tokenize(field.text)
      length += fieldTokens.length * field.weight
      for (const token of fieldTokens) tf.set(token, (tf.get(token) ?? 0) + field.weight)
    }

    index.tf.set(record.id, tf)
    index.lengths.set(record.id, length || 1)
    index.totalLength += length
    index.size += 1

    for (const token of tf.keys()) {
      index.df.set(token, (index.df.get(token) ?? 0) + 1)
      let posting = index.postings.get(token)
      if (posting === undefined) {
        posting = new Set()
        index.postings.set(token, posting)
      }
      posting.add(record.id)
    }
  }

  index.averageLength = index.size === 0 ? 1 : index.totalLength / index.size
  return index
}

/**
 * BM25 score for every record sharing at least one token with the query.
 *
 * @param index - an index built by {@link indexRecords}.
 * @param query - the raw query text.
 * @returns record id to score; empty when nothing matches.
 */
export function lexicalScores(index, query) {
  const scores = new Map()
  if (index.size === 0) return scores
  const tokens = [...new Set(tokenize(query))]
  if (tokens.length === 0) return scores

  const total = index.size
  for (const token of tokens) {
    const posting = index.postings.get(token)
    if (posting === undefined) continue
    const df = index.df.get(token) ?? 0
    // BM25 idf with the +0.5 smoothing that keeps a term present in every
    // document from producing a zero or negative weight.
    const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
    for (const id of posting) {
      const tf = index.tf.get(id)?.get(token) ?? 0
      if (tf === 0) continue
      const length = index.lengths.get(id) ?? 1
      const normalisation = 1 - B + B * (length / index.averageLength)
      scores.set(id, (scores.get(id) ?? 0) + idf * ((tf * (K1 + 1)) / (tf + K1 * normalisation)))
    }
  }
  return scores
}

/**
 * Spread activation outward from a seed set across the link graph.
 *
 * Traversal is **direction-agnostic**: an edge conducts whether it points away
 * from the active record or toward it. The store writes symmetric edges, so in
 * practice each association exists twice — but a reader that only followed
 * outgoing edges would turn silent and lopsided the moment any writer stored a
 * one-directional edge, and that failure mode is invisible: recall just quietly
 * gets worse. Building the reverse adjacency once per call costs one pass over
 * the edges and removes the dependency entirely.
 *
 * Each hop multiplies the carried activation by the edge weight and by
 * `decay ** hop`, so a strong link to a strongly-matched memory outranks a weak
 * link to a weak one. Activation is combined with `Math.max` rather than summed,
 * so a memory reachable by several paths is not artificially inflated.
 *
 * @param seeds - record id to seed activation.
 * @param byId - record lookup, used to read links in both directions.
 * @param options - `hops` and `decay`.
 * @returns record id to activation, including the untouched seeds.
 */
export function spreadActivation(seeds, byId, options = {}) {
  const { hops = 1, decay = 0.35 } = options
  const activation = new Map(seeds)
  if (hops <= 0 || seeds.size === 0) return activation

  /** Reverse adjacency: target id to the edges pointing at it. */
  const incoming = new Map()
  for (const record of byId.values()) {
    for (const link of record.links ?? []) {
      if (!byId.has(link.to)) continue
      let bucket = incoming.get(link.to)
      if (bucket === undefined) {
        bucket = []
        incoming.set(link.to, bucket)
      }
      bucket.push({ from: record.id, weight: link.weight ?? 0 })
    }
  }

  let frontier = new Map(seeds)
  for (let hop = 1; hop <= hops; hop += 1) {
    const factor = decay ** hop
    const next = new Map()
    const raise = (id, gain) => {
      if (!(gain > 0)) return
      if (gain > (next.get(id) ?? 0)) next.set(id, gain)
    }

    for (const [id, value] of frontier) {
      const record = byId.get(id)
      if (record === undefined) continue
      for (const link of record.links ?? []) {
        if (!byId.has(link.to)) continue
        raise(link.to, value * (link.weight ?? 0) * factor)
      }
      for (const edge of incoming.get(id) ?? []) {
        raise(edge.from, value * edge.weight * factor)
      }
    }

    if (next.size === 0) break
    for (const [id, value] of next) if (value > (activation.get(id) ?? 0)) activation.set(id, value)
    frontier = next
  }

  return activation
}

/**
 * Drop near-duplicate results and cap how many memories one session may
 * contribute.
 *
 * Deduplication compares normalised text rather than ids, because the same fact
 * re-observed after a rephrase is stored under a different content hash. The
 * per-session cap stops one long session from monopolising every recall slot.
 *
 * @param candidates - scored candidates, already sorted by descending score.
 * @param limit - maximum results.
 * @returns the surviving candidates.
 */
function diversify(candidates, limit) {
  const seen = new Set()
  const perSession = new Map()
  const results = []

  for (const candidate of candidates) {
    const key = candidate.record.text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
    if (seen.has(key)) continue
    const sessionCount = perSession.get(candidate.record.sessionId) ?? 0
    if (sessionCount >= 2) continue
    seen.add(key)
    perSession.set(candidate.record.sessionId, sessionCount + 1)
    results.push(candidate)
    if (results.length >= limit) break
  }

  return results
}

/**
 * Rank the store against a query and return the memories worth showing.
 *
 * @param records - every non-superseded record in the store.
 * @param index - an index built over those records.
 * @param query - the retrieval query; an empty query returns nothing, because
 *   recall without a query is just "show me something", which is not useful.
 * @param options - ranking and filtering options (see `Config` in index.js).
 * @returns scored candidates in descending score order.
 */
export function recall(records, index, query, options = {}) {
  const {
    limit = 6,
    minScore = 0.12,
    hops = 1,
    decay = 0.35,
    halfLifeDays = 45,
    workspace = '',
    workspaceScoped = true,
    now = Date.now(),
  } = options

  const byId = new Map(records.map((record) => [record.id, record]))
  const lexical = lexicalScores(index, query)
  if (lexical.size === 0) return []

  const activation = spreadActivation(lexical, byId, { hops, decay })
  const maxLexical = Math.max(0, ...lexical.values()) || 1
  const maxActivation = Math.max(0, ...activation.values()) || 1
  const candidates = []

  for (const [id, activationValue] of activation) {
    const record = byId.get(id)
    if (record === undefined || record.supersededBy !== undefined) continue
    // A memory with no workspace is treated as global and is always eligible.
    if (workspaceScoped && workspace !== '' && record.workspace !== '' && record.workspace !== workspace) continue

    const lexicalValue = lexical.get(id) ?? 0
    const ageDays = Math.max(0, (now - Math.max(record.updatedAt, record.lastUsedAt)) / 86_400_000)
    const recency = Math.exp(-ageDays / Math.max(1, halfLifeDays))
    const usage = Math.min(1, Math.log1p(record.useCount ?? 0) / Math.log1p(10))

    const base = 0.55 * (lexicalValue / maxLexical)
      + 0.25 * (activationValue / maxActivation)
      + 0.12 * recency
      + 0.08 * usage
    // Salience and confidence scale rather than gate, so an uncertain memory
    // can still win when nothing better exists — but never silently outranks a
    // certain one at equal base score.
    const score = base * (0.4 + 0.6 * record.salience) * (0.4 + 0.6 * record.confidence)

    if (score < minScore) continue
    candidates.push({ record, score, lexical: lexicalValue, activation: activationValue, recency })
  }

  candidates.sort((left, right) => right.score - left.score)
  return diversify(candidates, Math.max(1, limit))
}
