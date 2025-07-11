import { createServer } from 'http';
import SxServer from '../server.js';
import SxClient from '../client.js';

// ============ Server Setup with File Routes ============
const server = createServer();
const sxServer = new SxServer({ server });

// Set authentication handler
sxServer.setAuthHandler(async (token, socket) => {
    return token === 'valid' ? { userId: 'user123' } : null;
});

// Register different file handlers for different routes
sxServer.onFile('document_upload', async (socket, fileData, parsedFile) => {
    console.log(`\n📄 Document received on route 'document_upload':`);
    console.log(`   File: ${fileData.name} (${fileData.size} bytes)`);
    console.log(`   Parsed: ${parsedFile ? 'Yes' : 'No'}`);
    
    if (parsedFile) {
        console.log(`   Buffer size: ${parsedFile.buffer.length} bytes`);
        console.log(`   MIME type: ${parsedFile.mimeType}`);
        
        // Save to disk, process, etc.
        console.log(`   💾 Saving document to disk...`);
    }
    
    return { 
        status: 'document_processed',
        filename: fileData.name,
        route: 'document_upload'
    };
});

sxServer.onFile('image_upload', async (socket, fileData, parsedFile) => {
    console.log(`\n🖼️ Image received on route 'image_upload':`);
    console.log(`   File: ${fileData.name} (${fileData.size} bytes)`);
    console.log(`   Parsed: ${parsedFile ? 'Yes' : 'No'}`);
    
    if (parsedFile) {
        console.log(`   Buffer size: ${parsedFile.buffer.length} bytes`);
        console.log(`   MIME type: ${parsedFile.mimeType}`);
        
        // Resize image, generate thumbnails, etc.
        console.log(`   🎨 Processing image...`);
    }
    
    return { 
        status: 'image_processed',
        filename: fileData.name,
        route: 'image_upload'
    };
});

sxServer.onFile('chat_file', async (socket, fileData, parsedFile) => {
    console.log(`\n💬 Chat file received on route 'chat_file':`);
    console.log(`   File: ${fileData.name} (${fileData.size} bytes)`);
    console.log(`   Room: ${fileData.room || 'none'}`);
    
    // Extract room routing info
    const { room, ...cleanFileData } = fileData;
    
    if (room) {
        console.log(`   📤 Broadcasting to room: ${room}`);
        // Send to specific room using the same route
        sxServer.to(room).sendFile('chat_file', cleanFileData);
    }
    
    return { 
        status: 'chat_file_shared',
        filename: fileData.name,
        room: room || null
    };
});

server.listen(3000, () => {
    console.log('✅ Server running at http://localhost:3000');
    console.log('✅ File routes registered:');
    console.log('   - document_upload');
    console.log('   - image_upload');  
    console.log('   - chat_file');
    
    // Start client demo
    setTimeout(() => {
        startClientDemo();
    }, 1000);
});

// ============ Client Demo with File Routes ============
async function startClientDemo() {
    const client = new SxClient();
    
    try {
        // Connect to server
        const login = await client.connect('valid');
        console.log('\n🔌 CLIENT --> Connected:', login);
        
        // Join a room for chat files
        await client.join('file-chat');
        console.log('🏠 CLIENT --> Joined room: file-chat');
        
        // Set up file handlers for different routes
        client.onFile('chat_file', async (socket, fileData, parsedFile) => {
            console.log('\n📥 CLIENT --> Chat file received:', fileData.name);
            if (parsedFile) {
                console.log(`   Buffer size: ${parsedFile.buffer.length} bytes`);
                console.log(`   MIME type: ${parsedFile.mimeType}`);
            }
        });
        
        client.onFile('document_upload', async (socket, fileData, parsedFile) => {
            console.log('\n📥 CLIENT --> Document response:', fileData.name);
        });
        
        // Create mock files
        const textContent = 'Hello, this is a test document!';
        const imageContent = 'fake-image-data';
        
        const mockDocument = {
            name: 'test-document.txt',
            size: textContent.length,
            type: 'text/plain',
            lastModified: Date.now(),
            arrayBuffer: async () => Buffer.from(textContent)
        };
        
        const mockImage = {
            name: 'test-image.jpg',
            size: imageContent.length,
            type: 'image/jpeg',
            lastModified: Date.now(),
            arrayBuffer: async () => Buffer.from(imageContent)
        };
        
        const mockChatFile = {
            name: 'chat-file.txt',
            size: textContent.length,
            type: 'text/plain',
            lastModified: Date.now(),
            arrayBuffer: async () => Buffer.from(textContent)
        };
        
        // Send files to different routes
        setTimeout(async () => {
            console.log('\n📤 CLIENT --> Sending files to different routes...');
            
            try {
                // Send document
                const docResponse = await client.sendFile('document_upload', mockDocument);
                console.log('📄 Document sent:', docResponse);
                
                // Send image
                const imgResponse = await client.sendFile('image_upload', mockImage);
                console.log('🖼️ Image sent:', imgResponse);
                
                // Send chat file to room
                const chatResponse = await client.sendFile('chat_file', mockChatFile, 'file-chat');
                console.log('💬 Chat file sent:', chatResponse);
                
                console.log('\n✅ All files sent successfully!');
                console.log('🎯 Each file was routed to its specific handler');
                
            } catch (error) {
                console.error('❌ Error sending files:', error);
            }
            
            setTimeout(() => {
                console.log('\n✅ Demo completed - file routes working perfectly!');
                process.exit(0);
            }, 1000);
        }, 500);
        
    } catch (error) {
        console.error('❌ CLIENT --> Error:', error.message);
    }
}