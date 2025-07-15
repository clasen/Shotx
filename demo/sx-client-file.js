import SxClient from '../client.js';
import fs from 'fs';
import path from 'path';

const client = new SxClient();

try {
    const login = await client.connect('valid');
    console.log('CLIENT --> Login:', login);
    await client.join('all');

    client.onFile('picture', async (fileBuffer, data, socket) => {
        // console.log('CLIENT --> Received file:', fileBuffer.toString());
        console.log('CLIENT --> Extra data:', data);
    });

    let count = 0;
    setInterval(() => {
        try {
            // Read the image.png file
            const fileName = 'image.png';
            const imagePath = path.resolve('./',fileName);
            const demoFile = fs.readFileSync(imagePath);

            // Send image file to room 'general'
            client.sendFile('upload', demoFile, {
                count: count++
            });

            console.log(`📤 SERVER --> Sent image.png to room 'general'`);
        } catch (error) {
            console.error('Error sending demo file:', error);
        }
    }, 1000);

} catch (error) {
    console.error('CLIENT --> ', error.message === 'AUTH_FAIL' ? 'Invalid token' : error.message);
}
