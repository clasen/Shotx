import { SxClient } from '../index.js';

const client = new SxClient();

try {
    const login = await client.connect('valid');
    console.log('CLIENT --> Login:', login);

} catch (error) {
    console.error('CLIENT --> ', error.message === 'AUTH_FAIL' ? 'Invalid token' : error.message);
}

let messageCount = 0;

// Create an interval to send messages every 500ms
setInterval(async () => {
    messageCount++;

    const response = await client.send('test_route', { messageCount });
    console.log('CLIENT --> Message sent:', response);
}, 500);