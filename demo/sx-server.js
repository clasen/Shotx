import { createServer } from 'http';
import { resolve } from 'node:path';
import { SxServer } from '../index.js';

const server = createServer();
const sxServer = new SxServer(server, {}, {
    debug: 'debug',
    path: resolve(import.meta.dirname, '..', 'db')
});

sxServer
    // .setAuthHandler(async (token, socket) => {
    //     // Return user data if token is valid, null otherwise
    //     return token === 'valid' ? { userId: 'user123' } : null;
    // })
    .onMessage('test_route', async (data, socket) => {
        return { status: 'ok', data, auth: socket.auth };
    });

server.listen(3000, () => {
    console.log('Server running at http://localhost:3000');
});
