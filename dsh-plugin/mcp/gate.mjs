// Gate for companion mode: which events wake the model (think layer) and how often she may speak.
// Mirrors the old relay's proactive controller: importance threshold + cooldown, player speech always first.

/** Events that are worth a thought on their own. */
const NOTABLE_TAGS = new Set([
    'appraisal:client_fake', 'appraisal:client_bargain', 'appraisal:player_fake', 'appraisal:sold_fake', 'appraisal:bought_fake',
    'npc_arrived:security_officer', 'investigation_near_threshold', 'rent_paid', 'kill:ai_controlled',
    'money:bribe', 'money:loan_taken',
]);

/** Per chattiness: speech cooldown, what counts as a big trade, and whether routine traffic wakes her. */
export const GATES = {
    quiet: { cooldownMs: 60000, bigAmount: 2000, routineWakes: false },
    normal: { cooldownMs: 25000, bigAmount: 500, routineWakes: false },
    lively: { cooldownMs: 10000, bigAmount: 200, routineWakes: true },
};

export function gateFor(chatty) {
    return GATES[chatty] ?? GATES.normal;
}

/** urgent: answer now; notable: wake after the cooldown; routine: background context only. */
export function eventLevel(event, gate = GATES.normal) {
    if (event.tag === 'player_said') return 'urgent';
    const tag = event.tag ?? '';
    if (NOTABLE_TAGS.has(tag) || tag.startsWith('story:')) return 'notable';
    if ((tag.startsWith('sale:') || tag.startsWith('item_bought:')) && Math.abs(Number(event.amount) || 0) >= gate.bigAmount) return 'notable';
    return 'routine';
}

/** Whether an event may wake a waiting model under this gate. */
export function wakes(event, gate = GATES.normal) {
    const level = event.level ?? eventLevel(event, gate);
    return level !== 'routine' || gate.routineWakes;
}
