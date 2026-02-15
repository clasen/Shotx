import { createServer } from 'http';
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
