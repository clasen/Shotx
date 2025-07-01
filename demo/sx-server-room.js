import { createServer } from 'http';
import { SxServer } from '../index.js';

const server = createServer();
const sxServer = new SxServer({ server });

sxServer
    .setAuthHandler(async (token, socket) => {
        return token == 'valid' ? {} : null;
    })

let messageCount = 0;
server.listen(3000, () => {
    console.log('Server running at http://localhost:3000');

    // Demo: Send messages to rooms every 1 seconds
    setInterval(() => {

        // Send message to user2 room  
        sxServer.to('user1').send('join_route', { message: 'Hello user2!', count: messageCount++ });
    }, 1000);
});
