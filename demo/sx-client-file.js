import SxClient from '../client.js';

const client = new SxClient();

// Handle incoming files from server
client.onFile('server_notification', async (fileBuffer, extraData, socket) => {
    console.log(`📁 CLIENT --> Received file from server: ${fileBuffer.length} bytes`);
    console.log(`📁 CLIENT --> Filename: ${extraData.filename}`);
    console.log(`📁 CLIENT --> Content: ${fileBuffer.toString()}`);
    console.log(`📁 CLIENT --> Extra data:`, extraData);
});

// Handle profile picture confirmations
client.onFile('profile_updated', async (fileBuffer, extraData, socket) => {
    console.log(`🖼️ CLIENT --> Profile picture updated confirmation`);
    console.log(`🖼️ CLIENT --> Data:`, extraData);
});

// Handle regular messages
client.onMessage('test_response', async (socket, data) => {
    console.log(`💬 CLIENT --> Received message response:`, data);
});

try {
    // Connect to server
    const login = await client.connect('valid');
    console.log('🔐 CLIENT --> Login successful:', login);

    // Join a room to receive server file broadcasts
    await client.join('general');
    console.log('🏠 CLIENT --> Joined room: general');

    // Send a regular message
    const messageResponse = await client.send('test_message', { 
        text: 'Hello from client!',
        timestamp: Date.now() 
    });
    console.log('💬 CLIENT --> Message sent:', messageResponse);

    // Send a file upload
    const uploadFile = Buffer.from('This is a test file content from client');
    const uploadResponse = await client.sendFile('upload', uploadFile, {
        filename: 'test_upload.txt',
        description: 'Test file upload',
        category: 'document'
    });
    console.log('📤 CLIENT --> File upload response:', uploadResponse);

    // Send a profile picture (simulate image data)
    const profilePic = Buffer.from('fake_image_data_here_would_be_actual_image_bytes');
    const profileResponse = await client.sendFile('profile_picture', profilePic, {
        filename: 'profile.jpg',
        size: profilePic.length,
        type: 'image/jpeg'
    });
    console.log('🖼️ CLIENT --> Profile picture response:', profileResponse);

    // Send files periodically
    let fileCount = 0;
    setInterval(async () => {
        fileCount++;
        const periodicFile = Buffer.from(`Periodic file #${fileCount} - ${new Date().toISOString()}`);
        
        try {
            const response = await client.sendFile('upload', periodicFile, {
                filename: `periodic_${fileCount}.txt`,
                sequence: fileCount,
                type: 'periodic'
            });
            console.log(`📤 CLIENT --> Periodic file #${fileCount} sent:`, response);
        } catch (error) {
            console.error(`❌ CLIENT --> Error sending periodic file #${fileCount}:`, error.message);
        }
    }, 7000);

} catch (error) {
    console.error('❌ CLIENT --> Connection error:', error.message);
}