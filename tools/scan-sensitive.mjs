// Scan tracked (or staged) files for secrets and personal data before committing or publishing.
// Usage: node tools/scan-sensitive.mjs [--staged]
// --staged reads file contents from the git index, not the working tree.
// Exit code 1 when anything is found or a file cannot be read. Local deny list: tools/redact.local.json (gitignored).
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findSensitive, loadLocalTerms } from './redact.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const local = loadLocalTerms(join(ROOT, 'tools', 'redact.local.json'))
const staged = process.argv.includes('--staged')
const BINARY = /\.(png|jpe?g|webp|gif|ico|dll|exe|sqlite|db|wav|mp3|mp4|mkv|onnx)$/i
const MAX_BYTES = 5_000_000
// Files that intentionally contain the patterns themselves.
const SKIP = new Set(['tools/redact.mjs'])

function git(args, options = {}) {
    return execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, ...options })
}

// -z keeps non-ASCII paths (Chinese file names) unquoted.
const listArgs = staged
    ? ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']
    : ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
const files = git(listArgs, { encoding: 'utf8' }).split('\0').filter(Boolean)
// Submodule entries are gitlinks, not files.
const submodules = new Set(git(['ls-files', '-z', '--stage'], { encoding: 'utf8' }).split('\0')
    .filter(entry => entry.startsWith('160000 ')).map(entry => entry.split('\t')[1]))

function readContent(file) {
    if (staged) return git(['show', `:${file}`])
    const path = join(ROOT, file)
    if (!statSync(path).isFile()) return null
    return readFileSync(path)
}

let count = 0
let errors = 0
let checked = 0
for (const file of files) {
    if (BINARY.test(file) || SKIP.has(file) || submodules.has(file)) continue
    let buffer
    try {
        buffer = readContent(file)
    } catch (error) {
        // Deleted-but-tracked files are absent from the working tree; anything else is a failure.
        if (!staged && error.code === 'ENOENT') continue
        console.log(`${file}  read-error  ${error.message.split('\n')[0]}`)
        errors++
        continue
    }
    if (!buffer) continue
    if (buffer.length > MAX_BYTES) {
        console.log(`${file}  too-large  ${buffer.length} bytes; review manually`)
        errors++
        continue
    }
    const text = buffer.toString('utf8')
    checked++
    for (const finding of findSensitive(text, local)) {
        const line = text.slice(0, finding.index).split('\n').length
        const shown = finding.value.length > 12 ? `${finding.value.slice(0, 6)}…` : finding.value
        console.log(`${file}:${line}  ${finding.rule}  ${shown}`)
        count++
    }
}
if (count || errors) console.log(`\n${count} finding(s), ${errors} error(s).`)
else console.log(`Clean: ${checked} text file(s) checked.`)
process.exit(count || errors ? 1 : 0)
