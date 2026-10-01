import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { it } from 'node:test';
import SxClient from 'shotx/client';

it('drains an outbox in sequence order and retains each record until its ACK', { timeout: 2000 }, async () => {
    const client = new SxClient();
    client.socket = new EventEmitter();
    client.isConnected = true;
    client.serverReliable = true;
    for (const seq of [4, 2, 5, 1, 3]) {
        client.reliableOutbox.set(seq, {
            seq,
            eventName: 'message',
            meta: { id: `message-${seq}`, seq },
            data: { seq }
        });
    }
    const attempts = [];
    client.socket.on('message', (message, ack) => attempts.push({ message, ack }));

    const flush = client._flushReliableOutbox();
    for (let seq = 1; seq <= 5; seq += 1) {
        await nextTurn();
        assert.equal(attempts.length, seq, 'only one message may be awaiting its ACK');
        const { message, ack } = attempts[seq - 1];
        assert.equal(message.meta.seq, seq);
        assert.equal(client.reliableOutbox.has(seq), true);
        ack({ meta: { ...message.meta, reliable: true, success: true }, data: message.data });
    }
    await flush;
    assert.equal(client.reliableOutbox.size, 0);
    assert.equal(client.socket.listenerCount('disconnect'), 0);
});

function fakeDatabase(stores) {
    return {
        transaction() {
            const transaction = {
                objectStore(name) {
                    const store = stores[name];
                    const request = (action) => {
                        const value = {};
                        queueMicrotask(() => {
                            value.result = action();
                            value.onsuccess?.();
                        });
                        return value;
                    };
                    return {
                        get: (key) => request(() => store.get(key)),
                        put: (record) => request(() => store.set(record.key, record)),
                        delete: (key) => request(() => store.delete(key))
                    };
                }
            };
            setTimeout(() => transaction.oncomplete?.(), 0);
            return transaction;
        }
    };
}

it('persists a rebased outbox and drops records that may already have run', async () => {
    const prefix = 'http://localhost:1\u0000rebase\u0000';
    const sequenceKey = 'outbound-sequence\u0000http://localhost:1\u0000rebase';
    const record = (seq, emitted) => ({
        key: `${prefix}${seq}`,
        eventName: 'message',
        meta: { id: `message-${seq}`, stream: 'rebase', seq, type: 'command' },
        data: { seq },
        seq,
        storedAt: 0,
        ...(emitted === undefined ? {} : { emitted })
    });
    const records = [record(17, undefined), record(18, false), record(19, false), record(20, false)];
    const outbox = new Map(records.map((entry) => [entry.key, entry]));
    const metadata = new Map([[sequenceKey, { key: sequenceKey, nextSeq: 21, epoch: 'old-history' }]]);

    const client = new SxClient('http://localhost:1', {}, { reliable: { enabled: true, id: 'rebase' } });
    await client.reliableOutboxReady;
    client.useIndexedDB = true;
    client.db = fakeDatabase({ reliableOutbox: outbox, reliableMetadata: metadata });
    client.reliableOutbox = new Map(records.map((entry) => [entry.seq, entry]));
    client.reliableOutboundEpoch = 'old-history';
    client.nextReliableOutboundSeq = 21;

    await client._markReliableRecordEmitted(client.reliableOutbox.get(18));
    assert.equal(outbox.get(`${prefix}18`).emitted, true);

    await client._adoptReliableServerSequence(1, 'new-history');
    assert.deepEqual([...outbox.keys()], [`${prefix}1`, `${prefix}2`]);
    assert.deepEqual([...outbox.values()].map((entry) => [entry.seq, entry.meta.seq, entry.meta.id]), [
        [1, 1, 'message-19'],
        [2, 2, 'message-20']
    ]);
    assert.deepEqual(metadata.get(sequenceKey), { key: sequenceKey, nextSeq: 3, epoch: 'new-history' });
    assert.deepEqual([...client.reliableOutbox.keys()], [1, 2]);
    assert.equal(client.nextReliableOutboundSeq, 3);
    assert.equal(client.reliableOutboundEpoch, 'new-history');
});
