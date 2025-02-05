import { createServer } from 'http';
import { SxServer } from '../index.mjs';

const httpServer = createServer();
const sxServer = new SxServer({ httpServer });

sxServer
    .setAuthHandler(async (token, socket) => {
        return token == 'valid' ? {} : null;
    })
    .onMessage('test_route', async (socket, data) => {
        return { status: 'ok', data, auth: socket.auth };
    });

httpServer.listen(3000, () => {
    console.log('Server running at http://localhost:3000');
});
