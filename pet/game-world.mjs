import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Reader 1.2+ writes to the user data folder (works for Workshop installs); 1.1 wrote inside the game Mods folder.
export const DEFAULT_GAME_STATE_PATH = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'CharacterCompanion', 'probably-stolen', 'state.json');
export const LEGACY_GAME_STATE_PATH = 'C:/Program Files (x86)/Steam/steamapps/common/Probably Stolen/Mods/JingjingWorldBridge/state.json';
export const DEFAULT_GAME_STATE_PATHS = [DEFAULT_GAME_STATE_PATH, LEGACY_GAME_STATE_PATH];
const STALE_MS = 15000;
const REFRESH_MS = 10000;
const MAX_ITEMS = 1000;
const PAGE_SIZE = 23;

const DIALOGUE_LIMIT = 40;
// Money moves without a traded item; each names the reason for the next balance change.
const MONEY_LABELS = { 'money:service': '支付服务费', 'money:bribe': '行贿', 'money:permit': '购买许可', 'money:vending': '自动贩卖收入',
    'money:fountain': '饮水机收入', 'money:mortgage': '还按揭', 'money:loan_taken': '借款', 'money:loan_repaid': '还借款' };
const JOURNAL_TYPES = ['rent_paid', 'kill:ai_controlled', 'item_bought', 'item_sold', ...Object.keys(MONEY_LABELS),
    'scav_loot', 'scav_injury', 'night_log', 'bargain'];
// A scene must hold this long before it counts: flicking through the night map is not a visit.
export const SCENE_SETTLE_MS = 5000;
// A scavenged item worth at least this (one unit, game value) is a find worth speaking up about.
export const SCAV_FIND_VALUE = 50;
const STORE_SIDE = new Set(['store', 'end_of_day']);
export const SCENE_LABELS = { store: '店里', map: '夜里街上（看地图选去处）', end_of_day: '打烊结算', dumping_ground: '垃圾场',
    commissary: '小卖部', dr_jackson: '杰克逊博士的店' };
const DIFFICULTY_LABELS = { cozy: '休闲', normal: '普通', hard: '困难', challenge: '挑战' };
const BARGAIN_KINDS = ['discount', 'markup', 'buying_markup', 'buying_discount', 'blackmail', 'threaten'];
const BARGAIN_OUTCOMES = ['accepted', 'refused', 'worked', 'failed', 'innocent'];
const SAFE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
// Feature categories the game appraises (label vs actual); unknown ones keep a generic name.
const FEATURE_LABELS = { CATEGORY_WATER_PURITY: '水质', CATEGORY_CHEMICAL_PURITY: '化学纯度', CATEGORY_GENUINE_CIGARETTE: '香烟真伪',
    CATEGORY_GENUINE_INJECTOR: '注射器真伪', CATEGORY_GENUINE_STAMP: '印章真伪', CATEGORY_INGOT_PURITY: '金属锭纯度',
    CATEGORY_WINE_QUALITY: '酒品质', CATEGORY_EQUIPMENT_CONDITION: '装备成色', CATEGORY_FRESHNESS: '新鲜度', CATEGORY_EXPIRED: '保质期',
    CATEGORY_RUSTED: '锈蚀', CATEGORY_DENTED: '凹痕', CATEGORY_OPEN_BOX: '包装', CATEGORY_SHABBY: '破旧', CATEGORY_SECOND_HAND: '二手',
    CATEGORY_REPLICA: '复制品', CATEGORY_TRASH_GRADE: '垃圾级', CATEGORY_FREE: '赠品', CATEGORY_MODULE_STUCK: '模块卡死' };
export const LOCATION_LABELS = { store: '主库存', 'outer-counter': '外柜台', 'inner-counter': '内柜台', 'counter-stash': '柜台暂存',
    showcase: '展示柜', hidden: '暗格', documents: '文件架', 'cassette-player': '磁带机', 'vending-machine': '自动贩卖机',
    'vending-fountain': '饮水机', hireling: '雇员', 'pocket-left': '左口袋', 'pocket-backpack': '背包', 'pocket-right': '右口袋' };
const ROLE_LABELS = { client_offer: '对方出售', player_offer: '店主打算出售' };
const MAX_FEATURES = 6;

function normalizeFeatures(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(feature => feature && typeof feature.category === 'string' && /^[A-Z0-9_]{1,40}$/.test(feature.category)
        && typeof feature.actual === 'string' && feature.actual.trim()).slice(0, MAX_FEATURES)
        .map(feature => ({ category: feature.category, label: optionalText(feature.label, 40), actual: shortText(feature.actual.trim(), 40),
            match: feature.match === true, overstated: feature.overstated === true, understated: feature.understated === true,
            exposed: feature.exposed === true,
            purity: typeof feature.purity === 'number' && Number.isFinite(feature.purity) && feature.purity >= 0 && feature.purity <= 100 ? feature.purity : null }));
}

/** One feature as a short Chinese phrase: "水质 标签「纯净水」实际「鬼水」(纯度 96.12%) 虚标". */
export function describeFeature(feature) {
    const name = FEATURE_LABELS[feature.category] ?? feature.category.replace(/^CATEGORY_/, '').toLowerCase();
    const purity = feature.purity === null ? '' : `(纯度 ${feature.purity}%)`;
    const verdict = feature.match ? '属实' : feature.overstated ? '虚标' : feature.understated ? '低标' : '不符';
    const label = feature.label === null ? '无标签' : `标签「${feature.label}」`;
    return `${name} ${label}实际「${feature.actual}」${purity} ${verdict}`;
}

export function describeFeatures(features) {
    return features.map(describeFeature).join('；');
}

function itemKey(item) {
    // Exposing a feature in negotiation does not make it a new item.
    return JSON.stringify([item.location, item.id, item.name, item.owner, item.features.map(f => [f.category, f.label, f.actual])]);
}

