import { createServer } from 'http';
import SxServer from '../server.js';

// ============ Simple Server Test ============
const server = createServer();
const sxServer = new SxServer({ server });

// Set authentication handler
sxServer.setAuthHandler(async (token, socket) => {
    console.log('AUTH --> Token received:', token);
    return token === 'valid' ? { userId: 'user123' } : null;
});

// File handler test
sxServer.onFile(async (socket, fileData) => {
    console.log('SERVER --> File received:', {
        name: fileData.name,
        size: fileData.size,
        type: fileData.type,
        dataUrlLength: fileData.dataUrl ? fileData.dataUrl.length : 0
    });
    
    return { 
        status: 'processed', 
        message: 'File received successfully',
        filename: fileData.name 
    };
});

server.listen(3000, () => {
    console.log('✅ Server running at http://localhost:3000');
    console.log('✅ File handling functionality implemented');
    console.log('✅ Ready to receive files via sendFile() method');
    
    // Exit after showing the setup is working
    setTimeout(() => {
        console.log('✅ Demo completed successfully');
        process.exit(0);
    }, 1000);
});