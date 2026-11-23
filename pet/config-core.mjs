// Pure helpers for reading, diagnosing and rewriting the companion's .env.video.local.
import { randomBytes } from 'node:crypto';
import { getModelStatus, isLocalBaseUrl } from './model-status.mjs';
import { listJoin, t } from './config-i18n.mjs';

export { isLocalBaseUrl };

export const MODEL_KEYS = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL'];
export const TOKEN_KEY = 'CHARACTERLIFE_API_TOKEN';
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-flash';

const LINE = /^\s*(#+\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=＝]\s*(.*?)\s*$/;

function unquote(raw) {
    const value = raw.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === '`') && value.endsWith(quote) && value.length >= 2) {
        return value.slice(1, -1);
    }
    // Unquoted values end at an inline comment, matching node --env-file.
    return value.replace(/\s+#.*$/, '').trim();
}

// Parse env text into active values, commented-out values and per-line records.
export function parseEnv(text) {
    const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
    const active = {};
    const commented = {};
    const records = lines.map(raw => {
        const match = LINE.exec(raw);
        if (!match) return { raw };
        const commentedOut = Boolean(match[1]);
        const key = match[2];
        const value = unquote(match[3]);
        if (commentedOut) {
            if (value && !(key in commented)) commented[key] = value;
        } else {
            active[key] = value;
        }
        return { raw, key, value, commented: commentedOut };
    });
    return { records, active, commented };
}

export function maskSecret(value) {
    if (!value) return '';
    if (value.length <= 8) return '•'.repeat(value.length);
    return `${value.slice(0, 3)}${'•'.repeat(6)}${value.slice(-4)}`;
}

// Clean up typical copy-paste mistakes before validating or saving.
export function normalizeModelInput({ apiKey, baseUrl, model } = {}) {
    let key = String(apiKey ?? '').trim().replace(/^bearer\s+/i, '').replace(/^["'`]|["'`]$/g, '').trim();
    let base = String(baseUrl ?? '').trim().replace(/^["'`]|["'`]$/g, '').trim();
    base = base.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
    const name = String(model ?? '').trim().replace(/^["'`]|["'`]$/g, '').trim();
    key = key.replace(/\s+/g, '');
    return { apiKey: key, baseUrl: base, model: name };
}

export function validateModelInput(input, lang = 'zh') {
    const errors = {};
    if (!input.apiKey) {
        if (!isLocalBaseUrl(input.baseUrl)) errors.apiKey = t(lang, 'key.required');
    }
    else if (/[^\x21-\x7e]/.test(input.apiKey)) errors.apiKey = t(lang, 'key.badChars');
    if (input.baseUrl) {
        try {
            const url = new URL(input.baseUrl);
            if (!['http:', 'https:'].includes(url.protocol)) errors.baseUrl = t(lang, 'url.protocol');
            else if (url.username || url.password) errors.baseUrl = t(lang, 'url.credentials');
        } catch {
            errors.baseUrl = t(lang, 'url.invalid');
        }
    }
    if (input.model && /\s/.test(input.model)) errors.model = t(lang, 'model.spaces');
    return errors;
}

// Describe what the current file looks like so the page can explain problems in plain words.
export function diagnose({ exists, text }, lang = 'zh') {
    const problems = [];
    if (!exists) {
        problems.push({ code: 'missing-file', message: t(lang, 'problem.missingFile') });
        return { problems, values: {}, fromComment: [] };
    }
    const { active, commented } = parseEnv(text);
    const values = {};
    const fromComment = [];
    for (const key of MODEL_KEYS) {
        if (active[key]) values[key] = active[key];
        else if (commented[key]) {
            values[key] = commented[key];
            fromComment.push(key);
        }
    }
    if (fromComment.length) {
        problems.push({
            code: 'commented',
            message: t(lang, 'problem.commented', { keys: listJoin(lang, fromComment) }),
        });
    }
    const missing = MODEL_KEYS.filter(key => !(key in active) && !(key in commented));
    if (missing.length === MODEL_KEYS.length) {
        problems.push({ code: 'missing-lines', message: t(lang, 'problem.missingLines') });
    }
    const clAuth = active[TOKEN_KEY] ?? '';
    if (clAuth.length < 8) {
        problems.push({ code: 'missing-token', message: t(lang, 'problem.missingToken') });
    }
    if (/^﻿/.test(text)) {
        problems.push({ code: 'bom', message: t(lang, 'problem.bom') });
    }
    return { problems, values, fromComment };
}

export function statusFromText(text) {
    const { active } = parseEnv(text ?? '');
    return getModelStatus({ ...active, JINGJING_ALLOW_MOCK: '0' });
}

function quoteIfNeeded(value) {
    return /[\s#"'`]/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
}

// Rewrite the env text: keep unrelated lines, drop old/commented model lines, ensure a valid token.
export function renderEnv(text, input) {
    const { records, active } = parseEnv(text ?? '');
    const managed = new Set([...MODEL_KEYS, TOKEN_KEY]);
    const clAuth = active[TOKEN_KEY]?.length >= 8 ? active[TOKEN_KEY] : randomBytes(32).toString('hex');
    const kept = records
        .filter(record => !(record.key && managed.has(record.key)))
        .map(record => record.raw)
        .filter(line => !/^# Managed by the Configure page/.test(line));
    while (kept.length && !kept.at(-1).trim()) kept.pop();
    while (kept.length && !kept[0].trim()) kept.shift();
    const head = [
        '# Managed by the Configure page (Configure.cmd / CharacterCompanion.cmd setup).',
        ...[
            [TOKEN_KEY, clAuth],
            [MODEL_KEYS[0], quoteIfNeeded(input.apiKey)],
            [MODEL_KEYS[1], quoteIfNeeded(input.baseUrl || DEFAULT_BASE_URL)],
            [MODEL_KEYS[2], quoteIfNeeded(input.model || DEFAULT_MODEL)],
        ].map(pair => pair.join('=')),
    ];
    return [...head, ...(kept.length ? ['', ...kept] : []), ''].join('\n');
}
