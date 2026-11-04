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
const JOURNAL_TYPES = ['rent_paid', 'kill:ai_controlled', 'item_bought', 'item_sold', ...Object.keys(MONEY_LABELS)];

function optionalText(value, length) {
    return typeof value === 'string' && value.trim() ? shortText(value, length) : null;
}
const DIALOGUE_TEXT = 180;

function shortText(value, length) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid game text');
    return value.replace(/[\r\n\t]+/g, ' ').slice(0, length);
}

function itemFact(item) {
    const tuple = [item.id, item.name, item.location, item.quantity];
    while (JSON.stringify(tuple).length > 200) {
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
        return { id: shortText(item.id, 48), name: shortText(item.name, 48),
            location: shortText(item.location, 24), quantity: item.quantity };
    }).sort((a, b) => `${a.location}:${a.id}:${a.name}`.localeCompare(`${b.location}:${b.id}:${b.name}`));
    const extra = {};
    for (const key of ['investigation', 'crime', 'rent', 'day', 'rentPaid', 'augsShot']) {
        if (raw[key] !== undefined && raw[key] !== null) {
            if (!Number.isSafeInteger(raw[key])) throw new Error('Invalid game scalar');
            extra[key] = raw[key];
        }
    }
    if (raw.location) extra.location = shortText(raw.location, 48);
    extra.reputation = Object.fromEntries(Object.entries(raw.reputation ?? {}).filter(([key, value]) =>
        /^[A-Za-z0-9_.-]{1,40}$/.test(key) && typeof value === 'number' && Number.isFinite(value)).slice(0, 8));
    extra.client = raw.client?.id ? { id: shortText(raw.client.id, 64), name: shortText(raw.client.name || raw.client.id, 64),
        faction: shortText(raw.client.faction || 'unknown', 64), isSecurity: raw.client.isSecurity === true } : null;
    extra.events = (raw.events ?? []).filter(event => /^[A-Za-z0-9_:.-]{1,90}$/.test(event.id)
        && JOURNAL_TYPES.includes(event.type)
        && Number.isSafeInteger(event.at) && event.at <= now + 5000 && Number.isSafeInteger(event.amount)).slice(-128)
        .map(event => ({ id: event.id, type: event.type, at: event.at, amount: event.amount,
            runId: shortText(event.runId, 80), itemId: event.itemId ? shortText(event.itemId, 64) : null,
            itemName: event.itemName ? shortText(event.itemName, 64) : null,
            boughtFor: Number.isSafeInteger(event.boughtFor) && event.boughtFor > 0 ? event.boughtFor : null,
            clientId: optionalText(event.clientId, 64), clientName: optionalText(event.clientName, 64), detail: optionalText(event.detail, 64) }));
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
            clientId: typeof line.clientId === 'string' && line.clientId.trim() ? shortText(line.clientId, 64) : null, at: line.at })) : [];
    if (Number.isSafeInteger(raw.eventSequence) && raw.eventSequence >= 0) {
        extra.readerSession = base.sessionId;
        extra.readerSeq = raw.eventSequence;
        extra.readerFirstSeq = extra.events.length ? Number(extra.events[0].id.split(':').at(-1)) : raw.eventSequence + 1;
    }
    return { ...base, saveSlot: raw.saveSlot, runId: shortText(raw.runId, 64), cash: raw.cash, items, ...extra };
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
            const { capturedAt, ...content } = state;
            const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
            if (hash === this.lastHash && (this.lastSentAt !== null && now - this.lastSentAt < REFRESH_MS || !state.ready)) return;
            // Keep event IDs stable during retries after a lost HTTP response.
            if (this.pending?.hash !== hash) this.pending = { hash, events: this.buildEvents(state, now) };
            try {
                await this.send(this.pending.events);
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
                    for (const key of ['investigation', 'crime', 'rent', 'day', 'rentPaid', 'augsShot', 'location', 'readerSession', 'readerSeq', 'readerFirstSeq']) {
                        if (state[key] !== undefined) facts.push({ key, value: state[key] });
                    }
                    for (const [key, value] of Object.entries(state.reputation ?? {})) facts.push({ key: `reputation.${key}`, value });
                    if (state.client) facts.push({ key: 'clientId', value: state.client.isSecurity ? 'security_officer' : state.client.id },
                        { key: 'clientName', value: state.client.name }, { key: 'clientFaction', value: state.client.faction });
                }
                for (const [index, item] of (page === 0 ? [] : state.items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)).entries()) {
                    // A compact tuple keeps every fact within the native 200-character limit.
                    facts.push({ key: `item.${index}`, value: itemFact(item) });
                }
            }
            const delta = sameRun ? state.cash - this.previous.cash : null;
            let summary = state.ready ? `游戏世界事件：资金 ${state.cash}；库存第 ${page + 1}/${pages} 页，共 ${state.items.length} 类` : '游戏世界事件：当前游戏数据不可用，不得沿用之前的资金和库存';
            if (delta !== null && delta !== 0) summary += `；资金变化 ${delta > 0 ? '+' : ''}${delta}`;
            if (sameRun && page === 0) {
                const oldItems = new Map(this.previous.items.map(item => [JSON.stringify([item.location, item.id, item.name]), item.quantity]));
                let added = 0;
                let removed = 0;
                for (const item of state.items) {
                    const key = JSON.stringify([item.location, item.id, item.name]);
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
        if (!state.ready) return result;
        const save = `${state.saveSlot}:${state.runId}`;
        const event = (id, tag, summary, facts = [], at = now) => ({ eventId: id, kind: 'observation', actionId: null, result: null,
            atWorldTimeMs: at, summary, code: null, facts: [{ key: 'source', value: 'probably-stolen' },
                { key: 'event', value: tag }, { key: 'runId', value: save }, ...facts] });
        for (const entry of state.events ?? []) {
            if (entry.runId !== save) continue;
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
            result.push(event(`ps-event:${entry.id}`, tag, shortText(summary, 200),
                [{ key: 'amount', value: entry.amount }, { key: 'readerSession', value: entry.id.split(':').slice(0, -1).join(':') },
                    { key: 'readerSeq', value: Number(entry.id.split(':').at(-1)) },
                    ...(entry.itemName ? [{ key: 'itemName', value: entry.itemName }] : []),
                    ...(trade ? [{ key: 'price', value: entry.amount }] : []),
                    ...(profit !== null ? [{ key: 'profit', value: profit }, { key: 'boughtFor', value: entry.boughtFor }] : []),
                    ...(trade && entry.clientName ? [{ key: 'clientName', value: entry.clientName }] : []),
                    ...(trade && entry.clientId ? [{ key: 'clientId', value: entry.clientId }] : []),
                    ...(entry.detail ? [{ key: 'detail', value: entry.detail }] : [])], entry.at));
        }
        for (const line of state.dialogue ?? []) {
            if (line.runId !== save) continue;
            // Lines already delivered in this reader session are not resent (the kernel would only count duplicates).
            if (this.sentDialogue?.session === state.dialogueSession && line.seq <= this.sentDialogue.seq) continue;
            const who = line.role === 'player' ? '店主' : line.speaker === 'unknown' ? '来客' : line.speaker;
            result.push(event(`ps-line:${line.id}`, `dialogue:${line.role}`, shortText(`${who}：${line.text}`, 200), [
                { key: 'speaker', value: line.speaker }, { key: 'text', value: line.text }, { key: 'lineIndex', value: line.seq },
                { key: 'channel', value: line.channel }, ...(line.clientId ? [{ key: 'clientId', value: line.clientId }] : [])], line.at));
        }
        if (sameRun && (this.previous.investigation ?? Infinity) < 75 && state.investigation >= 75) {
            result.push(event(`ps-threshold:${snapshotId}`, 'investigation_near_threshold', `读取器阈值事件：调查进度 ${state.investigation}，已达到提醒线 75`));
        }
        if (sameRun && state.client?.id !== this.previous.client?.id) {
            if (state.client) result.push(event(`ps-arrived:${snapshotId}`, `npc_arrived:${state.client.isSecurity ? 'security_officer' : state.client.id}`, `当前来客进入：${state.client.name}`));
            if (this.previous.client) result.push(event(`ps-left:${snapshotId}`, `npc_left:${this.previous.client.isSecurity ? 'security_officer' : this.previous.client.id}`, `上一位来客离开：${this.previous.client.name}`));
        }
        const story = { FACTION_CARTEL: 'cartel.first_visit', FACTION_REVOLUTION: 'revolution.first_visit', FACTION_CHURCH: 'church.first_visit' }[state.client?.faction];
        if (story) {
            const id = createHash('sha256').update(`${save}:${story}`).digest('hex');
            result.push(event(`ps-story:${id}`, `story:${story}`, `实际在场来客确认接触派系：${state.client.faction}`));
        }
        return result;
    }
}
