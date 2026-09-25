import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { it } from 'node:test';
import SxServer from '../server.js';
import SxClient from '../client.js';

const timeoutMs = 5000;

async function waitFor(check) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        assert.ok(Date.now() < deadline, 'delivery did not complete');
        await delay(5);
    }
}

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'shotx-session-'));
    const servers = [];
    const clients = [];
    t.after(async () => {
        for (const client of clients) client.disconnect();
        for (const server of servers) await server.close();
        await rm(directory, { recursive: true, force: true });
    });
    return {
        async start(port = 0) {
            const httpServer = createServer();
            const sx = new SxServer(httpServer, {}, { path: directory, reliable: { enabled: true } });
            let closed = false;
            const server = {
                sx,
                async close() {
                    if (closed) return;
                    closed = true;
                    await new Promise((resolve) => sx.io.close(resolve));
                    while (sx.roomOperations.size || sx.clientOperations.size) {
                        await Promise.allSettled([...sx.roomOperations.values(), ...sx.clientOperations.values()]);
                    }
                    await sx.db.dispose();
                }
            };
            servers.push(server);
            await new Promise((resolve, reject) => {
                httpServer.once('error', reject);
                httpServer.listen(port, '127.0.0.1', resolve);
            });
            server.port = httpServer.address().port;
            return server;
        },
        client(port, reliable = true) {
            const client = new SxClient(`http://127.0.0.1:${port}`, { reconnection: false }, {
                timeout: timeoutMs,
                reliable: { enabled: reliable, id: 'session-client' }
            });
            clients.push(client);
            return client;
        }
    };
}

it('requires room resynchronization after a memory restart even when sequence numbers match', { timeout: 15000 }, async (t) => {
    const test = await fixture(t);
    const first = await test.start();
    const client = test.client(first.port, false);
    const received = [];
    const resyncs = [];
    await client.connect('token');
    client.onMessage('feed', (data) => received.push(data));
    client.onMessage('sx_resync_required', (data) => resyncs.push(data));
    await client.join('room');
    await first.sx.to('room').send('feed', 'before restart');
    await waitFor(() => received.length === 1);
    await first.close();
    await waitFor(() => !client.isConnected);

    const second = await test.start(first.port);
    await second.sx.to('room').send('feed', 'after restart');
    await client.connect('token');
    assert.equal(resyncs.length, 1);
    assert.equal(resyncs[0].reason, 'server_restarted');
    assert.deepEqual(received, ['before restart']);
    assert.equal(client.joinedRooms.has('room'), false);

    await client.join('room', { afterSeq: 0 });
    await second.sx.to('room').send('feed', 'next message');
    await waitFor(() => received.length === 3);
    assert.deepEqual(received, ['before restart', 'after restart', 'next message']);
});

it('starts a new outbound sequence after a memory restart when every earlier command was acknowledged', { timeout: 15000 }, async (t) => {
    const test = await fixture(t);
    const first = await test.start();
    first.sx.onMessage('echo', (data, socket, meta) => meta.seq);
    const client = test.client(first.port);
    await client.connect('token');
    assert.equal(await client.send('echo', {}), 1);
    const oldEpoch = client.reliableOutboundEpoch;
    await first.close();
    await waitFor(() => !client.isConnected);

    const second = await test.start(first.port);
    second.sx.onMessage('echo', (data, socket, meta) => meta.seq);
    await client.connect('token');
    assert.notEqual(client.reliableOutboundEpoch, oldEpoch);
    assert.equal(await client.send('echo', {}), 1);
});

it('binds an empty room to the new history before receiving its first message', { timeout: 15000 }, async (t) => {
    const test = await fixture(t);
    const first = await test.start();
    const client = test.client(first.port, false);
    const received = [];
    const resyncs = [];
    await client.connect('token');
    client.onMessage('feed', (data) => received.push(data));
    client.onMessage('sx_resync_required', (data) => resyncs.push(data));
    await client.join('empty-room');
    await first.close();
    await waitFor(() => !client.isConnected);

    const second = await test.start(first.port);
    await client.connect('token');
    await second.sx.to('empty-room').send('feed', 'first');
    await waitFor(() => received.length === 1);
    client.disconnect();
    await second.sx.to('empty-room').send('feed', 'second');
    await client.connect('token');
    assert.deepEqual(resyncs, []);
    await waitFor(() => received.length === 2);
    assert.deepEqual(received, ['first', 'second']);
});

it('does not repeat an unacknowledged command against a new memory history', { timeout: 15000 }, async (t) => {
    const test = await fixture(t);
    const first = await test.start();
    const client = test.client(first.port);
    let executions = 0;
    first.sx.onMessage('commit', (data, socket) => {
        executions += 1;
        socket.conn.close();
        return 'committed';
    });
    await client.connect('token');
    const pending = client.send('commit', {});
    const rejected = assert.rejects(pending, { code: 'RELIABLE_RESYNC_REQUIRED' });
    await waitFor(() => executions === 1 && !client.isConnected);
    await first.close();

    const second = await test.start(first.port);
    second.sx.onMessage('commit', () => { executions += 1; });
    await assert.rejects(client.connect('token'), { code: 'RELIABLE_RESYNC_REQUIRED' });
    await rejected;
    assert.equal(executions, 1);
    assert.equal(client.reliableOutbox.size, 1);
});

it('keeps the history identity with a persisted cursor and replaces its sequence after resynchronization', async () => {
    let stored;
    const request = (result, update) => {
        const value = { result };
        queueMicrotask(() => {
            if (update) update();
            value.onsuccess();
        });
        return value;
    };
    const store = {
        get: () => request(stored),
        put: (record) => request(undefined, () => { stored = record; })
    };
    const createClient = (epoch) => {
        const client = new SxClient('http://localhost:1', {}, { reliable: { id: 'persisted-cursor' } });
        client.useIndexedDB = true;
        client.db = { transaction: () => ({ objectStore: () => store }) };
        client.reliableServerEpoch = epoch;
        return client;
    };
    const first = createClient('first-history');
    await first._prepareReliableRoom('room', 0);
    await first._saveReliableCursor('room', 7);

    const recreated = createClient('second-history');
    const previous = await recreated._prepareReliableRoom('room');
    assert.equal(previous.lastSeq, 7);
    assert.equal(previous.epoch, 'first-history');
    await recreated._prepareReliableRoom('room', 0);
    await recreated._saveReliableCursor('room', 1);
    assert.deepEqual(await recreated._loadReliableCursor('room'), { seq: 1, epoch: 'second-history' });
});
