import { createServer } from 'http';
import SxServer from '../server.js';

// ============ Clean File Handling Demo ============
const server = createServer();
const sxServer = new SxServer({ server });

// Set authentication handler
sxServer.setAuthHandler(async (token, socket) => {
    return token === 'valid' ? { userId: 'user123' } : null;
});

// Clean file handler that separates file properties from routing info
sxServer.onFile(async (socket, fileData) => {
    console.log('\n📁 File received from client');
    
    // Separate file properties from routing information
    const { room, ...fileProperties } = fileData;
    
    console.log('📋 File properties:', {
        name: fileProperties.name,
        size: fileProperties.size,
        type: fileProperties.type,
        lastModified: fileProperties.lastModified,
        dataUrlLength: fileProperties.dataUrl?.length || 0
    });
    
    console.log('📍 Routing info:', { room: room || 'none' });
    
    // Process the file (save to disk, database, etc.)
    console.log('💾 Processing file...');
    
    // Decide where to send the file based on your business logic
    if (room) {
        console.log(`📤 Client requested broadcast to room: ${room}`);
        // Send only file properties, not routing info
        sxServer.to(room).sendFile(fileProperties);
    } else {
        console.log('📤 No room specified, broadcasting to all users');
        // Could broadcast to a default room or handle differently
        sxServer.to('general').sendFile(fileProperties);
    }
    
    return { 
        status: 'processed', 
        message: 'File received and processed successfully',
        filename: fileProperties.name,
        broadcastedTo: room || 'general'
    };
});

server.listen(3000, () => {
    console.log('✅ Server running at http://localhost:3000');
    console.log('✅ Clean file handling with separated routing info');
    
    // Demo: Send clean file data to room (without routing info mixed in)
    setTimeout(() => {
        console.log('\n📡 Server sending clean file to room');
        
        const cleanFileData = {
            // Only file properties, no routing info
            name: 'server-document.pdf',
            size: 2048,
            type: 'application/pdf',
            lastModified: Date.now(),
            dataUrl: 'data:application/pdf;base64,JVBERi0xLjQKJeIkdGVzdA=='
        };
        
        // Clean API: routing is separate from file data
        sxServer.to('documents').sendFile(cleanFileData);
        console.log('📤 Clean file sent to "documents" room');
        console.log('🎯 File data contains only file properties, no routing info');
        
        setTimeout(() => {
            console.log('\n✅ Demo completed - routing info separated from file properties!');
            process.exit(0);
        }, 500);
        
    }, 1000);
});