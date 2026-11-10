import { readFile } from 'node:fs/promises';

const MAX_RESULTS = 8;
// In-game Chinese names that differ from the knowledge base wording (seen in live play 2026-11-10).
const SYNONYMS = [['幽灵水', '鬼水'], ['铁锈水', '锈水'], ['沟渠水', '水质'], ['水瓶', '瓶装水']];

/** Split "a、b, c" keyword cells into lowercase aliases. */
function aliases(cell) {
    return cell.split(/[、,，/]/).map(alias => alias.trim().toLowerCase()).filter(Boolean);
}

/** Drop markers that only made sense for the removed spoiler fence. */
function clean(text) {
    return text.replace(/`?剧情:需已见过`?/g, '').replace(/\s+$/g, '').trim();
}

export function parseKnowledge(source) {
    // The knowledge base was written for a streamer co-host; players are the audience here.
    const markdown = source.replace(/\r\n?/g, '\n').replace(/主播/g, '玩家');
    const sections = [];
    const rows = [];
    const headings = [...markdown.matchAll(/^## (.+)$/gm)];
    for (const [index, heading] of headings.entries()) {
        const body = markdown.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? markdown.length).trim();
        sections.push({ title: heading[1].trim(), body });
        for (const line of body.split('\n')) {
            const cells = line.trim().split('|').slice(1, -1).map(cell => cell.trim());
            if (cells.length !== 2 || /^-+$/.test(cells[0]) || cells[0] === '关键词或别名' || cells[0] === '触发') continue;
            rows.push({ section: heading[1].trim(), keys: aliases(cells[0]), label: cells[0], text: clean(cells[1]) });
        }
    }
    return { sections, rows };
}

export function parseGlossary(json) {
    const entries = Array.isArray(json?.entries) ? json.entries : [];
    return entries.filter(entry => typeof entry?.term === 'string' && typeof entry?.meaning === 'string')
        .map(entry => ({ term: entry.term, kind: entry.kind ?? '', meaning: entry.meaning,
            keys: [entry.term, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].map(key => String(key).toLowerCase()) }));
}

function tokens(query) {
    return query.toLowerCase().split(/[\s,，。？?！!、;；:："“”'（）()]+/).filter(token => token.length > 0);
}

/** Score a candidate by alias hits: alias inside the query, or a query token inside the alias. */
function score(keys, query, queryTokens) {
    let best = 0;
    for (const key of keys) {
        if (!key) continue;
        if (query.includes(key)) best = Math.max(best, 10 + key.length);
        else if (queryTokens.some(token => token.length >= 2 && key.includes(token))) best = Math.max(best, 5);
    }
    return best;
}

export class KnowledgeBase {
    constructor({ knowledgePath, glossaryPath = null }) {
        this.knowledgePath = knowledgePath;
        this.glossaryPath = glossaryPath;
        this.data = null;
    }

    async load() {
        const markdown = await readFile(this.knowledgePath, 'utf8');
        let glossary = [];
        if (this.glossaryPath) {
            glossary = await readFile(this.glossaryPath, 'utf8').then(text => parseGlossary(JSON.parse(text))).catch(() => []);
        }
        this.data = { ...parseKnowledge(markdown), glossary };
        return this.data;
    }

    /** Text for the always-on world context: everything before the keyword index, minus internal plumbing sections. */
    coreContext() {
        const keep = this.data.sections.filter(section => section.title.startsWith('第一层') || section.title.startsWith('吐槽钩子'));
        return keep.map(section => `## ${section.title}\n${section.body}`).join('\n\n');
    }

    lookup(rawQuery) {
        let query = String(rawQuery ?? '').trim().toLowerCase();
        if (!query) return { matches: [], keywords: this.keywords() };
        for (const [gameName, kbName] of SYNONYMS) if (query.includes(gameName)) query += ` ${kbName}`;
        const queryTokens = tokens(query);
        const scored = [];
        for (const row of this.data.rows) {
            const value = score(row.keys, query, queryTokens);
            if (value) scored.push({ value, kind: 'knowledge', label: row.label, section: row.section, text: row.text });
        }
        for (const entry of this.data.glossary) {
            const value = score(entry.keys, query, queryTokens);
            if (value) scored.push({ value, kind: 'glossary', label: `${entry.term}（${entry.kind}）`, text: entry.meaning });
        }
        for (const section of this.data.sections) {
            if (section.title.toLowerCase().includes(query)) scored.push({ value: 3, kind: 'section', label: section.title, text: clean(section.body).slice(0, 1500) });
        }
        scored.sort((a, b) => b.value - a.value);
        const matches = scored.slice(0, MAX_RESULTS).map(({ value, ...rest }) => rest);
        return matches.length ? { matches } : { matches, keywords: this.keywords() };
    }

    keywords() {
        return this.data.rows.filter(row => row.section.startsWith('第三层')).map(row => row.keys[0]);
    }
}
