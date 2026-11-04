import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import test from 'node:test';
// The kernel copy the cohost adapter imports (vendor submodule), so both share one module instance.
const VENDOR = '../../vendor/CharacterLife-VideoCohost/vendor/characterlife/src';
const { assembleRuntime, createApiServer } = await import(`${VENDOR}/api/index.ts`);
const { MockProvider } = await import(`${VENDOR}/index.ts`);
const { JingjingGameAdapter } = await import('../../vendor/CharacterLife-VideoCohost/examples/video-cohost/game-adapter.ts');
const { JingjingKnowledge } = await import('../../vendor/CharacterLife-VideoCohost/examples/video-cohost/knowledge.ts');
const { jingjingTemplate } = await import('../../vendor/CharacterLife-VideoCohost/examples/characters/jingjing.ts');
const { parseEventLog } = await import('../../vendor/CharacterLife-VideoCohost/examples/video-cohost/contract/event-log.ts');

const WORLD = 'world_jingjing_video';
const TOKEN = 'test-chat-token-123456';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Thinker double: JSON drafts from a script, optionally slow. */
class ScriptedThinker {
    name = 'scripted-think';
    model = 'scripted-think';
    requests = [];
    script = [];
    async complete(request) {
        this.requests.push(request);
        const next = this.script.shift() ?? { json: { decision: 'silent' } };
        if (next.delayMs) await sleep(next.delayMs);
        return { text: JSON.stringify({ heard: 'x', meant: 'x', meantConf: 0.9, turn: 'done', emotion: 'neutral', ...next.json }),
            provider: this.name, model: this.model, usage: null, latencyMs: 0 };
    }
}

class RecordingMain extends MockProvider {
    requests = [];
    delayMs = 0;
    async complete(request) {
        this.requests.push(request);
        if (this.delayMs) await sleep(this.delayMs);
        return super.complete(request);
    }
}

async function withStack(run) {
    const directory = await mkdtemp(join(tmpdir(), 'jingjing-thinking-'));
    const knowledge = new JingjingKnowledge(fileURLToPath(new URL('../../vendor/CharacterLife-VideoCohost/tests/season/fixtures/knowledge.md', import.meta.url)));
    const thinker = new ScriptedThinker();
    const main = new RecordingMain({ mode: 'in-character' });
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: WORLD, template: jingjingTemplate, provider: main, thinkProvider: thinker,
        world: { enabled: true, worldIds: [WORLD], acceptObservations: true, allowedVerbs: [], allowedTargets: [] },
        configureInstance: (instance, context) => new JingjingGameAdapter({ instance, ...context, knowledge }) });
    const api = createApiServer({ runtime, port: 0, token: TOKEN, logger: () => {}, stIdentityUserId: 'jingjing-video', world: { token: 'test-world-token-123456' } });
    const { url } = await api.listen();
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const eventLogPath = join(directory, 'events.jsonl');
    const relay = spawn(process.execPath, [fileURLToPath(new URL('../relay.mjs', import.meta.url))], {
        env: { ...process.env, JINGJING_PROACTIVE: '0', PORT: String(port), CL_URL: url, CHARACTERLIFE_API_TOKEN: TOKEN, JINGJING_WORLD_TOKEN: '',
            JINGJING_GAME_STATE_PATH: join(directory, 'missing.json'), JINGJING_EVENT_LOG: eventLogPath,
            HISTORY_DB: join(directory, 'history.sqlite'), FRONTEND_HISTORY_DIR: join(directory, 'empty') },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = '';
    relay.stderr.on('data', data => { errors += data; });
    await Promise.race([once(relay.stdout, 'data'), once(relay, 'exit').then(() => { throw new Error(errors); })]);
    const base = `http://127.0.0.1:${port}`;
    const events = [];
    const abort = new AbortController();
    const stream = await fetch(base + '/events', { signal: abort.signal });
    const collecting = (async () => {
        let buffer = '';
        const decoder = new TextDecoder();
        try {
            for await (const chunk of stream.body) {
                buffer += decoder.decode(chunk, { stream: true });
                let index;
                while ((index = buffer.indexOf('\n\n')) >= 0) {
                    const line = buffer.slice(0, index).split('\n').find(item => item.startsWith('data:'));
                    buffer = buffer.slice(index + 2);
                    if (line) events.push(JSON.parse(line.slice(5)));
                }
            }
        } catch {}
    })();
    const say = async (text, extra = {}) => {
        const response = await fetch(base + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, durationMs: 600, ...extra }) });
        assert.equal(response.status, 202);
    };
    const waitFor = async (predicate, timeoutMs = 10000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) { if (predicate(events)) return; await sleep(50); }
        throw new Error(`Timed out. Events: ${JSON.stringify(events.map(event => event.type))}`);
    };
    try {
        await run({ say, waitFor, events, thinker, main, base, eventLogPath });
    } finally {
        abort.abort();
        await collecting;
        if (relay.exitCode === null) { const exited = once(relay, 'exit'); relay.kill(); await exited; }
        await api.close();
        runtime.close();
        await rm(directory, { recursive: true, force: true });
    }
}

