import SxClient from '../client.js';

const client = new SxClient({ token: 'valid' });
const login = await client.connect();
console.log('CLIENT --> Login:', login);

let messageCount = 0; // Add counter variable

// Create an interval to send messages every 500ms
setInterval(async () => {
    messageCount++; // Increment counter

    const r = await client.send('test_route', {
        messageCount
    });

    console.log('CLIENT --> Message sent:', r);
}, 500);
