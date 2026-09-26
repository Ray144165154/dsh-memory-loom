/**
 * The durable storage schema for long-term memory.
 *
 * Record schemas handed to `domainTable` must be **zod** schemas (the domain
 * layer projects them to RPC wire schemas later); the plugin's own `Config`
 * stays schemastery. Both facts are load-bearing — see the note in
 * `@deepseek-ai/dsh-storage-domain/src/spec`.
 *
 * `layout: 'per-record'` means the shipped JSON backend stores one document per
 * record under `$DSH_HOME/storages/agent_memory/`, so a single memory can be
 * inspected, backed up, or hand-deleted without rewriting a whole file.
 *
 * @module dsh-memory-loom/domain
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Allowed memory kinds. Kept small on purpose: a wide taxonomy nobody respects is worse than a narrow one that is applied consistently. */
export const MEMORY_KINDS = [
  'fact',
  'preference',
  'decision',
  'constraint',
  'entity',
  'task',
  'insight',
]

/** How a record entered the store. */
export const MEMORY_SOURCES = ['explicit', 'auto', 'backfill']

/** Association kinds. `related` is the default; the others carry more meaning into the prompt. */
export const LINK_KINDS = ['related', 'refines', 'contradicts', 'depends-on', 'same-entity']

/**
 * One durable memory record.
 *
 * Every field is required unless marked optional: a record written by an older
 * version is validated on load, and `invalidRecords: 'backup-and-skip'` below
 * means a record that fails here is moved aside rather than allowed to cost the
 * boot. That policy is why the schema can afford to be strict.
 */
export const memoryRecord = z.object({
  /** Stable identity derived from normalized content, so re-observing the same fact updates rather than duplicates it. */
  id: z.string().min(1),
  /** The durable statement, in the language it was observed in. */
  text: z.string().min(1),
  kind: z.enum(MEMORY_KINDS),
  /** Retrieval keywords, lowercased. */
  tags: z.array(z.string()),
  /** Paths, URLs, package names, quoted identifiers — the things worth associating on. */
  entities: z.array(z.string()),
  /** Workspace this memory belongs to (empty string when unscoped). */
  workspace: z.string(),
  /** Session the memory was first observed in. */
  sessionId: z.string(),
  /** Event sequence within that session, or -1 when it did not come from an event. */
  seq: z.number().int(),
  source: z.enum(MEMORY_SOURCES),
  /** Explicit importance, 0..1. */
  salience: z.number().min(0).max(1),
  /** Extraction confidence, 0..1. */
  confidence: z.number().min(0).max(1),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Last time this memory was served by an explicit recall. */
  lastUsedAt: z.number(),
  useCount: z.number().int().min(0),
  /** Directed association edges. Weight is 0..1. */
  links: z.array(z.object({
    to: z.string(),
    kind: z.enum(LINK_KINDS),
    weight: z.number().min(0).max(1),
  })),
  /** Set when a newer memory replaces this one; superseded records are not recalled. */
  supersededBy: z.string().optional(),
  /** Schema revision for the record body itself, independent of the domain version. */
  version: z.number().int().min(1),
})

/**
 * The `agent_memory` domain.
 *
 * `version` is bumped only when an existing record's meaning changes; purely
 * additive optional fields do not need one, because zod validation of an older
 * record would still succeed only if those fields were optional.
 */
export const memoryDomainSpec = defineDomain({
  name: 'agent_memory',
  version: 1,
  invalidRecords: 'backup-and-skip',
  layout: 'per-record',
  tables: { memories: domainTable(memoryRecord) },
})

/** Current body revision written into new records. */
export const RECORD_VERSION = 1