test('she can think and stay silent: no reply, a silent record, and the line joins the next spoken turn', { timeout: 30000 }, async () => {
    await withStack(async ({ say, waitFor, events, thinker, main, base, eventLogPath }) => {
        thinker.script.push({ json: { heard: '我去理货了', meant: '我去理货了', decision: 'silent' } });
        // The page reports that the speech ended 1.2 s ago, so the complete sentence flushes at once.
        await say('我去理货了。', { speechEndAt: Date.now() - 1200 });
        await waitFor(list => list.some(event => event.type === 'silent'));
        assert.deepEqual(events.map(event => event.type), ['user', 'thinking', 'silent']);
        assert.equal(main.requests.length, 0, 'no reply model call for silence');
        const history = (await (await fetch(base + '/history')).json()).conversations;
        assert.equal(history[0].status, 'silent');

        thinker.script.push({ json: { heard: '鲸鲸你说呢', meant: '鲸鲸你说呢', turn: 'asking_me', decision: 'reply' } });
        await say('鲸鲸你说呢？', { speechEndAt: Date.now() - 1200 });
        await waitFor(list => list.some(event => event.type === 'end'));
        const userText = main.requests.at(-1).messages.map(message => message.content).join('\n');
        assert.match(userText, /我去理货了[\s\S]*鲸鲸你说呢/, 'the unanswered line is folded into the spoken turn');

        const log = parseEventLog(await readFile(eventLogPath, 'utf8'));
        const types = new Set(log.map(event => event.type));
        for (const type of ['asr', 'turn', 'thought', 'overlay']) assert.ok(types.has(type), `event log has ${type}`);
        assert.ok(log.some(event => event.type === 'thought' && event.result.decision === 'silent'));
    });
});

test('speech while she thinks joins the same turn and continues the thought', { timeout: 30000 }, async () => {
    await withStack(async ({ say, waitFor, events, thinker, main }) => {
        thinker.script.push({ json: { heard: '房租交了', decision: 'silent' }, delayMs: 1500 });
        thinker.script.push({ json: { heard: '还有一件事', meant: '还有一件事', turn: 'asking_me', decision: 'reply' } });
        await say('房租交了。', { speechEndAt: Date.now() - 1200 });
        await waitFor(list => list.some(event => event.type === 'thinking'));
        await sleep(100);
        await say('还有一件事。', { speechEndAt: Date.now() - 1200 });
        await waitFor(list => list.some(event => event.type === 'end'));
        assert.ok(!events.some(event => event.type === 'cancel'), 'thinking is not cancelled by new speech');
        assert.equal(new Set(events.filter(event => event.type === 'user').map(event => event.turn)).size, 1, 'one turn');
        assert.equal(events.filter(event => event.type === 'user').at(-1).text, '房租交了。还有一件事。');
        assert.equal(thinker.requests.length, 2);
        assert.match(thinker.requests[1].messages[0].content, /接着想/);
        const userText = main.requests.at(-1).messages.map(message => message.content).join('\n');
        assert.match(userText, /房租交了[\s\S]*还有一件事/);
    });
});

test('interrupting a reply: the new turn waits for CL to finish the old one, then goes through', { timeout: 30000 }, async () => {
    await withStack(async ({ say, waitFor, events, thinker, main }) => {
        main.delayMs = 1500;
        thinker.script.push({ json: { heard: '鲸鲸你看呢', turn: 'asking_me', decision: 'reply' } });
        thinker.script.push({ json: { heard: '算了先不说这个', turn: 'asking_me', decision: 'reply' } });
        await say('鲸鲸你看呢？', { speechEndAt: Date.now() - 1200 });
        await waitFor(list => list.some(event => event.type === 'start'));
        // She is generating (CL cannot abort that); the host keeps talking.
        await say('算了先不说这个。', { speechEndAt: Date.now() - 1200 });
        await waitFor(list => list.some(event => event.type === 'cancel'));
        await waitFor(list => list.some(event => event.type === 'end'), 15000);
        assert.ok(!events.some(event => event.type === 'error'), 'the new turn did not fail on 409 SPEAKING');
        const cancelled = events.find(event => event.type === 'cancel').turn;
        const ended = events.find(event => event.type === 'end').turn;
        assert.notEqual(ended, cancelled, 'the reply shown belongs to the new turn');
        assert.equal(thinker.requests.length, 2);
        main.delayMs = 0;
    });
});
