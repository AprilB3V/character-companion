// Regression cases for the desensitization rules. Run: node --test tools/
// Secret-looking literals are assembled at runtime so this file itself scans clean.
import test from 'node:test'
import assert from 'node:assert/strict'
import { findSensitive, redact } from './redact.mjs'

const local = { terms: ['someone-handle'], allow: [] }
const rules = text => findSensitive(text, local).map(finding => finding.rule)
const fake = (...parts) => parts.join('')

test('detects real-format secrets even when they contain "test"', () => {
    assert.ok(rules(fake('gh', 'p_', 'test', 'A'.repeat(30))).includes('github-token'))
    assert.ok(rules(fake('mail latest', '@', 'company.com')).includes('email'))
})

test('detects credential assignments in many spellings', () => {
    for (const sample of [
        fake('pass', "word='hunter22'"),
        fake('api', "Key: 'abcd1234'"),
        fake('{"API_', 'TOKEN":"zz9yy8xx"}'),
        fake('DEEPSEEK_API_', 'KEY=abcd1234efgh'),
        fake('pass', 'word="ab12"'),
        fake('TOKEN=', 'ABCD1234WXYZ'),
    ]) assert.ok(rules(sample).includes('key-assignment'), sample)
})

test('placeholder prefix does not hide a trailing secret', () => {
    assert.ok(rules(fake('[REDACTED] s', 'k-', 'abcdEFGH1234567890xyz')).includes('openai-style-key'))
    assert.ok(rules(fake('TOKEN="[REDACTED]', 'abc123def"')).includes('key-assignment'))
})

test('ignores code references, quoted test fixtures and reserved example domains', () => {
    for (const sample of [
        'const CL_TOKEN = process.env.CHARACTERLIFE_API_TOKEN ?? ""',
        'CHARACTERLIFE_CONSOLE_TOKEN: CONSOLE_TOKEN,',
        'token: options.token',
        'clientSecret: this.#credentials.appSecret',
        'apiKey = env.CHARACTERLIFE_THINK_API_KEY?.trim()',
        'worldToken = opts.world?.token',
        'apiKey: env.DEEPSEEK_API_KEY!.trim()',
        'password: string',
        fake("const TOKEN = 'test-", "chat-token-123456'"),
        fake("authorization: 'Bearer test-", "chat-token-123456'"),
        'http://127.0.0.1:8790@evil.example/',
        '"sha256": "' + 'a'.repeat(64) + '"',
        'TOKEN=[REDACTED]',
    ]) assert.deepEqual(rules(sample), [], sample)
})

test('redact rewrites values and local terms', () => {
    const { text } = redact(fake('id someone-handle s', 'k-abcdEFGH1234567890xyz C:\\', 'Users\\alice\\x 138', '12345678'), local)
    assert.equal(text, 'id [NAME] [REDACTED_KEY] C:\\Users\\<user>\\x [PHONE]')
})
