const QUEUE_LIMIT = 200;

/** Ordered queue of game events and float-window chat, consumed by long-polling waiters. */
export class EventQueue {
    constructor({ now = Date.now } = {}) {
        this.now = now;
        this.items = [];
        this.seq = 0;
        this.delivered = 0;
        this.waiters = new Set();
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

    /**
     * Resolve with every event after `afterSeq` (default: what the last call returned), waiting up to
     * timeoutMs for the first one, then lingering `settleMs` so a burst arrives as one batch.
     */
    async wait({ afterSeq = this.delivered, timeoutMs = 60000, settleMs = 1500, signal } = {}) {
        const dropped = this.items.length && this.items[0].seq > afterSeq + 1 ? this.items[0].seq - afterSeq - 1 : 0;
        if (!this.since(afterSeq).length) {
            await new Promise(resolve => {
                const done = () => { clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener?.('abort', done); resolve(); };
                const timer = setTimeout(done, timeoutMs);
                this.waiters.add(done);
                signal?.addEventListener?.('abort', done);
            });
            // The player talking is answered at once; only game bursts get a short settle window.
            const fresh = this.since(afterSeq);
            if (fresh.length && settleMs > 0 && !fresh.some(item => item.urgent)) await new Promise(resolve => setTimeout(resolve, settleMs));
        }
        const events = this.since(afterSeq);
        const lastSeq = events.length ? events.at(-1).seq : Math.max(afterSeq, 0);
        this.delivered = Math.max(this.delivered, lastSeq);
        // Player lines first so they are never buried under counter traffic.
        const ordered = [...events.filter(item => item.urgent), ...events.filter(item => !item.urgent)];
        return { events: ordered, lastSeq, timedOut: events.length === 0, ...(dropped ? { dropped } : {}) };
    }
}
