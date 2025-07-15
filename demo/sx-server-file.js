import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import SxServer from '../server.js';

const server = createServer();
const sxServer = new SxServer({ server });

// Create uploads directory if it doesn't exist
const uploadsDir = join(process.cwd(), 'uploads');
if (!existsSync(uploadsDir)) {
    mkdirSync(uploadsDir, { recursive: true });
}

// Set authentication handler
sxServer.setAuthHandler(async (token, socket) => {
    return token === 'valid' ? { userId: 'user123' } : null;
});

server.listen(3000, () => {
    console.log('🚀 Server running at http://localhost:3000');
    console.log('📁 File handling enabled');
    console.log(`💾 Files will be saved to: ${uploadsDir}`);

    const file = readFileSync('./image.png');
    console.log(file)
    sxServer.to('all').sendFile('upload', file);

    sxServer.onFile('upload', async (fileBuffer, data, socket) => {
        try {
            // Generate unique filename
            const timestamp = Date.now();
            const filename = `upload_${timestamp}`;
            const uniqueFilename = `${filename}.${data.meta.extension}`;
            const filePath = join(uploadsDir, uniqueFilename);

            // Save file to disk
            writeFileSync(filePath, fileBuffer);

            console.log('SERVER --> File saved successfully!');
            console.log('SERVER --> Extra data:', data);
            console.log(`SERVER --> Saved to: ${filePath}`);
            console.log(`SERVER --> File size: ${fileBuffer.length} bytes`);

        } catch (error) {
            console.error('SERVER --> Error saving file:', error);
        }
    });

    // Demo: Send a file to all clients in a room every 10 seconds
    let count = 0;
    setInterval(() => {
        try {
            // Create a simple text file buffer
            const demoFile = Buffer.from(`Hello from server! Time: ${new Date().toISOString()}`);

            // Send file to room 'general'
            sxServer.to('general').sendFile('upload', demoFile, {
                count: count++,
                filename: 'server_message.txt',
                timestamp: Date.now(),
                message: 'This is a demo file from server'
            });

            console.log(`📤 SERVER --> Sent demo file to room 'general'`);
        } catch (error) {
            console.error('Error sending demo file:', error);
        }
    }, 1000);
});