function optionalText(value, length) {
    return typeof value === 'string' && value.trim() ? shortText(value, length) : null;
}
const DIALOGUE_TEXT = 180;

function shortText(value, length) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid game text');
    return value.replace(/[\r\n\t]+/g, ' ').slice(0, length);
}

// [id, name, location, quantity, role, appraisal]; role is null for plain stock, appraisal null when the item has none.
function itemFact(item) {
    const tuple = [item.id, item.name, item.location, item.quantity, item.role, item.features.length ? describeFeatures(item.features) : null];
    while (JSON.stringify(tuple).length > 200) {
        if (tuple[5] && tuple[5].length > 60) { tuple[5] = tuple[5].slice(0, -1); continue; }
        const index = tuple[0].length > tuple[1].length ? 0 : 1;
        tuple[index] = tuple[index].slice(0, -1);
    }
    return JSON.stringify(tuple);
}

function normalize(raw, now) {
    if (raw?.schemaVersion !== 1 || raw.source !== 'probably-stolen' || typeof raw.ready !== 'boolean'
        || !Number.isSafeInteger(raw.capturedAt) || raw.capturedAt < 0 || raw.capturedAt > now + 5000) {
        throw new Error('Invalid game snapshot');
    }
    const base = { schemaVersion: 1, source: raw.source, sessionId: shortText(raw.sessionId, 64),
        capturedAt: raw.capturedAt, ready: raw.ready && now - raw.capturedAt <= STALE_MS };
    if (!base.ready) return { ...base, cash: null, items: [], reason: '游戏未加载或快照已过期' };
    if (!Number.isSafeInteger(raw.cash) || !Number.isSafeInteger(raw.saveSlot)
        || !Array.isArray(raw.items) || raw.items.length > MAX_ITEMS) throw new Error('Invalid game inventory');
    const items = raw.items.map(item => {
        if (!Number.isSafeInteger(item.quantity) || item.quantity < 0) throw new Error('Invalid item quantity');
        // Reader 1.2 sends neither owner nor role: everything it lists is the player's.
        const owner = item.owner === 'client' ? 'client' : 'player';
        const role = item.role === 'client_offer' || item.role === 'player_offer' ? item.role : null;
        return { id: shortText(item.id, 48), name: shortText(item.name, 48),
            location: shortText(item.location, 24), quantity: item.quantity, owner, role, features: normalizeFeatures(item.features) };
    }).sort((a, b) => `${a.location}:${a.id}:${a.name}`.localeCompare(`${b.location}:${b.id}:${b.name}`));
    const extra = {};
    for (const key of ['investigation', 'crime', 'rent', 'day', 'rentPaid', 'augsShot']) {
        if (raw[key] !== undefined && raw[key] !== null) {
            if (!Number.isSafeInteger(raw[key])) throw new Error('Invalid game scalar');
            extra[key] = raw[key];
        }
    }
    if (raw.location) extra.location = shortText(raw.location, 48);
    extra.scene = normalizeScene(raw.scene);
    extra.health = raw.health && Number.isSafeInteger(raw.health.wound) && raw.health.wound >= 0 && raw.health.wound <= 99
        ? { wound: raw.health.wound, stable: raw.health.stable !== false, fresh: raw.health.fresh === true, serious: raw.health.serious === true } : null;
    extra.difficulty = normalizeDifficulty(raw.difficulty);
    if (Number.isSafeInteger(raw.scavLeft) && raw.scavLeft >= 0 && raw.scavLeft <= 99) extra.scavLeft = raw.scavLeft;
    extra.reputation = Object.fromEntries(Object.entries(raw.reputation ?? {}).filter(([key, value]) =>
        /^[A-Za-z0-9_.-]{1,40}$/.test(key) && typeof value === 'number' && Number.isFinite(value)).slice(0, 8));
    extra.client = raw.client?.id ? { id: shortText(raw.client.id, 64), name: shortText(raw.client.name || raw.client.id, 64),
        faction: shortText(raw.client.faction || 'unknown', 64), isSecurity: raw.client.isSecurity === true,
        visit: Number.isSafeInteger(raw.client.visit) && raw.client.visit > 0 ? raw.client.visit : null } : null;
    extra.events = (raw.events ?? []).filter(event => /^[A-Za-z0-9_:.-]{1,90}$/.test(event.id)
        && JOURNAL_TYPES.includes(event.type)
        && Number.isSafeInteger(event.at) && event.at <= now + 5000 && Number.isSafeInteger(event.amount)).slice(-128)
        .map(event => ({ id: event.id, type: event.type, at: event.at, amount: event.amount,
            runId: shortText(event.runId, 80), itemId: event.itemId ? shortText(event.itemId, 64) : null,
            itemName: event.itemName ? shortText(event.itemName, 64) : null,
            boughtFor: Number.isSafeInteger(event.boughtFor) && event.boughtFor > 0 ? event.boughtFor : null,
            clientId: optionalText(event.clientId, 64), clientName: optionalText(event.clientName, 64), detail: optionalText(event.detail, 64),
            features: normalizeFeatures(event.features),
            outcome: BARGAIN_OUTCOMES.includes(event.outcome) ? event.outcome : null,
            loot: normalizeLoot(event.loot),
            lines: (Array.isArray(event.lines) ? event.lines : []).filter(line => typeof line === 'string' && line.trim()).slice(0, 12)
                .map(line => shortText(line.trim(), 120)) }))
        .filter(event => event.type !== 'bargain' || BARGAIN_KINDS.includes(event.detail));
    // Completed dialogue lines (own journal in the reader). Invalid lines are dropped, never the whole snapshot.
    const dialogueSession = typeof raw.dialogueSession === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.dialogueSession) ? raw.dialogueSession : null;
    extra.dialogueSession = dialogueSession;
    extra.dialogue = dialogueSession ? (Array.isArray(raw.dialogue) ? raw.dialogue : []).filter(line => line
        && Number.isSafeInteger(line.seq) && line.seq > 0 && line.id === `${dialogueSession}:${line.seq}`
        && ['npc', 'player'].includes(line.role) && typeof line.text === 'string' && line.text.trim()
        && typeof line.runId === 'string' && line.runId.trim()
        && Number.isSafeInteger(line.at) && line.at <= now + 5000).slice(-DIALOGUE_LIMIT)
        .map(line => ({ id: line.id, seq: line.seq, role: line.role, channel: line.channel === 'phone' ? 'phone' : 'counter',
            speaker: typeof line.speaker === 'string' && line.speaker.trim() ? shortText(line.speaker, 64) : 'unknown',
            text: shortText(line.text.trim(), DIALOGUE_TEXT), runId: shortText(line.runId, 80),
            clientId: typeof line.clientId === 'string' && line.clientId.trim() ? shortText(line.clientId, 64) : null,
            clientName: optionalText(line.clientName, 64), scene: typeof line.scene === 'string' && SAFE_ID.test(line.scene) ? line.scene : null,
            visit: Number.isSafeInteger(line.visit) && line.visit > 0 ? line.visit : null, security: line.security === true, at: line.at })) : [];
    if (Number.isSafeInteger(raw.eventSequence) && raw.eventSequence >= 0) {
        extra.readerSession = base.sessionId;
        extra.readerSeq = raw.eventSequence;
        extra.readerFirstSeq = extra.events.length ? Number(extra.events[0].id.split(':').at(-1)) : raw.eventSequence + 1;
    }
    return { ...base, saveSlot: raw.saveSlot, runId: shortText(raw.runId, 64), cash: raw.cash, items, ...extra };
}

