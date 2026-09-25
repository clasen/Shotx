import { createServer } from 'http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'assert';
import { SxServer } from '../index.js';

const roomStore = 'sxReliableRooms';
const clientStore = 'sxReliableClients';

async function createTestServer(initialContent) {
    const dir = await mkdtemp(join(tmpdir(), 'shotx-reliable-'));
    if (initialContent !== undefined) {
        await writeFile(join(dir, 'shotx.json'), initialContent);
    }
    const httpServer = createServer();
    const sxServer = new SxServer(httpServer, {}, {
        debug: 'none',
        path: dir,
        reliable: { enabled: true, storage: 'disk' }
    });
    await sxServer.db.connect();
    return { httpServer, sxServer, dir };
}

async function cleanup({ httpServer, sxServer, dir }) {
    if (httpServer.listening) {
        await new Promise((resolve) => httpServer.close(resolve));
    }
    sxServer.io.close();
    try {
        await sxServer.db.dispose();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function trackWrites(sxServer) {
    const writes = { set: [], upd: [] };
    const set = sxServer.db.set.bind(sxServer.db);
    const upd = sxServer.db.upd.bind(sxServer.db);
    sxServer.db.set = (...args) => {
        writes.set.push(args);
        return set(...args);
    };
    sxServer.db.upd = (update) => {
        writes.upd.push(update);
        return upd(update);
    };
    return writes;
}

function defer() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function roomState(seq) {
    return { nextSeq: seq, messages: [] };
}

function clientState(seq) {
    return { nextSeq: seq, responses: [] };
}

function clientKey(clientId) {
    return JSON.stringify([null, clientId]);
}

function onceImmediate() {
    return new Promise((resolve) => setImmediate(resolve));
}

function trackReliableEmissions(sxServer) {
    const emitted = [];
    const to = sxServer.io.to.bind(sxServer.io);
    sxServer.io.to = (room) => {
        const target = to(room);
        const emit = target.emit.bind(target);
        target.emit = (...args) => {
            emitted.push({ room, args });
            return emit(...args);
        };
        return target;
    };
    return emitted;
}

describe('SxServer reliable persistence batching', function () {

    it('coalesces saves from different rooms into a single batched write', async function () {
        const testServer = await createTestServer();
        const { sxServer } = testServer;
        try {
            const writes = trackWrites(sxServer);
            const states = {
                'room-a': roomState(2),
                'room-b': roomState(3),
                'room-c': roomState(4)
            };

            await Promise.all(Object.entries(states).map(
                ([room, state]) => sxServer.saveReliableState(roomStore, room, state)
            ));

            assert.strictEqual(writes.set.length, 0);
            assert.strictEqual(writes.upd.length, 1);
            for (const [room, state] of Object.entries(states)) {
                assert.deepStrictEqual(await sxServer.db.get(roomStore, room), state);
            }

            await Promise.all([
                sxServer.saveReliableState(roomStore, 'room-d', roomState(5)),
                sxServer.saveReliableState(clientStore, clientKey('client-a'), clientState(2))
            ]);

            assert.strictEqual(writes.set.length, 0);
            assert.strictEqual(writes.upd.length, 2);
        } finally {
            await cleanup(testServer);
        }
    });

    it('uses a single key write when only one save is pending', async function () {
        const testServer = await createTestServer();
        const { sxServer } = testServer;
        try {
            const writes = trackWrites(sxServer);
            const key = clientKey('solo-client');
            const state = clientState(2);

            await sxServer.saveReliableState(clientStore, key, state);

            assert.strictEqual(writes.upd.length, 0);
            assert.strictEqual(writes.set.length, 1);
            assert.deepStrictEqual(writes.set[0], [clientStore, key, state]);
            assert.deepStrictEqual(await sxServer.db.get(clientStore, key), state);
        } finally {
            await cleanup(testServer);
        }
    });

    it('preserves unrelated root keys and both reliable stores while batching', async function () {
        const testServer = await createTestServer();
        const { sxServer } = testServer;
        try {
            const keptClientKey = JSON.stringify(['principal', 'kept-client']);
            await sxServer.db.set('general', 'message-1', { type: 'notification', data: { n: 1 } });
            await sxServer.db.set(clientStore, keptClientKey, clientState(9));

            const writes = trackWrites(sxServer);
            await Promise.all([
                sxServer.saveReliableState(roomStore, 'batched-room', roomState(2)),
                sxServer.saveReliableState(clientStore, clientKey('batched-client'), clientState(2)),
                sxServer.db.set('general', 'message-2', { type: 'notification', data: { n: 2 } })
            ]);

            assert.strictEqual(writes.upd.length, 1);
            assert.deepStrictEqual(
                await sxServer.db.get('general', 'message-1'),
                { type: 'notification', data: { n: 1 } }
            );
            assert.deepStrictEqual(
                await sxServer.db.get('general', 'message-2'),
                { type: 'notification', data: { n: 2 } }
            );
            assert.deepStrictEqual(await sxServer.db.get(clientStore, keptClientKey), clientState(9));
            assert.deepStrictEqual(await sxServer.db.get(roomStore, 'batched-room'), roomState(2));
            assert.deepStrictEqual(await sxServer.db.get(clientStore, clientKey('batched-client')), clientState(2));
        } finally {
            await cleanup(testServer);
        }
    });

    it('reads a pre-existing pretty JSON file and preserves it while batching', async function () {
        const existing = {
            general: { 'message-1': { type: 'notification', data: { n: 1 } } },
            user1: { 'message-2': { type: 'notification', data: { n: 2 } } },
            sxReliableClients: { '["principal","kept-client"]': clientState(9) },
            sxReliableRooms: { 'kept-room': roomState(4) }
        };
        const testServer = await createTestServer(JSON.stringify(existing, null, 4));
        const { sxServer } = testServer;
        try {
            await Promise.all([
                sxServer.saveReliableState(roomStore, 'new-room', roomState(2)),
                sxServer.saveReliableState(clientStore, clientKey('new-client'), clientState(2))
            ]);

            assert.deepStrictEqual(await sxServer.db.get('general', 'message-1'), existing.general['message-1']);
            assert.deepStrictEqual(await sxServer.db.get('user1', 'message-2'), existing.user1['message-2']);
            assert.deepStrictEqual(await sxServer.db.get(roomStore, 'kept-room'), roomState(4));
            assert.deepStrictEqual(await sxServer.db.get(roomStore, 'new-room'), roomState(2));

            const onDisk = JSON.parse(await readFile(join(testServer.dir, 'shotx.json'), 'utf8'));
            assert.deepStrictEqual(onDisk.general, existing.general);
            assert.deepStrictEqual(onDisk.user1, existing.user1);
            assert.deepStrictEqual(onDisk[clientStore]['["principal","kept-client"]'], clientState(9));
            assert.deepStrictEqual(Object.keys(onDisk[roomStore]).sort(), ['kept-room', 'new-room']);
        } finally {
            await cleanup(testServer);
        }
    });

    it('rejects a batched write instead of replacing a corrupt store', async function () {
        const testServer = await createTestServer(JSON.stringify({
            general: { 'message-1': { type: 'notification', data: { n: 1 } } },
            sxReliableRooms: 'corrupt'
        }));
        const { sxServer } = testServer;
        try {
            const settled = await Promise.allSettled([
                sxServer.saveReliableState(roomStore, 'room-a', roomState(2)),
                sxServer.saveReliableState(clientStore, clientKey('client-a'), clientState(2))
            ]);

            assert.deepStrictEqual(settled.map((entry) => entry.status), ['rejected', 'rejected']);
            assert.match(settled[0].reason.message, /Corrupt reliable store: sxReliableRooms/);
            assert.deepStrictEqual(
                await sxServer.db.get('general', 'message-1'),
                { type: 'notification', data: { n: 1 } }
            );
            assert.strictEqual(await sxServer.db.get(roomStore), 'corrupt');
            assert.strictEqual(await sxServer.db.get(clientStore), null);

            const onDisk = JSON.parse(await readFile(join(testServer.dir, 'shotx.json'), 'utf8'));
            assert.strictEqual(onDisk[roomStore], 'corrupt');
            assert.deepStrictEqual(onDisk.general, { 'message-1': { type: 'notification', data: { n: 1 } } });
        } finally {
            await cleanup(testServer);
        }
    });

    it('rejects a batched write instead of replacing a corrupt root', async function () {
        const testServer = await createTestServer('5');
        const { sxServer } = testServer;
        try {
            const settled = await Promise.allSettled([
                sxServer.saveReliableState(roomStore, 'room-a', roomState(2)),
                sxServer.saveReliableState(clientStore, clientKey('client-a'), clientState(2))
            ]);

            assert.deepStrictEqual(settled.map((entry) => entry.status), ['rejected', 'rejected']);
            assert.match(settled[0].reason.message, /Corrupt persistence root/);
            assert.strictEqual(await sxServer.db.get(), 5);
        } finally {
            await cleanup(testServer);
        }
    });

    it('stores arbitrary room keys as own properties without touching prototypes', async function () {
        const testServer = await createTestServer();
        const { sxServer } = testServer;
        try {
            await Promise.all([
                sxServer.saveReliableState(roomStore, '__proto__', roomState(2)),
                sxServer.saveReliableState(roomStore, 'plain-room', roomState(3))
            ]);

            const stored = await sxServer.db.get(roomStore);
            assert.strictEqual(Object.getPrototypeOf(stored), Object.prototype);
            assert.ok(Object.prototype.hasOwnProperty.call(stored, '__proto__'));
            assert.deepStrictEqual(stored.__proto__, roomState(2));
            assert.deepStrictEqual(stored['plain-room'], roomState(3));
        } finally {
            await cleanup(testServer);
        }
    });

    it('does not resolve reliable room publishes before the batched write completes', async function () {
        const testServer = await createTestServer();
        const { sxServer } = testServer;
        const gate = defer();
        try {
            const realUpd = sxServer.db.upd.bind(sxServer.db);
            const writeEntered = defer();
            let updCalls = 0;
            sxServer.db.upd = (update) => {
                updCalls += 1;
                writeEntered.resolve();
                return gate.promise.then(() => realUpd(update));
            };
            const emitted = trackReliableEmissions(sxServer);

            let firstResolved = false;
            let secondResolved = false;
            const first = sxServer._sendReliableRoomMessage('room-a', 'alpha', { n: 1 })
                .then((result) => {
                    firstResolved = true;
                    return result;
                });
            const second = sxServer._sendReliableRoomMessage('room-b', 'beta', { n: 2 })
                .then((result) => {
                    secondResolved = true;
                    return result;
                });

            await writeEntered.promise;
            assert.strictEqual(firstResolved, false);
            assert.strictEqual(secondResolved, false);
            assert.deepStrictEqual(emitted, []);
            assert.strictEqual(await sxServer.db.get(roomStore, 'room-a'), null);

            gate.resolve();
            await Promise.all([first, second]);

            assert.strictEqual(updCalls, 1);
            assert.deepStrictEqual(emitted.map((entry) => entry.args[0]), ['message', 'message']);
            assert.deepStrictEqual(
                emitted.map((entry) => [entry.room, entry.args[1].meta.type]),
                [['room-a', 'alpha'], ['room-b', 'beta']]
            );
            assert.deepStrictEqual(emitted.map((entry) => entry.args[1].meta.seq), [1, 1]);
            assert.strictEqual((await sxServer.db.get(roomStore, 'room-a')).nextSeq, 2);
            assert.strictEqual((await sxServer.db.get(roomStore, 'room-b')).nextSeq, 2);
        } finally {
            gate.resolve();
            await cleanup(testServer);
        }
    });

    it('does not resolve a reliable client acknowledgement before the batched write completes', async function () {
        const testServer = await createTestServer();
        const { sxServer } = testServer;
        const gate = defer();
        try {
            sxServer.onMessage('echo', async (data) => ({ echoed: data }));

            const realUpd = sxServer.db.upd.bind(sxServer.db);
            const writeEntered = defer();
            let updCalls = 0;
            sxServer.db.upd = (update) => {
                updCalls += 1;
                writeEntered.resolve();
                return gate.promise.then(() => realUpd(update));
            };

            const firstSocket = { id: 'socket-1', reliableClientEnabled: true, reliableClientId: 'ack-a', reliableClientKey: clientKey('ack-a') };
            const secondSocket = { id: 'socket-2', reliableClientEnabled: true, reliableClientId: 'ack-b', reliableClientKey: clientKey('ack-b') };

            let firstResolved = false;
            const first = sxServer.handleReliableClientMessage(firstSocket, {
                meta: { type: 'echo', id: 'message-1', stream: 'ack-a', seq: 1 },
                data: { n: 1 }
            }).then((response) => {
                firstResolved = true;
                return response;
            });
            const second = sxServer.handleReliableClientMessage(secondSocket, {
                meta: { type: 'echo', id: 'message-2', stream: 'ack-b', seq: 1 },
                data: { n: 2 }
            });

            await writeEntered.promise;
            assert.strictEqual(firstResolved, false);
            assert.strictEqual(await sxServer.db.get(clientStore, clientKey('ack-a')), null);

            gate.resolve();
            const [firstResponse, secondResponse] = await Promise.all([first, second]);

            assert.strictEqual(updCalls, 1);
            assert.deepStrictEqual(firstResponse, {
                meta: { success: true, reliable: true, seq: 1, id: 'message-1' },
                data: { echoed: { n: 1 } }
            });
            assert.deepStrictEqual(secondResponse.data, { echoed: { n: 2 } });

            const storedClient = await sxServer.db.get(clientStore, clientKey('ack-a'));
            assert.strictEqual(storedClient.nextSeq, 2);
            assert.strictEqual(storedClient.responses.length, 1);
            assert.strictEqual(storedClient.responses[0].seq, 1);
        } finally {
            gate.resolve();
            await cleanup(testServer);
        }
    });

    it('rejects every save in a failed batch and lets the next batch proceed', async function () {
        const testServer = await createTestServer();
        const { sxServer } = testServer;
        try {
            const realUpd = sxServer.db.upd.bind(sxServer.db);
            const failure = new Error('write failed');
            let updCalls = 0;
            sxServer.db.upd = (update) => {
                updCalls += 1;
                if (updCalls === 1) {
                    return Promise.reject(failure);
                }
                return realUpd(update);
            };

            const settled = await Promise.allSettled([
                sxServer.saveReliableState(roomStore, 'failed-a', roomState(2)),
                sxServer.saveReliableState(roomStore, 'failed-b', roomState(2))
            ]);

            assert.deepStrictEqual(settled.map((entry) => entry.status), ['rejected', 'rejected']);
            assert.strictEqual(settled[0].reason, failure);
            assert.strictEqual(settled[1].reason, failure);
            assert.strictEqual(await sxServer.db.get(roomStore, 'failed-a'), null);
            assert.strictEqual(await sxServer.db.get(roomStore, 'failed-b'), null);

            await Promise.all([
                sxServer.saveReliableState(roomStore, 'next-a', roomState(2)),
                sxServer.saveReliableState(roomStore, 'next-b', roomState(2))
            ]);

            assert.strictEqual(updCalls, 2);
            assert.deepStrictEqual(await sxServer.db.get(roomStore, 'next-a'), roomState(2));
            assert.deepStrictEqual(await sxServer.db.get(roomStore, 'next-b'), roomState(2));
        } finally {
            await cleanup(testServer);
        }
    });

    it('does not confirm a save enqueued during an in-flight write from the first batch', async function () {
        const testServer = await createTestServer();
        const { sxServer } = testServer;
        const gate = defer();
        let pending = [];
        try {
            const realUpd = sxServer.db.upd.bind(sxServer.db);
            const realSet = sxServer.db.set.bind(sxServer.db);
            const writeEntered = defer();
            let updCalls = 0;
            let setCalls = 0;
            sxServer.db.upd = (update) => {
                updCalls += 1;
                writeEntered.resolve();
                return gate.promise.then(() => realUpd(update));
            };
            sxServer.db.set = (...args) => {
                setCalls += 1;
                return realSet(...args);
            };

            let firstResolved = false;
            let secondResolved = false;
            let thirdResolved = false;
            const first = sxServer.saveReliableState(roomStore, 'room-a', roomState(2))
                .then(() => { firstResolved = true; });
            const second = sxServer.saveReliableState(roomStore, 'room-b', roomState(2))
                .then(() => { secondResolved = true; });

            await writeEntered.promise;

            const third = sxServer.saveReliableState(roomStore, 'room-c', roomState(2))
                .then(() => { thirdResolved = true; });
            pending = [first, second, third];
            await onceImmediate();

            assert.strictEqual(updCalls, 1);
            assert.strictEqual(setCalls, 0);
            assert.strictEqual(firstResolved, false);
            assert.strictEqual(secondResolved, false);
            assert.strictEqual(thirdResolved, false);
            assert.strictEqual(await sxServer.db.get(roomStore, 'room-c'), null);

            gate.resolve();
            await Promise.all(pending);

            assert.strictEqual(updCalls, 1);
            assert.strictEqual(setCalls, 1);
            assert.deepStrictEqual(await sxServer.db.get(roomStore, 'room-a'), roomState(2));
            assert.deepStrictEqual(await sxServer.db.get(roomStore, 'room-b'), roomState(2));
            assert.deepStrictEqual(await sxServer.db.get(roomStore, 'room-c'), roomState(2));
        } finally {
            gate.resolve();
            await Promise.allSettled(pending);
            await cleanup(testServer);
        }
    });

    it('writes one save per reliable stream and keeps message order', async function () {
        const testServer = await createTestServer();
        const { sxServer } = testServer;
        try {
            const writes = trackWrites(sxServer);

            const first = await sxServer._sendReliableRoomMessage('stream-room', 'alpha', { n: 1 });
            const second = await sxServer._sendReliableRoomMessage('stream-room', 'beta', { n: 2 });

            assert.deepStrictEqual([first.seq, second.seq], [1, 2]);
            assert.strictEqual(writes.upd.length, 0);
            assert.strictEqual(writes.set.length, 2);

            const stored = await sxServer.db.get(roomStore, 'stream-room');
            assert.strictEqual(stored.nextSeq, 3);
            assert.deepStrictEqual(stored.messages.map((message) => message.meta.seq), [1, 2]);
            assert.deepStrictEqual(stored.messages.map((message) => message.data), [{ n: 1 }, { n: 2 }]);
        } finally {
            await cleanup(testServer);
        }
    });

    it('batches prune writes from rooms and clients with other pending saves', async function () {
        const testServer = await createTestServer();
        const { sxServer } = testServer;
        try {
            const room = 'stale-room';
            const key = clientKey('stale-client');
            await sxServer.db.set(roomStore, room, {
                nextSeq: 5,
                messages: [{ meta: { type: 'old', id: 'old-1', stream: room, seq: 4 }, data: {}, storedAt: 0 }]
            });
            await sxServer.db.set(clientStore, key, {
                nextSeq: 4,
                responses: [{ seq: 3, id: 'old-ack', response: { meta: { success: true }, data: null }, storedAt: 0 }]
            });

            const writes = trackWrites(sxServer);
            const socket = { join: async () => {}, emit: () => {} };

            const [replayResult, nextSeq] = await Promise.all([
                sxServer.replayReliableMessages(room, socket, { startSeq: 1, hasCursor: true }),
                sxServer.getReliableClientNextSeq(key),
                sxServer._sendReliableRoomMessage('fresh-room', 'alpha', { n: 1 })
            ]);

            assert.strictEqual(writes.upd.length, 1);
            assert.strictEqual(writes.set.length, 0);
            assert.deepStrictEqual(replayResult, {
                status: 'resync_required',
                reason: 'cursor_expired',
                earliestSeq: 5,
                latestSeq: 4
            });
            assert.strictEqual(nextSeq, 4);
            assert.deepStrictEqual(await sxServer.db.get(roomStore, room), { nextSeq: 5, messages: [] });
            assert.deepStrictEqual(await sxServer.db.get(clientStore, key), { nextSeq: 4, responses: [] });
        } finally {
            await cleanup(testServer);
        }
    });
});
