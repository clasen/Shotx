import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SxServer } from '../index.js';
import SxClient from '../client.js';

const HOST = '127.0.0.1';

// Bounded stress workload. Performance thresholds live outside this suite.
const WORKLOAD = Object.freeze({
    connections: 20,
    burstMessagesPerClient: 10,
    fanoutRooms: 3,
    fanoutClientsPerRoom: 6,
    fanoutOutsiders: 2,
    fanoutMessagesPerRoom: 15,
    reconnectClients: 20,
    reconnectCycles: 3,
    reconnectMessagesPerWindow: 5,
    socketTimeoutMs: 5_000,
    testTimeoutMs: 60_000
});

const TEST_TIMEOUT = { timeout: WORKLOAD.testTimeoutMs };

const RELIABLE_CONFIG = Object.freeze({
    enabled: true,
    retentionMs: 60_000,
    maxMessagesPerRoom: 1_000,
    identity: (auth) => auth.token
});

const DELIVERY_MODES = Object.freeze([
    Object.freeze({ name: 'plain delivery', reliable: undefined, clientReliable: false }),
    Object.freeze({ name: 'reliable memory delivery', reliable: RELIABLE_CONFIG, clientReliable: true }),
    Object.freeze({ name: 'reliable disk delivery', reliable: { ...RELIABLE_CONFIG, storage: 'disk' }, clientReliable: true })
]);

/**
 * Event-driven inbox. `waitFor` resolves from a real delivery, so no success
 * path depends on an interval timer.
 */
function createInbox() {
    const items = [];
    const waiters = new Set();
    const flush = () => {
        for (const waiter of [...waiters]) {
            if (waiter()) waiters.delete(waiter);
        }
    };
    return {
        items,
        push(item) {
            items.push(item);
            flush();
        },
        waitFor(check) {
            return new Promise((resolve) => {
                const waiter = () => {
                    if (!check(items.length)) return false;
                    resolve();
                    return true;
                };
                if (waiter()) return;
                waiters.add(waiter);
            });
        }
    };
}

async function drainOperationMaps(sxServer) {
    while (sxServer.roomOperations.size > 0 || sxServer.clientOperations.size > 0) {
        await Promise.allSettled([
            ...sxServer.roomOperations.values(),
            ...sxServer.clientOperations.values()
        ]);
    }
}

/** Starts a throwaway SxServer on a temporary database directory and registers cleanup. */
async function startServer(t, { reliable } = {}) {
    const dir = await mkdtemp(joinPath(tmpdir(), 'shotx-stress-'));
    const httpServer = createServer();
    const sxServer = new SxServer(httpServer, {}, { debug: 'none', path: dir, reliable });
    const clients = [];

    t.after(async () => {
        for (const client of clients) client.disconnect();
        await new Promise((resolve) => sxServer.io.close(resolve));
        await drainOperationMaps(sxServer);
        if (httpServer.listening) {
            await new Promise((resolve, reject) => {
                httpServer.close((error) => (error ? reject(error) : resolve()));
                httpServer.closeAllConnections?.();
            });
        }
        // JsonDriver.dispose() flushes the file and releases the cached instance.
        await sxServer.db.dispose();
        await rm(dir, { recursive: true, force: true });
    });

    await sxServer.db.connect();
    const port = await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, HOST, () => {
            httpServer.off('error', reject);
            resolve(httpServer.address().port);
        });
    });

    return { sxServer, port, clients };
}

function createClient(port, { reliable = false, reliableId, reconnection = false } = {}) {
    return new SxClient(
        `http://${HOST}:${port}`,
        { reconnection },
        {
            debug: 'none',
            timeout: WORKLOAD.socketTimeoutMs,
            reliable: reliable ? { enabled: true, id: reliableId } : undefined
        }
    );
}

function serverSocketByToken(sxServer, token) {
    return [...sxServer.io.sockets.sockets.values()]
        .find((socket) => socket.handshake?.auth?.token === token);
}