function normalizeScene(raw) {
    if (!raw || typeof raw.id !== 'string' || !SAFE_ID.test(raw.id)) return null;
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    return { id: raw.id, title: optionalText(raw.title, 48), visits: count(raw.visits), lastVisitDay: count(raw.lastVisitDay) };
}

function normalizeDifficulty(raw) {
    if (!raw || typeof raw.id !== 'string' || !SAFE_ID.test(raw.id)) return null;
    const percent = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000 ? value : null;
    return { id: raw.id, title: optionalText(raw.title, 48), retailMarkup: percent(raw.retailMarkup), inventorMarkup: percent(raw.inventorMarkup),
        retiredSupplierMarkup: percent(raw.retiredSupplierMarkup), merchantDiscount: percent(raw.merchantDiscount),
        effects: (Array.isArray(raw.effects) ? raw.effects : []).filter(line => typeof line === 'string' && line.trim()).slice(0, 12)
            .map(line => shortText(line.trim(), 120)) };
}

function normalizeLoot(raw) {
    return (Array.isArray(raw) ? raw : []).filter(item => item && typeof item.id === 'string' && SAFE_ID.test(item.id)
        && typeof item.name === 'string' && item.name.trim() && Number.isSafeInteger(item.quantity) && item.quantity > 0).slice(0, 12)
        .map(item => ({ id: item.id, name: shortText(item.name.trim(), 48), quantity: item.quantity,
            value: Number.isSafeInteger(item.value) && item.value >= 0 ? item.value : null }));
}

/** In the store or its end-of-day screen; unknown (older reader) counts as the store. */
const isStoreSide = sceneId => sceneId === null || sceneId === undefined || STORE_SIDE.has(sceneId);

/** Where the player is, for her: "店里" / "外出：垃圾场" / "外出：四十七酿酒商店". */
export function describeScene(scene) {
    if (!scene) return null;
    const name = SCENE_LABELS[scene.id] ?? scene.title ?? scene.id;
    return isStoreSide(scene.id) ? name : `外出：${name}`;
}

const healthLevel = health => health.wound === 0 ? 0 : health.serious ? 2 : 1;

/** "健康" / "重伤（伤势 7/10，行动受限，伤情不稳定，夜里可能恶化）". */
export function describeHealth(health) {
    if (!health) return null;
    if (health.wound === 0) return '健康';
    const notes = [`伤势 ${health.wound}/10`];
    if (health.serious) notes.push('行动受限');
    if (!health.stable) notes.push('伤情不稳定，夜里可能恶化');
    if (health.fresh) notes.push('今晚刚受的伤，不能再拾荒');
    return `${health.serious ? '重伤' : '轻伤'}（${notes.join('，')}）`;
}

/** "普通「Mark Up」，卖货加价 15%". */
export function describeDifficulty(difficulty) {
    if (!difficulty) return null;
    const name = DIFFICULTY_LABELS[difficulty.id] ?? difficulty.title ?? difficulty.id;
    const markup = difficulty.retailMarkup === null ? '' : difficulty.retailMarkup > 0 ? `，卖货加价 ${difficulty.retailMarkup}%` : '，卖货无加价';
    return `${name}${difficulty.title && difficulty.title !== name ? `「${difficulty.title}」` : ''}${markup}`;
}

const difficultyKey = difficulty => difficulty ? `${difficulty.id}|${difficulty.retailMarkup}` : null;

const BARGAIN_TEXT = {
    discount: (who, percent) => `店主主动给 ${who} 让价 ${percent}%`,
    markup: (who, percent, outcome) => `店主卖货时对 ${who} 加价 ${percent}%，${outcome === 'accepted' ? '对方勉强接受' : '对方拒绝了'}`,
    buying_markup: (who, percent) => `店主收货时主动多付 ${who} ${percent}%`,
    buying_discount: (who, percent, outcome) => `店主收货时向 ${who} 压价 ${percent}%，${outcome === 'accepted' ? '对方接受' : '对方拒绝了'}`,
    blackmail: (who, _percent, outcome) => `店主勒索 ${who}，${{ worked: '得手了，价格让 20%', refused: '对方确实有把柄，但不吃这套',
        innocent: '没用，对方根本没犯事' }[outcome] ?? '没成'}`,
    threaten: (who, _percent, outcome) => `店主威胁 ${who} 是改造人，${outcome === 'worked' ? '对方服软，价格让 20%' : '没用，对方不是改造人'}`,
};

