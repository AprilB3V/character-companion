import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GameWorldBridge } from '../game-world.mjs';
import { validateWorldEvent } from '../../../CLResearch/CharacterLife/src/kernel/world/service.ts';

const fixture = (now, overrides = {}) => ({
    schemaVersion: 1, source: 'probably-stolen', sessionId: 'game-session-1',
    capturedAt: now, ready: true, saveSlot: 1, runId: 'run-1', cash: 1200,
    items: [{ id: 'magnifier', name: '放大镜', location: 'store', quantity: 2 }],
    ...overrides,
});

test('snapshots become native observations, changes are deduplicated and failures retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jingjing-world-'));
    const statePath = join(directory, 'state.json');
    let now = 1800000000000;
    const deliveries = [];
    let fail = false;
    const bridge = new GameWorldBridge({ statePath, now: () => now, send: async events => {
        if (fail) throw new Error('offline');
        deliveries.push(events);
    } });
    try {
        await writeFile(statePath, JSON.stringify(fixture(now)));
        await bridge.poll();
        assert.equal(deliveries.length, 1);
        assert.equal(deliveries[0][0].kind, 'observation');
        assert.ok(deliveries[0][0].facts.some(fact => fact.key === 'cash' && fact.value === 1200));
        assert.ok(deliveries[0].flatMap(event => event.facts).some(fact => String(fact.value).includes('放大镜')));
        for (const event of deliveries[0]) assert.equal(validateWorldEvent({ ...event, instanceId: 'inst_001' }).ok, true);
        await bridge.poll();
        assert.equal(deliveries.length, 1);
        now += 2000;
        await writeFile(statePath, JSON.stringify(fixture(now, { cash: 1500, items: [] })));
        fail = true;
        await bridge.poll();
        assert.equal(bridge.status().connected, false);
        fail = false;
        await bridge.poll();
        assert.equal(deliveries.length, 2);
        assert.ok(deliveries[1].some(event => event.facts.some(fact => fact.key === 'cashDelta' && fact.value === 300)));
        now += 16000;
        await bridge.poll();
        assert.equal(bridge.status().ready, false);
        assert.ok(deliveries.at(-1)[0].facts.some(fact => fact.key === 'ready' && fact.value === false));
        await bridge.poll();
        assert.equal(deliveries.length, 3);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('invalid or future snapshots never become game truth; large inventories obey CL batch limits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jingjing-world-'));
    const statePath = join(directory, 'state.json');
    const now = 1800000000000;
    const deliveries = [];
    const bridge = new GameWorldBridge({ statePath, now: () => now, send: async events => deliveries.push(events) });
    try {
        for (const overrides of [{ cash: '1200' }, { capturedAt: now + 100000 }, { items: [{ quantity: -1 }] }]) {
            await writeFile(statePath, JSON.stringify(fixture(now, overrides)));
            await bridge.poll();
            assert.equal(bridge.status().ready, false);
        }
        assert.ok(!deliveries.flat().some(event => event.facts.some(fact => fact.key === 'ready' && fact.value === true)));
        const items = Array.from({ length: 1000 }, (_, index) => ({
            id: `item-${index}`, name: '物品'.repeat(60), location: 'store', quantity: 1,
        }));
        await writeFile(statePath, JSON.stringify(fixture(now, { items })));
        await bridge.poll();
        const events = deliveries.at(-1);
        assert.ok(events.length <= 50);
        for (const event of events) assert.equal(validateWorldEvent({ ...event, instanceId: 'inst_001' }).ok, true);
        assert.equal(bridge.snapshot().items.length, 1000);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('reader facts and completed callbacks produce stable story, threshold, rent, purchase and kill events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jingjing-world-'));
    const statePath = join(directory, 'state.json');
    let now = 1800000000000;
    const deliveries = [];
    const bridge = new GameWorldBridge({ statePath, now: () => now, send: async events => deliveries.push(events) });
    try {
        await writeFile(statePath, JSON.stringify(fixture(now, { investigation: 70, crime: 10, rent: 500, location: 'IN_STORE' })));
        await bridge.poll();
        now += 2000;
        await writeFile(statePath, JSON.stringify(fixture(now, { investigation: 76, crime: 14, rent: 500, location: 'IN_STORE',
            reputation: { FACTION_CARTEL: 2 }, client: { id: 'cartel_guest', name: '来客', faction: 'FACTION_CARTEL', isSecurity: false },
            events: [
                { id: 'game:1', type: 'rent_paid', amount: 500, runId: '1:run-1', at: now },
                { id: 'game:2', type: 'kill:ai_controlled', amount: 1, runId: '1:run-1', at: now },
                { id: 'game:3', type: 'item_bought', itemId: 'fanta', itemName: '芬太', amount: 200, runId: '1:run-1', at: now },
            ] })));
        await bridge.poll();
        const events = deliveries.at(-1);
        const tags = events.flatMap(event => event.facts.filter(fact => fact.key === 'event').map(fact => fact.value));
        for (const expected of ['story:cartel.first_visit', 'investigation_near_threshold', 'rent_paid', 'kill:ai_controlled', 'item_bought:fanta']) {
            assert.ok(tags.includes(expected), expected);
        }
        assert.ok(events.some(event => event.eventId === 'ps-event:game:2'));
        for (const event of events) assert.equal(validateWorldEvent({ ...event, instanceId: 'inst_001' }).ok, true);
        assert.ok(events[0].facts.some(fact => fact.key === 'investigation' && fact.value === 76));
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('finished dialogue lines become one observation each, are cleaned, and are not resent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jingjing-world-'));
    const statePath = join(directory, 'state.json');
    let now = 1800000000000;
    const deliveries = [];
    const bridge = new GameWorldBridge({ statePath, now: () => now, send: async events => deliveries.push(events) });
    const line = (seq, role, speaker, text, extra = {}) => ({ id: `talk1:${seq}`, seq, role, channel: 'counter', speaker, text,
        runId: '1:run-1', clientId: role === 'npc' ? 'fence_01' : null, at: now, ...extra });
    const lineEvents = events => events.filter(event => event.eventId.startsWith('ps-line:'));
    try {
        await writeFile(statePath, JSON.stringify(fixture(now, { dialogueSession: 'talk1', dialogue: [
            line(1, 'npc', '老张', '这块表是真货，治安部查不到。'),
            line(2, 'player', 'player', '三百，不能再多了。'),
            line(3, 'npc', 'unknown', '货到了吗？', { channel: 'phone', clientId: null }),
            line(4, 'npc', '老张', '', {}),
            line(5, 'npc', '老张', '别的存档', { runId: '2:other' }),
            { ...line(6, 'npc', '老张', '伪造的编号'), id: 'other:6' },
        ] })));
        await bridge.poll();
        const first = lineEvents(deliveries.at(-1));
        assert.deepEqual(first.map(event => event.eventId), ['ps-line:talk1:1', 'ps-line:talk1:2', 'ps-line:talk1:3']);
        assert.deepEqual(first.map(event => event.summary), ['老张：这块表是真货，治安部查不到。', '店主：三百，不能再多了。', '来客：货到了吗？']);
        const fact = (event, key) => event.facts.find(item => item.key === key)?.value;
        assert.equal(fact(first[0], 'event'), 'dialogue:npc');
        assert.equal(fact(first[1], 'event'), 'dialogue:player');
        assert.equal(fact(first[0], 'clientId'), 'fence_01');
        assert.equal(fact(first[2], 'channel'), 'phone');
        assert.equal(fact(first[0], 'lineIndex'), 1);
        for (const event of first) assert.equal(validateWorldEvent({ ...event, instanceId: 'inst_001' }).ok, true);

        now += 2000;
        await writeFile(statePath, JSON.stringify(fixture(now, { dialogueSession: 'talk1', dialogue: [
            line(1, 'npc', '老张', '这块表是真货，治安部查不到。'), line(2, 'player', 'player', '三百，不能再多了。'),
            line(7, 'npc', '老张', '成交。' + '长'.repeat(400)),
        ] })));
        await bridge.poll();
        const second = lineEvents(deliveries.at(-1));
        assert.deepEqual(second.map(event => event.eventId), ['ps-line:talk1:7'], 'already delivered lines are not resent');
        assert.ok(second[0].summary.length <= 200 && fact(second[0], 'text').length <= 180);
        assert.equal(validateWorldEvent({ ...second[0], instanceId: 'inst_001' }).ok, true);

        now += 2000;
        await writeFile(statePath, JSON.stringify(fixture(now, { dialogueSession: 'talk2', dialogue: [line(1, 'npc', '老张', '新会话第一句', { id: 'talk2:1' })] })));
        await bridge.poll();
        assert.deepEqual(lineEvents(deliveries.at(-1)).map(event => event.eventId), ['ps-line:talk2:1'], 'a new reader session starts over');
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sales carry price, profit and buyer; money moves name their reason; malformed item ids are dropped', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jingjing-world-'));
    const statePath = join(directory, 'state.json');
    const now = 1800000000000;
    const deliveries = [];
    const bridge = new GameWorldBridge({ statePath, now: () => now, send: async events => deliveries.push(events) });
    try {
        await writeFile(statePath, JSON.stringify(fixture(now, { eventSequence: 5, events: [
            { id: 'game:1', type: 'item_sold', itemId: 'watch', itemName: '手表', amount: 900, boughtFor: 300, clientId: 'fence_01', clientName: '老张', runId: '1:run-1', at: now },
            { id: 'game:2', type: 'item_sold', itemId: 'gift', itemName: '礼物', amount: 400, boughtFor: null, runId: '1:run-1', at: now },
            { id: 'game:3', type: 'item_bought', itemId: 'lamp', itemName: '台灯', amount: 120, clientName: '老张', runId: '1:run-1', at: now },
            { id: 'game:4', type: 'money:service', amount: 80, detail: 'appraisal', runId: '1:run-1', at: now },
            { id: 'game:5', type: 'item_sold', itemId: 'bad id!', amount: 10, runId: '1:run-1', at: now },
        ] })));
        await bridge.poll();
        const events = deliveries.at(-1).filter(event => event.eventId.startsWith('ps-event:'));
        const fact = (event, key) => event.facts.find(item => item.key === key)?.value;
        assert.deepEqual(events.map(event => fact(event, 'event')), ['sale:watch', 'sale:gift', 'item_bought:lamp', 'money:service']);
        const [watch, gift, lamp, service] = events;
        assert.equal(watch.summary, '游戏成交回调：卖出 手表 给 老张，收款 900，进价 300，利润 600');
        assert.equal(fact(watch, 'price'), 900);
        assert.equal(fact(watch, 'profit'), 600);
        assert.equal(fact(watch, 'clientName'), '老张');
        assert.equal(fact(gift, 'profit'), undefined, 'an unknown cost basis gives no profit');
        assert.match(gift.summary, /进价未知/);
        assert.equal(lamp.summary, '游戏成交回调：买入 台灯（卖家 老张），支付 120');
        assert.equal(service.summary, '游戏资金回调：支付服务费 80（appraisal）');
        for (const event of events) assert.equal(validateWorldEvent({ ...event, instanceId: 'inst_001' }).ok, true);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
