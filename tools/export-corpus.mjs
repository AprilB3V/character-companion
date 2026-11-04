// Export desensitized corpus raw material from a local CharacterLife database and overlay event logs.
// Usage:
//   node tools/export-corpus.mjs --db <characterlife.db> [--events <overlay data/events dir>]
// Writes corpus/generated/*.jsonl (gitignored staging) and corpus/manifest.json (committed).
// Curated, publishable files under corpus/game and corpus/samples are edited by hand from this staging.
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { RULES_VERSION, loadLocalTerms, redact } from './redact.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'corpus', 'generated')
const MANIFEST_PATH = join(ROOT, 'corpus', 'manifest.json')
// Tables that hold identities, credentials or raw sessions are never read.
const EXCLUDED_TABLES = ['platform_identities', 'platform_sessions', 'binding_codes', 'identity_settings', 'sessions', 'ledger', 'processed_messages', 'context_requests']
// Memory tags dropped from export: raw speech promises and run identifiers.
const DROP_MEMORY_TAGS = new Set(['promise'])
const PRICE_HINT = /(花|买|卖|收了|进账|入账|价|信用点|房租|贿赂|罚款)/

const { values } = parseArgs({ options: {
    db: { type: 'string', default: process.env.CHARACTERLIFE_VIDEO_DB },
    events: { type: 'string', default: process.env.JINGJING_EVENTS_DIR },
} })

const local = loadLocalTerms(join(ROOT, 'tools', 'redact.local.json'))
const hitCounts = {}
function clean(text) {
    const result = redact(text ?? '', local)
    for (const hit of result.hits) hitCounts[hit] = (hitCounts[hit] ?? 0) + 1
    return result.text
}

function writeJsonl(name, rows) {
    writeFileSync(join(OUT_DIR, name), rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
    return rows.length
}

function exportMemories(dbPath) {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
        const rows = db.prepare(`SELECT kind, status, origin, trust, title, content, tags_json, created_wall
            FROM memories WHERE deleted_at_sim IS NULL ORDER BY created_wall`).all()
        const lastEventSeq = db.prepare('SELECT MAX(seq) AS seq FROM events').get().seq ?? 0
        const memories = []
        for (const row of rows) {
            const tags = JSON.parse(row.tags_json)
            if (tags.some(tag => DROP_MEMORY_TAGS.has(tag))) continue
            memories.push({
                kind: row.kind,
                status: row.status,
                origin: row.origin,
                title: clean(row.title),
                content: clean(row.content),
                // Strip run/session identifiers; keep topical tags only.
                tags: tags.filter(tag => !/^run:|[0-9a-f]{8}-[0-9a-f]{4}-/.test(tag)),
                date: row.created_wall.slice(0, 10),
            })
        }
        return { memories, total: rows.length, lastEventSeq }
    } finally {
        db.close()
    }
}

// Pair each final spoken line with the recognized utterance that preceded it.
function exportDialogues(eventsDir) {
    const pairs = []
    const files = readdirSync(eventsDir).filter(file => file.endsWith('.jsonl')).sort()
    let lines = 0
    for (const file of files) {
        let heard = null
        let thought = null
        let speaking = null
        const flush = () => {
            if (speaking?.text) {
                pairs.push({
                    date: basename(file, '.jsonl'),
                    heard: heard ? clean(heard) : null,
                    reply: clean(speaking.text),
                    emotion: speaking.emotion ?? thought?.emotion ?? null,
                    decision: thought?.decision ?? null,
                    innerOS: thought?.innerOS ? clean(thought.innerOS) : null,
                })
            }
            speaking = null
        }
        for (const raw of readFileSync(join(eventsDir, file), 'utf8').split('\n')) {
            if (!raw.trim()) continue
            lines++
            let event
            try { event = JSON.parse(raw) } catch { continue }
            if (event.type === 'asr' && event.text && event.text !== '。') {
                flush()
                heard = event.text
                thought = null
            } else if (event.type === 'thought') {
                thought = event.result ?? null
            } else if (event.type === 'overlay') {
                // Streaming emits growing prefixes; keep the longest text until the state changes.
                if (event.state === 'speaking' && event.text) {
                    if (!speaking || event.text.length >= speaking.text.length) speaking = { text: event.text, emotion: event.emotion }
                } else if (speaking) {
                    flush()
                }
            }
        }
        flush()
    }
    return { pairs, files: files.length, lines }
}

if (!values.db || !existsSync(values.db)) {
    console.error('Missing --db <characterlife.db> (or CHARACTERLIFE_VIDEO_DB).')
    process.exit(2)
}
mkdirSync(OUT_DIR, { recursive: true })

const dbStat = statSync(values.db)
const { memories, total, lastEventSeq } = exportMemories(values.db)
const outputs = {
    'memories.jsonl': writeJsonl('memories.jsonl', memories),
    'price-observations.jsonl': writeJsonl('price-observations.jsonl', memories.filter(memory => /\d/.test(memory.content) && PRICE_HINT.test(memory.content))),
}
const sources = {
    db: { file: clean(basename(values.db)), bytes: dbStat.size, modified: dbStat.mtime.toISOString(), activeMemories: total, lastEventSeq, excludedTables: EXCLUDED_TABLES },
}
if (values.events && existsSync(values.events)) {
    const { pairs, files, lines } = exportDialogues(values.events)
    outputs['dialogue-candidates.jsonl'] = writeJsonl('dialogue-candidates.jsonl', pairs)
    sources.events = { files, lines }
}

const manifest = {
    rulesVersion: RULES_VERSION,
    exportedAt: new Date().toISOString(),
    sources,
    staging: outputs,
    redactionHits: hitCounts,
    curated: {
        'corpus/game/probably-stolen.md': 'hand-curated from staging; owner-reviewed',
        'corpus/samples/dialogues.jsonl': 'selected from dialogue-candidates.jsonl',
    },
}
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 4) + '\n', 'utf8')
console.log(JSON.stringify({ staging: outputs, redactionHits: hitCounts }, null, 2))
