import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { SxServer } from '../index.js';

const port = Number(process.env.PORT || 3000);
const intervalMs = Number(process.env.SHOTX_TEST_INTERVAL_MS || 250);
const userId = 'browser-user';
const runId = randomUUID();
const room = `user:${userId}:${runId}`;

const server = createServer();
const sxServer = new SxServer(server, {}, { debug: 'info' });

sxServer.setAuthHandler(async (token) => {
    if (token !== 'browser-test-token') return null;
    return { userId, room, runId };
});

let sequence = 0;
let timer;

server.listen(port, () => {
    console.log(`Shotx reconnect test server: http://localhost:${port}`);
    console.log(`Room: ${room}`);
    console.log(`Sending one numbered message every ${intervalMs}ms`);

    timer = setInterval(() => {
        sequence += 1;
        sxServer.to(room).send('numbered-message', {
            runId,
            room,
            number: sequence,
            sentAt: Date.now()
        });
        console.log(`SERVER --> #${sequence}`);
    }, intervalMs);
});

function shutdown() {
    clearInterval(timer);
    sxServer.io.close(() => server.close());
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