/** One reader session of one save and run; anything observed belongs to exactly one. */
const runKey = state => `${state.sessionId}|${state.saveSlot}|${state.runId}`;

/** A scene counts once it has held for SCENE_SETTLE_MS; quick hops through the night map never do. */
export class SceneTracker {
    constructor() { this.reset(null); }

    reset(run) {
        this.run = run;
        this.settled = null;
        this.candidate = null;
        this.since = 0;
        this.tonight = new Map();
        this.day = null;
    }

    /** Returns the settled transition, or null. The first scene of a run is a baseline, never a transition. */
    observe(state) {
        if (!state.ready || !state.scene) return null;
        const run = runKey(state);
        const id = state.scene.id;
        if (run !== this.run) {
            this.reset(run);
            this.settled = this.candidate = id;
            this.since = state.capturedAt;
            this.day = state.day ?? null;
            return null;
        }
        // "Tonight" ends with the game day, not when the player pops back into the store between outings.
        if ((state.day ?? null) !== this.day) {
            this.day = state.day ?? null;
            this.tonight.clear();
        }
        if (id !== this.candidate) {
            this.candidate = id;
            this.since = state.capturedAt;
        }
        if (id === this.settled || state.capturedAt - this.since < SCENE_SETTLE_MS) return null;
        const from = this.settled;
        this.settled = id;
        const place = id !== 'map' && !isStoreSide(id);
        const tonight = place ? (this.tonight.get(id) ?? 0) + 1 : 0;
        if (place) this.tonight.set(id, tonight);
        return { from, to: state.scene, tonight };
    }
}

function itemLine(item) {
    return `${item.name}×${item.quantity}`;
}

/** Page-zero digest of both counters, so she can tell offers from stock without parsing tuples. */
function counterSummary(items) {
    const offers = items.filter(item => item.role === 'client_offer');
    const selling = items.filter(item => item.role === 'player_offer');
    let text = '';
    if (offers.length) text += `；柜台上对方出售：${offers.slice(0, 6).map(itemLine).join('、')}${offers.length > 6 ? ' 等' : ''}`;
    if (selling.length) text += `；内柜台上店主打算出售：${selling.slice(0, 6).map(itemLine).join('、')}${selling.length > 6 ? ' 等' : ''}`;
    return text;
}

export class GameWorldBridge {
    // statePath: one file, or candidates of which the most recently written one is read.
    constructor({ statePath = DEFAULT_GAME_STATE_PATHS, now = Date.now, send }) {
        this.statePaths = Array.isArray(statePath) ? statePath : [statePath];
        this.statePath = this.statePaths[0];
        this.now = now;
        this.send = send;
        this.current = null;
        this.previous = null;
        this.sentDialogue = null;
        this.lastHash = null;
        this.lastSentAt = null;
        this.connected = false;
        this.error = null;
        this.busy = false;
        this.pending = null;
        this.scenes = new SceneTracker();
        // Discrete changes seen between polls (scenes, health, difficulty) waiting for delivery, tagged with their run.
        // IDs are fixed when queued, so a retry after a lost response is deduplicated even if the snapshot moved on.
        this.queue = [];
        // Last health / difficulty seen on any poll (delivered or not), per run: the baseline for the next change.
        this.seen = null;
        // The visitor last introduced to CL ({ session, key, id, name }), so lines and arrivals stay in order.
        this.announced = null;
    }

    async resolveStatePath() {
        let newest = null;
        for (const path of this.statePaths) {
            const info = await stat(path).catch(() => null);
            if (info?.isFile() && (!newest || info.mtimeMs > newest.info.mtimeMs)) newest = { path, info };
        }
        if (!newest) throw Object.assign(new Error('No game snapshot'), { code: 'ENOENT' });
        this.statePath = newest.path;
        return newest.info;
    }

    snapshot() {
        if (!this.current?.ready || this.now() - this.current.capturedAt > STALE_MS) return null;
        return structuredClone(this.current);
    }

    status() {
        return { enabled: true, ready: this.snapshot() !== null, connected: this.connected,
            capturedAt: this.current?.capturedAt ?? null, lastSentAt: this.lastSentAt, error: this.error };
    }

    async poll() {
        if (this.busy) return;
        this.busy = true;
        try {
            const now = this.now();
            let state;
            try {
                const info = await this.resolveStatePath();
                if (info.size > 2 * 1024 * 1024) throw new Error('Snapshot too large');
                state = normalize(JSON.parse(await readFile(this.statePath, 'utf8')), now);
            } catch (error) {
                state = { ready: false, cash: null, items: [], capturedAt: now, reason: '无法读取游戏快照' };
                this.error = error.code === 'ENOENT' ? '等待游戏模组写入快照' : '游戏快照无效或不可读';
            }
            this.current = state;
            // Changes are detected on every poll: a settled transition must not wait for the next content change.
            this.observeWorld(state);
            const { capturedAt, ...content } = state;
            const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
            if (!this.queue.length && hash === this.lastHash
                && (this.lastSentAt !== null && now - this.lastSentAt < REFRESH_MS || !state.ready)) return;
            // Keep event IDs stable during retries after a lost HTTP response.
            if (this.pending?.hash !== hash) this.pending = { hash, ...this.buildEvents(state, now) };
            const queued = this.queue.slice();
            try {
                await this.send([...this.pending.events, ...queued.map(entry => entry.event)]);
                this.queue = this.queue.filter(entry => !queued.includes(entry));
                this.announced = this.pending.announced;
                if (state.dialogueSession && state.dialogue?.length) {
                    this.sentDialogue = { session: state.dialogueSession, seq: Math.max(...state.dialogue.map(line => line.seq)) };
                }
                this.previous = state;
                this.lastHash = hash;
                this.lastSentAt = now;
                this.pending = null;
                this.connected = true;
                if (state.ready) this.error = null;
            } catch {
                this.connected = false;
                this.error = 'CL 世界事件未送达，将自动重试';
            }
        } finally {
            this.busy = false;
        }
    }

