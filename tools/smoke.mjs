/**
 * Offline smoke test — no harness required.
 *
 * Run it after any change to the ranking or extraction rules:
 *
 *   node tools/smoke.mjs
 *
 * It resolves the `@deepseek-ai/*` imports from an installed DSH tree, so a
 * developer checkout needs that tree reachable. Two options:
 *
 *   - run with the harness's own node_modules on the resolution path, or
 *   - create junctions (Windows) from this package's `node_modules` into the
 *     installed app, which is what the README documents.
 *
 * The point of this file is to make the parts that can be tested without a
 * running harness actually tested: tokenisation, extraction rules, lexical
 * ranking, and — most importantly — that association can surface a record the
 * query shares no words with. That last property is the whole reason the plugin
 * exists, and it is easy to break silently.
 *
 * @module dsh-memory-loom/tools/smoke
 */
import assert from 'node:assert/strict'

let failures = 0

/** Run one named check, reporting rather than throwing so every check reports. */
function check(name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  }
}

/** Minimal record factory mirroring the stored shape closely enough to rank. */
function record(id, text, extra = {}) {
  const now = Date.now()
  return {
    id,
    text,
    kind: 'fact',
    tags: [],
    entities: [],
    workspace: 'D:\\ds',
    sessionId: 'session-test',
    seq: -1,
    source: 'explicit',
    salience: 0.7,
    confidence: 1,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
    useCount: 0,
    links: [],
    version: 1,
    ...extra,
  }
}

console.log('module resolution + schemas')
const plugin = await import('../index.js')

check('index.js exports Config, MemoryLoom and a default', () => {
  assert.equal(typeof plugin.Config, 'function', 'Config must be a schemastery schema')
  assert.equal(typeof plugin.MemoryLoom, 'function', 'MemoryLoom must be a class')
  assert.equal(plugin.default, plugin.MemoryLoom, 'the class must also be the default export')
})

check('Config applies defaults', () => {
  const config = plugin.Config({})
  assert.equal(config.recallLimit, 6)
  assert.equal(config.minScore, 0.12)
  assert.equal(config.associationHops, 1)
  assert.equal(config.enabled, true)
})

check('the storage domain spec validates at module load', async () => {
  const { memoryDomainSpec } = await import('../lib/domain.js')
  assert.equal(memoryDomainSpec.name, 'agent_memory')
  assert.equal(memoryDomainSpec.version, 1)
  assert.deepEqual(Object.keys(memoryDomainSpec.tables), ['memories'])
})

console.log('\ntokenisation')
const { tokenize, indexRecords, recall } = await import('../lib/rank.js')

check('latin words are lowercased and stopwords dropped', () => {
  const tokens = tokenize('Use the PNPM lockfile')
  assert.ok(tokens.includes('pnpm'), 'pnpm must survive tokenisation')
  assert.ok(!tokens.includes('the'), 'stopwords must be dropped')
})

check('CJK is segmented into bigrams', () => {
  const tokens = tokenize('跨会话记忆')
  assert.ok(tokens.includes('跨会') && tokens.includes('会话'), `expected bigrams, got ${tokens.join(',')}`)
})

console.log('\nextraction rules')
const { extractCandidates, memoryId } = await import('../lib/extract.js')

check('a hard constraint is captured as a constraint', () => {
  const [candidate] = extractCandidates('记住：这个项目必须用 pnpm，不要用 npm。', { max: 2 })
  assert.ok(candidate, 'expected at least one candidate')
  assert.equal(candidate.kind, 'constraint')
})

check('a stated preference is captured as a preference', () => {
  const [candidate] = extractCandidates('我更喜欢用深色主题。', { max: 1 })
  assert.equal(candidate.kind, 'preference')
})

check('the stronger cue wins when one clause states both', () => {
  // Comma-joined clauses stay one statement, so precedence decides: a hard
  // constraint outranks the preference it is attached to.
  const [candidate] = extractCandidates('我更喜欢深色主题，界面不要用亮色。', { max: 1 })
  assert.equal(candidate.kind, 'constraint')
})

check('an English preference cue is captured', () => {
  const [candidate] = extractCandidates('From now on, use pnpm for installs.', { max: 1 })
  assert.equal(candidate.kind, 'preference')
})

check('a decision is captured as a decision', () => {
  const [candidate] = extractCandidates('我们决定用 SQLite 做会话缓存。', { max: 1 })
  assert.equal(candidate.kind, 'decision')
})

