import { createServer } from 'http';
import SxServer from '../server.js';
import SxClient from '../client.js';

// ============ Server Setup ============
const server = createServer();
const sxServer = new SxServer({ server });

// Set authentication handler
sxServer.setAuthHandler(async (token, socket) => {
    return token === 'valid' ? { userId: 'user123' } : null;
});

// Optional: Custom file handler
sxServer.onFile(async (socket, fileData) => {
    console.log('SERVER --> File received:', {
        name: fileData.name,
        size: fileData.size,
        type: fileData.type,
        room: fileData.room
    });
    
    // Custom processing - you can save to disk, process, etc.
    if (fileData.room) {
        console.log(`SERVER --> Broadcasting file to room: ${fileData.room}`);
        // File is automatically broadcasted to room by default handler
    }
    
    return { 
        status: 'processed', 
        message: 'File received and processed successfully',
        filename: fileData.name 
    };
});

server.listen(3000, () => {
    console.log('Server running at http://localhost:3000');
    startClientDemo();
});

// ============ Client Demo ============
async function startClientDemo() {
    const client = new SxClient();
    
    try {
        // Connect to server
        const login = await client.connect('valid');
        console.log('CLIENT --> Connected:', login);
        
        // Join a room for file sharing
        await client.join('file-room');
        console.log('CLIENT --> Joined room: file-room');
        
        // Set up file handler
        client.onFile(async (socket, fileData) => {
            console.log('CLIENT --> File received:', {
                name: fileData.name,
                size: fileData.size,
                type: fileData.type,
                from: fileData.room
            });
            
            // You can process the received file here
            // fileData.dataUrl contains the base64 data URL
            console.log('CLIENT --> File data URL length:', fileData.dataUrl.length);
        });
        
        // Simulate file creation and sending
        setTimeout(() => {
            // Create a mock file (in a real app, this would be from input[type=file])
            const mockFileContent = 'Hello, this is a test file content!';
            const mockFile = new Blob([mockFileContent], { type: 'text/plain' });
            
            // Create a file-like object with the necessary properties
            const fileData = {
                name: 'test-file.txt',
                size: mockFileContent.length,
                type: 'text/plain',
                lastModified: Date.now(),
                // Add the blob methods
                stream: mockFile.stream.bind(mockFile),
                arrayBuffer: mockFile.arrayBuffer.bind(mockFile),
                text: mockFile.text.bind(mockFile)
            };
            
            // Send file to the room
            console.log('CLIENT --> Sending file to room...');
            client.sendFile(fileData, 'file-room')
                .then(response => {
                    console.log('CLIENT --> File sent successfully:', response);
                })
                .catch(error => {
                    console.error('CLIENT --> Error sending file:', error);
                });
        }, 1000);
        
    } catch (error) {
        console.error('CLIENT --> Error:', error.message);
    }
}

// ============ Browser Example (for reference) ============
/*
// This is how you would use it in a browser environment:

const client = new SxClient();
await client.connect('valid');
await client.join('file-room');

// Set up file handler
client.onFile(async (socket, fileData) => {
    console.log('File received:', fileData.name);
    
    // Create a download link
    const a = document.createElement('a');
    a.href = fileData.dataUrl;
    a.download = fileData.name;
    a.click();
});

// Handle file input
document.getElementById('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        try {
            const response = await client.sendFile(file, 'file-room');
            console.log('File sent:', response);
        } catch (error) {
            console.error('Error sending file:', error);
        }
    }
});
*/