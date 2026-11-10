import { GameWorldBridge, LOCATION_LABELS, describeFeatures, DEFAULT_GAME_STATE_PATHS } from '../../pet/game-world.mjs';

const POLL_MS = 2000;
const SEEN_LIMIT = 4000;

function locationLabel(location) {
    return LOCATION_LABELS[location] ?? location;
}

function itemLine(item) {
    const appraisal = item.features.length ? `；鉴定：${describeFeatures(item.features)}` : '';
    return `${item.name}×${item.quantity}（${locationLabel(item.location)}）${appraisal}`;
}

function eventTag(event) {
    return event.facts?.find(fact => fact.key === 'event')?.value ?? null;
}

/** Page events re-describe the whole snapshot every few seconds; only discrete happenings are worth waking for. */
export function isDiscreteEvent(event) {
    return typeof event?.eventId === 'string' && !event.eventId.startsWith('ps:');
}

export function formatEvent(event) {
    const amount = event.facts?.find(fact => fact.key === 'amount')?.value;
    return { id: event.eventId, tag: eventTag(event), at: new Date(event.atWorldTimeMs).toLocaleString('zh-CN', { hour12: false }), summary: event.summary,
        ...(typeof amount === 'number' ? { amount } : {}) };
}

/**
 * Reads the reader mod's state.json through the existing pet bridge and turns its output into
 * a snapshot for status tools plus a stream of new discrete events.
 */
export class GameMonitor {
    constructor({ statePath = DEFAULT_GAME_STATE_PATHS, now = Date.now, onEvent = () => {} } = {}) {
        this.now = now;
        this.startedAt = now();
        this.onEvent = onEvent;
        this.seen = new Set();
        this.bridge = new GameWorldBridge({ statePath, now, send: async events => this.accept(events) });
        this.timer = null;
    }

    accept(events) {
        for (const event of events) {
            if (!isDiscreteEvent(event) || this.seen.has(event.eventId)) continue;
            this.seen.add(event.eventId);
            // Journal and dialogue entries already in the file when the server started are history, not news.
            if (event.atWorldTimeMs < this.startedAt) continue;
            this.onEvent(formatEvent(event));
        }
        if (this.seen.size > SEEN_LIMIT) this.seen = new Set([...this.seen].slice(-SEEN_LIMIT / 2));
    }

    start() {
        if (this.timer) return;
        void this.bridge.poll().catch(() => {});
        this.timer = setInterval(() => { void this.bridge.poll().catch(() => {}); }, POLL_MS);
        this.timer.unref?.();
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    status() {
        const snapshot = this.bridge.snapshot();
        if (!snapshot) {
            return { ready: false, reason: this.bridge.error ?? this.bridge.current?.reason ?? '还没读到游戏快照（游戏未启动、未进存档或读取模组未激活）' };
        }
        const offers = snapshot.items.filter(item => item.role === 'client_offer');
        const selling = snapshot.items.filter(item => item.role === 'player_offer');
        const stock = snapshot.items.filter(item => item.owner === 'player');
        const byLocation = {};
        for (const item of stock) byLocation[locationLabel(item.location)] = (byLocation[locationLabel(item.location)] ?? 0) + item.quantity;
        const result = { ready: true, cash: snapshot.cash };
        for (const key of ['day', 'rent', 'rentPaid', 'investigation', 'crime', 'location', 'augsShot']) {
            if (snapshot[key] !== undefined) result[key] = snapshot[key];
        }
        if (Object.keys(snapshot.reputation ?? {}).length) result.reputation = snapshot.reputation;
        result.client = snapshot.client ? { name: snapshot.client.name, faction: snapshot.client.faction, isSecurity: snapshot.client.isSecurity } : null;
        result.clientOffers = offers.map(itemLine);
        result.playerOffers = selling.map(itemLine);
        result.stock = { kinds: stock.length, quantityByLocation: byLocation };
        result.capturedAt = new Date(snapshot.capturedAt).toLocaleString('zh-CN', { hour12: false });
        return result;
    }

    /** Compact "right now" view attached to every wait_for_event result. */
    brief() {
        const status = this.status();
        if (!status.ready) return { ready: false, reason: status.reason };
        return { ready: true, cash: status.cash, day: status.day, investigation: status.investigation,
            client: status.client, clientOffers: status.clientOffers.slice(0, 8), playerOffers: status.playerOffers.slice(0, 8),
            ...(status.clientOffers.length > 8 ? { moreClientOffers: status.clientOffers.length - 8 } : {}) };
    }

    inventory({ query = '', location = '', limit = 60 } = {}) {
        const snapshot = this.bridge.snapshot();
        if (!snapshot) return { ready: false, reason: this.status().reason };
        const needle = String(query).trim().toLowerCase();
        const where = String(location).trim();
        const items = snapshot.items.filter(item => (!needle || item.name.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle))
            && (!where || item.location === where || locationLabel(item.location) === where));
        const cap = Math.max(1, Math.min(Number(limit) || 60, 300));
        return { ready: true, total: items.length, items: items.slice(0, cap).map(item => ({ owner: item.owner === 'player' ? '店主' : '来客', line: itemLine(item) })),
            truncated: items.length > cap, locations: LOCATION_LABELS };
    }

    /** Journal and dialogue still present in the snapshot, formatted by the same code the pet bridge uses. */
    recent({ limit = 20 } = {}) {
        const snapshot = this.bridge.snapshot();
        if (!snapshot) return { ready: false, reason: this.status().reason };
        const scratch = Object.create(GameWorldBridge.prototype);
        Object.assign(scratch, { previous: null, sentDialogue: null });
        const events = scratch.buildEvents(snapshot, this.now()).filter(isDiscreteEvent)
            .sort((a, b) => a.atWorldTimeMs - b.atWorldTimeMs);
        const cap = Math.max(1, Math.min(Number(limit) || 20, 100));
        return { ready: true, events: events.slice(-cap).map(formatEvent) };
    }
}
