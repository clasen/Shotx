import SxClient from '../client.js';

const client = new SxClient();
try {
    const login = await client.connect('valid');
    console.log('CLIENT --> Login:', login);

    console.log('started...');
    // Join room user1
    await client.join('user1');
    console.log('CLIENT --> Joined room: user1');

    // Set up message handlers
    client.onMessage('join_route', async (socket, data) => {
        console.log('CLIENT --> Received join_route message:', socket.id, data);
    });

} catch (error) {
    console.error('CLIENT --> ', error.message == 'AUTH_FAIL' ? 'Invalid token' : error.message);
}
