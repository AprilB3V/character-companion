// Shared desensitization rules for corpus export and the repository scan.
import { existsSync, readFileSync } from 'node:fs'

export const RULES_VERSION = 2

const SECRET_NAME = String.raw`[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|pwd)`

// Each rule: name, pattern (global), replacement. Order matters: specific before generic.
export const RULES = [
    { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
    { name: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: '[REDACTED_KEY]' },
    { name: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: '[REDACTED_TOKEN]' },
    { name: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED_KEY]' },
    { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, replacement: 'Bearer [REDACTED_TOKEN]' },
    // name = value / name: value / "name": "value", any case; values of 4+ characters.
    { name: 'key-assignment', pattern: new RegExp(String.raw`(["']?)(${SECRET_NAME})\1(\s*[=:]\s*)(["']?)([^\s'",;)}]{4,})\4`, 'gi'), replacement: '$1$2$1$3$4[REDACTED]$4' },
    { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[EMAIL]' },
    { name: 'windows-user-path', pattern: /([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s'"`]+/gi, replacement: '$1<user>' },
    { name: 'posix-user-path', pattern: /(\/(?:c\/)?(?:Users|home)\/)[^/\s'"`]+/g, replacement: '$1<user>' },
    { name: 'steam-id', pattern: /\b7656119\d{10}\b/g, replacement: '[STEAM_ID]' },
    { name: 'cn-mobile', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, replacement: '[PHONE]' },
    { name: 'long-secret', pattern: /\b[A-Fa-f0-9]{40,}\b/g, replacement: '[REDACTED_HEX]' },
]

// Exact placeholders produced by redaction; anything else alongside them is still checked.
const PLACEHOLDERS = new Set(['[REDACTED]', '[REDACTED_KEY]', '[REDACTED_TOKEN]', '[REDACTED_HEX]', '[REDACTED_PRIVATE_KEY]', '[EMAIL]', '[PHONE]', '[STEAM_ID]', '[NAME]', '<user>'])

// Machine-local deny list (gitignored): real names, handles, account IDs that must never appear.
// Format: { "terms": ["name", "handle"], "allow": ["exact full match value that is a false positive"] }
export function loadLocalTerms(path) {
    if (!path || !existsSync(path)) return { terms: [], allow: [] }
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return { terms: (data.terms ?? []).filter(Boolean), allow: data.allow ?? [] }
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function redact(text, local = { terms: [] }) {
    if (typeof text !== 'string') return { text, hits: [] }
    const hits = []
    let out = text
    for (const rule of RULES) {
        const single = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''))
        out = out.replace(rule.pattern, match => {
            if (rule.name === 'key-assignment' && isCodeReference(match)) return match
            hits.push(rule.name)
            return match.replace(single, rule.replacement)
        })
    }
    for (const term of local.terms) {
        out = out.replace(new RegExp(escapeRegExp(term), 'gi'), () => {
            hits.push('local-term')
            return '[NAME]'
        })
    }
    return { text: out, hits }
}

// The assigned value of a key-assignment match, without quotes.
function assignedValue(match) {
    const single = new RegExp(RULES.find(rule => rule.name === 'key-assignment').pattern.source, 'i')
    const parts = single.exec(match)
    return parts ? { value: parts[5], quoted: Boolean(parts[4]) } : { value: match, quoted: false }
}

// Code passing a variable, constant, property or env lookup rather than a literal secret:
// CONSOLE_TOKEN, options.token, process.env.X, TypeScript types. Unquoted only; letters without digits.
function isCodeReference(match) {
    const { value, quoted } = assignedValue(match)
    if (quoted) return false
    if (/^(?:process\.env\.|\$env:)/.test(value)) return true
    return /^[A-Za-z_$][A-Za-z_$]*(?:\.[A-Za-z_$][A-Za-z_$]*)*(?:\?\?|\(|$)/.test(value)
}

// Find matches without rewriting; used by the repository scan.
// Test fixtures pass only as quoted values starting with "test-"; example emails only on reserved domains.
export function findSensitive(text, local = { terms: [], allow: [] }) {
    const findings = []
    const allowed = (rule, value, index) => {
        if (PLACEHOLDERS.has(value) || local.allow.includes(value)) return true
        if (rule === 'key-assignment') {
            if (isCodeReference(value)) return true
            const assigned = assignedValue(value)
            if (PLACEHOLDERS.has(assigned.value)) return true
            if (assigned.quoted && /^test-[A-Za-z0-9-]+$/.test(assigned.value)) return true
        }
        if (rule === 'bearer' && /^Bearer\s+test-[A-Za-z0-9-]+$/.test(value)) return true
        if (rule === 'email' && /@[A-Za-z0-9.-]*\.(example|test|invalid|localhost)$/i.test(value)) return true
        if (rule === 'windows-user-path' || rule === 'posix-user-path') {
            if (/[\\/]<user>$/.test(value)) return true
        }
        if (rule === 'long-secret' && /"(sha\d+|hash|digest|commit)"\s*:\s*"$/i.test(text.slice(Math.max(0, index - 20), index))) return true
        return false
    }
    for (const rule of RULES) {
        for (const match of text.matchAll(rule.pattern)) {
            if (!allowed(rule.name, match[0], match.index)) findings.push({ rule: rule.name, value: match[0], index: match.index })
        }
    }
    for (const term of local.terms) {
        for (const match of text.matchAll(new RegExp(escapeRegExp(term), 'gi'))) {
            findings.push({ rule: 'local-term', value: match[0], index: match.index })
        }
    }
    return findings
}
