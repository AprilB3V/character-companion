import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GameWorldBridge, SCENE_SETTLE_MS } from '../game-world.mjs';
import { validateWorldEvent } from '../../vendor/CharacterLife-VideoCohost/vendor/characterlife/src/kernel/world/service.ts';

const START = 1800000000000;
const base = (now, overrides = {}) => ({
    schemaVersion: 1, source: 'probably-stolen', sessionId: 'reader-1', capturedAt: now, ready: true,
    saveSlot: 1, runId: 'run-1', cash: 1000, items: [], scene: { id: 'store' }, ...overrides,
});
const tags = events => events.flatMap(event => event.facts.filter(fact => fact.key === 'event').map(fact => String(fact.value)));
const fact = (events, key) => events.flatMap(event => event.facts).find(item => item.key === key)?.value;

async function harness(run) {
    const directory = await mkdtemp(join(tmpdir(), 'jingjing-immersion-'));
    const statePath = join(directory, 'state.json');
    let now = START;
    const deliveries = [];
    const bridge = new GameWorldBridge({ statePath, now: () => now, send: async events => {
        for (const event of events) assert.equal(validateWorldEvent({ ...event, instanceId: 'inst_001' }).ok, true, event.eventId);
        deliveries.push(events);
    } });
    // Write a snapshot taken `after` ms from the start and poll it; returns what was sent by this poll.
    const step = async (after, overrides = {}) => {
        now = START + after;
        await writeFile(statePath, JSON.stringify(base(now, overrides)));
        const before = deliveries.length;
        await bridge.poll();
        return deliveries.slice(before).flat();
    };
    try { await run(step, deliveries); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('going out, visiting a night shop and coming home are scene events; quick map hops are not', () => harness(async step => {
    await step(0);
    assert.deepEqual(tags(await step(2000, { scene: { id: 'map' } })).filter(tag => tag.startsWith('scene:')), []);
    // A two-second hop to the doctor's shop never settles.
    await step(4000, { scene: { id: 'dr_jackson', visits: 3 }, client: { id: 'drJackson', name: '杰克逊博士' } });
    const out = await step(6000, { scene: { id: 'be_brew_shop_47', title: '四十七酿酒商店', visits: 15 }, client: { id: 'be_brew_shop_47', name: '四十七' } });
    assert.ok(!tags(out).some(tag => tag.startsWith('npc_arrived')), 'A night shopkeeper is not a visitor');
    assert.equal(fact(out, 'clientId'), undefined);
    assert.equal(fact(out, 'hostName'), '四十七');
    const settled = await step(6000 + SCENE_SETTLE_MS, { scene: { id: 'be_brew_shop_47', title: '四十七酿酒商店', visits: 15 }, client: { id: 'be_brew_shop_47', name: '四十七' } });
    assert.deepEqual(tags(settled).filter(tag => tag.startsWith('scene:')), ['scene:out', 'scene:visit:be_brew_shop_47']);
    const visit = settled.find(event => tags([event]).includes('scene:visit:be_brew_shop_47'));
    assert.match(visit.summary, /四十七酿酒商店.*不是来店里的客人.*第 15 次来.*今晚第 1 次/);
    assert.equal(fact(settled, 'playerLocation'), '外出：四十七酿酒商店');
    // Back to the map and into the same shop again tonight: a revisit, not a new arrival.
    await step(20000, { scene: { id: 'map' } });
    await step(26000, { scene: { id: 'map' } });
    await step(28000, { scene: { id: 'be_brew_shop_47', title: '四十七酿酒商店', visits: 16 } });
    assert.ok(tags(await step(34000, { scene: { id: 'be_brew_shop_47', title: '四十七酿酒商店', visits: 16 } })).includes('scene:revisit:be_brew_shop_47'));
    await step(40000);
    const home = await step(46000);
    assert.ok(tags(home).includes('scene:home'));
    assert.equal(fact(home, 'playerLocation'), '店里');
}));

test('a first-ever visit is marked, and the end-of-day screen is reported once', () => harness(async step => {
    await step(0);
    await step(2000, { scene: { id: 'dumping_ground', visits: 1 }, scavLeft: 3 });
    const first = await step(8000, { scene: { id: 'dumping_ground', visits: 1 }, scavLeft: 3 });
    assert.ok(tags(first).includes('scene:first_visit:dumping_ground'));
    assert.equal(fact(first, 'scavLeft'), 3);
    await step(10000, { scene: { id: 'end_of_day' } });
    const end = await step(16000, { scene: { id: 'end_of_day' } });
    assert.deepEqual(tags(end).filter(tag => tag.startsWith('scene:')), ['scene:end_of_day']);
    assert.match(end.find(event => tags([event]).includes('scene:end_of_day')).summary, /外出回来就睡下了/);
}));

test('scavenging, injuries, bargains and the night report become tagged events', () => harness(async step => {
    const journal = events => ({ events: events.map((event, index) => ({ id: `j1:${index + 1}`, runId: '1:run-1', at: START + 1000, amount: 1, ...event })), eventSequence: events.length });
    await step(0, { health: { wound: 0, stable: true } });
    const loot = { type: 'scav_loot', loot: [{ id: 'scrap', name: '废金属', quantity: 3, value: 12 }, { id: 'watch', name: '金表', quantity: 1, value: 260 }] };
    const injury = { type: 'scav_injury', detail: 'minor' };
    const events = await step(2000, { health: { wound: 3, stable: false, fresh: true }, ...journal([loot, injury,
        { type: 'bargain', detail: 'blackmail', amount: 20, outcome: 'innocent', clientName: '乔治奥', clientId: 'georgio' },
        { type: 'bargain', detail: 'markup', amount: 15, outcome: 'refused', clientName: '乔治奥' },
        { type: 'bargain', detail: 'haggle_forever', amount: 15 },
        { type: 'night_log', lines: ['伤势恶化了', '房租已扣'] }]) });
    const list = tags(events);
    assert.ok(list.includes('scav:find') && list.includes('scav:injury_minor') && list.includes('bargain:blackmail')
        && list.includes('bargain:markup') && list.includes('night_report'));
    assert.ok(!list.some(tag => tag.startsWith('health:')), 'The callback already reported this injury');
    assert.ok(!list.includes('bargain:haggle_forever'));
    assert.match(events.find(event => tags([event]).includes('scav:find')).summary, /金表（每件估值 260）；另有 废金属×3/);
    assert.match(events.find(event => tags([event]).includes('bargain:blackmail')).summary, /勒索 乔治奥，没用/);
    assert.match(fact(events, 'playerState'), /^轻伤（伤势 3\/10/);
    // Cheap loot is noted, not celebrated; a wound worsening overnight is its own event.
    const cheap = await step(4000, { health: { wound: 7, stable: false, serious: true }, ...journal([loot, injury,
        { type: 'scav_loot', loot: [{ id: 'scrap', name: '废金属', quantity: 1, value: 49 }] }]) });
    assert.ok(tags(cheap).includes('scav:loot'));
    assert.ok(tags(cheap).includes('health:serious'));
    assert.ok(tags(await step(6000, { health: { wound: 0, stable: true } })).includes('health:healed'));
}));

test('difficulty is set once per run and reported again only when it changes', () => harness(async step => {
    const normal = { id: 'normal', title: 'Mark Up', retailMarkup: 15, merchantDiscount: 15, effects: ['出售时零售加价 15%'] };
    const first = await step(0, { difficulty: normal });
    assert.ok(tags(first).includes('difficulty:set'));
    assert.equal(fact(first, 'difficulty'), '普通「Mark Up」，卖货加价 15%');
    assert.ok(!tags(await step(2000, { difficulty: normal, cash: 900 })).some(tag => tag.startsWith('difficulty:')));
    const changed = await step(4000, { difficulty: { ...normal, id: 'challenge', title: 'Red Ink', retailMarkup: 0, effects: ['出售时无零售加价'] } });
    assert.ok(tags(changed).includes('difficulty:changed'));
    assert.match(changed.find(event => tags([event]).includes('difficulty:changed')).summary, /挑战「Red Ink」，卖货无加价；规则：出售时无零售加价/);
}));

test('batched lines of several visitors keep each line with its own visitor, in order', () => harness(async step => {
    await step(0);
    const line = (seq, visit, name, text, extra = {}) => ({ id: `d1:${seq}`, seq, role: 'npc', channel: 'counter', speaker: 'unknown',
        text, runId: '1:run-1', clientId: name === '乔治奥' ? 'georgio' : 'officer', clientName: name, visit, scene: 'store', at: START + seq, ...extra });
    const events = await step(2000, { dialogueSession: 'd1', client: { id: 'officer', name: '伦警官', isSecurity: true, visit: 2 }, dialogue: [
        line(1, 1, '乔治奥', '好，听起来正合适。'), line(2, 1, '乔治奥', '好，听起来正合适。'),
        line(3, 2, '伦警官', '例行检查。', { security: true })] });
    const order = events.filter(event => /^(npc_|dialogue:)/.test(tags([event])[0] ?? '') || tags([event]).some(tag => /^(npc_|dialogue:)/.test(tag)))
        .map(event => tags([event]).find(tag => /^(npc_|dialogue:)/.test(tag)) + ' ' + event.summary);
    assert.deepEqual(order, [
        'npc_arrived:georgio 来客进店：乔治奥',
        'dialogue:npc 乔治奥：好，听起来正合适。',
        'dialogue:npc 乔治奥：好，听起来正合适。（这句刚才说过）',
        'npc_left:georgio 上一位来客离开：乔治奥',
        'npc_arrived:security_officer 来客进店：伦警官',
        'dialogue:npc 伦警官：例行检查。',
    ]);
    // The same visitor still at the counter is not announced again; their leaving is.
    assert.ok(!tags(await step(4000, { dialogueSession: 'd1', client: { id: 'officer', name: '伦警官', isSecurity: true, visit: 2 } })).some(tag => tag.startsWith('npc_')));
    assert.deepEqual(tags(await step(6000, { dialogueSession: 'd1' })).filter(tag => tag.startsWith('npc_')), ['npc_left:security_officer']);
}));

test('page zero stays within the kernel fact limit with every context field present', () => harness(async step => {
    const reputation = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`faction${index}`, index]));
    await step(0);
    const events = await step(2000, { investigation: 10, crime: 1, rent: 900, day: 4, rentPaid: 2, augsShot: 0, eventSequence: 0,
        reputation, client: { id: 'georgio', name: '乔治奥', faction: 'f', visit: 1 }, cash: 1500,
        scene: { id: 'store' }, health: { wound: 2, stable: true }, difficulty: { id: 'normal', retailMarkup: 15, effects: [] } });
    const page = events.find(event => event.facts.some(item => item.key === 'page' && item.value === 0));
    assert.ok(page.facts.length <= 32, String(page.facts.length));
    assert.ok(page.facts.some(item => item.key === 'cashDelta'));
    assert.ok(!page.facts.some(item => item.key === 'location'), 'The misleading IN_STORE enum is not shown to her');
}));

