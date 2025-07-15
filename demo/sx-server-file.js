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

    sxServer.onMessage('audio', async (data, socket) => {
        try {
            // Generate unique filename
            const timestamp = Date.now();
            const filename = `upload_${timestamp}`;
            const uniqueFilename = `${filename}.wav`;
            const filePath = join(uploadsDir, uniqueFilename);

            // Save file to disk
            writeFileSync(filePath, data);

            console.log('SERVER --> File saved successfully!');
            console.log('SERVER --> Extra data:', data);
            console.log(`SERVER --> Saved to: ${filePath}`);
            console.log(`SERVER --> File size: ${data.length} bytes`);

        } catch (error) {
            console.error('SERVER --> Error saving file:', error);
        }
    });
});