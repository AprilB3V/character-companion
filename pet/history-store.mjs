import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class ConversationStore {
    constructor(databasePath) {
        mkdirSync(dirname(databasePath), { recursive: true });
        this.database = new DatabaseSync(databasePath);
        this.database.exec(`
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                userText TEXT NOT NULL,
                assistantText TEXT NOT NULL,
                status TEXT NOT NULL,
                createdAt INTEGER NOT NULL,
                source TEXT NOT NULL
            );
            UPDATE conversations SET status = 'interrupted' WHERE status = 'pending';
        `);
        this.saveStatement = this.database.prepare(`
            INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                userText = excluded.userText,
                assistantText = excluded.assistantText,
                status = excluded.status
        `);
    }

    save(record) {
        this.saveStatement.run(record.id, record.userText ?? '', record.assistantText ?? '',
            record.status ?? 'complete', record.createdAt ?? Date.now(), record.source ?? 'relay');
    }

    list(query = '') {
        const records = this.database.prepare('SELECT * FROM conversations ORDER BY createdAt DESC, rowid DESC').all();
        const searchText = query.toLocaleLowerCase();
        return searchText ? records.filter(record =>
            `${record.userText}\n${record.assistantText}`.toLocaleLowerCase().includes(searchText)) : records;
    }

    importFrontend(historyDirectory) {
        if (this.list().length) return;
        let files;
        try {
            files = readdirSync(historyDirectory).filter(file => file.endsWith('.json')).sort();
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        for (const file of files) {
            const messages = JSON.parse(readFileSync(join(historyDirectory, file), 'utf8'));
            let current = null;
            for (const [index, message] of messages.entries()) {
                if (message.role === 'human' && typeof message.content === 'string') {
                    if (current) this.save(current);
                    current = { id: `frontend:${file}:${index}`, userText: message.content,
                        createdAt: Date.parse(message.timestamp) || Date.now(),
                        status: 'unanswered', source: 'frontend' };
                } else if (message.role === 'ai' && typeof message.content === 'string' && current) {
                    current.assistantText = [current.assistantText, message.content].filter(Boolean).join('\n');
                    current.status = 'complete';
                }
            }
            if (current) this.save(current);
        }
    }

    close() {
        this.database.close();
    }
}
