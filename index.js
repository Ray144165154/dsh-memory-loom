/**
 * dsh-memory-loom — long-term cross-session memory and association.
 *
 * ## Shape of the plugin
 *
 * This is a **class plugin** (a `Service` subclass), not a function plugin, and
 * that is a deliberate choice rather than style. Opening the storage domain is
 * asynchronous, and `Service.init` is the one initialization hook Cordis is
 * documented to await before the plugin is considered live. A function plugin
 * with an `async apply` would return a pending promise whose resolution order is
 * not guaranteed, and registering tools or prompt hooks after an unawaited
 * `await` risks them landing too late to affect the first turn.
 *
 * ## The four stages
 *
 * 1. **Capture** — `system-prompt/assemble` fires before every model call. When
 *    the newest user message has not been mined yet, it is run through the
 *    heuristic extractor. A per-session hash of the last mined message makes
 *    this exactly once per user turn rather than once per model step.
 * 2. **Store** — records live in the harness's own storage domain
 *    (`agent_memory`, per-record JSON under `$DSH_HOME/storages`), so they
 *    survive version upgrades and are inspectable on disk.
 * 3. **Associate** — every write auto-links the new record to existing ones that
 *    share entities or tags, which is what gives the ranking function a graph to
 *    spread activation over. Without this step "联想" would be a claim, not a
 *    behaviour.
 * 4. **Recall** — the newest user message becomes the query; the top-scoring
 *    memories are rendered into a dedicated system-prompt section (order 8600,
 *    late in the prompt). The model can also search explicitly with
 *    `memory_recall`.
 *
 * @module dsh-memory-loom
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MemoryStore } from './lib/store.js'
import { createMemoryTools } from './lib/tools.js'
import { extractCandidates, memoryId } from './lib/extract.js'
import { latestUserText } from './lib/text.js'
import { backfillFromSessions } from './lib/backfill.js'
import { registerRoutes } from './lib/routes.js'

/** The system-prompt section this plugin owns. */
const SECTION = 'memory:recall'

/**
 * Placement of the memory section. `8600` sits after every tool-documentation
 * section (which top out at `TOOLS_SDK: 5000`) and before the deliverable and
 * structured-output tail, so recalled facts are the freshest context before the
 * response contract. See `SECTION_ORDERS` in `@deepseek-ai/dsh-system-prompt`.
 */
const SECTION_ORDER = 8600

/**
 * The settings namespace, and simultaneously the key the browser card is
 * registered under.
 *
 * These two values **must stay identical**, and the coupling is not obvious:
 * `settings.plugin.item` is not a free-standing card list. The Plugins settings
 * tab enumerates *registered settings namespaces* and dispatches the slot once
 * per namespace, so a card whose key matches no namespace is never rendered at
 * all — silently, with no error anywhere. That is precisely how this plugin's
 * card failed to appear on its first install.
 *
 * The namespace's schema is deliberately empty. It is an anchor, not a form:
 * this card is an observability panel (counts, recollection list, forget /
 * backfill / evict actions), and the real configuration lives in the profile's
 * `cordis.patch.yml`. Registering the twelve config keys here would render a
 * form that edits a settings document the plugin does not read — a UI that lies
 * about being connected to anything. The first-party `dsh-image-generation`
 * uses the same empty-anchor pattern.
 */
export const SETTINGS_NAMESPACE = 'memory-loom'

/** Empty anchor schema for {@link SETTINGS_NAMESPACE}. See the note above for why it is empty. */
export const SettingsAnchor = z.object({})

