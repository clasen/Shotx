import SxClient from '../client.js';
import { readFileSync } from 'fs';

const client = new SxClient('http://localhost:3000', {}, { debug: 'debug' });

client.connect();

let messageCount = 0;

// Create an interval to send messages every 500ms
setInterval(async () => {
    messageCount++;

    const fileBuffer = readFileSync('file.jpg');

    const response = await client.send('upload', fileBuffer);
    console.log('CLIENT --> Message sent:', response);
}, 500);