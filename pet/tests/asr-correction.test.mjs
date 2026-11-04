import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsrCorrector, acceptCorrection, applyGlossary, editDistance, normalizeGlossary } from '../asr-correction.mjs';

const MODEL = { baseUrl: 'http://model.test/v1', apiKey: 'test-only', model: 'test-model' };

function scripted(reply, calls = []) {
    return async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        if (reply instanceof Error) throw reply;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: reply }) } }] }), { status: 200 });
    };
}

function setup(glossary) {
    const dir = mkdtempSync(join(tmpdir(), 'asr-fix-'));
    const path = join(dir, 'asr-glossary.json');
    if (glossary) writeFileSync(path, JSON.stringify(glossary), 'utf8');
    return { dir, path, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('glossary replaces known misrecognitions, longest variant first', () => {
    const glossary = normalizeGlossary({ replacements: [{ from: ['一平如洗'], to: '一贫如洗' }, { from: ['井', '井井'], to: '鲸鲸' }] });
    const result = applyGlossary('井井说我们一平如洗开局', glossary);
    assert.equal(result.text, '鲸鲸说我们一贫如洗开局');
    assert.equal(result.changes.length, 2);
});

test('model corrections are accepted only as small edits', () => {
    assert.equal(editDistance('一平如洗', '一贫如洗'), 1);
    assert.ok(acceptCorrection('我们也一平如洗开局', '我们也一贫如洗开局'));
    assert.ok(!acceptCorrection('测试连接', '连接正常，我这边能听到你说话。'), 'answers are rejected');
    assert.ok(!acceptCorrection('今天玩什么', ''));
});

test('model pass corrects with hints, and falls back on failure, rewrite or disabled flag', async () => {
    const ctx = setup({ llm: true, replacements: [], hints: ['治安官'] });
    try {
        const calls = [];
        const fixer = new AsrCorrector({ glossaryPath: ctx.path, extraHints: ['卡特尔'], model: MODEL, fetchImpl: scripted('治安官来了', calls) });
        const fixed = await fixer.correct('之安官来了');
        assert.equal(fixed.text, '治安官来了');
        assert.equal(fixed.model, 'corrected');
        assert.equal(fixed.original, '之安官来了');
        assert.match(calls[0].body.messages[0].content, /治安官、卡特尔/);
        assert.equal(calls[0].body.temperature, 0);

        const failing = new AsrCorrector({ glossaryPath: ctx.path, model: MODEL, fetchImpl: scripted(new Error('timeout')) });
        assert.deepEqual(await failing.correct('之安官来了').then(result => [result.text, result.model]), ['之安官来了', 'failed']);

        const rewriting = new AsrCorrector({ glossaryPath: ctx.path, model: MODEL, fetchImpl: scripted('好的，我来帮你看看治安官的情况吧') });
        assert.deepEqual(await rewriting.correct('之安官来了').then(result => [result.text, result.model]), ['之安官来了', 'rejected']);

        writeFileSync(ctx.path, JSON.stringify({ llm: false, replacements: [{ from: ['之安官'], to: '治安官' }] }), 'utf8');
        const offCalls = [];
        const disabled = new AsrCorrector({ glossaryPath: ctx.path, model: MODEL, fetchImpl: scripted('不应调用', offCalls) });
        const result = await disabled.correct('之安官来了');
        assert.equal(result.text, '治安官来了');
        assert.equal(result.model, 'off');
        assert.equal(offCalls.length, 0);
    } finally { ctx.done(); }
});

test('missing credentials or glossary keep the recognized text and defaults', async () => {
    const ctx = setup(null);
    try {
        const fixer = new AsrCorrector({ glossaryPath: ctx.path, model: { baseUrl: '', apiKey: '', model: '' } });
        const result = await fixer.correct('我们也一平如洗开局');
        assert.equal(result.text, '我们也一贫如洗开局', 'built-in glossary still applies');
        assert.equal(result.model, 'off');
    } finally { ctx.done(); }
});

test('corpus terms are loaded from text files and picked by character overlap with the utterance', async () => {
    const { loadCorpus, relevantTerms } = await import('../asr-correction.mjs');
    const ctx = setup(null);
    try {
        writeFileSync(join(ctx.dir, 'game.txt'), '# local only\n深空当铺\n治安部盘查员\n卡特尔接头人\n梦尘\n', 'utf8');
        const corpus = await loadCorpus(ctx.dir);
        assert.deepEqual(corpus.sort(), ['卡特尔接头人', '梦尘', '治安部盘查员', '深空当铺']);
        const picked = relevantTerms('今天我们来到了升空当铺，治安部的人来了', corpus);
        assert.ok(picked.includes('深空当铺'), 'homophone-damaged title still matches');
        assert.ok(picked.includes('治安部盘查员'));
        assert.ok(!picked.includes('卡特尔接头人'));
        const calls = [];
        const fixer = new AsrCorrector({ glossaryPath: join(ctx.dir, 'none.json'), corpus, model: MODEL, fetchImpl: scripted('今天我们来到了深空当铺', calls) });
        await fixer.correct('今天我们来到了深空党铺');
        assert.match(calls[0].body.messages[0].content, /深空当铺/);
    } finally { ctx.done(); }
});
