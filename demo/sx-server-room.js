import { createServer } from 'http';
import { SxServer } from '../index.js';

const server = createServer();
const sxServer = new SxServer(server, {}, { debug: 'debug' });

sxServer
    .setAuthHandler(async (token, socket) => {
        return token === 'valid' ? { userId: 'user123' } : null;
    });

let messageCount = 0;

server.listen(3000, () => {
    console.log('Server running at http://localhost:3000');

    // Demo: Send messages to rooms every 2 seconds
    setInterval(() => {
        messageCount++;
        
        // Send message to user1 room  
        sxServer.to('user1').send('notification', { 
            message: `Hello from server! Message #${messageCount}`, 
            timestamp: Date.now(),
            count: messageCount 
        });
        
        console.log(`SERVER --> Sent message #${messageCount} to room 'user1'`);
    }, 2000);
});