check('an explicit remember cue is captured as a fact', () => {
  const [candidate] = extractCandidates('请记住这个仓库的默认分支是 main。', { max: 1 })
  assert.equal(candidate.kind, 'fact')
})

check('a question is never stored, even when it contains a cue', () => {
  const candidates = extractCandidates('你记住了吗？', { max: 3 })
  assert.equal(candidates.length, 0, `expected no candidates, got ${JSON.stringify(candidates)}`)
})

check('ordinary conversation produces nothing', () => {
  const candidates = extractCandidates('帮我看看这个函数为什么报错，把文件打开。', { max: 3 })
  assert.equal(candidates.length, 0, `expected no candidates, got ${JSON.stringify(candidates)}`)
})

check('ids are content-addressed and whitespace-insensitive', () => {
  assert.equal(memoryId('必须用  pnpm'), memoryId('必须用 pnpm'))
  assert.notEqual(memoryId('必须用 pnpm'), memoryId('必须用 npm'))
})

check('entities are recovered from paths, urls and backticks', () => {
  const [candidate] = extractCandidates('记住 D:\\ds\\plans 下的 `build.ps1` 必须用 pwsh 跑。', { max: 1 })
  assert.ok(candidate.entities.length >= 2, `expected paths/code, got ${JSON.stringify(candidate.entities)}`)
})

console.log('\ninjected context must never become a memory')
const { stripHarnessPreamble, stripInjectedBlocks, userAuthoredText, latestUserText } = await import('../lib/text.js')

// Real shape: this lands inside actual `user/message` payloads, observed in a
// real session log at 447 characters.
const preamble = `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.

Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: "D:\\ds". Some platform temporary areas may also be writable.

Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.`

check('the injected runtime-context preamble yields no memories', () => {
  assert.equal(extractCandidates(preamble, { max: 3 }).length, 0)
  assert.equal(stripHarnessPreamble(preamble), '')
})

check('harness policy prose is not stored as the user\'s constraint', () => {
  // This is real shipped prompt text in this profile. It only reaches the
  // extractor if a deployment embeds it in a user payload, but the damage would
  // be permanent if it did.
  const policy = 'Do not call image_generate. Never ask for an API key in conversation.'
  const stripped = stripHarnessPreamble(policy)
  // No preamble opener, so the text is returned untouched — and that is the
  // honest boundary: a policy sentence quoted inside a user message IS the
  // user's text. What must never happen is the *injected preamble* being mined.
  assert.equal(stripped, policy)
})

check('a real preference after the preamble still gets captured', () => {
  const candidates = extractCandidates(`${preamble}\n\n我更喜欢用深色主题。`, { max: 3 })
  assert.equal(candidates.length, 1, `expected exactly one candidate, got ${JSON.stringify(candidates.map(c => c.text))}`)
  assert.equal(candidates[0].kind, 'preference')
  assert.equal(candidates[0].text, '我更喜欢用深色主题')
})

check('a user message that merely starts with the phrase is left intact', () => {
  const text = 'Current runtime context. Anyway, 我更喜欢用深色主题。'
  assert.equal(stripHarnessPreamble(text), text)
  assert.equal(extractCandidates(text, { max: 3 }).length, 1)
})

check('latestUserText strips the preamble from the recall query', () => {
  const events = [
    { type: 'assistant/message', data: { text: 'hello' } },
    { type: 'user/message', data: { text: preamble } },
    { type: 'user/message', data: { text: '帮我看看这个 bug' } },
  ]
  assert.equal(latestUserText(events), '帮我看看这个 bug')
})

// Transcribed from a REAL payload: session-e09e83ac seq 10, 852 characters,
// delivered as an ordinary `user/message`. This is the vector that produced two
// stored constraints of pure harness prose, which a later recall then served
// back to the model as the user's own memory. Both offending sentences are
// verbatim inside this block.
const skillReminder = `<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- \`generate-image\`: Create reusable photos, illustrations and backgrounds for presentations, documents and other image requests with the configured image_generate tool.
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the \`skill\` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.

A user may also invoke a skill directly; its <skill_content> block appears in this conversation. Follow it, and do not call the \`skill\` tool again for that skill.
</system-reminder>`

