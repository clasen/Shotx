import SxClient from '../client.js';

const client = new SxClient('http://localhost:3000', {}, { debug: 'debug' });

try {
    const login = await client.connect('valid');
    console.log('CLIENT --> Login:', login);

    // Join room user1
    await client.join('user1');
    console.log('CLIENT --> Joined room: user1');

    // Set up message handlers
    client.onMessage('notification', async (data, socket) => {
        console.log('CLIENT --> Received notification:', data);
    });

    console.log('CLIENT --> Waiting for messages...');

} catch (error) {
    console.error('CLIENT --> ', error.message === 'AUTH_FAIL' ? 'Invalid token' : error.message);
}