    /** Items newly put on a counter: what the visitor offers, what the player lays out, and what their labels hide. */
    counterEvents(state, event, snapshotId) {
        const before = new Set(this.previous.items.map(itemKey));
        const fresh = state.items.filter(item => item.role && !before.has(itemKey(item)));
        const result = [];
        const offers = fresh.filter(item => item.role === 'client_offer');
        const selling = fresh.filter(item => item.role === 'player_offer');
        const who = state.client?.name ?? '来客';
        if (offers.length) {
            result.push(event(`ps-counter:${snapshotId}:client`, 'counter:client_offer',
                shortText(`柜台：${who} 摆出要卖的东西：${offers.map(itemLine).join('、')}`, 200),
                [{ key: 'role', value: ROLE_LABELS.client_offer }]));
        }
        if (selling.length) {
            result.push(event(`ps-counter:${snapshotId}:player`, 'counter:player_offer',
                shortText(`柜台：店主把 ${selling.map(itemLine).join('、')} 放上内柜台，打算卖给 ${who}`, 200),
                [{ key: 'role', value: ROLE_LABELS.player_offer }]));
        }
        for (const [index, item] of fresh.filter(entry => entry.features.length).entries()) {
            const lies = item.features.filter(feature => !feature.match);
            const fake = lies.some(feature => feature.overstated);
            const cheap = lies.some(feature => feature.understated);
            let tag;
            let verdict;
            if (item.role === 'client_offer') {
                tag = fake ? 'appraisal:client_fake' : cheap ? 'appraisal:client_bargain' : 'appraisal:client_genuine';
                verdict = fake ? '标签虚标，别按标签价收' : cheap ? '标签低估了，实际更值钱，可以捡漏' : '标签属实';
            } else {
                tag = fake ? 'appraisal:player_fake' : 'appraisal:player_genuine';
                verdict = fake ? '店主准备拿虚标货去卖' : cheap ? '标签低估了，店主可能卖亏' : '标签属实';
            }
            result.push(event(`ps-appraisal:${snapshotId}:${index}`, tag,
                shortText(`鉴定（读取游戏数据）：${ROLE_LABELS[item.role]}的 ${item.name} —— ${describeFeatures(item.features)}；${verdict}`, 200),
                [{ key: 'itemName', value: item.name }, { key: 'role', value: ROLE_LABELS[item.role] },
                    { key: 'appraisal', value: shortText(describeFeatures(item.features), 200) }]));
        }
        return result;
    }

