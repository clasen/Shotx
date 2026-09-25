import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { it } from 'node:test';
import SxClient from '../client.js';

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