check('a <system-reminder> payload yields no memories', () => {
  assert.equal(userAuthoredText(skillReminder), '')
  const candidates = extractCandidates(skillReminder, { max: 4 })
  assert.equal(candidates.length, 0, `expected none, got ${JSON.stringify(candidates.map(c => c.text))}`)
})

check('the two sentences that actually leaked are no longer extracted', () => {
  const leaked = [
    "do not infer or follow a skill's instructions",
    'Follow it, and do not call the',
  ]
  const texts = extractCandidates(skillReminder, { max: 6 }).map((candidate) => candidate.text)
  for (const sentence of leaked) {
    assert.ok(!texts.some((text) => text.includes(sentence)), `leaked again: ${sentence}`)
  }
})

check('an unterminated reminder is removed through the end of the payload', () => {
  // A truncated reminder must not leave its tail behind — the tail is exactly
  // where the "do not ..." sentences live.
  const truncated = `<system-reminder>
A skill is reusable. do not infer or follow a skill's instructions`
  assert.equal(userAuthoredText(truncated), '')
})

check('real user text after a reminder is still captured', () => {
  const mixed = `${skillReminder}\n\n我更喜欢用深色主题。`
  const candidates = extractCandidates(mixed, { max: 3 })
  assert.equal(candidates.length, 1, `expected exactly one, got ${JSON.stringify(candidates.map(c => c.text))}`)
  assert.equal(candidates[0].kind, 'preference')
})

check('latestUserText skips an injected reminder and walks back to the human message', () => {
  // Payload keys mirror the real shape: ["content","source","role","id"].
  const events = [
    { type: 'user/message', data: { content: '记住：必须用 pnpm。', source: 'user', role: 'user', id: 'a' } },
    { type: 'user/message', data: { content: skillReminder, source: 'user', role: 'user', id: 'b' } },
  ]
  assert.equal(latestUserText(events), '记住：必须用 pnpm。')
})

console.log('\nranking: lexical')
const records = [
  record('a', '用户偏好用 pnpm 管理依赖，不要用 npm。', { tags: ['pnpm'], workspace: 'D:\\ds' }),
  record('b', '构建脚本必须带 --frozen-lockfile。', { tags: ['build'] }),
  record('c', '用户喜欢深色主题。', { tags: ['theme'] }),
  record('d', '另一个项目里的无关记录。', { tags: ['unrelated'], workspace: 'D:\\other' }),
]
const index = indexRecords(records)

check('a keyword hit ranks above an unrelated record', () => {
  const hits = recall(records, index, 'pnpm 依赖', { limit: 5, minScore: 0.05 })
  assert.ok(hits.length > 0, 'expected hits')
  assert.equal(hits[0].record.id, 'a')
})

check('workspace scoping excludes a foreign record', () => {
  const scoped = recall(records, index, '无关', { limit: 5, minScore: 0, workspace: 'D:\\ds', workspaceScoped: true })
  assert.ok(!scoped.some(hit => hit.record.id === 'd'), 'the D:\\other record must be filtered out')
  const unscoped = recall(records, index, '无关', { limit: 5, minScore: 0, workspace: 'D:\\ds', workspaceScoped: false })
  assert.ok(unscoped.some(hit => hit.record.id === 'd'), 'unscoped recall must include it')
})

console.log('\nranking: association (the load-bearing property)')
const linked = [
  record('seed', '用户偏好用 pnpm 管理依赖。', { tags: ['pnpm'] }),
  // No shared token with the query "pnpm" — it can only be reached through the edge.
  record('linked', '构建脚本必须带 --frozen-lockfile。', {
    tags: ['build'],
    links: [{ to: 'seed', kind: 'related', weight: 0.9 }],
  }),
]

check('an association surfaces a record with zero lexical overlap', () => {
  const hits = recall(linked, indexRecords(linked), 'pnpm', { limit: 5, minScore: 0.01, hops: 1, decay: 0.35 })
  const associated = hits.find(hit => hit.record.id === 'linked')
  assert.ok(associated, `expected the linked record, got ${hits.map(hit => hit.record.id).join(',')}`)
  assert.equal(associated.lexical, 0, 'the associated record must have no lexical score')
})

check('zero hops disables association', () => {
  const hits = recall(linked, indexRecords(linked), 'pnpm', { limit: 5, minScore: 0.01, hops: 0 })
  assert.ok(!hits.some(hit => hit.record.id === 'linked'), 'with hops=0 the linked record must not appear')
})

