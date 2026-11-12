import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProactiveRunner, proactiveInputs, FOCUS_PREFIX } from '../proactive-runner.mjs';
import { DEFAULT_PROACTIVE_CONFIG } from '../../vendor/CharacterLife-VideoCohost/examples/video-cohost/events/config.ts';

const settings = DEFAULT_PROACTIVE_CONFIG.proactive;
const at = ms => new Date(ms).toISOString();
const sale = (id, ms) => ({ id, ts: 1, wall_time: at(ms), source: 'game', importance: 0.7,
    type: 'transaction', payload: { kind: 'sell', item: '手表', price: 900, counterparty: '老张', profit: 600 } });
const fine = (id, ms) => ({ id, ts: 1, wall_time: at(ms), source: 'game', importance: 0.8,
    type: 'credit_change', payload: { delta: -600, balance_before: 1000, balance_after: 400, reason: 'unknown', counterparty: null } });
const line = event => `${JSON.stringify(event)}\n`;

async function harness({ busy = () => false, decision = { should_speak: true, utterance: '这块表卖得值。', reason: '利润高' } } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'jj-proactive-'));
    const eventsDir = join(root, 'events');
    const logDir = join(root, 'log');
    let now = 1_800_000_000_000;
    const calls = [];
    const runner = new ProactiveRunner({ settings, eventsDir, logDir, now: () => now, isBusy: busy,
        think: async inputs => { calls.push(inputs); return decision; } });
    await mkdir(eventsDir, { recursive: true });
    const file = join(eventsDir, 'run.jsonl');
    await writeFile(file, '');
    return {
        runner, calls, file, root,
        advance: ms => { now += ms; },
        now: () => now,
        log: async () => {
            const names = await readdir(logDir).catch(() => []);
            if (!names.length) return [];
            return (await readFile(join(logDir, names[0]), 'utf8')).trim().split('\n').map(text => JSON.parse(text));
        },
        close: () => rm(root, { recursive: true, force: true }),
    };
}

test('inputs say why she is thinking, then what happened, as event inputs', () => {
    const inputs = proactiveInputs({ triggers: [{ kind: 'post_transaction', reason: 'x', eventId: 's1' }],
        events: [sale('s1', 0), { ...fine('f1', 0), importance: 0.1 }], willingness: 1.2 });
    assert.deepEqual(inputs, [
        { kind: 'event', text: '刚做完一笔交易' },
        { kind: 'event', text: '卖出 手表 给 老张，收款 900，利润 600' },
    ], 'low-importance events stay out');
});

test('the event the arbiter picked comes first and is not repeated among the rest', () => {
    const inputs = proactiveInputs({ triggers: [{ kind: 'event', reason: 'x', eventId: 'f1' }],
        events: [fine('f1', 0), sale('s1', 0)], willingness: 1.2 });
    assert.equal(inputs.length, 2);
    assert.ok(inputs[0].text.startsWith(FOCUS_PREFIX));
    assert.equal(inputs[1].text, '卖出 手表 给 老张，收款 900，利润 600');
});

test('a sale in the live feed leads to one post-transaction thought and a logged spoken line', async () => {
    const h = await harness();
    try {
        await h.runner.tick();
        await appendFile(h.file, line(sale('s1', h.now())));
        await h.runner.tick();
        assert.equal(h.calls.length, 0, 'not yet: a trade is commented 2-5 s after it settles');
        h.advance(3000);
        await h.runner.tick();
        assert.equal(h.calls.length, 1);
        assert.equal(h.calls[0][0].text, '刚做完一笔交易');
        h.advance(1000);
        await h.runner.tick();
        assert.equal(h.calls.length, 1, 'once per trade');
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.deepEqual((await h.log()).map(entry => entry.stage), ['trigger', 'gate', 'think', 'spoke']);
    } finally { await h.close(); }
});

test('while she is busy or the host is speaking nothing is considered; the block is logged', async () => {
    let busy = true;
    const h = await harness({ busy: () => busy });
    try {
        await h.runner.tick();
        await appendFile(h.file, line(fine('f1', h.now())));
        await h.runner.tick();
        assert.equal(h.calls.length, 0);
        busy = false;
        h.runner.observeHostSpeech(true);
        h.advance(500);
        await h.runner.tick();
        assert.equal(h.calls.length, 0, 'the host is talking');
        h.runner.observeHostSpeech(false);
        h.advance(settings.userQuietSec * 1000 + 100);
        await h.runner.tick();
        assert.equal(h.calls.length, 1, 'after the host stopped and the quiet window passed');
        await new Promise(resolve => setTimeout(resolve, 30));
        const blocked = (await h.log()).filter(entry => entry.stage === 'gate' && !entry.passed).flatMap(entry => entry.blocked);
        assert.ok(blocked.includes('she_pending'));
        assert.ok(blocked.includes('host_speaking'));
    } finally { await h.close(); }
});
