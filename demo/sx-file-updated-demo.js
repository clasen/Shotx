import { createServer } from 'http';
import SxServer from '../server.js';

// ============ Server Setup with New API ============
const server = createServer();
const sxServer = new SxServer({ server });

// Set authentication handler
sxServer.setAuthHandler(async (token, socket) => {
    return token === 'valid' ? { userId: 'user123' } : null;
});

// Custom file handler
sxServer.onFile(async (socket, fileData) => {
    console.log('SERVER --> File received:', {
        name: fileData.name,
        size: fileData.size,
        type: fileData.type,
        room: fileData.room
    });
    
    return { 
        status: 'processed', 
        message: 'File received and processed successfully',
        filename: fileData.name 
    };
});

server.listen(3000, () => {
    console.log('✅ Server running at http://localhost:3000');
    console.log('✅ File API updated with consistent to(room).sendFile() syntax');
    
    // Demo: Send file to room using new consistent API
    setTimeout(() => {
        console.log('\n📡 Demonstrating new API: to(room).sendFile()');
        
        const fileData = {
            name: 'server-announcement.txt',
            size: 45,
            type: 'text/plain',
            lastModified: Date.now(),
            dataUrl: 'data:text/plain;base64,SGVsbG8gZnJvbSBzZXJ2ZXIhIEZpbGUgQVBJIGlzIHJlYWR5IQ=='
        };
        
        // Using the new consistent API
        sxServer.to('announcements').sendFile(fileData);
        console.log('📤 File sent to room "announcements" using to(room).sendFile()');
        
        // Also show that the old method still works for backward compatibility
        sxServer.sendFileToRoom('legacy-room', fileData);
        console.log('📤 File sent to room "legacy-room" using sendFileToRoom()');
        
        console.log('\n✅ Both APIs work - new consistent API preferred!');
        
        setTimeout(() => {
            console.log('✅ Demo completed successfully');
            process.exit(0);
        }, 500);
        
    }, 1000);
});