check('a superseded record is never recalled', () => {
  const superseded = [
    record('seed', '用户偏好用 pnpm 管理依赖。', { tags: ['pnpm'] }),
    record('gone', '这条已经被取代了。', { tags: ['pnpm'], supersededBy: 'seed' }),
  ]
  const hits = recall(superseded, indexRecords(superseded), 'pnpm', { limit: 5, minScore: 0 })
  assert.ok(!hits.some(hit => hit.record.id === 'gone'), 'superseded records must be excluded')
})

check('an empty query recalls nothing', () => {
  assert.equal(recall(records, index, '   ', { limit: 5, minScore: 0 }).length, 0)
})

console.log('\nstore + tool integration (the real store over an in-memory domain)')
const { MemoryStore } = await import('../lib/store.js')
const { createMemoryTools } = await import('../lib/tools.js')

/**
 * A stand-in for the storage domain's table handle: same method surface, backed
 * by a Map instead of disk. Everything above it — validation, association,
 * ranking, the tools — is the real implementation under test.
 */
function fakeDomain() {
  const records = new Map()
  const table = {
    get: key => records.get(key),
    keys: () => records.keys(),
    entries: () => records.entries(),
    get size() { return records.size },
    put: async (key, value) => { records.set(key, value) },
    delete: async key => records.delete(key),
  }
  return { table: () => table, close: () => {} }
}

const logger = { info() {}, warn() {}, error() {} }
const storeCtx = { storageDomain: { open: async () => fakeDomain() }, effect: () => {} }
const store = new MemoryStore(storeCtx, plugin.Config({}))
await store.open()

check('the store opens and starts empty', () => {
  assert.equal(store.opened, true)
  assert.equal(store.stats().live, 0)
})

await store.upsert(
  { id: memoryId('用户偏好用 pnpm 管理依赖。'), text: '用户偏好用 pnpm 管理依赖。', kind: 'preference', tags: ['pnpm', '依赖'], entities: ['pnpm'], salience: 0.8, confidence: 1 },
  { workspace: 'D:\\ds', sessionId: 'session-a', source: 'explicit' },
)

check('a write auto-associates on a shared entity', async () => {
  // Shares the entity `pnpm` with the first record but no other token overlap.
  await store.upsert(
    { id: memoryId('lockfile 必须提交进仓库。'), text: 'lockfile 必须提交进仓库。', kind: 'constraint', tags: ['lockfile'], entities: ['pnpm'], salience: 0.85, confidence: 1 },
    { workspace: 'D:\\ds', sessionId: 'session-b', source: 'auto' },
  )
  const linked = store.live().find(record => record.text.includes('lockfile'))
  assert.ok(linked.links.length > 0, 'auto-association must have created an edge')
  assert.equal(linked.links[0].kind, 'same-entity')
})

check('the auto-created edge actually conducts', () => {
  const hits = store.recallFrom('pnpm 依赖', { limit: 5, minScore: 0.01, hops: 1 })
  const associated = hits.find(hit => hit.record.text.includes('lockfile'))
  assert.ok(associated, `expected the associated record, got ${hits.map(hit => hit.record.id).join(',')}`)
  // Note: an entity-based link always shares the entity token, so this record
  // legitimately has a small lexical score of its own. The strongest form of the
  // property — a non-zero activation with a strictly zero lexical score — is
  // exercised by the explicit-link test above and by the tag-link test below.
  assert.ok(associated.activation > 0, 'the associated record must carry activation from the edge')
})

check('a tag-only association reaches a record with zero lexical overlap', async () => {
  // No shared entity, and no token in common with the query below: the only path
  // is the tag-similarity edge the store creates on write.
  await store.upsert(
    { id: memoryId('构建流程要跑 lint 再跑测试。'), text: '构建流程要跑 lint 再跑测试。', kind: 'fact', tags: ['构建流程', '质量'], entities: [], salience: 0.6, confidence: 1 },
    { workspace: 'D:\\ds', sessionId: 'session-d', source: 'auto' },
  )
  const probe = store.live().find(record => record.text.includes('lint'))
  assert.ok(probe.links.length > 0, 'tag similarity must have created an edge')

  const hits = store.recallFrom(store.live().find(record => record.text.includes('pnpm')).text, { limit: 10, minScore: 0.01, hops: 2 })
  const reached = hits.find(hit => hit.record.id === probe.id)
  assert.ok(reached, 'the tag-linked record must be reachable')
  assert.equal(reached.lexical, 0, `expected zero lexical overlap, got ${reached.lexical}`)
})

