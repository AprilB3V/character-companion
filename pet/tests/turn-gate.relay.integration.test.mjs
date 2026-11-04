import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Spin up a relay against a stub CL. Upstream replies are JSON; the first request can be made slow.
async function withRelay(run, { firstReplyDelayMs = 0, replyFor = () => '好的，我记下了。' } = {}) {
    const tempDir = mkdtempSync(join(tmpdir(), 'jingjing-gate-'));
    const upstreamRequests = [];
    const upstreamNotices = [];
    const upstream = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        if (request.url !== '/v1/messages') {
            response.writeHead(404, { 'Content-Type': 'application/json' });
            return response.end('{}');
        }
        const message = JSON.parse(body);
        upstreamRequests.push(message.text);
        upstreamNotices.push(message.notices ?? []);
        if (upstreamRequests.length === 1 && firstReplyDelayMs) await sleep(firstReplyDelayMs);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ reply: replyFor(message.text) }));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));

    const relay = spawn(process.execPath, [fileURLToPath(new URL('../relay.mjs', import.meta.url))], {
        env: { ...process.env, JINGJING_PROACTIVE: '0', PORT: String(port), CL_URL: `http://127.0.0.1:${upstream.address().port}`,
            HISTORY_DB: join(tempDir, 'history.sqlite'), FRONTEND_HISTORY_DIR: join(tempDir, 'empty'),
            MIC_SETTINGS_PATH: join(tempDir, 'microphone.json'), JINGJING_WORLD_TOKEN: '',
            CHARACTERLIFE_API_TOKEN: 'test-only-token', ASR_URL: `http://127.0.0.1:${upstream.address().port}` },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    await Promise.race([
        once(relay.stdout, 'data'),
        once(relay, 'exit').then(([code]) => { throw new Error(`Relay exited ${code}`); }),
    ]);
    const baseUrl = `http://127.0.0.1:${port}`;

    // Collect SSE events in the background.
    const events = [];
    const eventsAbort = new AbortController();
    const eventResponse = await fetch(baseUrl + '/events', { signal: eventsAbort.signal });
    const collecting = (async () => {
        let buffer = '';
        const decoder = new TextDecoder();
        try {
            for await (const chunk of eventResponse.body) {
                buffer += decoder.decode(chunk, { stream: true });
                let index;
                while ((index = buffer.indexOf('\n\n')) >= 0) {
                    const frame = buffer.slice(0, index);
                    buffer = buffer.slice(index + 2);
                    const line = frame.split('\n').find(item => item.startsWith('data:'));
                    if (line) events.push(JSON.parse(line.slice(5)));
                }
            }
        } catch {}
    })();

    const say = async (text, durationMs = 500, extra = {}) => {
        const response = await fetch(baseUrl + '/api/chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, durationMs, ...extra }),
        });
        assert.equal(response.status, 202);
    };
    const waitFor = async (predicate, timeoutMs = 8000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            if (predicate(events)) return;
            await sleep(50);
        }
        throw new Error(`Timed out. Events: ${JSON.stringify(events.map(event => event.type))}`);
    };

    try {
        await run({ say, waitFor, events, upstreamRequests, upstreamNotices, baseUrl });
    } finally {
        eventsAbort.abort();
        await collecting;
        relay.kill();
        await once(relay, 'exit').catch(() => {});
        upstream.closeAllConnections();
        await new Promise(resolve => upstream.close(resolve));
        rmSync(tempDir, { recursive: true, force: true });
    }
}

test('a filler-ended utterance waits and merges with the next one into a single turn', { timeout: 20000 }, async () => {
    await withRelay(async ({ say, waitFor, events, upstreamRequests }) => {
        await say('我们准备开始了，然后');
        await sleep(1000);
        await say('先看看账本');
        await waitFor(list => list.some(event => event.type === 'end'));
        const users = events.filter(event => event.type === 'user');
        assert.equal(users.length, 1);
        assert.equal(users[0].text, '我们准备开始了，然后先看看账本');
        assert.deepEqual(upstreamRequests, ['我们准备开始了，然后先看看账本']);
    });
});

test('speech during generation cancels the reply and merges it into the next turn', { timeout: 20000 }, async () => {
    await withRelay(async ({ say, waitFor, events, upstreamRequests, upstreamNotices, baseUrl }) => {
        await say('房租交了。');
        // The first reply is slow, so the host speaks again while generation is still running.
        await waitFor(list => list.some(event => event.type === 'start'));
        await sleep(300);
        await say('还有一件事');
        await waitFor(list => list.some(event => event.type === 'cancel'));
        await waitFor(list => list.some(event => event.type === 'end'));
        const cancel = events.find(event => event.type === 'cancel');
        const firstUser = events.find(event => event.type === 'user');
        assert.equal(cancel.turn, firstUser.turn);
        const merged = events.filter(event => event.type === 'user').at(-1);
        assert.notEqual(merged.turn, firstUser.turn);
        assert.equal(merged.text, '房租交了。还有一件事');
        // CL already committed the first request, so only the new speech is sent, with a notice.
        assert.deepEqual(upstreamRequests, ['房租交了。', '还有一件事']);
        assert.equal(upstreamNotices[0].length, 0);
        assert.equal(upstreamNotices[1].length, 1);
        const records = (await (await fetch(baseUrl + '/history')).json()).conversations;
        assert.equal(records.find(record => record.userText === '房租交了。').status, 'interrupted');
    }, { firstReplyDelayMs: 2500 });
});

test('speech while the reply is on screen yields, with the "你先说" line only once', { timeout: 20000 }, async () => {
    await withRelay(async ({ say, waitFor, events }) => {
        await say('第一句。', 300);
        await waitFor(list => list.some(event => event.type === 'end'));
        await sleep(200);
        await say('等一下', 300);
        await waitFor(list => list.some(event => event.type === 'yield'));
        const yieldEvent = events.find(event => event.type === 'yield');
        assert.equal(yieldEvent.text, '……你先说');
        assert.equal(yieldEvent.turn, events.find(event => event.type === 'user').turn);
    });
});

test('speechEndAt from the page lets a finished sentence reply without an extra wait', { timeout: 20000 }, async () => {
    await withRelay(async ({ say, waitFor, events }) => {
        const sentAt = Date.now();
        // The segmenter already waited 1.2 s of silence before handing this over.
        await say('房租交了。', 800, { speechEndAt: sentAt - 1200 });
        await waitFor(list => list.some(event => event.type === 'user'));
        const user = events.find(event => event.type === 'user');
        assert.ok(user.at - sentAt < 600, `waited ${user.at - sentAt} ms`);
    });
});

test('recognition originals are shown with the merged turn', { timeout: 20000 }, async () => {
    await withRelay(async ({ say, waitFor, events }) => {
        await say('收表多少钱？', 500, { original: '手表多少钱？' });
        await waitFor(list => list.some(event => event.type === 'user'));
        assert.equal(events.find(event => event.type === 'user').original, '手表多少钱？');
    });
});
