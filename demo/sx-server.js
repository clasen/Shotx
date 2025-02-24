import { createServer } from 'http';
import { SxServer } from '../index.js';

const server = createServer();
const sxServer = new SxServer({ server });

sxServer
    .setAuthHandler(async (token, socket) => {
        return token == 'valid' ? {} : null;
    })
    .onMessage('test_route', async (socket, data) => {
        return { status: 'ok', data, auth: socket.auth };
    });

server.listen(3000, () => {
    console.log('Server running at http://localhost:3000');
});
