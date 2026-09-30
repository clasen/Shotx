import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SxServer } from 'shotx';

// `node server.mjs reliable` enables reliable room delivery with a small history for resync tests.
const reliable = process.argv[2] === 'reliable';
let blockedUntil = 0;
const counts = new Map();
const count = (key) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts.get(key);
};

const httpServer = createServer();
const sxServer = new SxServer(httpServer, {
    allowRequest: (req, callback) => callback(null, Date.now() >= blockedUntil)
}, {
    path: mkdtempSync(join(tmpdir(), 'shotx-unity-')),
    reliable: { enabled: reliable, maxMessagesPerRoom: 3 }
});

sxServer
    .setAuthHandler(async (token) => (token === 'valid' ? { userId: 'user123' } : null))
    .onMessage('echo', async (data, socket, meta) => ({ data, meta }))
    .onMessage('fail', async () => {
        throw new Error('handler failed');
    })
    .onMessage('slow', async ({ ms }) => {
        await sleep(ms);
        return 'late';
    })
    .onMessage('broadcast', async ({ room, type, data }) => {
        await sxServer.to(room).send(type, data);
    })
    .onMessage('burst', async ({ room, type, count }) => {
        for (let index = 0; index < count; index += 1) await sxServer.to(room).send(type, index);
    })
    .onMessage('count', async ({ key }) => count(key))
    .onMessage('counts', async ({ key }) => counts.get(key) ?? 0)
    .onMessage('count_and_drop', async ({ key }, socket) => {
        // Close before the handler returns so its acknowledgement is lost.
        socket.conn.close();
        return count(key);
    })
    .onMessage('drop', async ({ blockMs }, socket) => {
        blockedUntil = Date.now() + blockMs;
        setTimeout(() => socket.conn.close(), 10);
    });

httpServer.listen(0, () => {
    console.log(httpServer.address().port);
});