/**
 * Register the settings anchor on the version lines that have one.
 *
 * The settings service was **replaced** between the 0.1.x and 0.2.x lines, and
 * the difference is not cosmetic:
 *
 * - **0.1.x** — `ctx.settings.register(ns, schema, { applies })` exists, and the
 *   Plugins configuration tab enumerates registered settings namespaces,
 *   dispatching `settings.plugin.item` once per namespace. The card is keyed by
 *   the namespace, so this call is what makes it render at all.
 * - **0.2.x** — there is no `register`. `ctx.settings` is a `SettingsForms`
 *   service whose namespaces are *profile entry ids* and whose pages are
 *   generated from the plugin's own `Config`; `SettingsDescriptor.autoGenerate`
 *   documents the policy. Nothing needs registering, and the browser slot
 *   `settings.plugin.item` no longer exists anywhere in the tree (verified: zero
 *   occurrences across all 254 `@deepseek-ai` packages at 0.2.0-rc.1).
 *
 * Hence the conditional. Calling the removed method would reject
 * `Service.init`, and a tree entry that fails to activate does not merely lose
 * this plugin's features — it can fail the surrounding boot. A missing anchor
 * costs one card; a thrown `TypeError` can cost the harness.
 *
 * Feature detection rather than a version comparison on purpose: the packages
 * are versioned independently on npm (their `latest` dist-tags currently point
 * at unrelated `0.0.1-rc.x` builds), so probing the API is the only reliable
 * test.
 *
 * @param ctx - a context whose `settings` service may be either shape.
 * @returns whether an anchor was registered.
 */
export function registerSettingsAnchor(ctx) {
  const settings = ctx?.settings
  if (typeof settings?.register === 'function') {
    settings.register(SETTINGS_NAMESPACE, SettingsAnchor, { applies: 'live' })
    return true
  }
  return false
}

/**
 * Plugin configuration.
 *
 * Defaults are chosen so that an unconfigured install is useful but quiet: a
 * small recall budget, a real score floor, and auto-extraction on. The score
 * floor is the most important dial — at `0` every memory with any token overlap
 * is injected, which is worse than no memory at all.
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  recallLimit: z.natural().default(6),
  minScore: z.number().default(0.12),
  injectSection: z.boolean().default(true),
  autoExtract: z.boolean().default(true),
  autoExtractMax: z.natural().default(3),
  associationHops: z.natural().default(1),
  associationDecay: z.number().default(0.35),
  halfLifeDays: z.number().default(45),
  workspaceScoped: z.boolean().default(true),
  maxRecords: z.natural().default(5000),
  backfillSessions: z.natural().default(50),
})

/**
 * Resolve the calling session's workspace.
 *
 * `session.header.cwd` is the harness's own record of the session's working
 * directory, which is what makes workspace scoping reliable rather than a guess
 * based on the process's cwd (the desktop shell's own cwd is unrelated).
 *
 * @param session - a live session, or undefined.
 * @returns the workspace path, or an empty string when unknown.
 */
function workspaceOf(session) {
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' ? cwd : ''
}

/** Render one ISO date (YYYY-MM-DD) for the injected block. */
function dayOf(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10)
}

/**
 * The memory service (`ctx.memoryLoom`).
 *
 * Exposed as a service so other plugins can query the store without importing
 * this package's internals, and so the plugin has an identity in the loader's
 * diagnostics.
 */
export class MemoryLoom extends Service {
  /**
   * Only the three services this plugin cannot function without.
   *
   * `sessionQuery` (used by backfill) is deliberately absent: a plugin whose
   * *required* service is missing does not quietly stay dormant — a tree entry
   * that never activates fails the boot, so a profile without session query
   * would take the whole harness down instead of losing one feature. It is
   * injected optionally in `init` and degrades to a clear tool error.
   */
  static inject = ['storageDomain', 'tools', 'systemPrompt', 'settings']
  static Config = Config

  /** Content hash of the last user message mined per session id. */
  #mined = new Map()

  constructor(ctx, config) {
    super(ctx, 'memoryLoom')
    this.config = config
    this.store = undefined
  }

  /**
   * Open the store, install the prompt hook and tools, and expose the routes.
   *
   * Awaited by Cordis before the plugin is considered active, which is what
   * guarantees the tools and the prompt section exist for the very first turn.
   */
  async [Service.init]() {
    const config = this.config
    const store = new MemoryStore(this.ctx, config)
    await store.open()
    this.store = store

    // Registers the anchor the browser card hangs off, on the version lines that
    // have that mechanism. See registerSettingsAnchor() for why the call is
    // conditional.
    registerSettingsAnchor(this.ctx)

    this.ctx.systemPrompt.section({ name: SECTION, order: SECTION_ORDER, text: '' })

    this.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const assembled = await next()
      if (!config.enabled) return assembled

      const session = context?.agent?.session
      const workspace = workspaceOf(session)
      const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
      const query = latestUserText(events)

      if (config.autoExtract && query.length > 0) await this.#mine(session, workspace, query)

      if (!config.injectSection || query.length === 0) return assembled

      const candidates = store.recallFrom(query, {
        limit: config.recallLimit,
        minScore: config.minScore,
        hops: config.associationHops,
        decay: config.associationDecay,
        halfLifeDays: config.halfLifeDays,
        workspace,
        workspaceScoped: config.workspaceScoped,
      })
      // Nothing matched: contribute an empty string rather than an empty
      // heading. The tool schemas already tell the model that memory exists, so
      // a standing "no memories found" paragraph would be paid for on every
      // request and say nothing.
      if (candidates.length === 0) return assembled

      return {
        ...assembled,
        sections: assembled.sections.map((section) => section.name === SECTION
          ? { ...section, text: this.#renderBlock(candidates) }
          : section),
      }
    })

