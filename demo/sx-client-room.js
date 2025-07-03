import { SxClient } from '../index.js';

const client = new SxClient();

try {
    const login = await client.connect('valid');
    console.log('CLIENT --> Login:', login);

    // Join room user1
    await client.join('user1');
    console.log('CLIENT --> Joined room: user1');

    // Set up message handlers
    client.onMessage('notification', async (socket, data) => {
        console.log('CLIENT --> Received notification:', data);
    });

    console.log('CLIENT --> Waiting for messages...');

} catch (error) {
    console.error('CLIENT --> ', error.message === 'AUTH_FAIL' ? 'Invalid token' : error.message);
}
