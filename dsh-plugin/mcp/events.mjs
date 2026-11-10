const QUEUE_LIMIT = 200;
const BACKGROUND_LIMIT = 12;

/** Ordered queue of game events and float-window chat, consumed by long-polling waiters. */
export class EventQueue {
    constructor({ now = Date.now } = {}) {
        this.now = now;
        this.items = [];
        this.seq = 0;
        this.delivered = 0;
        this.waiters = new Set();
        /** Calls currently blocked in wait(); > 0 means the companion loop is listening. */
        this.listening = 0;
        this.lastWaitEndedAt = null;
    }

    push(event) {
        const item = { seq: ++this.seq, ...event };
        this.items.push(item);
        if (this.items.length > QUEUE_LIMIT) this.items.splice(0, this.items.length - QUEUE_LIMIT);
        for (const wake of this.waiters) wake();
        return item;
    }

    since(afterSeq) {
        return this.items.filter(item => item.seq > afterSeq);
    }

    /** Sleep until a push, the deadline or an abort, whichever comes first. */
    #sleep(untilMs, signal) {
        return new Promise(resolve => {
            const done = () => { clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener?.('abort', done); resolve(); };
            const timer = setTimeout(done, Math.max(0, untilMs - this.now()));
            this.waiters.add(done);
            signal?.addEventListener?.('abort', done);
        });
    }

    /**
     * Resolve with the events after `afterSeq` (default: what the last call returned).
     * - `wakes(item)` decides which events end the wait; the rest come back as `background` context.
     *   Without it every event wakes (plain long poll).
     * - Urgent items (the player talking) end the wait at once; other waking items wait out
     *   `holdUntil` (speech cooldown) and then a `settleMs` window so a burst arrives as one batch.
     */
    async wait({ afterSeq = this.delivered, timeoutMs = 60000, settleMs = 1500, wakes = () => true, holdUntil = 0, signal } = {}) {
        const deadline = this.now() + timeoutMs;
        const dropped = this.items.length && this.items[0].seq > afterSeq + 1 ? this.items[0].seq - afterSeq - 1 : 0;
        this.listening++;
        try {
            for (;;) {
                const fresh = this.since(afterSeq);
                if (fresh.some(item => item.urgent)) break;
                const waking = fresh.some(wakes);
                if (waking && this.now() >= holdUntil) {
                    // Settle the whole window (more pushes extend the batch), unless the player starts talking.
                    const settleEnd = Math.min(deadline, this.now() + settleMs);
                    while (this.now() < settleEnd && !signal?.aborted && !this.since(afterSeq).some(item => item.urgent)) {
                        await this.#sleep(settleEnd, signal);
                    }
                    break;
                }
                if (this.now() >= deadline || signal?.aborted) break;
                await this.#sleep(waking ? Math.min(deadline, holdUntil) : deadline, signal);
            }
        } finally {
            this.listening--;
            this.lastWaitEndedAt = this.now();
        }
        const fresh = this.since(afterSeq);
        const lastSeq = fresh.length ? fresh.at(-1).seq : Math.max(afterSeq, 0);
        this.delivered = Math.max(this.delivered, lastSeq);
        const waking = fresh.filter(item => item.urgent || wakes(item));
        const background = fresh.filter(item => !(item.urgent || wakes(item)));
        // Player lines first so they are never buried under counter traffic.
        const events = [...waking.filter(item => item.urgent), ...waking.filter(item => !item.urgent)];
        return {
            events, lastSeq, timedOut: events.length === 0,
            ...(background.length ? { background: background.slice(-BACKGROUND_LIMIT) } : {}),
            ...(background.length > BACKGROUND_LIMIT ? { backgroundOmitted: background.length - BACKGROUND_LIMIT } : {}),
            ...(dropped ? { dropped } : {}),
        };
    }
}
