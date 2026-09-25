import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import SxServer from '../server.js';
import SxClient from '../client.js';

const config = {
    clients: 20,
    rounds: 3,
    warmupMessages: 20,
    requestsPerClient: 200,
    broadcasts: 200,
    payloadBytes: 256,
    timeoutMs: 120_000,
    reliable: { retentionMs: 60_000, maxMessagesPerRoom: 1_000 }
};
const payload = 'x'.repeat(config.payloadBytes);

async function withDeadline(operation, label) {
    let timer;
    try {
        return await Promise.race([
            operation(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out`)), config.timeoutMs);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function summarize(start, latencies) {
    const elapsedMs = performance.now() - start;
    const sorted = [...latencies].sort((a, b) => a - b);
    const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
    return {
        completed: sorted.length,
        elapsedMs,
        perSecond: sorted.length * 1000 / elapsedMs,
        latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) }
    };
}

async function runRound(mode, round) {
    const reliable = mode !== 'normal';
    const directory = await mkdtemp(join(tmpdir(), 'shotx-benchmark-'));
    const httpServer = createServer();
    const server = new SxServer(httpServer, {}, {
        path: directory,
        reliable: { ...config.reliable, enabled: reliable, storage: mode === 'disk' ? 'disk' : 'memory', identity: (auth) => auth.id }
    });
    const clients = [];
    const handled = Array.from({ length: config.clients }, () => []);
    server.setAuthHandler((id) => ({ id }));
    server.onMessage('echo', (data, socket) => {
        assert.equal(socket.auth.id, `client-${data.client}`);
        handled[data.client].push(data.sequence);
        return data;
    });

    try {
        await server.db.connect();
        await new Promise((resolve, reject) => {
            httpServer.once('error', reject);
            httpServer.listen(0, '127.0.0.1', resolve);
        });
        const url = `http://127.0.0.1:${httpServer.address().port}`;
        for (let index = 0; index < config.clients; index += 1) {
            clients.push(new SxClient(url, { transports: ['websocket'], reconnection: false }, {
                timeout: config.timeoutMs,
                reliable: { enabled: reliable, id: `client-${index}` }
            }));
        }
        const connectionStart = performance.now();
        const connectionLatencies = [];
        await withDeadline(() => Promise.all(clients.map(async (client, index) => {
            const start = performance.now();
            await client.connect(`client-${index}`);
            connectionLatencies.push(performance.now() - start);
        })), 'Connect');
        const connections = summarize(connectionStart, connectionLatencies);
        assert.equal(server.io.sockets.sockets.size, config.clients);

        async function requests(count) {
            for (const values of handled) values.length = 0;
            const latencies = [];
            const start = performance.now();
            await withDeadline(() => Promise.all(clients.map(async (client, index) => {
                for (let sequence = 0; sequence < count; sequence += 1) {
                    const data = { client: index, sequence, payload };
                    const sentAt = performance.now();
                    const response = await client.send('echo', data);
                    latencies.push(performance.now() - sentAt);
                    assert.deepEqual(response, data);
                }
            })), 'Request/response');
            const result = summarize(start, latencies);
            const expected = Array.from({ length: count }, (_, index) => index);
            for (const values of handled) assert.deepEqual(values, expected);
            assert.equal(result.completed, count * config.clients);
            return result;
        }

        async function fanout(count, room) {
            const received = clients.map(() => []);
            const latencies = [];
            const sentAt = [];
            let complete;
            const delivered = new Promise((resolve) => { complete = resolve; });
            for (const [index, client] of clients.entries()) {
                client.onMessage('broadcast', (data) => {
                    received[index].push(data);
                    latencies.push(performance.now() - sentAt[data.sequence]);
                    if (latencies.length === config.clients * count) complete();
                });
            }
            await withDeadline(() => Promise.all(clients.map((client) => client.join(room))), 'Join');
            const start = performance.now();
            await withDeadline(async () => {
                await Promise.all(Array.from({ length: count }, (_, sequence) => {
                    sentAt[sequence] = performance.now();
                    return server.to(room).send('broadcast', { sequence, payload });
                }));
                await delivered;
            }, 'Fanout delivery');
            const result = summarize(start, latencies);
            const expected = Array.from({ length: count }, (_, sequence) => ({ sequence, payload }));
            for (const messages of received) assert.deepEqual(messages, expected);
            await withDeadline(() => Promise.all(clients.map((client) => client.leave(room))), 'Leave');
            return { ...result, published: count };
        }

        await requests(config.warmupMessages);
        await fanout(config.warmupMessages, 'warmup');
        const storeFile = join(directory, 'shotx.json');
        const storeBytesBefore = (await stat(storeFile)).size;
        const memoryBefore = process.memoryUsage();
        const cpuBefore = process.cpuUsage();
        const requestResponse = await requests(config.requestsPerClient);
        const storeBytesAfterRequests = (await stat(storeFile)).size;
        console.error(`${mode} round ${round}: request/response complete (${requestResponse.elapsedMs.toFixed(0)} ms)`);
        const broadcast = await fanout(config.broadcasts, 'measured');
        return {
            mode,
            round,
            connections,
            requestResponse,
            broadcast,
            storeBytes: {
                afterWarmup: storeBytesBefore,
                afterRequests: storeBytesAfterRequests,
                afterBroadcast: (await stat(storeFile)).size
            },
            processMemoryBytes: { before: memoryBefore, after: process.memoryUsage() },
            processCpuMicroseconds: process.cpuUsage(cpuBefore)
        };
    } finally {
        for (const client of clients) client.disconnect();
        await new Promise((resolve) => server.io.close(resolve));
        while (server.roomOperations.size > 0 || server.clientOperations.size > 0) {
            await Promise.allSettled([...server.roomOperations.values(), ...server.clientOperations.values()]);
        }
        await server.db.dispose();
        await rm(directory, { recursive: true, force: true });
    }
}

const results = [];
try {
    for (let round = 1; round <= config.rounds; round += 1) {
        // Rotate which mode runs first to reduce ordering bias.
        const modes = ['normal', 'memory', 'disk'];
        const offset = (round - 1) % modes.length;
        for (const mode of [...modes.slice(offset), ...modes.slice(0, offset)]) {
            const result = await runRound(mode, round);
            results.push(result);
            console.error(`${result.mode} round ${round}: ${result.requestResponse.perSecond.toFixed(0)} ACK/s, ${result.broadcast.perSecond.toFixed(0)} deliveries/s`);
        }
    }
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}

console.log(JSON.stringify({
    status: process.exitCode ? 'failed' : 'passed',
    environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0].model },
    methodology: {
        transport: 'WebSocket over loopback; server and all clients share one Node process',
        requestResponse: 'One outstanding request per client; latency measured from send to validated ACK',
        broadcast: 'Burst to one room; throughput counts actual client deliveries; latency includes server queue time',
        memory: 'Whole-process snapshots without forced GC; include clients, harness and prior rounds; not comparable server memory measurements',
        persistence: 'Memory keeps reliable history in the server instance; disk uses the installed DeepBase JSON driver and rewrites the growing store per commit; not a steady-state or crash-durability test'
    },
    config,
    results
}, null, 2));