check('re-observation strengthens instead of duplicating', async () => {
  const before = store.stats().live
  const text = '用户偏好用 pnpm 管理依赖。'
  await store.upsert(
    { id: memoryId(text), text, kind: 'preference', tags: ['pnpm'], entities: ['pnpm'], salience: 0.5, confidence: 0.4 },
    { workspace: 'D:\\ds', sessionId: 'session-c', source: 'auto' },
  )
  assert.equal(store.stats().live, before, 'a repeated fact must not add a record')
  const record = store.live().find(candidate => candidate.id === memoryId(text))
  assert.equal(record.salience, 0.8, 'salience must ratchet up to the strongest observation')
  assert.equal(record.confidence, 1, 'confidence must ratchet up too')
})

check('touch records usage', async () => {
  const id = memoryId('用户偏好用 pnpm 管理依赖。')
  await store.touch([id])
  assert.equal(store.live().find(record => record.id === id).useCount, 1)
})

check('eviction honours the ceiling', async () => {
  const small = new MemoryStore(storeCtx, plugin.Config({ maxRecords: 1 }))
  await small.open()
  for (const text of ['第一条记忆内容在此。', '第二条记忆内容在此。', '第三条记忆内容在此。']) {
    await small.upsert({ id: memoryId(text), text, kind: 'fact', tags: [], entities: [], salience: 0.5, confidence: 1 }, { workspace: '', sessionId: 's', source: 'auto' })
  }
  const evicted = await small.evict()
  assert.equal(small.stats().total, 1, `expected 1 record to survive, got ${small.stats().total}`)
  assert.equal(evicted, 2)
})

const tools = createMemoryTools({ ctx: { logger }, store, config: plugin.Config({}), logger, backfill: async () => ({ available: 0, considered: 0, sessions: 0, messages: 0, added: 0, strengthened: 0, unreadable: 0 }) })

