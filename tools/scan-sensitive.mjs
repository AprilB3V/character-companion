// Scan tracked (or staged) files for secrets and personal data before committing or publishing.
// Usage: node tools/scan-sensitive.mjs [--staged]
// Exit code 1 when anything is found. Local deny list: tools/redact.local.json (gitignored).
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findSensitive, loadLocalTerms } from './redact.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const local = loadLocalTerms(join(ROOT, 'tools', 'redact.local.json'))
const staged = process.argv.includes('--staged')
const BINARY = /\.(png|jpe?g|webp|gif|ico|dll|exe|sqlite|db|wav|mp3|mp4|mkv|onnx)$/i
// Files that intentionally contain the patterns themselves.
const SKIP = new Set(['tools/redact.mjs'])

const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['ls-files', '--cached', '--others', '--exclude-standard']
const files = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)

let count = 0
for (const file of files) {
    if (BINARY.test(file) || SKIP.has(file)) continue
    const path = join(ROOT, file)
    let stat
    try { stat = statSync(path) } catch { continue }
    if (!stat.isFile() || stat.size > 5_000_000) continue
    const text = readFileSync(path, 'utf8')
    for (const finding of findSensitive(text, local)) {
        const line = text.slice(0, finding.index).split('\n').length
        const shown = finding.value.length > 12 ? `${finding.value.slice(0, 6)}…` : finding.value
        console.log(`${file}:${line}  ${finding.rule}  ${shown}`)
        count++
    }
}
console.log(count ? `\n${count} finding(s).` : `Clean: ${files.length} file(s) checked.`)
process.exit(count ? 1 : 0)
