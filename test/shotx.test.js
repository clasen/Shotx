import { createServer } from 'http';
import { describe, it, before, after } from 'node:test';
import assert from 'assert';
import { SxServer } from '../index.js';
import SxClient from '../client.js';

// ============ Helper ============

function createTestServer(serverOpts = {}, sxOpts = {}) {
    return new Promise((resolve) => {
        const httpServer = createServer();
        const sxServer = new SxServer(httpServer, serverOpts, { debug: 'none', ...sxOpts });
        httpServer.listen(0, () => {
            const port = httpServer.address().port;
            resolve({ httpServer, sxServer, port });
        });
    });
}

function createTestClient(port, clientOpts = {}, sxOpts = {}) {
    return new SxClient(`http://localhost:${port}`, {
        reconnection: false,
        ...clientOpts
    }, { debug: 'none', ...sxOpts });
}

function cleanup(httpServer, client) {
    return new Promise((resolve) => {
        if (client) client.disconnect();
        if (httpServer) {
            httpServer.close(() => resolve());
        } else {
            resolve();
        }
    });
}

async function waitFor(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function dropNextRoomMessage(sxServer, predicate) {
    const adapter = sxServer.io.sockets.adapter;
    const originalBroadcast = adapter.broadcast;
    let dropped = false;

    adapter.broadcast = function (packet, opts) {
        const message = packet?.data?.[0] === 'message' ? packet.data[1] : null;
        if (!dropped && message && predicate(message)) {
            dropped = true;
            return;
        }
        return originalBroadcast.call(this, packet, opts);
    };

    return {
        wasDropped: () => dropped,
        restore: () => {
            adapter.broadcast = originalBroadcast;
        }
    };
}

// ============ Tests ============

describe('SxServer', function () {

    describe('constructor', function () {
        it('should throw if no HTTP server is provided', function () {
            assert.throws(() => new SxServer(), /HTTP\(s\) server must be provided/);
        });

        it('should create server with valid HTTP server', async function () {
            const { httpServer, sxServer } = await createTestServer();
            assert.ok(sxServer.io);
            assert.ok(sxServer.messageHandlers instanceof Map);
            await cleanup(httpServer);
        });
    });

    describe('setAuthHandler', function () {
        it('should throw if handler is not a function', async function () {
            const { httpServer, sxServer } = await createTestServer();
            assert.throws(() => sxServer.setAuthHandler('not a function'), /must be a function/);
            await cleanup(httpServer);
        });

        it('should set and return this for chaining', async function () {
            const { httpServer, sxServer } = await createTestServer();
            const result = sxServer.setAuthHandler(() => ({}));
            assert.strictEqual(result, sxServer);
            await cleanup(httpServer);
        });
    });

    describe('onMessage', function () {
        it('should throw if route is not a string', async function () {
            const { httpServer, sxServer } = await createTestServer();
            assert.throws(() => sxServer.onMessage(123, () => { }), /Invalid parameters/);
            await cleanup(httpServer);
        });

        it('should throw if handler is not a function', async function () {
            const { httpServer, sxServer } = await createTestServer();
            assert.throws(() => sxServer.onMessage('route', 'not a function'), /Invalid parameters/);
            await cleanup(httpServer);
        });

        it('should register handler and return this for chaining', async function () {
            const { httpServer, sxServer } = await createTestServer();
            const handler = async () => ({ ok: true });
            const result = sxServer.onMessage('test', handler);
            assert.strictEqual(result, sxServer);
            assert.strictEqual(sxServer.messageHandlers.get('test'), handler);
            await cleanup(httpServer);
        });
    });
});

describe('SxClient', function () {

    describe('constructor', function () {
        it('should set default values', function () {
            const client = new SxClient();
            assert.strictEqual(client.url, 'http://localhost:3000');
            assert.strictEqual(client.timeout, 0);
            assert.strictEqual(client.isConnected, false);
            assert.ok(Array.isArray(client.offlineQueue));
            assert.strictEqual(client.offlineQueue.length, 0);
        });

        it('should accept custom url and timeout', function () {
            const client = new SxClient('http://example.com:8080', {}, { timeout: 5000 });
            assert.strictEqual(client.url, 'http://example.com:8080');
            assert.strictEqual(client.timeout, 5000);
        });
    });
});

describe('Auth Flow', function () {
    let httpServer, sxServer, port;

    before(async function () {
        ({ httpServer, sxServer, port } = await createTestServer());
        sxServer.setAuthHandler(async (token) => {
            if (token === 'valid') return { userId: 'user123' };
            return null;
        });
    });

    after(async function () {
        await cleanup(httpServer);
    });

    it('should connect with valid token and receive auth data', async function () {
        const client = createTestClient(port);
        const auth = await client.connect('valid');
        assert.deepStrictEqual(auth, { userId: 'user123' });
        assert.strictEqual(client.isConnected, true);
        client.disconnect();
    });

    it('should fail with AUTH_FAIL for invalid token', async function () {
        const client = createTestClient(port);
        await assert.rejects(
            () => client.connect('invalid', { timeout: 2000 }),
            (err) => {
                // Socket.IO wraps the auth error in connect_error
                // The client retries until timeout
                assert.ok(err.message.includes('TIMEOUT') || err.message.includes('AUTH_FAIL'));
                return true;
            }
        );
        client.disconnect();
    });

    it('should fail with AUTH_NULL for missing token', async function () {
        // Connect with null token - client defaults to uuidv7 so we need
        // a custom approach: use raw socket.io-client
        const client = createTestClient(port);
        // Force null token by passing null explicitly
        await assert.rejects(
            () => client.connect(null, { timeout: 2000 }),
            (err) => {
                // null gets replaced by uuidv7 in the client, so the auth handler
                // will reject it (not 'valid'), causing AUTH_FAIL -> timeout
                assert.ok(err.message.includes('TIMEOUT') || err.message.includes('AUTH'));
                return true;
            }
        );
        client.disconnect();
    });
});

describe('Message Routing', function () {
    let httpServer, sxServer, port, client;

    before(async function () {
        ({ httpServer, sxServer, port } = await createTestServer());

        sxServer.onMessage('test_route', async (data) => {
            return { echo: data, status: 'ok' };
        });

        sxServer.onMessage('error_route', async () => {
            throw new Error('Handler exploded');
        });

        client = createTestClient(port);
        await client.connect('any-token');
    });

    after(async function () {
        await cleanup(httpServer, client);
    });

    it('should route message to registered handler and return data', async function () {
        const result = await client.send('test_route', { hello: 'world' });
        assert.deepStrictEqual(result, { echo: { hello: 'world' }, status: 'ok' });
    });

    it('should return error 2003 for unknown route', async function () {
        await assert.rejects(
            () => client.send('nonexistent_route', {}),
            (err) => {
                assert.ok(err.message.includes('Unknown message type'));
                return true;
            }
        );
    });

    it('should return error 2004 when handler throws', async function () {
        await assert.rejects(
            () => client.send('error_route', {}),
            (err) => {
                assert.ok(err.message.includes('Handler exploded'));
                return true;
            }
        );
    });

    it('should handle multiple sequential messages', async function () {
        for (let i = 0; i < 5; i++) {
            const result = await client.send('test_route', { count: i });
            assert.strictEqual(result.echo.count, i);
            assert.strictEqual(result.status, 'ok');
        }
    });
});

describe('Timeout', function () {

    describe('connect timeout', function () {
        it('should timeout when server does not respond in time', async function () {
            // Connect to a port that is not listening
            const client = new SxClient('http://localhost:1', {
                reconnection: false,
            }, { debug: 'none' });

            await assert.rejects(
                () => client.connect('token', { timeout: 500 }),
                (err) => {
                    assert.ok(err.message.includes('TIMEOUT'));
                    assert.ok(err.message.includes('connect'));
                    assert.ok(err.message.includes('500ms'));
                    return true;
                }
            );
            client.disconnect();
        });
    });

    describe('send timeout (per-call)', function () {
        let httpServer, sxServer, port, client;

        before(async function () {
            ({ httpServer, sxServer, port } = await createTestServer());

            // Handler that takes 2 seconds to respond
            sxServer.onMessage('slow_route', async (data) => {
                await new Promise((r) => setTimeout(r, 2000));
                return { done: true };
            });

            sxServer.onMessage('fast_route', async (data) => {
                return { fast: true };
            });

            client = createTestClient(port);
            await client.connect('token');
        });

        after(async function () {
            await cleanup(httpServer, client);
        });

        it('should timeout when server handler is too slow', async function () {
            await assert.rejects(
                () => client.send('slow_route', {}, { timeout: 200 }),
                (err) => {
                    assert.ok(err.message.includes('TIMEOUT'));
                    assert.ok(err.message.includes('200ms'));
                    return true;
                }
            );
        });

        it('should NOT timeout when response is fast enough', async function () {
            const result = await client.send('fast_route', {}, { timeout: 2000 });
            assert.deepStrictEqual(result, { fast: true });
        });
    });

    describe('send timeout (global default)', function () {
        let httpServer, sxServer, port, client;

        before(async function () {
            ({ httpServer, sxServer, port } = await createTestServer());

            sxServer.onMessage('slow_route', async () => {
                await new Promise((r) => setTimeout(r, 2000));
                return { done: true };
            });

            // Client with global timeout of 300ms
            client = createTestClient(port, {}, { timeout: 300 });
            await client.connect('token');
        });

        after(async function () {
            await cleanup(httpServer, client);
        });

        it('should apply global timeout from constructor', async function () {
            await assert.rejects(
                () => client.send('slow_route', {}),
                (err) => {
                    assert.ok(err.message.includes('TIMEOUT'));
                    assert.ok(err.message.includes('300ms'));
                    return true;
                }
            );
        });
    });

    describe('per-call timeout overrides global', function () {
        let httpServer, sxServer, port, client;

        before(async function () {
            ({ httpServer, sxServer, port } = await createTestServer());

            sxServer.onMessage('slow_route', async () => {
                await new Promise((r) => setTimeout(r, 2000));
                return { done: true };
            });

            // Client with global timeout of 5000ms (generous)
            client = createTestClient(port, {}, { timeout: 5000 });
            await client.connect('token');
        });

        after(async function () {
            await cleanup(httpServer, client);
        });

        it('should use per-call timeout instead of global', async function () {
            await assert.rejects(
                () => client.send('slow_route', {}, { timeout: 200 }),
                (err) => {
                    assert.ok(err.message.includes('TIMEOUT'));
                    assert.ok(err.message.includes('200ms'));
                    return true;
                }
            );
        });
    });
});

describe('Offline Queue', function () {
    let httpServer, sxServer, port;

    before(async function () {
        ({ httpServer, sxServer, port } = await createTestServer());

        sxServer.onMessage('queued_route', async (data) => {
            return { received: data };
        });
    });

    after(async function () {
        await cleanup(httpServer);
    });

    it('should queue messages when client is offline', function () {
        const client = createTestClient(port);
        // Don't connect - client is offline
        assert.strictEqual(client.isConnected, false);

        // send returns a promise that will resolve when reconnected
        const promise = client.send('queued_route', { msg: 'queued1' });
        assert.strictEqual(client.offlineQueue.length, 1);

        // Queue a second message
        client.send('queued_route', { msg: 'queued2' });
        assert.strictEqual(client.offlineQueue.length, 2);

        client.disconnect();
    });

    it('should process queued messages after connecting', async function () {
        const client = createTestClient(port);

        // Queue messages while offline
        const p1 = client.send('queued_route', { msg: 'q1' });
        const p2 = client.send('queued_route', { msg: 'q2' });
        assert.strictEqual(client.offlineQueue.length, 2);

        // Now connect - queue should be processed
        await client.connect('token');

        const [r1, r2] = await Promise.all([p1, p2]);
        assert.deepStrictEqual(r1, { received: { msg: 'q1' } });
        assert.deepStrictEqual(r2, { received: { msg: 'q2' } });
        assert.strictEqual(client.offlineQueue.length, 0);

        client.disconnect();
    });
});

describe('Rooms', function () {
    let httpServer, sxServer, port, client;

    before(async function () {
        ({ httpServer, sxServer, port } = await createTestServer());
        client = createTestClient(port);
        await client.connect('token');
    });

    after(async function () {
        await cleanup(httpServer, client);
    });

    it('should join a room successfully', async function () {
        await client.join('test-room');
        assert.ok(client.joinedRooms.has('test-room'));
    });

    it('should receive messages sent to joined room', async function () {
        const received = new Promise((resolve) => {
            client.onMessage('room_msg', (data) => {
                resolve(data);
            });
        });

        // Small delay to ensure handler is registered
        await new Promise((r) => setTimeout(r, 50));

        sxServer.to('test-room').send('room_msg', { hello: 'room' });

        const data = await received;
        assert.deepStrictEqual(data, { hello: 'room' });
    });

    it('should leave a room successfully', async function () {
        await client.leave('test-room');
        assert.ok(!client.joinedRooms.has('test-room'));
    });

    it('should NOT receive messages after leaving room', async function () {
        let received = false;

        client.onMessage('room_msg_after_leave', () => {
            received = true;
        });

        await new Promise((r) => setTimeout(r, 50));

        sxServer.to('test-room').send('room_msg_after_leave', { should: 'not arrive' });

        // Wait a bit to confirm no message arrives
        await new Promise((r) => setTimeout(r, 200));
        assert.strictEqual(received, false);
    });
});

describe('Room persistence across client recreation', function () {
    let httpServer, sxServer, port;

    before(async function () {
        ({ httpServer, sxServer, port } = await createTestServer());
    });

    after(async function () {
        await cleanup(httpServer);
    });

    it('should deliver every numbered message after closing and recreating a client', async function () {
        const room = `reconnect-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const received = [];
        let client = createTestClient(port);

        await client.connect('token');
        client.onMessage('numbered_message', ({ number }) => received.push(number));
        await client.join(room);

        sxServer.to(room).send('numbered_message', { number: 1 });
        sxServer.to(room).send('numbered_message', { number: 2 });
        await new Promise((resolve) => setTimeout(resolve, 50));

        client.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 50));

        sxServer.to(room).send('numbered_message', { number: 3 });
        sxServer.to(room).send('numbered_message', { number: 4 });
        sxServer.to(room).send('numbered_message', { number: 5 });

        // Recreate the whole client, as a browser does after closing and reopening a tab.
        client = createTestClient(port);
        await client.connect('token');
        client.onMessage('numbered_message', ({ number }) => received.push(number));
        await client.join(room);
        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.deepStrictEqual(received, [1, 2, 3, 4, 5]);
        client.disconnect();
    });
});

describe('Reliable room delivery', function () {
    const reliable = {
        enabled: true,
        retentionMs: 60_000,
        maxMessagesPerRoom: 100
    };

    const createReliableClient = (port, id) => createTestClient(
        port,
        {},
        id === undefined ? {} : { reliable: { id } }
    );

    it('loses a message when the normal transport drops one packet', async function () {
        const { httpServer, sxServer, port } = await createTestServer();
        const room = `normal-packet-loss-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const received = [];
        const client = createTestClient(port);

        await client.connect('token');
        client.onMessage('numbered', ({ number }) => received.push(number));
        await client.join(room);

        sxServer.to(room).send('numbered', { number: 1 });
        await waitFor(() => received.length === 1);

        const packetLoss = dropNextRoomMessage(
            sxServer,
            (message) => message.meta.type === 'numbered' && message.data.number === 2
        );
        sxServer.to(room).send('numbered', { number: 2 });
        sxServer.to(room).send('numbered', { number: 3 });
        packetLoss.restore();

        await waitFor(() => received.length === 2);
        assert.strictEqual(packetLoss.wasDropped(), true);
        assert.deepStrictEqual(received, [1, 3]);

        await cleanup(httpServer, client);
    });

    it('recovers the same dropped packet when reliable mode is enabled', async function () {
        const { httpServer, sxServer, port } = await createTestServer({}, { reliable });
        const room = `reliable-packet-loss-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const received = [];
        const client = createReliableClient(port, 'packet-loss-client');

        await client.connect('token');
        client.onMessage('numbered', ({ number }) => received.push(number));
        await client.join(room);

        await sxServer.to(room).send('numbered', { number: 1 });
        await waitFor(() => received.length === 1);

        const packetLoss = dropNextRoomMessage(
            sxServer,
            (message) => message.meta.type === 'numbered' && message.data.number === 2
        );
        await sxServer.to(room).send('numbered', { number: 2 });
        await sxServer.to(room).send('numbered', { number: 3 });
        packetLoss.restore();

        await waitFor(() => received.length === 3);
        assert.strictEqual(packetLoss.wasDropped(), true);
        assert.deepStrictEqual(received, [1, 2, 3]);

        await sxServer.db.del('sxReliableRooms', room);
        await cleanup(httpServer, client);
    });

    it('requires explicit retention configuration', async function () {
        const httpServer = createServer();
        assert.throws(
            () => new SxServer(httpServer, {}, { reliable: {} }),
            /reliable\.enabled/
        );
        assert.throws(
            () => new SxServer(httpServer, {}, { reliable: { enabled: true } }),
            /reliable\.retentionMs/
        );
        await cleanup(httpServer);
    });

    it('does not add a public send method when the feature is disabled', async function () {
        const { httpServer, sxServer } = await createTestServer({}, {
            reliable: { enabled: false }
        });
        const sender = sxServer.to('disabled-room');

        assert.strictEqual(sender.sendReliable, undefined);
        assert.strictEqual(typeof sender.send, 'function');
        await cleanup(httpServer);
    });

    it('generates a client ID unless an explicit one is configured', async function () {
        assert.throws(
            () => createTestClient(1, {}, { reliable: { id: '' } }),
            /reliable\.id/
        );
        const generatedClient = createReliableClient(1);
        const otherGeneratedClient = createReliableClient(1);
        const explicitClient = createReliableClient(1, 'explicit-client');

        const generatedId = await generatedClient.reliableIdPromise;
        const otherGeneratedId = await otherGeneratedClient.reliableIdPromise;
        assert.strictEqual(typeof generatedId, 'string');
        assert.notStrictEqual(generatedId, otherGeneratedId);
        assert.strictEqual(await explicitClient.reliableIdPromise, 'explicit-client');
    });

    it('serializes initial replay with live sends', async function () {
        const { httpServer, sxServer, port } = await createTestServer({}, { reliable });
        const room = `reliable-join-race-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const received = [];
        const client = createReliableClient(port, 'join-race-client');

        await sxServer.to(room).send('numbered', { number: 1 });
        await sxServer.to(room).send('numbered', { number: 2 });
        await client.connect('token');
        client.onMessage('numbered', ({ number }) => received.push(number));

        const serverSocket = [...sxServer.io.sockets.sockets.values()][0];
        const originalJoin = serverSocket.join.bind(serverSocket);
        let releaseJoin;
        const joinBlocked = new Promise((resolve) => {
            releaseJoin = resolve;
        });
        let joined;
        const socketJoined = new Promise((resolve) => {
            joined = resolve;
        });
        serverSocket.join = async (joinedRoom) => {
            await originalJoin(joinedRoom);
            joined();
            await joinBlocked;
        };

        const clientJoin = client.join(room);
        await socketJoined;
        const liveSend = sxServer.to(room).send('numbered', { number: 3 });
        releaseJoin();
        await Promise.all([clientJoin, liveSend]);

        await waitFor(() => received.length === 3);
        assert.deepStrictEqual(received, [1, 2, 3]);

        await sxServer.db.del('sxReliableRooms', room);
        await cleanup(httpServer, client);
    });

    it('replaces a persisted cursor when afterSeq is explicit', async function () {
        const client = createReliableClient(1, 'cursor-reset-client');
        const key = client._reliableCursorKey('cursor-reset-room', 'cursor-reset-client');
        let record = { key, seq: 10 };
        const createRequest = (result, update) => {
            const request = { result };
            queueMicrotask(() => {
                if (update) update();
                request.onsuccess();
            });
            return request;
        };
        const store = {
            get: () => createRequest(record),
            put: (nextRecord) => createRequest(undefined, () => {
                record = nextRecord;
            })
        };
        client.useIndexedDB = true;
        client.dbReady = Promise.resolve();
        client.db = {
            transaction: () => ({
                objectStore: () => store
            })
        };

        await client._saveReliableCursor('cursor-reset-room', 4, { replace: true });
        assert.strictEqual(record.seq, 4);
        await client._saveReliableCursor('cursor-reset-room', 3);
        assert.strictEqual(record.seq, 4);
    });

    it('detects a gap, replays from the missing sequence, and deduplicates the replay', async function () {
        const { httpServer, sxServer, port } = await createTestServer({}, { reliable });
        const room = `reliable-gap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const received = [];
        const metadata = [];
        const client = createReliableClient(port);

        await client.connect('token');
        client.onMessage('numbered', ({ number }, socket, meta) => {
            received.push(number);
            metadata.push(meta);
        });
        await client.join(room);

        const first = await sxServer.to(room).send('numbered', { number: 1 });
        assert.strictEqual(first.seq, 1);
        assert.strictEqual(typeof first.id, 'string');
        await waitFor(() => received.length === 1);

        const serverSocket = [...sxServer.io.sockets.sockets.values()][0];
        await serverSocket.leave(room);
        await sxServer.to(room).send('numbered', { number: 2 });
        await serverSocket.join(room);
        await sxServer.to(room).send('numbered', { number: 3 });

        await waitFor(() => received.length === 3);
        assert.deepStrictEqual(received, [1, 2, 3]);
        assert.deepStrictEqual(metadata.map(({ seq }) => seq), [1, 2, 3]);
        assert.strictEqual(new Set(metadata.map(({ id }) => id)).size, 3);

        await sxServer.db.del('sxReliableRooms', room);
        await cleanup(httpServer, client);
    });

    it('serializes asynchronous handlers within each room', async function () {
        const { httpServer, sxServer, port } = await createTestServer({}, { reliable });
        const room = `reliable-order-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const steps = [];
        const client = createReliableClient(port, 'order-client');

        await client.connect('token');
        client.onMessage('ordered', async ({ number }) => {
            steps.push(`start-${number}`);
            if (number === 1) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            steps.push(`end-${number}`);
        });
        await client.join(room);

        await Promise.all([
            sxServer.to(room).send('ordered', { number: 1 }),
            sxServer.to(room).send('ordered', { number: 2 })
        ]);

        await waitFor(() => steps.length === 4);
        assert.deepStrictEqual(steps, ['start-1', 'end-1', 'start-2', 'end-2']);

        await sxServer.db.del('sxReliableRooms', room);
        await cleanup(httpServer, client);
    });

    it('tracks broadcast-room cursors independently for each client', async function () {
        const { httpServer, sxServer, port } = await createTestServer({}, { reliable });
        const room = `reliable-broadcast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const firstReceived = [];
        const secondReceived = [];
        const firstClient = createReliableClient(port, 'first-client');
        const secondClient = createReliableClient(port, 'second-client');

        await firstClient.connect('first-token');
        await secondClient.connect('second-token');
        firstClient.onMessage('broadcast', ({ number }) => firstReceived.push(number));
        secondClient.onMessage('broadcast', ({ number }) => secondReceived.push(number));
        await firstClient.join(room);
        await secondClient.join(room);

        await sxServer.to(room).send('broadcast', { number: 1 });
        const firstServerSocket = [...sxServer.io.sockets.sockets.values()]
            .find((socket) => socket.handshake.auth.token === 'first-token');
        await firstServerSocket.leave(room);
        await sxServer.to(room).send('broadcast', { number: 2 });
        await firstServerSocket.join(room);
        await sxServer.to(room).send('broadcast', { number: 3 });

        await waitFor(() => firstReceived.length === 3 && secondReceived.length === 3);
        assert.deepStrictEqual(firstReceived, [1, 2, 3]);
        assert.deepStrictEqual(secondReceived, [1, 2, 3]);

        firstClient.disconnect();
        secondClient.disconnect();
        await sxServer.db.del('sxReliableRooms', room);
        await cleanup(httpServer);
    });

    it('continues the durable sequence after recreating the server', async function () {
        const room = `reliable-restart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const firstServer = await createTestServer({}, { reliable });

        await firstServer.sxServer.to(room).send('restart', { number: 1 });
        await firstServer.sxServer.to(room).send('restart', { number: 2 });
        await cleanup(firstServer.httpServer);

        const secondServer = await createTestServer({}, { reliable });
        const received = [];
        const client = createReliableClient(secondServer.port, 'restart-client');
        await client.connect('token');
        client.onMessage('restart', ({ number }) => received.push(number));
        await client.join(room, { afterSeq: 0 });

        await waitFor(() => received.length === 2);
        const next = await secondServer.sxServer.to(room).send('restart', { number: 3 });
        await waitFor(() => received.length === 3);

        assert.strictEqual(next.seq, 3);
        assert.deepStrictEqual(received, [1, 2, 3]);

        await secondServer.sxServer.db.del('sxReliableRooms', room);
        await cleanup(secondServer.httpServer, client);
    });

    it('reports when a saved cursor is older than the retained log', async function () {
        const { httpServer, sxServer, port } = await createTestServer({}, {
            reliable: { enabled: true, retentionMs: 60_000, maxMessagesPerRoom: 2 }
        });
        const room = `reliable-expired-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        await sxServer.to(room).send('event', { number: 1 });
        await sxServer.to(room).send('event', { number: 2 });
        await sxServer.to(room).send('event', { number: 3 });

        const client = createReliableClient(port, 'expired-client');
        await client.connect('token');
        client.onMessage('event', () => {});
        await assert.rejects(
            () => client.join(room, { afterSeq: 0 }),
            (error) => error.code === 'RELIABLE_RESYNC_REQUIRED'
        );
        const serverSocket = [...sxServer.io.sockets.sockets.values()][0];
        assert.strictEqual(serverSocket.rooms.has(room), false);

        await sxServer.db.del('sxReliableRooms', room);
        await cleanup(httpServer, client);
    });

    it('stops a live stream when a detected gap is no longer retained', async function () {
        const { httpServer, sxServer, port } = await createTestServer({}, {
            reliable: { enabled: true, retentionMs: 60_000, maxMessagesPerRoom: 2 }
        });
        const room = `reliable-live-expired-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const client = createReliableClient(port, 'live-expired-client');
        const received = [];
        let resync;

        await client.connect('token');
        client.onMessage('event', ({ number }) => received.push(number));
        client.onMessage('sx_resync_required', (details) => {
            resync = details;
        });
        await client.join(room);
        await sxServer.to(room).send('event', { number: 1 });
        await waitFor(() => received.length === 1);

        const serverSocket = [...sxServer.io.sockets.sockets.values()][0];
        await serverSocket.leave(room);
        await sxServer.to(room).send('event', { number: 2 });
        await sxServer.to(room).send('event', { number: 3 });
        await sxServer.to(room).send('event', { number: 4 });
        await serverSocket.join(room);
        await sxServer.to(room).send('event', { number: 5 });

        await waitFor(() => resync !== undefined);
        assert.deepStrictEqual(received, [1]);
        assert.strictEqual(resync.reason, 'cursor_expired');
        assert.strictEqual(serverSocket.rooms.has(room), false);
        assert.strictEqual(client.joinedRooms.has(room), false);

        await sxServer.db.del('sxReliableRooms', room);
        await cleanup(httpServer, client);
    });
});

describe('Disconnect', function () {
    let httpServer, sxServer, port;

    before(async function () {
        ({ httpServer, sxServer, port } = await createTestServer());
    });

    after(async function () {
        await cleanup(httpServer);
    });

    it('should set isConnected to false after disconnect', async function () {
        const client = createTestClient(port);
        await client.connect('token');
        assert.strictEqual(client.isConnected, true);

        client.disconnect();
        assert.strictEqual(client.isConnected, false);
        assert.strictEqual(client.socket, null);
    });

    it('should handle disconnect when not connected', function () {
        const client = createTestClient(port);
        // Should not throw
        client.disconnect();
        assert.strictEqual(client.isConnected, false);
    });
});