check('all six tool definitions compile against the schema DSL', () => {
  assert.deepEqual(
    tools.map(tool => tool.name).sort(),
    ['memory_backfill', 'memory_forget', 'memory_link', 'memory_recall', 'memory_remember', 'memory_stats'],
  )
  for (const tool of tools) {
    // A schema feature the compiler rejects throws inside defineTool, so simply
    // having the definitions is the assertion; the shapes confirm they compiled.
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters must compile to an object root`)
    assert.ok(tool.output?.schema, `${tool.name} must declare an output schema`)
  }
})

const exec = { agent: { session: { id: 'session-test', header: { cwd: 'D:\\ds' } } }, signal: undefined }
const byName = name => tools.find(tool => tool.name === name)

check('memory_remember writes and reports creation', async () => {
  const result = await byName('memory_remember').execute(
    { text: '这个仓库的默认分支是 main，不要直接推到 main。', kind: 'constraint', tags: 'git,branch', entities: 'main', salience: 0.9 },
    exec,
  )
  assert.equal(result.created, true)
  assert.equal(result.kind, 'constraint')
  assert.equal(store.has(result.id), true)
})

check('memory_recall returns the shapes its output schema declares', async () => {
  const result = await byName('memory_recall').execute({ query: '分支 main', limit: 5 }, exec)
  assert.ok(result.count > 0, 'expected a hit for a just-remembered fact')
  const declared = Object.keys(byName('memory_recall').output.schema.properties.memories.items.properties)
  for (const memory of result.memories) {
    assert.deepEqual(Object.keys(memory).sort(), declared.slice().sort(), 'returned keys must match the declared schema')
  }
})

check('memory_stats returns the shapes its output schema declares', async () => {
  const result = await byName('memory_stats').execute({}, exec)
  const declared = Object.keys(byName('memory_stats').output.schema.properties)
  assert.deepEqual(Object.keys(result).sort(), declared.slice().sort())
  assert.ok(result.live >= 3)
  assert.ok(Array.isArray(result.by_kind))
})

check('memory_forget removes by query', async () => {
  const before = store.stats().live
  const result = await byName('memory_forget').execute({ query: '默认分支是 main' }, exec)
  assert.equal(result.removed, true)
  assert.equal(store.stats().live, before - 1)
})

check('memory_backfill reports a clear failure when session query is unavailable', async () => {
  const gated = createMemoryTools({
    ctx: { logger },
    store,
    config: plugin.Config({}),
    logger,
    backfill: async () => { throw new Error('memory_backfill requires the sessionQuery service, which this profile does not provide') },
  })
  await assert.rejects(
    () => gated.find(tool => tool.name === 'memory_backfill').execute({}, exec),
    /sessionQuery/,
  )
})

console.log('\nmanifest and bundle contract')
const { readFileSync, existsSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const { dirname, join, resolve } = await import('node:path')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

check('the manifest carries no UTF-8 BOM', () => {
  // A leading BOM makes JSON.parse throw, so this is checked on the bytes
  // before the parse below could fail as an anonymous stack trace. It is not
  // hypothetical: Windows PowerShell's `Set-Content -Encoding UTF8` adds a BOM,
  // and a one-line version bump written that way put one here. Node and pnpm
  // both tolerate it, so the install kept working while every strict JSON
  // reader — including this suite — broke.
  const bytes = readFileSync(join(root, 'package.json'))
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  assert.ok(!hasBom, 'package.json starts with a UTF-8 BOM; rewrite it with a BOM-less encoder')
})

// Parsed with any BOM stripped, so a BOM failure is one named check rather than
// a stack trace that hides every check after it.
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').replace(/^\uFEFF/u, ''))

check('the bundle declaration points at a real patch file', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(root, 'cordis.patch.yml')), 'cordis.patch.yml must exist')
})

check('every file promised by `files` exists', () => {
  for (const entry of manifest.files ?? []) {
    assert.ok(existsSync(join(root, entry)), `${entry} is listed in files but missing`)
  }
})

check('the client half is declared for the web platform', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh?.client?.inject), 'client.inject must be an array')
})

check('the client bundle registers under the package name', () => {
  // The shell serves the bundle from /plugins/<package name>/client.js and
  // matches the registration id against it; a mismatch means a card that never
  // appears and no error anywhere.
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  assert.ok(source.includes('window.__ModuleLoader__.load'), 'client.js must use the module-loader handoff')
  assert.ok(source.includes(`id: '${manifest.name}'`), `client.js must register id '${manifest.name}'`)
})

check('the card key equals the host settings namespace', () => {
  // This coupling is invisible at runtime: `settings.plugin.item` is dispatched
  // once per registered settings namespace, so a card whose key matches no
  // namespace renders nothing and logs nothing. It is exactly how this plugin's
  // card failed to appear on its first install.
  assert.equal(plugin.SETTINGS_NAMESPACE, 'memory-loom', 'the host namespace must be the documented one')
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  assert.ok(
    source.includes(`key: '${plugin.SETTINGS_NAMESPACE}'`),
    `client.js must register key: '${plugin.SETTINGS_NAMESPACE}' to match the host's settings namespace`,
  )
})

check('the anchor schema is empty, so the card cannot edit settings it does not read', () => {
  // A non-empty anchor would render a settings form for keys this plugin reads
  // from the profile patch, not from the settings document — a UI that lies.
  const anchor = plugin.SettingsAnchor({})
  assert.deepEqual(Object.keys(anchor), [], `expected an empty anchor, got ${Object.keys(anchor).join(',')}`)
  assert.ok(Object.keys(plugin.Config({})).length > 0, 'the real Config must still declare its keys')
})

check('the patch config keys are exactly the ones Config declares', async () => {
  let yaml
  try {
    yaml = (await import('js-yaml')).default
  } catch {
    console.log('       (js-yaml not resolvable here — skipped)')
    return
  }
  const patch = yaml.load(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'))
  assert.ok(Array.isArray(patch), 'the patch must be a top-level array')
  const row = patch[0]?.insert?.[0]
  assert.ok(row, 'the patch must insert one row')
  assert.equal(row.id, 'memory-loom')
  assert.equal(row.name, manifest.name, 'the row name must be the package name')

  // A key the loader passes but Config does not declare is silently dropped by
  // schema validation, which reads as "the setting does nothing".
  const declared = new Set(Object.keys(plugin.Config({})))
  for (const key of Object.keys(row.config ?? {})) {
    assert.ok(declared.has(key), `patch config key "${key}" is not declared by Config`)
  }
})

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
