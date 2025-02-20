import SxClient from '../client.js';

const client = new SxClient();
try {
    const login = await client.connect('valid');
    console.log('CLIENT --> Login:', login);

} catch (error) {
    console.error('CLIENT --> ', error.message == 'AUTH_FAIL' ? 'Invalid token' : error.message);
}

let messageCount = 0; // Add counter variable

// Create an interval to send messages every 500ms
setInterval(async () => {
    messageCount++; // Increment counter

    const r = await client.send('test_route', {
        messageCount
    });

    console.log('CLIENT --> Message sent:', r);
}, 500);