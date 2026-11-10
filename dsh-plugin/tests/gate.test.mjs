import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventQueue } from '../mcp/events.mjs';
import { eventLevel, GATES, wakes } from '../mcp/gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('gate levels: player first, flagged goods and big trades notable, foot traffic routine', () => {
    assert.equal(eventLevel({ tag: 'player_said' }), 'urgent');
    assert.equal(eventLevel({ tag: 'appraisal:client_fake' }), 'notable');
    assert.equal(eventLevel({ tag: 'npc_arrived:security_officer' }), 'notable');
    assert.equal(eventLevel({ tag: 'sale:gold', amount: 800 }), 'notable');
    assert.equal(eventLevel({ tag: 'sale:gold', amount: 800 }, GATES.quiet), 'routine');
    assert.equal(eventLevel({ tag: 'npc_arrived:merchant' }), 'routine');
    assert.equal(eventLevel({ tag: 'dialogue:npc' }), 'routine');
    assert.equal(wakes({ tag: 'dialogue:npc' }, GATES.normal), false);
    assert.equal(wakes({ tag: 'dialogue:npc' }, GATES.lively), true);
});

test('routine traffic does not wake the waiter; it comes back as background with the next notable event', async () => {
    const queue = new EventQueue();
    const gate = item => wakes(item, GATES.normal);
    setTimeout(() => {
        queue.push({ tag: 'npc_arrived:merchant', summary: 'merchant in' });
        queue.push({ tag: 'dialogue:npc', summary: 'hello' });
    }, 10);
    setTimeout(() => queue.push({ tag: 'appraisal:client_fake', summary: 'fake water' }), 120);
    const started = Date.now();
    const result = await queue.wait({ timeoutMs: 5000, settleMs: 0, wakes: gate });
    assert.ok(Date.now() - started >= 100, 'woke on routine traffic');
    assert.deepEqual(result.events.map(event => event.summary), ['fake water']);
    assert.deepEqual(result.background.map(event => event.summary), ['merchant in', 'hello']);
    assert.equal(queue.listening, 0);
    assert.ok(queue.lastWaitEndedAt);
});

test('cooldown holds notable events, but the player cuts through it', async () => {
    const queue = new EventQueue();
    const gate = item => wakes(item, GATES.normal);
    queue.push({ tag: 'appraisal:client_fake', summary: 'fake' });
    let started = Date.now();
    let result = await queue.wait({ timeoutMs: 5000, settleMs: 0, wakes: gate, holdUntil: Date.now() + 200 });
    assert.ok(Date.now() - started >= 180, 'cooldown ignored');
    assert.deepEqual(result.events.map(event => event.summary), ['fake']);

    queue.push({ tag: 'appraisal:client_fake', summary: 'fake 2' });
    setTimeout(() => queue.push({ tag: 'player_said', urgent: true, summary: 'hi' }), 30);
    started = Date.now();
    result = await queue.wait({ timeoutMs: 5000, settleMs: 0, wakes: gate, holdUntil: Date.now() + 3000 });
    assert.ok(Date.now() - started < 1000, 'player waited for the cooldown');
    assert.deepEqual(result.events.map(event => event.summary), ['hi', 'fake 2']);
});

test('react logs the decision, speaks, and returns the next batch; float chat reports a stopped loop', async () => {
    const data = await mkdtemp(join(tmpdir(), 'jj-react-'));
    const child = spawn(process.execPath, [join(ROOT, 'mcp/server.mjs')], {
        cwd: join(ROOT, 'mcp'), stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, JINGJING_PET: '0', JINGJING_GAME_STATE_PATH: join(data, 'missing.json'), LOCALAPPDATA: data },
    });
    const pending = new Map();
    let buffer = '';
    child.stdout.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            const message = JSON.parse(line);
            pending.get(message.id)?.(message);
        }
    });
    let nextId = 1;
    const request = (method, params) => new Promise(resolveRequest => {
        const id = nextId++;
        pending.set(id, resolveRequest);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const call = async (name, args) => JSON.parse((await request('tools/call', { name, arguments: args })).result.content[0].text);
    try {
        await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
        const list = await request('tools/list', {});
        assert.ok(list.result.tools.some(tool => tool.name === 'react'));
        const result = await call('react', { speak: false, reason: '没什么事', timeoutMs: 1000 });
        assert.equal(result.timedOut, true);
        assert.match(result.next, /react/);
        const spoken = await call('react', { speak: true, reason: '测试', text: '在呢', timeoutMs: 1000 });
        assert.equal(spoken.said.delivered, false);
        const { readFile } = await import('node:fs/promises');
        const log = (await readFile(join(data, 'CharacterCompanion', 'dsh', 'decisions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(log.map(entry => entry.speak), [false, true]);
        assert.equal(log[1].text, '在呢');
    } finally {
        child.stdin.end();
        child.kill();
    }
});

test('pet hub passes the loop notice back to the float window', async () => {
    const { PetHub } = await import('../mcp/pet-hub.mjs');
    const hub = new PetHub({ port: 0, onChat: () => ({ notice: '消息已记下，但未在陪玩' }), status: () => ({ companion: { state: 'off', label: '未在陪玩' } }) });
    hub.listen();
    await new Promise(resolveListen => hub.server.once('listening', resolveListen));
    const base = `http://127.0.0.1:${hub.server.address().port}`;
    try {
        const chat = await (await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ text: '在吗' }) })).json();
        assert.equal(chat.notice, '消息已记下，但未在陪玩');
        const status = await (await fetch(`${base}/api/status`)).json();
        assert.equal(status.companion.state, 'off');
    } finally {
        hub.close();
    }
});
