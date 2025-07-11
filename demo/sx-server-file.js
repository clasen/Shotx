import { createServer } from 'http';
import { readFileSync } from 'fs';
import SxServer from '../server.js';

const server = createServer();
const sxServer = new SxServer({ server });

// Set authentication handler
sxServer.setAuthHandler(async (token, socket) => {
    return token === 'valid' ? { userId: 'user123' } : null;
});

// Handle file uploads
sxServer.onFile('upload', async (fileBuffer, extraData, socket) => {
    console.log(`📁 SERVER --> Received file upload: ${fileBuffer.length} bytes`);
    console.log(`📁 SERVER --> Extra data:`, extraData);
    
    // Process the file (save to disk, validate, etc.)
    // For demo, just return file info
    return {
        status: 'received',
        size: fileBuffer.length,
        filename: extraData.filename || 'unknown',
        uploadedBy: socket.auth.userId
    };
});

// Handle profile picture uploads
sxServer.onFile('profile_picture', async (fileBuffer, extraData, socket) => {
    console.log(`🖼️ SERVER --> Received profile picture: ${fileBuffer.length} bytes`);
    console.log(`🖼️ SERVER --> User: ${socket.auth.userId}`);
    
    // In a real app, you'd save this to a storage service
    return {
        status: 'profile_updated',
        size: fileBuffer.length,
        userId: socket.auth.userId
    };
});

// Regular message handler
sxServer.onMessage('test_message', async (socket, data) => {
    console.log(`💬 SERVER --> Received message:`, data);
    return { echo: data, timestamp: Date.now() };
});

server.listen(3000, () => {
    console.log('🚀 Server running at http://localhost:3000');
    console.log('📁 File handling enabled');
    
    // Demo: Send a file to all clients in a room every 10 seconds
    setInterval(() => {
        try {
            // Create a simple text file buffer
            const demoFile = Buffer.from(`Hello from server! Time: ${new Date().toISOString()}`);
            
            // Send file to room 'general'
            sxServer.to('general').sendFile('server_notification', demoFile, {
                filename: 'server_message.txt',
                timestamp: Date.now(),
                message: 'This is a demo file from server'
            });
            
            console.log(`📤 SERVER --> Sent demo file to room 'general'`);
        } catch (error) {
            console.error('Error sending demo file:', error);
        }
    }, 10000);
});