// Regressions from the Codex review of reader 1.4.

async function flaky(run) {
    const directory = await mkdtemp(join(tmpdir(), 'jingjing-immersion-'));
    const statePath = join(directory, 'state.json');
    let now = START;
    const control = { fail: false, attempts: [], delivered: [] };
    const bridge = new GameWorldBridge({ statePath, now: () => now, send: async events => {
        control.attempts.push(events);
        if (control.fail) throw new Error('response lost');
        control.delivered.push(...events);
    } });
    const step = async (after, overrides) => {
        now = START + after;
        await writeFile(statePath, JSON.stringify(base(now, overrides)));
        await bridge.poll();
    };
    try { await run(step, control); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('a change event lost in transit is retried with the same ID even after the snapshot moves on', () => flaky(async (step, control) => {
    await step(0, { health: { wound: 0, stable: true } });
    control.fail = true;
    await step(2000, { health: { wound: 3, stable: true } });
    control.fail = false;
    // The wound already healed and cash changed before the retry: the injury still arrives, with its first ID.
    await step(4000, { health: { wound: 0, stable: true }, cash: 900 });
    const ids = control.attempts.map(events => events.find(event => tags([event]).includes('health:minor'))?.eventId).filter(Boolean);
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, 1);
    assert.ok(tags(control.attempts.at(-1)).includes('health:healed'));
}));

test('changes queued for one save are dropped when another save loads', () => flaky(async (step, control) => {
    await step(0);
    control.fail = true;
    await step(2000, { scene: { id: 'dr_jackson', visits: 2 } });
    await step(8000, { scene: { id: 'dr_jackson', visits: 2 } });
    control.fail = false;
    await step(10000, { runId: 'run-2', saveSlot: 2 });
    assert.ok(!tags(control.delivered).some(tag => tag.startsWith('scene:')), 'The first save\'s outing never reaches the second');
}));

test('after a restart, journal lines from earlier visitors produce no arrivals or departures', () => harness(async step => {
    const line = (seq, visit, id, name, text) => ({ id: `d1:${seq}`, seq, role: 'npc', channel: 'counter', speaker: name, text,
        runId: '1:run-1', clientId: id, clientName: name, visit, scene: 'store', at: START - 60000 + seq });
    const first = await step(0, { dialogueSession: 'd1', client: { id: 'b', name: '乙', visit: 2 },
        dialogue: [line(1, 1, 'a', '甲', '旧话'), line(2, 2, 'b', '乙', '也是旧话')] });
    assert.ok(!tags(first).some(tag => tag.startsWith('npc_')), tags(first).join(','));
    assert.equal(first.filter(event => tags([event]).includes('dialogue:npc')).length, 2, 'The lines themselves are still delivered');
    // The visitor standing there at startup is the baseline: their leaving later is real.
    assert.deepEqual(tags(await step(2000, { dialogueSession: 'd1' })).filter(tag => tag.startsWith('npc_')), ['npc_left:b']);
}));

test('going back to the same place later the same night is a revisit; a new day starts the count again', () => harness(async step => {
    const shop = { scene: { id: 'dr_jackson', visits: 5 }, day: 3 };
    await step(0, { day: 3 });
    await step(2000, shop);
    assert.ok(tags(await step(8000, shop)).includes('scene:visit:dr_jackson'));
    await step(10000, { day: 3 });
    await step(16000, { day: 3 });
    await step(18000, shop);
    assert.ok(tags(await step(24000, shop)).includes('scene:revisit:dr_jackson'), 'Popping home in between does not reset tonight');
    await step(26000, { day: 4 });
    await step(32000, { day: 4 });
    await step(34000, { ...shop, day: 4 });
    assert.ok(tags(await step(40000, { ...shop, day: 4 })).includes('scene:visit:dr_jackson'), 'The next night counts from one');
}));

test('a refused blackmail is not mistaken for an innocent visitor', () => harness(async step => {
    await step(0);
    const entry = (seq, outcome) => ({ id: `j1:${seq}`, runId: '1:run-1', at: START + 1000, type: 'bargain', detail: 'blackmail', amount: 20, outcome, clientName: '乔治奥' });
    const events = await step(2000, { events: [entry(1, 'refused'), entry(2, 'failed')], eventSequence: 2 });
    const text = events.filter(event => tags([event]).includes('bargain:blackmail')).map(event => event.summary);
    assert.match(text[0], /有把柄，但不吃这套/);
    assert.match(text[1], /没成$/);
    assert.ok(!text.some(summary => summary.includes('没犯事')));
}));

test('returning to an earlier difficulty is reported again', () => harness(async step => {
    const normal = { id: 'normal', retailMarkup: 15, effects: [] };
    const hard = { id: 'hard', retailMarkup: 0, effects: [] };
    const ids = [];
    for (const [index, difficulty] of [normal, hard, normal, hard].entries()) {
        const events = await step(index * 2000, { difficulty });
        ids.push(...events.filter(event => tags([event]).some(tag => tag.startsWith('difficulty:'))).map(event => event.eventId));
    }
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4);
}));

test('a wound healing within the same level is reported as better', () => harness(async step => {
    await step(0, { health: { wound: 5, stable: true } });
    assert.ok(tags(await step(2000, { health: { wound: 1, stable: true } })).includes('health:better'));
}));
