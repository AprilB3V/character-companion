// Shared desensitization rules for corpus export and the repository scan.
import { existsSync, readFileSync } from 'node:fs'

export const RULES_VERSION = 1

// Each rule: name, pattern (global), replacement. Order matters: specific before generic.
export const RULES = [
    { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
    { name: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: '[REDACTED_KEY]' },
    { name: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: '[REDACTED_TOKEN]' },
    { name: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED_KEY]' },
    { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, replacement: 'Bearer [REDACTED_TOKEN]' },
    { name: 'key-assignment', pattern: /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/g, replacement: '$1=[REDACTED]' },
    { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[EMAIL]' },
    { name: 'windows-user-path', pattern: /([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s'"`]+/gi, replacement: '$1<user>' },
    { name: 'posix-user-path', pattern: /(\/(?:c\/)?(?:Users|home)\/)[^/\s'"`]+/g, replacement: '$1<user>' },
    { name: 'steam-id', pattern: /\b7656119\d{10}\b/g, replacement: '[STEAM_ID]' },
    { name: 'cn-mobile', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, replacement: '[PHONE]' },
    { name: 'long-secret', pattern: /\b[A-Fa-f0-9]{40,}\b/g, replacement: '[REDACTED_HEX]' },
]

// Machine-local deny list (gitignored): real names, handles, account IDs that must never appear.
// Format: { "terms": ["name", "handle"], "allow": ["exact substring that is a false positive"] }
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
        out = out.replace(rule.pattern, (...match) => {
            hits.push(rule.name)
            return match[0].replace(new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '')), rule.replacement)
        })
    }
    for (const term of local.terms) {
        const pattern = new RegExp(escapeRegExp(term), 'gi')
        out = out.replace(pattern, () => {
            hits.push('local-term')
            return '[NAME]'
        })
    }
    return { text: out, hits }
}

// Find matches without rewriting; used by the repository scan.
export function findSensitive(text, local = { terms: [], allow: [] }) {
    const findings = []
    // Already-redacted placeholders are not findings.
    const allowed = value => /\[REDACTED|<user>|\[EMAIL\]/.test(value) || local.allow.some(entry => value.includes(entry))
    for (const rule of RULES) {
        for (const match of text.matchAll(rule.pattern)) {
            if (!allowed(match[0])) findings.push({ rule: rule.name, value: match[0], index: match.index })
        }
    }
    for (const term of local.terms) {
        for (const match of text.matchAll(new RegExp(escapeRegExp(term), 'gi'))) {
            findings.push({ rule: 'local-term', value: match[0], index: match.index })
        }
    }
    return findings
}
