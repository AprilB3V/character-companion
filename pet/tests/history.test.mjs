import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('conversation history survives restart and keeps unfinished requests visible', async () => {
    assert.ok(existsSync(new URL('../history-store.mjs', import.meta.url)), 'Persistent conversation storage is missing');
    const { ConversationStore } = await import('../history-store.mjs');
    const tempDir = mkdtempSync(join(tmpdir(), 'jingjing-history-'));
    try {
        const databasePath = join(tempDir, 'history.sqlite');
        let store = new ConversationStore(databasePath);
        store.save({ id: 'first', userText: '你好，鲸鲸', assistantText: '你好！', status: 'complete', createdAt: 100 });
        store.save({ id: 'second', userText: '尚未回复', status: 'pending', createdAt: 200 });
        store.close();
        store = new ConversationStore(databasePath);
        assert.equal(store.list()[0].status, 'interrupted');
        assert.equal(store.list()[1].assistantText, '你好！');
        assert.equal(store.list('你好').length, 1);
        store.save({ id: 'first', userText: '你好，鲸鲸', assistantText: '更新后的回复', status: 'complete', createdAt: 100 });
        assert.equal(store.list().length, 2);
        assert.equal(store.list().find(item => item.id === 'first').assistantText, '更新后的回复');
        store.close();
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
