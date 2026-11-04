import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import test from 'node:test';
const VENDOR = '../../vendor/CharacterLife-VideoCohost/vendor/characterlife/src';
const { assembleRuntime, createApiServer } = await import(`${VENDOR}/api/index.ts`);
const { MockProvider } = await import(`${VENDOR}/index.ts`);
const { JingjingGameAdapter } = await import('../../vendor/CharacterLife-VideoCohost/examples/video-cohost/game-adapter.ts');
const { JingjingKnowledge } = await import('../../vendor/CharacterLife-VideoCohost/examples/video-cohost/knowledge.ts');
const { jingjingTemplate } = await import('../../vendor/CharacterLife-VideoCohost/examples/characters/jingjing.ts');

const WORLD = 'world_jingjing_video';
const TOKEN = 'test-chat-token-123456';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class ScriptedThinker {
    name = 'scripted-think';
    model = 'scripted-think';
    requests = [];
    script = [];
    async complete(request) {
        this.requests.push(request);
        const { delayMs = 0, ...next } = this.script.shift() ?? { decision: 'silent' };
        if (delayMs) await sleep(delayMs);
        return { text: JSON.stringify({ heard: 'x', meant: 'x', meantConf: 0.9, turn: 'self_talk', emotion: 'neutral', ...next }),
            provider: this.name, model: this.model, usage: null, latencyMs: 0 };
    }
}

class RecordingMain extends MockProvider {
    requests = [];
    async complete(request) { this.requests.push(request); return super.complete(request); }
}

async function withStack(run) {
    const directory = await mkdtemp(join(tmpdir(), 'jingjing-proactive-'));
    const eventsDir = join(directory, 'game-events');
    const logDir = join(directory, 'proactive');
    await mkdir(eventsDir, { recursive: true });
    const eventsFile = join(eventsDir, 'run.jsonl');
    await writeFile(eventsFile, '');
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
    const relay = spawn(process.execPath, [fileURLToPath(new URL('../relay.mjs', import.meta.url))], {
        env: { ...process.env, PORT: String(port), CL_URL: url, CHARACTERLIFE_API_TOKEN: TOKEN, JINGJING_WORLD_TOKEN: '',
            JINGJING_GAME_STATE_PATH: join(directory, 'missing.json'), JINGJING_EVENT_LOG: join(directory, 'events.jsonl'),
            JINGJING_GAME_EVENTS_DIR: eventsDir, JINGJING_PROACTIVE_LOG_DIR: logDir,
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
    const waitFor = async (predicate, timeoutMs = 15000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) { if (predicate(events)) return; await sleep(50); }
        throw new Error(`Timed out. Events: ${JSON.stringify(events.map(event => event.type))}`);
    };
    const publish = async event => appendFile(eventsFile, `${JSON.stringify({ id: `e${Math.random()}`, ts: 1, wall_time: new Date().toISOString(),
        source: 'game', ...event })}\n`);
    const decisions = async () => {
        const names = await readdir(logDir).catch(() => []);
        if (!names.length) return [];
        return (await readFile(join(logDir, names[0]), 'utf8')).trim().split('\n').filter(Boolean).map(text => JSON.parse(text));
    };
    try {
        // Let the relay's feed position itself at the end of the (empty) file before anything is published.
        await sleep(1500);
        const voice = speaking => fetch(base + '/api/presentation/voice', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ speaking }) });
        const say = async text => {
            const response = await fetch(base + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text, durationMs: 600, speechEndAt: Date.now() - 2500 }) });
            assert.equal(response.status, 202);
        };
        await run({ events, waitFor, publish, decisions, thinker, main, base, voice, say });
    } finally {
        abort.abort();
        await collecting;
        if (relay.exitCode === null) { const exited = once(relay, 'exit'); relay.kill(); await exited; }
        await api.close();
        runtime.close();
        await rm(directory, { recursive: true, force: true });
    }
}

const sale = { importance: 0.7, type: 'transaction', payload: { kind: 'sell', item: '手表', price: 900, counterparty: '老张', profit: 600 } };

test('after a sale she thinks on her own and speaks, marked as proactive; every stage is logged', { timeout: 40000 }, async () => {
    await withStack(async ({ events, waitFor, publish, decisions, thinker, main }) => {
        thinker.script.push({ decision: 'reply', meant: '这单赚得多，想夸一句' });
        await publish(sale);
        await waitFor(list => list.some(event => event.type === 'end'));
        const start = events.find(event => event.type === 'start');
        assert.equal(start.proactive, true, 'the page can play the proactive chime');
        const user = events.find(event => event.type === 'user');
        assert.equal(user.text, '', 'no host line is invented for a proactive turn');
        const thinkerText = JSON.stringify(thinker.requests[0]);
        assert.match(thinkerText, /刚做完一笔交易/);
        assert.match(thinkerText, /卖出 手表 给 老张，收款 900，利润 600/);
        const replyText = main.requests.at(-1).messages.map(message => message.content).join('\n');
        assert.match(replyText, /【刚发生】刚做完一笔交易/, 'the reply model sees events, not fake host speech');
        await sleep(200);
        assert.deepEqual((await decisions()).map(entry => entry.stage), ['trigger', 'gate', 'think', 'spoke']);
    });
});

test('when the thinker stays silent nothing is shown and the decision is logged', { timeout: 40000 }, async () => {
    await withStack(async ({ events, waitFor, publish, decisions, main }) => {
        await publish(sale);
        await waitFor(list => list.some(event => event.type === 'silent'));
        assert.equal(events.some(event => event.type === 'start'), false);
        assert.equal(main.requests.length, 0);
        await sleep(200);
        const think = (await decisions()).find(entry => entry.stage === 'think');
        assert.equal(think.decision.should_speak, false);
    });
});

test('the chime files are served', { timeout: 40000 }, async () => {
    await withStack(async ({ base }) => {
        for (const name of ['chime_proactive', 'chime_reply']) {
            const response = await fetch(`${base}/sfx/${name}.wav`);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('content-type'), 'audio/wav');
            assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString('ascii'), 'RIFF');
        }
    });
});

test('if the host starts talking while she thinks on her own, her line does not start; the next turn is told', { timeout: 40000 }, async () => {
    await withStack(async ({ events, waitFor, publish, thinker, main, voice, say }) => {
        thinker.script.push({ decision: 'reply', delayMs: 1500 });
        await publish(sale);
        await waitFor(list => list.some(event => event.type === 'thinking'));
        await voice(true);
        await waitFor(list => list.some(event => event.type === 'cancel'));
        assert.equal(events.some(event => event.type === 'start'), false, 'she never starts over the host');
        await voice(false);
        thinker.script.push({ decision: 'reply', turn: 'asking_me', meant: '主播问她' });
        await say('鲸鲸你说呢？');
        await waitFor(list => list.some(event => event.type === 'end'));
        const replyText = main.requests.at(-1).messages.map(message => message.content).join('\n');
        assert.match(replyText, /主动想说的话没有显示出来/, 'the unseen proactive reply is mentioned once');
    });
});
