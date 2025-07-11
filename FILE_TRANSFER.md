# File Transfer in Shotx

Shotx now supports efficient file transfer between server and client using the same message channel. Files are automatically converted to base64 internally for transmission and converted back to Buffer on receipt.

## Features

- **Efficient Transfer**: Files are converted to base64 for safe transmission over WebSocket
- **Same Channel**: Uses the existing message infrastructure, no additional ports needed
- **Room Support**: Files can be sent to specific rooms and are persisted for offline clients
- **Minimal API**: Simple methods that follow the same pattern as regular messages
- **Type Safety**: Validates that files are proper Buffer objects

## Server API

### `sxServer.onFile(route, handler)`

Register a handler for incoming files from clients.

```javascript
sxServer.onFile('upload', async (fileBuffer, extraData, socket) => {
    console.log(`Received file: ${fileBuffer.length} bytes`);
    console.log('Extra data:', extraData);
    
    // Process file (save to disk, validate, etc.)
    return {
        status: 'received',
        size: fileBuffer.length,
        filename: extraData.filename
    };
});
```

**Parameters:**
- `route` (string): The route identifier for this file type
- `handler` (function): Async function that receives `(fileBuffer, extraData, socket)`
  - `fileBuffer`: Buffer containing the file data
  - `extraData`: Object with additional data sent with the file
  - `socket`: Socket.IO socket object for the client

### `sxServer.to(room).sendFile(route, fileBuffer, extraData)`

Send a file to all clients in a specific room.

```javascript
const fileBuffer = Buffer.from('file content here');
sxServer.to('user-room').sendFile('notification', fileBuffer, {
    filename: 'message.txt',
    timestamp: Date.now()
});
```

**Parameters:**
- `route` (string): The route identifier for this file
- `fileBuffer` (Buffer): The file data as a Buffer
- `extraData` (object): Additional data to send with the file

## Client API

### `sxClient.sendFile(route, fileBuffer, extraData)`

Send a file to the server.

```javascript
const fileBuffer = Buffer.from('file content');
const response = await client.sendFile('upload', fileBuffer, {
    filename: 'document.txt',
    description: 'Important document'
});
```

**Parameters:**
- `route` (string): The route identifier for this file
- `fileBuffer` (Buffer): The file data as a Buffer
- `extraData` (object): Additional data to send with the file

**Returns:** Promise that resolves with the server's response

### `sxClient.onFile(route, handler)`

Register a handler for incoming files from the server.

```javascript
client.onFile('server_notification', async (fileBuffer, extraData, socket) => {
    console.log(`Received file: ${fileBuffer.length} bytes`);
    console.log('Filename:', extraData.filename);
    console.log('Content:', fileBuffer.toString());
});
```

**Parameters:**
- `route` (string): The route identifier for this file type
- `handler` (function): Async function that receives `(fileBuffer, extraData, socket)`

## Usage Examples

### Basic File Upload

**Server:**
```javascript
sxServer.onFile('document', async (fileBuffer, extraData, socket) => {
    // Save file to disk
    const filename = extraData.filename || 'unknown';
    await fs.writeFile(`uploads/${filename}`, fileBuffer);
    
    return {
        status: 'saved',
        filename: filename,
        size: fileBuffer.length
    };
});
```

**Client:**
```javascript
const fileBuffer = fs.readFileSync('document.pdf');
const response = await client.sendFile('document', fileBuffer, {
    filename: 'document.pdf',
    type: 'application/pdf'
});
console.log('Upload response:', response);
```

### Broadcasting Files to Rooms

**Server:**
```javascript
// Send a file to all clients in a room
const announcement = Buffer.from('Important announcement content');
sxServer.to('all-users').sendFile('announcement', announcement, {
    filename: 'announcement.txt',
    priority: 'high',
    timestamp: Date.now()
});
```

**Client:**
```javascript
// Handle broadcast files
client.onFile('announcement', async (fileBuffer, extraData, socket) => {
    console.log('Received announcement:', fileBuffer.toString());
    console.log('Priority:', extraData.priority);
    
    // Process the announcement
    await processAnnouncement(fileBuffer, extraData);
});
```

### Image Upload and Processing

**Server:**
```javascript
sxServer.onFile('profile_picture', async (fileBuffer, extraData, socket) => {
    // Validate image
    if (!extraData.type?.startsWith('image/')) {
        throw new Error('Invalid file type');
    }
    
    // Process image (resize, save, etc.)
    const processedImage = await processImage(fileBuffer);
    
    return {
        status: 'processed',
        originalSize: fileBuffer.length,
        processedSize: processedImage.length,
        userId: socket.auth.userId
    };
});
```

**Client:**
```javascript
const imageBuffer = fs.readFileSync('profile.jpg');
const response = await client.sendFile('profile_picture', imageBuffer, {
    filename: 'profile.jpg',
    type: 'image/jpeg',
    dimensions: { width: 800, height: 600 }
});
console.log('Image processed:', response);
```

## Technical Details

### File Format

Files are transmitted in the following format:
```javascript
{
    meta: {
        type: 'route_name',
        isFile: true,
        id: 'uuid-v7-id'
    },
    data: {
        fileData: 'base64-encoded-file-content',
        extraData: {
            filename: 'example.txt',
            // ... other custom data
        }
    }
}
```

### Conversion Process

1. **Sending**: Buffer → base64 string → transmission
2. **Receiving**: base64 string → Buffer → handler

### Offline Support

Files sent to rooms are persisted when the room is offline and delivered when clients join, just like regular messages.

### Error Handling

The system provides the same error codes as regular messages:
- `2001`: Invalid message format
- `2002`: Invalid message type  
- `2003`: Unknown file route
- `2004`: Error processing file

## Performance Considerations

- Files are base64 encoded, which increases size by ~33%
- Large files should be chunked or handled via separate upload endpoints
- Consider file size limits in your application logic
- Base64 encoding/decoding is CPU intensive for large files

## Best Practices

1. **Validate file types** in your handlers
2. **Set size limits** to prevent abuse
3. **Use meaningful route names** for different file types
4. **Include metadata** in extraData for better processing
5. **Handle errors gracefully** with try-catch blocks
6. **Consider chunking** for files larger than 10MB

## Running the Examples

1. Start the server demo: `node demo/sx-server-file.js`
2. Start the client demo: `node demo/sx-client-file.js`
3. Watch the console for file transfer logs

The examples demonstrate bidirectional file transfer with different file types and use cases.