describe('Stress', function () {

    it('connects 20 clients at once with distinct identities', TEST_TIMEOUT, async function (t) {
        const { sxServer, port, clients } = await startServer(t, { reliable: RELIABLE_CONFIG });
        sxServer.setAuthHandler((token) => ({ token }));
        sxServer.onMessage('identity_echo', (data, socket) => ({
            token: socket.auth.token,
            payload: data.token
        }));

        let readyCount = 0;
        let allReady;
        const everyConnection = new Promise((resolve) => {
            allReady = resolve;
        });
        sxServer.io.on('connection', () => {
            readyCount += 1;
            if (readyCount === WORKLOAD.connections) allReady();
        });

        const descriptors = Array.from({ length: WORKLOAD.connections }, (_, index) => ({
            token: `identity-token-${index}`,
            reliableId: `identity-client-${index}`
        }));

        const connected = await Promise.all(descriptors.map(async (descriptor) => {
            const client = createClient(port, { reliable: true, reliableId: descriptor.reliableId });
            clients.push(client);
            const auth = await client.connect(descriptor.token);
            return { descriptor, client, auth };
        }));

        for (const { descriptor, client, auth } of connected) {
            assert.deepStrictEqual(auth, { token: descriptor.token });
            assert.strictEqual(client.isConnected, true);
            assert.strictEqual(client.serverReliable, true);
        }

        await everyConnection;
        const serverSockets = [...sxServer.io.sockets.sockets.values()];
        assert.strictEqual(serverSockets.length, WORKLOAD.connections);
        assert.strictEqual(new Set(serverSockets.map((socket) => socket.id)).size, WORKLOAD.connections);
        assert.strictEqual(new Set(serverSockets.map((socket) => socket.auth.token)).size, WORKLOAD.connections);
        assert.strictEqual(new Set(serverSockets.map((socket) => socket.reliableClientId)).size, WORKLOAD.connections);

        const echoed = await Promise.all(connected.map(({ descriptor, client }) => (
            client.send('identity_echo', { token: descriptor.token })
        )));
        echoed.forEach((result, index) => {
            assert.deepStrictEqual(result, {
                token: descriptors[index].token,
                payload: descriptors[index].token
            });
        });
    });

    for (const mode of DELIVERY_MODES) {

        it(`acknowledges concurrent client bursts with exact per-client counts (${mode.name})`, TEST_TIMEOUT, async function (t) {
            const { sxServer, port, clients } = await startServer(t, { reliable: mode.reliable });
            sxServer.setAuthHandler((token) => ({ token }));

            const handled = new Map();
            sxServer.onMessage('burst', ({ clientId, n }, socket) => {
                const numbers = handled.get(clientId) ?? [];
                numbers.push(n);
                handled.set(clientId, numbers);
                return { clientId, n, token: socket.auth.token };
            });

            const descriptors = Array.from({ length: WORKLOAD.connections }, (_, index) => ({
                clientId: `burst-client-${index}`,
                token: `burst-token-${index}`
            }));

            await Promise.all(descriptors.map(async (descriptor) => {
                const client = createClient(port, {
                    reliable: mode.clientReliable,
                    reliableId: descriptor.clientId
                });
                clients.push(client);
                await client.connect(descriptor.token);
                descriptor.client = client;
            }));

            const expectedNumbers = Array.from(
                { length: WORKLOAD.burstMessagesPerClient },
                (_, index) => index + 1
            );

            const results = await Promise.all(descriptors.map((descriptor) => Promise.all(
                expectedNumbers.map((n) => descriptor.client.send('burst', { clientId: descriptor.clientId, n }))
            )));

            results.forEach((clientResults, descriptorIndex) => {
                const descriptor = descriptors[descriptorIndex];
                assert.strictEqual(clientResults.length, WORKLOAD.burstMessagesPerClient);
                const acknowledged = clientResults.map((result, index) => {
                    assert.strictEqual(result.clientId, descriptor.clientId);
                    assert.strictEqual(result.token, descriptor.token);
                    assert.strictEqual(result.n, index + 1);
                    return result.n;
                });
                assert.deepStrictEqual(acknowledged, expectedNumbers);
            });

            assert.strictEqual(handled.size, descriptors.length);
            for (const descriptor of descriptors) {
                assert.deepStrictEqual(
                    handled.get(descriptor.clientId),
                    expectedNumbers,
                    `handled sequence for ${descriptor.clientId}`
                );
            }
        });

        it(`fans out ordered messages only to room subscribers (${mode.name})`, TEST_TIMEOUT, async function (t) {
            const { sxServer, port, clients } = await startServer(t, { reliable: mode.reliable });
            sxServer.setAuthHandler((token) => ({ token }));
            sxServer.onMessage('stress_barrier', () => ({ ok: true }));

            const rooms = Array.from({ length: WORKLOAD.fanoutRooms }, (_, index) => `fanout-room-${index}`);
            const subscribers = [];
            for (const [roomIndex, room] of rooms.entries()) {
                for (let index = 0; index < WORKLOAD.fanoutClientsPerRoom; index += 1) {
                    const client = createClient(port, {
                        reliable: mode.clientReliable,
                        reliableId: `fanout-${room}-${index}`
                    });
                    clients.push(client);
                    await client.connect(`fanout-token-${roomIndex}-${index}`);
                    const inbox = createInbox();
                    client.onMessage('fanout', (message) => inbox.push(message));
                    await client.join(room);
                    subscribers.push({ room, inbox });
                }
            }

            const outsiders = [];
            for (let index = 0; index < WORKLOAD.fanoutOutsiders; index += 1) {
                const client = createClient(port, {
                    reliable: mode.clientReliable,
                    reliableId: `fanout-outsider-${index}`
                });
                const received = [];
                clients.push(client);
                await client.connect(`fanout-outsider-token-${index}`);
                client.onMessage('fanout', (message) => received.push(message));
                outsiders.push({ received });
            }

            for (let n = 1; n <= WORKLOAD.fanoutMessagesPerRoom; n += 1) {
                for (const room of rooms) {
                    await Promise.resolve(sxServer.to(room).send('fanout', { room, n }));
                }
            }

            await Promise.all(subscribers.map(({ inbox }) => (
                inbox.waitFor((length) => length >= WORKLOAD.fanoutMessagesPerRoom)
            )));
            // Flush prior traffic on every socket before checking isolation and duplicates.
            await Promise.all(clients.map((client) => client.send('stress_barrier', {})));

            const expectedNumbers = Array.from(
                { length: WORKLOAD.fanoutMessagesPerRoom },
                (_, index) => index + 1
            );
            for (const { room, inbox } of subscribers) {
                assert.deepStrictEqual(
                    inbox.items.map((message) => message.room),
                    Array(WORKLOAD.fanoutMessagesPerRoom).fill(room),
                    `room tag for ${room}`
                );
                assert.deepStrictEqual(
                    inbox.items.map((message) => message.n),
                    expectedNumbers,
                    `ordered stream for ${room}`
                );
            }

            for (const [index, { received }] of outsiders.entries()) {
                assert.deepStrictEqual(received, [], `outsider ${index} must receive no fanout`);

                const serverSocket = serverSocketByToken(sxServer, `fanout-outsider-token-${index}`);
                assert.ok(serverSocket, 'outsider server socket present');
                assert.strictEqual(serverSocket.rooms.size, 1);
                for (const room of rooms) {
                    assert.strictEqual(serverSocket.rooms.has(room), false, `outsider joined ${room}`);
                }
            }
        });
    }

    for (const mode of DELIVERY_MODES.filter((mode) => mode.clientReliable)) {
        it(`replays both directions across simultaneous disconnect and reconnect cycles (${mode.name})`, TEST_TIMEOUT, async function (t) {
            const { sxServer, port, clients } = await startServer(t, { reliable: mode.reliable });
            sxServer.setAuthHandler((token) => ({ token }));

            const handled = new Map();
            sxServer.onMessage('echo', ({ clientId, n }, socket) => {
                assert.strictEqual(socket.auth.token, clientId);
                const numbers = handled.get(clientId) ?? [];
                numbers.push(n);
                handled.set(clientId, numbers);
                return { clientId, n };
            });

            const room = 'reconnect-room';
            const participants = [];
            for (let index = 0; index < WORKLOAD.reconnectClients; index += 1) {
                const token = `reconnect-token-${index}`;
                const client = createClient(port, { reliable: true, reliableId: token });
                clients.push(client);
                await client.connect(token);
                const inbox = createInbox();
                client.onMessage('feed', ({ n }) => inbox.push(n));
                await client.join(room);
                participants.push({ client, token, inbox, outbound: 0 });
            }

            const expected = [];
            let roomNumber = 0;
            const advanceRoom = async () => {
                roomNumber += 1;
                expected.push(roomNumber);
                await Promise.resolve(sxServer.to(room).send('feed', { n: roomNumber }));
            };

            const sendOutbound = (participant) => {
                participant.outbound += 1;
                const n = participant.outbound;
                return participant.client.send('echo', { clientId: participant.token, n })
                    .then((result) => {
                        assert.deepStrictEqual(result, { clientId: participant.token, n });
                    });
            };

            const expectRoomStream = async () => {
                await Promise.all(participants.map(({ inbox }) => (
                    inbox.waitFor((length) => length >= expected.length)
                )));
                for (const { token, inbox } of participants) {
                    assert.deepStrictEqual(inbox.items, expected, `room stream for ${token}`);
                }
            };

            await advanceRoom();
            await expectRoomStream();
            await Promise.all(participants.map(sendOutbound));

            for (let cycle = 0; cycle < WORKLOAD.reconnectCycles; cycle += 1) {
                const clientDrops = participants.map(({ client }) => new Promise((resolve) => {
                    client.socket.once('disconnect', resolve);
                }));
                const serverDrops = participants.map(({ token }) => new Promise((resolve) => {
                    const serverSocket = serverSocketByToken(sxServer, token);
                    assert.ok(serverSocket, `server socket for ${token} before drop`);
                    serverSocket.once('disconnect', resolve);
                }));
                for (const { token } of participants) {
                    serverSocketByToken(sxServer, token).conn.close();
                }
                // A server socket leaves its rooms before it emits 'disconnect'.
                await Promise.all([...clientDrops, ...serverDrops]);
                for (const { client, token } of participants) {
                    assert.strictEqual(client.isConnected, false, `${token} still connected`);
                }
                assert.strictEqual(
                    sxServer.io.sockets.adapter.rooms.has(room),
                    false,
                    `${room} must be empty while every client is offline`
                );

                // Both directions accumulate during the same offline window.
                const outbound = participants.map((participant) => Promise.all(
                    Array.from({ length: WORKLOAD.reconnectMessagesPerWindow }, () => sendOutbound(participant))
                ));
                for (let index = 0; index < WORKLOAD.reconnectMessagesPerWindow; index += 1) {
                    await advanceRoom();
                }

                await Promise.all(participants.map(({ client, token }) => client.connect(token)));
                await Promise.all(outbound);

                await advanceRoom();
                await expectRoomStream();
            }

            for (const { token, outbound } of participants) {
                assert.deepStrictEqual(
                    handled.get(token),
                    Array.from({ length: outbound }, (_, index) => index + 1),
                    `handled outbound sequence for ${token}`
                );
            }
        });
    }
});
