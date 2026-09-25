import { createServer } from 'http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'assert';
import { SxServer } from '../index.js';

const roomStore = 'sxReliableRooms';
const clientStore = 'sxReliableClients';

function clientKey(clientId) {
    return JSON.stringify([null, clientId]);
}

async function createTempDir() {
    return mkdtemp(join(tmpdir(), 'shotx-storage-'));
}

function createSxServer(dir, reliable) {
    return new SxServer(createServer(), {}, { debug: 'none', path: dir, reliable });
}

async function disposeServer(sxServer) {
    try {
        sxServer.io.close();
    } catch {}
    await sxServer.db.dispose().catch(() => {});
}

describe('SxServer reliable storage', function () {

    it('serves reliable room and client state from memory without touching the database', async function () {
        const dir = await createTempDir();
        const sxServer = createSxServer(dir, { enabled: true });
        try {
            const calls = [];
            for (const method of ['get', 'set', 'upd', 'add', 'values', 'del']) {
                sxServer.db[method] = (...args) => {
                    calls.push([method, ...args]);
                    throw new Error(`db.${method} must not be called with memory storage`);
                };
            }

            const published = await sxServer._sendReliableRoomMessage('memory-room', 'alpha', { n: 1 });
            assert.strictEqual(published.seq, 1);
            assert.strictEqual(typeof published.id, 'string');

            sxServer.onMessage('echo', async (data) => ({ echoed: data }));
            const response = await sxServer.handleReliableClientMessage(
                {
                    id: 'socket-1',
                    reliableClientEnabled: true,
                    reliableClientId: 'memory-client',
                    reliableClientKey: clientKey('memory-client')
                },
                { meta: { type: 'echo', id: 'message-1', stream: 'memory-client', seq: 1 }, data: { n: 1 } }
            );

            assert.deepStrictEqual(response, {
                meta: { success: true, reliable: true, seq: 1, id: 'message-1' },
                data: { echoed: { n: 1 } }
            });
            assert.deepStrictEqual(calls, []);
        } finally {
            await disposeServer(sxServer);
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('starts a fresh memory session on the same path when the server is recreated', async function () {
        const dir = await createTempDir();
        const servers = [];
        try {
            const first = createSxServer(dir, { enabled: true });
            servers.push(first);
            assert.strictEqual((await first._sendReliableRoomMessage('session-room', 'alpha', { n: 1 })).seq, 1);
            await disposeServer(first);
            assert.strictEqual(existsSync(join(dir, 'shotx.json')), false);

            const second = createSxServer(dir, { enabled: true });
            servers.push(second);
            assert.strictEqual((await second._sendReliableRoomMessage('session-room', 'beta', { n: 2 })).seq, 1);
        } finally {
            for (const sxServer of servers) await disposeServer(sxServer);
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('persists disk storage in a real file and continues the sequence across instances', async function () {
        const dir = await createTempDir();
        const servers = [];
        try {
            const first = createSxServer(dir, { enabled: true, storage: 'disk' });
            servers.push(first);
            await first.db.connect();
            assert.strictEqual((await first._sendReliableRoomMessage('disk-room', 'alpha', { n: 1 })).seq, 1);
            assert.strictEqual((await first._sendReliableRoomMessage('disk-room', 'beta', { n: 2 })).seq, 2);
            await disposeServer(first);

            const onDisk = JSON.parse(await readFile(join(dir, 'shotx.json'), 'utf8'));
            assert.deepStrictEqual(
                onDisk[roomStore]['disk-room'].messages.map((message) => message.meta.seq),
                [1, 2]
            );

            const second = createSxServer(dir, { enabled: true, storage: 'disk' });
            servers.push(second);
            await second.db.connect();
            assert.strictEqual((await second._sendReliableRoomMessage('disk-room', 'gamma', { n: 3 })).seq, 3);
            assert.strictEqual((await second.db.get(roomStore, 'disk-room')).nextSeq, 4);
        } finally {
            for (const sxServer of servers) await disposeServer(sxServer);
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('keeps in-memory room and client history independent from the objects it returns', async function () {
        const dir = await createTempDir();
        const sxServer = createSxServer(dir, { enabled: true });
        try {
            sxServer.onMessage('echo', async (data) => ({ echoed: data }));

            const published = { n: 1, nested: { value: 'original' } };
            await sxServer._sendReliableRoomMessage('alias-room', 'alpha', published);
            published.n = 999;
            published.nested.value = 'mutated';

            const replayed = [];
            await sxServer.replayReliableMessages(
                'alias-room',
                { emit: (event, envelope) => replayed.push(envelope) },
                { startSeq: 1, hasCursor: false }
            );
            assert.deepStrictEqual(
                replayed.map((envelope) => envelope.data),
                [{ n: 1, nested: { value: 'original' } }]
            );

            const socket = {
                id: 'socket-1',
                reliableClientEnabled: true,
                reliableClientId: 'alias-client',
                reliableClientKey: clientKey('alias-client')
            };
            const request = {
                meta: { type: 'echo', id: 'message-1', stream: 'alias-client', seq: 1 },
                data: { n: 5 }
            };

            const response = await sxServer.handleReliableClientMessage(socket, request);
            response.data.echoed.n = 999;
            response.meta.seq = 99;

            const duplicate = await sxServer.handleReliableClientMessage(socket, request);
            assert.deepStrictEqual(duplicate, {
                meta: { success: true, reliable: true, seq: 1, id: 'message-1' },
                data: { echoed: { n: 5 } }
            });
        } finally {
            await disposeServer(sxServer);
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('ignores and preserves persisted reliable logs when storage is memory', async function () {
        const dir = await createTempDir();
        const existing = { [roomStore]: { 'legacy-room': { nextSeq: 5, messages: [] } } };
        await writeFile(join(dir, 'shotx.json'), JSON.stringify(existing));
        const sxServer = createSxServer(dir, { enabled: true, storage: 'memory' });
        try {
            assert.strictEqual((await sxServer._sendReliableRoomMessage('legacy-room', 'alpha', { n: 1 })).seq, 1);
            assert.deepStrictEqual(JSON.parse(await readFile(join(dir, 'shotx.json'), 'utf8')), existing);
        } finally {
            await disposeServer(sxServer);
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('leaves no sequence gap when a memory payload cannot be snapshotted', async function () {
        const dir = await createTempDir();
        const sxServer = createSxServer(dir, { enabled: true });
        try {
            sxServer.onMessage('echo', async (data) => ({ echoed: data }));

            const circular = {};
            circular.self = circular;

            await assert.rejects(
                () => sxServer._sendReliableRoomMessage('gap-room', 'alpha', circular),
                /circular/i
            );
            const roomState = sxServer.memoryRoomStates.get('gap-room');
            assert.deepStrictEqual(roomState, { nextSeq: 1, messages: [] });
            assert.strictEqual((await sxServer._sendReliableRoomMessage('gap-room', 'alpha', { n: 1 })).seq, 1);

            const socket = {
                id: 'socket-1',
                reliableClientEnabled: true,
                reliableClientId: 'gap-client',
                reliableClientKey: clientKey('gap-client')
            };
            await assert.rejects(
                () => sxServer.handleReliableClientMessage(socket, {
                    meta: { type: 'echo', id: 'gap-message', stream: 'gap-client', seq: 1 },
                    data: circular
                }),
                /circular/i
            );
            const clientState = sxServer.memoryClientStates.get(clientKey('gap-client'));
            assert.deepStrictEqual(clientState, { nextSeq: 1, responses: [] });
            assert.deepStrictEqual(
                await sxServer.handleReliableClientMessage(socket, {
                    meta: { type: 'echo', id: 'gap-message', stream: 'gap-client', seq: 1 },
                    data: { n: 1 }
                }),
                { meta: { success: true, reliable: true, seq: 1, id: 'gap-message' }, data: { echoed: { n: 1 } } }
            );
        } finally {
            await disposeServer(sxServer);
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('defaults to memory storage and rejects an unknown storage mode', function () {
        const defaultServer = createSxServer('/tmp', undefined);
        assert.strictEqual(defaultServer.reliable.storage, 'memory');
        defaultServer.io.close();

        assert.throws(
            () => createSxServer('/tmp', { enabled: true, storage: 'tape' }),
            /reliable\.storage must be one of: memory, disk/
        );
    });
});