    buildEvents(state, now) {
        const snapshotId = randomUUID();
        // Page zero holds scalar state; item pages keep all facts under the CL limit.
        const pages = 1 + Math.ceil(state.items.length / PAGE_SIZE);
        const sameRun = state.ready && this.previous?.ready && state.sessionId === this.previous.sessionId
            && state.runId === this.previous.runId && state.saveSlot === this.previous.saveSlot;
        const result = Array.from({ length: pages }, (_, page) => {
            const facts = [
                { key: 'source', value: 'probably-stolen' }, { key: 'snapshotId', value: snapshotId },
                { key: 'page', value: page }, { key: 'pages', value: pages },
                { key: 'ready', value: state.ready }, { key: 'capturedAt', value: state.capturedAt },
            ];
            if (state.ready) {
                facts.push({ key: 'cash', value: state.cash });
                facts.push({ key: 'save', value: `${state.saveSlot}:${state.runId}`.slice(0, 200) });
                if (page === 0) {
                    // The game's IN_STORE/INVENTOR enum stays out: it says IN_STORE while the player is outside.
                    for (const key of ['investigation', 'crime', 'rent', 'day', 'rentPaid', 'augsShot', 'readerSession', 'readerSeq', 'readerFirstSeq']) {
                        if (state[key] !== undefined) facts.push({ key, value: state[key] });
                    }
                    const context = { playerLocation: describeScene(state.scene), playerState: describeHealth(state.health),
                        difficulty: describeDifficulty(state.difficulty),
                        scavLeft: state.scene?.id === 'dumping_ground' && state.scavLeft !== undefined ? state.scavLeft : null };
                    for (const [key, value] of Object.entries(context)) if (value !== null) facts.push({ key, value });
                    // At a night location the "client" is that place's shopkeeper, not a visitor in the store.
                    if (state.client && isStoreSide(state.scene?.id)) facts.push({ key: 'clientId', value: state.client.isSecurity ? 'security_officer' : state.client.id },
                        { key: 'clientName', value: state.client.name }, { key: 'clientFaction', value: state.client.faction });
                    else if (state.client) facts.push({ key: 'hostName', value: state.client.name });
                    // Reputation fills what is left under the kernel's 32-fact limit (one slot kept for cashDelta).
                    for (const [key, value] of Object.entries(state.reputation ?? {})) if (facts.length < 31) facts.push({ key: `reputation.${key}`, value });
                }
                for (const [index, item] of (page === 0 ? [] : state.items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)).entries()) {
                    // A compact tuple keeps every fact within the native 200-character limit.
                    facts.push({ key: `item.${index}`, value: itemFact(item) });
                }
            }
            const delta = sameRun ? state.cash - this.previous.cash : null;
            let summary = state.ready ? `游戏世界事件：资金 ${state.cash}；库存第 ${page + 1}/${pages} 页，共 ${state.items.length} 类` : '游戏世界事件：当前游戏数据不可用，不得沿用之前的资金和库存';
            if (state.ready && page === 0) summary += counterSummary(state.items);
            if (delta !== null && delta !== 0) summary += `；资金变化 ${delta > 0 ? '+' : ''}${delta}`;
            if (sameRun && page === 0) {
                const oldItems = new Map(this.previous.items.filter(item => item.owner === 'player').map(item => [itemKey(item), item.quantity]));
                let added = 0;
                let removed = 0;
                for (const item of state.items.filter(entry => entry.owner === 'player')) {
                    const key = itemKey(item);
                    const change = item.quantity - (oldItems.get(key) ?? 0);
                    if (change > 0) added += change;
                    else removed -= change;
                    oldItems.delete(key);
                }
                for (const quantity of oldItems.values()) removed += quantity;
                if (added || removed) summary += `；物品数量增加 ${added}，减少 ${removed}（含库存移动，原因未知）`;
            }
            if (page === 0 && delta !== null && facts.length < 32) facts.push({ key: 'cashDelta', value: delta });
            return { eventId: `ps:${snapshotId}:${page}`, kind: 'observation', actionId: null, result: null,
                atWorldTimeMs: now, summary, facts, code: null };
        });
        if (!state.ready) return { events: result, announced: this.announced };
        const save = `${state.saveSlot}:${state.runId}`;
        const event = (id, tag, summary, facts = [], at = now) => ({ eventId: id, kind: 'observation', actionId: null, result: null,
            atWorldTimeMs: at, summary, code: null, facts: [{ key: 'source', value: 'probably-stolen' },
                { key: 'event', value: tag }, { key: 'runId', value: save }, ...facts] });
        for (const entry of state.events ?? []) {
            if (entry.runId !== save) continue;
            const world = this.worldEntry(entry, event);
            if (world !== undefined) {
                if (world) result.push(world);
                continue;
            }
            if ((entry.type === 'item_bought' || entry.type === 'item_sold') && !/^[A-Za-z0-9_.-]{1,64}$/.test(entry.itemId ?? '')) continue;
            const item = entry.itemName ?? entry.itemId;
            const who = entry.clientName ?? entry.clientId;
            const profit = entry.type === 'item_sold' && entry.boughtFor !== null ? entry.amount - entry.boughtFor : null;
            const tag = entry.type === 'item_bought' ? `item_bought:${entry.itemId}` : entry.type === 'item_sold' ? `sale:${entry.itemId}` : entry.type;
            const summary = entry.type === 'item_bought' ? `游戏成交回调：买入 ${item}${who ? `（卖家 ${who}）` : ''}，支付 ${entry.amount}`
                : entry.type === 'item_sold' ? `游戏成交回调：卖出 ${item}${who ? ` 给 ${who}` : ''}，收款 ${entry.amount}${profit !== null ? `，进价 ${entry.boughtFor}，利润 ${profit}` : '，进价未知'}`
                    : MONEY_LABELS[entry.type] ? `游戏资金回调：${MONEY_LABELS[entry.type]} ${entry.amount}${entry.detail ? `（${entry.detail}）` : ''}`
                        : entry.type === 'rent_paid' ? `游戏租金回调：支付房租 ${entry.amount}` : '游戏击杀回调：1 名被 AI 控制的来客被击杀';
            const trade = entry.type === 'item_bought' || entry.type === 'item_sold';
            const lies = trade ? entry.features.filter(feature => !feature.match) : [];
            const fake = lies.some(feature => feature.overstated);
            const appraisal = lies.length ? `；鉴定：${describeFeatures(lies)}${fake ? (entry.type === 'item_sold' ? '（店主卖的是标签虚标的货）' : '（店主买到了虚标货）') : ''}` : '';
            const extraTags = fake ? [{ key: 'event', value: entry.type === 'item_sold' ? 'appraisal:sold_fake' : 'appraisal:bought_fake' }] : [];
            result.push(event(`ps-event:${entry.id}`, tag, shortText(summary + appraisal, 200),
                [{ key: 'amount', value: entry.amount }, { key: 'readerSession', value: entry.id.split(':').slice(0, -1).join(':') },
                    { key: 'readerSeq', value: Number(entry.id.split(':').at(-1)) },
                    ...(entry.itemName ? [{ key: 'itemName', value: entry.itemName }] : []),
                    ...(trade ? [{ key: 'price', value: entry.amount }] : []),
                    ...(profit !== null ? [{ key: 'profit', value: profit }, { key: 'boughtFor', value: entry.boughtFor }] : []),
                    ...(trade && entry.clientName ? [{ key: 'clientName', value: entry.clientName }] : []),
                    ...(trade && entry.clientId ? [{ key: 'clientId', value: entry.clientId }] : []),
                    ...(entry.detail ? [{ key: 'detail', value: entry.detail }] : []),
                    ...(lies.length ? [{ key: 'appraisal', value: shortText(describeFeatures(lies), 200) }] : []), ...extraTags], entry.at));
        }
        if (sameRun) result.push(...this.counterEvents(state, event, snapshotId));
        // Visitors in the order they came: each one's arrival before their lines, the previous one's exit before that.
        const session = createHash('sha256').update(`${state.sessionId}|${save}`).digest('hex').slice(0, 24);
        let announced = this.announced?.session === session ? this.announced : null;
        const leave = (visitor, at = now) => event(`ps-left:${session}:${visitor.key}`, `npc_left:${visitor.id}`, `上一位来客离开：${visitor.name}`, [], at);
        const arrive = (visitor, at = now) => {
            if (announced) result.push(leave(announced, at));
            announced = { session, ...visitor };
            result.push(event(`ps-arrived:${session}:${visitor.key}`, `npc_arrived:${visitor.id}`, `来客进店：${visitor.name}`, [], at));
        };
        const dialogue = (state.dialogue ?? []).filter(line => line.runId === save);
        for (const [index, line] of dialogue.entries()) {
            // Lines already delivered in this reader session are not resent (the kernel would only count duplicates).
            if (this.sentDialogue?.session === state.dialogueSession && line.seq <= this.sentDialogue.seq) continue;
            const inStore = isStoreSide(line.scene);
            const visitKey = line.visit === null ? null : `v${line.visit}`;
            // Only live lines move visitors in and out; after a restart the journal's old lines are history, not arrivals.
            if (sameRun && line.role === 'npc' && inStore && visitKey && line.clientId && visitKey !== announced?.key) {
                arrive({ key: visitKey, id: line.security ? 'security_officer' : line.clientId, name: line.clientName ?? line.clientId }, line.at);
            }
            const name = line.speaker === 'unknown' ? line.clientName ?? '来客' : line.speaker;
            const who = line.role === 'player' ? '店主' : inStore || line.channel === 'phone' ? name : `${name}（店主正在对方店里）`;
            // NPCs repeat stock lines on every trade; a repeat is not news.
            const repeated = line.role === 'npc' && dialogue.slice(0, index).some(other => other.role === 'npc' && other.text === line.text
                && (other.clientId ?? other.speaker) === (line.clientId ?? line.speaker));
            result.push(event(`ps-line:${line.id}`, `dialogue:${line.role}`, shortText(`${who}：${line.text}${repeated ? '（这句刚才说过）' : ''}`, 200), [
                { key: 'speaker', value: line.role === 'npc' && line.speaker === 'unknown' && line.clientName ? line.clientName : line.speaker },
                { key: 'text', value: line.text }, { key: 'lineIndex', value: line.seq },
                { key: 'channel', value: line.channel }, ...(line.clientId ? [{ key: 'clientId', value: line.clientId }] : []),
                ...(repeated ? [{ key: 'repeated', value: true }] : [])], line.at));
        }
        if (sameRun && (this.previous.investigation ?? Infinity) < 75 && state.investigation >= 75) {
            result.push(event(`ps-threshold:${snapshotId}`, 'investigation_near_threshold', `读取器阈值事件：调查进度 ${state.investigation}，已达到提醒线 75`));
        }
        if (sameRun) {
            // At a night location the counterpart is that place's shopkeeper; the scene events speak for it.
            const visitor = state.client && isStoreSide(state.scene?.id) ? state.client : null;
            const visitorKey = visitor ? (visitor.visit === null ? `id:${visitor.id}` : `v${visitor.visit}`) : null;
            if (visitor && visitorKey !== announced?.key) {
                arrive({ key: visitorKey, id: visitor.isSecurity ? 'security_officer' : visitor.id, name: visitor.name });
            } else if (!visitor && announced) {
                result.push(leave(announced));
                announced = null;
            }
        } else {
            // A new run or reader session: whoever stands at the counter is the baseline, not an arrival.
            const visitor = state.client && isStoreSide(state.scene?.id) ? state.client : null;
            announced = visitor ? { session, key: visitor.visit === null ? `id:${visitor.id}` : `v${visitor.visit}`,
                id: visitor.isSecurity ? 'security_officer' : visitor.id, name: visitor.name } : null;
        }
        const story = { FACTION_CARTEL: 'cartel.first_visit', FACTION_REVOLUTION: 'revolution.first_visit', FACTION_CHURCH: 'church.first_visit' }[state.client?.faction];
        if (story) {
            const id = createHash('sha256').update(`${save}:${story}`).digest('hex');
            result.push(event(`ps-story:${id}`, `story:${story}`, `实际在场来客确认接触派系：${state.client.faction}`));
        }
        return { events: result, announced };
    }

    /** Scavenging, bargains and the night report. Returns undefined for journal types handled elsewhere, null to drop. */
    worldEntry(entry, event) {
        const journal = [{ key: 'readerSession', value: entry.id.split(':').slice(0, -1).join(':') },
            { key: 'readerSeq', value: Number(entry.id.split(':').at(-1)) }];
        if (entry.type === 'scav_loot') {
            if (!entry.loot.length) return null;
            const loot = [...entry.loot].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
            const best = loot[0].value !== null && loot[0].value >= SCAV_FIND_VALUE ? loot[0] : null;
            const line = item => `${item.name}${item.quantity > 1 ? `×${item.quantity}` : ''}（${item.value === null ? '估值未知' : `每件估值 ${item.value}`}）`;
            const text = best ? `店主在垃圾场翻到好东西：${line(best)}${loot.length > 1 ? `；另有 ${loot.slice(1).map(line).join('、')}` : ''}`
                : `店主在垃圾场翻到：${loot.map(line).join('、')}`;
            return event(`ps-event:${entry.id}`, best ? 'scav:find' : 'scav:loot', shortText(`拾荒（游戏回调）：${text}`, 200), [...journal,
                { key: 'itemName', value: (best ?? loot[0]).name }, ...(best ? [{ key: 'value', value: best.value }] : [])], entry.at);
        }
        if (entry.type === 'scav_injury') {
            const major = entry.detail === 'major';
            return event(`ps-event:${entry.id}`, major ? 'scav:injury_major' : 'scav:injury_minor',
                `拾荒受伤（游戏回调）：店主翻垃圾时受了${major ? '重伤，行动受限' : '轻伤，今晚不能再翻了'}`, journal, entry.at);
        }
        if (entry.type === 'night_log') {
            if (!entry.lines.length) return null;
            return event(`ps-event:${entry.id}`, 'night_report', shortText(`昨夜结算（游戏晨报）：${entry.lines.join('；')}`, 200),
                [...journal, { key: 'report', value: shortText(entry.lines.join('；'), 200) }], entry.at);
        }
        if (entry.type === 'bargain') {
            const who = entry.clientName ?? entry.clientId ?? '对方';
            return event(`ps-event:${entry.id}`, `bargain:${entry.detail}`,
                shortText(`议价（游戏回调）：${BARGAIN_TEXT[entry.detail](who, entry.amount, entry.outcome)}`, 200), [...journal,
                    { key: 'percent', value: entry.amount }, ...(entry.outcome ? [{ key: 'outcome', value: entry.outcome }] : []),
                    ...(entry.clientId ? [{ key: 'clientId', value: entry.clientId }] : [])], entry.at);
        }
        return undefined;
    }

    /** Queue this poll's scene, health and difficulty changes. Another save or reader session drops what is still queued. */
    observeWorld(state) {
        if (!state.ready) return;
        const run = runKey(state);
        this.queue = this.queue.filter(entry => entry.run === run);
        const enqueue = events => this.queue.push(...events.map(event => ({ run, event })));
        const transition = this.scenes.observe(state);
        if (transition) enqueue(this.sceneEvents(transition, state));
        const seen = this.seen?.run === run ? this.seen : null;
        enqueue(this.healthEvents(state, seen));
        enqueue(this.difficultyEvents(state, seen));
        this.seen = { run, health: state.health ?? seen?.health ?? null, difficulty: state.difficulty ?? seen?.difficulty ?? null,
            capturedAt: state.capturedAt };
    }

    /** Observation shaped like the reader's events, for changes detected here rather than reported by the game. */
    changeEvent(state, eventId, tag, summary, facts = []) {
        return { eventId, kind: 'observation', actionId: null, result: null, atWorldTimeMs: state.capturedAt, summary, code: null,
            facts: [{ key: 'source', value: 'probably-stolen' }, { key: 'event', value: tag }, { key: 'runId', value: `${state.saveSlot}:${state.runId}` }, ...facts] };
    }

    /** Settled scene transition: going out, coming home, walking into a night location. */
    sceneEvents(transition, state) {
        const id = randomUUID();
        const event = (suffix, tag, summary, facts = []) => this.changeEvent(state, `ps-scene:${id}:${suffix}`, tag, summary, facts);
        const { from, to, tonight } = transition;
        const result = [];
        if (isStoreSide(from) && !isStoreSide(to.id)) result.push(event('out', 'scene:out', `店主关店出门了，现在：${describeScene(to)}`));
        if (!isStoreSide(from) && to.id === 'store') result.push(event('home', 'scene:home', '店主外出回来，回到店里'));
        if (from !== 'end_of_day' && to.id === 'end_of_day') {
            result.push(event('end', 'scene:end_of_day', isStoreSide(from) ? '店主打烊，进入当天结算' : '店主外出回来就睡下了，进入当天结算'));
        }
        if (tonight) {
            const name = SCENE_LABELS[to.id] ?? to.title ?? to.id;
            const first = to.visits === 1;
            const tag = first ? `scene:first_visit:${to.id}` : tonight > 1 ? `scene:revisit:${to.id}` : `scene:visit:${to.id}`;
            const counts = [first ? '第一次来' : to.visits ? `游戏记录这是第 ${to.visits} 次来` : null, `今晚第 ${tonight} 次进来`].filter(Boolean).join('，');
            result.push(event('visit', tag, shortText(`店主走进了 ${name}（夜里出门去的地方，里面的人是这里的店主，不是来店里的客人）；${counts}`, 200),
                [{ key: 'place', value: name }, { key: 'placeId', value: to.id }, { key: 'tonight', value: tonight },
                    ...(to.visits ? [{ key: 'visits', value: to.visits }] : [])]));
        }
        return result;
    }

    /** Wound changes since the last poll of this run. A fresh scavenging injury is already reported by its own callback. */
    healthEvents(state, seen) {
        const before = seen?.health;
        const after = state.health;
        if (!before || !after) return [];
        const was = healthLevel(before);
        const now = healthLevel(after);
        let tag = null;
        if (now > was) tag = now === 2 ? 'health:serious' : 'health:minor';
        else if (now === was && now > 0 && after.wound > before.wound) tag = 'health:worse';
        else if (now < was) tag = now === 0 ? 'health:healed' : 'health:better';
        else if (now === was && now > 0 && after.wound < before.wound) tag = 'health:better';
        else if (now > 0 && !before.stable && after.stable) tag = 'health:stabilized';
        if (!tag) return [];
        const injured = (state.events ?? []).some(entry => entry.type === 'scav_injury' && entry.at > seen.capturedAt);
        if (injured && (tag === 'health:minor' || tag === 'health:serious' || tag === 'health:worse')) return [];
        const text = { 'health:serious': '店主伤重了', 'health:minor': '店主受了轻伤', 'health:worse': '店主伤势加重', 'health:better': '店主伤势好转',
            'health:healed': '店主的伤好了', 'health:stabilized': '店主的伤情稳定下来了' }[tag];
        return [this.changeEvent(state, `ps-health:${randomUUID()}`, tag, `身体状况（读取游戏数据）：${text}；现在 ${describeHealth(after)}`,
            [{ key: 'wound', value: after.wound }])];
    }

    /**
     * The difficulty once per run (as context), and again whenever it changes. The first one has a deterministic ID so a
     * relay restart does not repeat it; each change gets its own, so going back to an earlier difficulty is still news.
     */
    difficultyEvents(state, seen) {
        const key = difficultyKey(state.difficulty);
        if (!key || (seen && difficultyKey(seen.difficulty) === key)) return [];
        const changed = Boolean(seen?.difficulty);
        const save = `${state.saveSlot}:${state.runId}`;
        const id = changed ? randomUUID() : createHash('sha256').update(`${save}|${key}`).digest('hex').slice(0, 32);
        const rules = state.difficulty.effects.join('；');
        return [this.changeEvent(state, `ps-difficulty:${id}`, changed ? 'difficulty:changed' : 'difficulty:set',
            shortText(`游戏难度${changed ? '变了' : ''}：${describeDifficulty(state.difficulty)}${rules ? `；规则：${rules}` : ''}`, 200), [
                { key: 'difficultyId', value: state.difficulty.id },
                ...(state.difficulty.retailMarkup !== null ? [{ key: 'retailMarkup', value: state.difficulty.retailMarkup }] : []),
                ...(state.difficulty.merchantDiscount !== null ? [{ key: 'merchantDiscount', value: state.difficulty.merchantDiscount }] : []),
                ...(rules ? [{ key: 'rules', value: shortText(rules, 200) }] : [])])];
    }
}