    for (const tool of createMemoryTools({
      ctx: this.ctx,
      store,
      config,
      logger: this.ctx.logger,
      backfill: this.#backfill(store),
    })) {
      this.ctx.tools.register(tool)
    }

    // The browser surface is optional: a headless profile never provides
    // `connection`, and the plugin is fully functional without a card.
    this.ctx.inject(['connection'], (childCtx) => {
      registerRoutes(childCtx, {
        store,
        config,
        logger: this.ctx.logger,
        backfill: this.#backfill(store),
      })
    })

    const stats = store.stats()
    this.ctx.logger.info('memory-loom: ready; %d live memories, %d associations', stats.live, stats.links)
  }

  /**
   * Build the backfill entry point, resolved against the optional
   * `sessionQuery` service.
   *
   * Returning a function rather than throwing at init keeps the failure at the
   * point of use: a profile without session query still gets every other
   * feature, and a model that calls `memory_backfill` is told precisely why it
   * cannot run.
   *
   * @returns an async function taking `{ workspace, limit, currentSessionId, signal }`.
   */
  #backfill(store) {
    let queryCtx
    this.ctx.inject(['sessionQuery'], (childCtx) => {
      queryCtx = childCtx
    })
    return async (options = {}) => {
      if (queryCtx === undefined) throw new Error('memory_backfill requires the sessionQuery service, which this profile does not provide')
      return backfillFromSessions(queryCtx, store, { maxPerSession: 2, ...options })
    }
  }

  /**
   * Mine one user message for durable memories.
   *
   * Guarded by a content hash per session, because this hook fires once per
   * model step and a turn can take many steps. Without the guard the same
   * sentence would be re-written to disk on every step, inflating both the write
   * volume and each record's recency.
   *
   * Failures are swallowed to a warning on purpose: memory is an enhancement,
   * and a bug in extraction must never prevent the user's request from being
   * answered.
   */
  async #mine(session, workspace, query) {
    const sessionId = typeof session?.id === 'string' ? session.id : ''
    const fingerprint = memoryId(query)
    if (this.#mined.get(sessionId) === fingerprint) return
    this.#mined.set(sessionId, fingerprint)

    try {
      for (const candidate of extractCandidates(query, { max: this.config.autoExtractMax })) {
        await this.store.upsert(candidate, { workspace, sessionId, source: 'auto', seq: -1 })
      }
      await this.store.evict()
    } catch (error) {
      this.ctx.logger.warn('memory-loom: automatic extraction failed; %s', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Render the recalled memories into prompt text.
   *
   * The framing is load-bearing in both directions: it tells the model these
   * are *not* part of the conversation (so it does not treat them as something
   * the user just said), and it establishes that the live conversation wins on
   * conflict (so a stale memory cannot override a correction).
   *
   * @param candidates - scored candidates from `store.recallFrom`.
   * @returns the section text.
   */
  #renderBlock(candidates) {
    const lines = [
      '## Long-term memory (cross-session)',
      'Durable facts recorded in earlier sessions, ranked for the current request. They are background, not part of this conversation: if one conflicts with what the user says now, the current conversation wins, and you should correct the stored memory with memory_forget or memory_remember.',
    ]
    for (const candidate of candidates) {
      const { record } = candidate
      const via = candidate.lexical > 0 ? '' : ', reached by association'
      lines.push(`- [${record.kind}] ${record.text} (score ${candidate.score.toFixed(2)}${via}, recorded ${dayOf(record.updatedAt)}, id ${record.id})`)
    }
    return lines.join('\n')
  }
}

export { MemoryLoom as default }
