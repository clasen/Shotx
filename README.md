# Shotx

🚅 Shotx - Powerful real-time communication library.

Shotx features built-in token-based authentication, asynchronous message handling, and offline message queuing. It’s designed to simplify the development of applications requiring robust, event-driven communication.

## Features

- **Socket Server**: Easily set up a Socket.IO server with custom authentication and message routing.
- **Socket Client**: Connect to a server with built-in support for offline message queuing.
- **Custom Message Handlers**: Register specific handlers for different message types.
- **Asynchronous Authentication**: Use async functions to validate tokens and authorize connections.

## Usage

### Server Setup

The server component creates a Socket.IO server and allows you to set up a custom authentication handler and message handlers.

``` javascript
// server.js
import { createServer } from 'http';
import { SxServer } from 'shotx';

const httpServer = createServer();
const sxServer = new SxServer({ httpServer });
// Set a custom authentication handler and register a 'read' message handler
sxServer
.setAuthHandler(async (token, socket) => {
    // Validate token using your preferred logic or database
    return token == 'valid' ? {} : null;
})
.onMessage('test_route', async (socket, data) => {
    // Handle the "read" message type
    return { status: 'ok', data, auth: socket.auth };
});

httpServer.listen(3000, () => {
    console.log('Server running at http://localhost:3000');
});
```

### Client Setup

The client component manages the socket connection, performs authentication, and queues messages if offline.

``` javascript
import SxClient from 'shotx/client';

const client = new SxClient({ token: 'valid' });

const login = await client.connect();
console.log('Client logged in:', login);
let messageCount = 0;

// Periodically send messages to the server every 500ms
setInterval(async () => {
    messageCount++;

    const response = await client.send('test_route', { messageCount });
    console.log('Message sent:', response);
}, 500);
```


## API Documentation

### SxServer

The `SxServer` class provides a framework for building the server side of your real-time communication system.

**Constructor**
```javascript
new SxServer({ httpServer })
```
- `httpServer` (required): An instance of an HTTP server that Socket.IO will attach to.

**Methods**

- **setAuthHandler(handler: Function): SxServer**  
  Set a custom authentication handler. The function receives the client's token and socket, and should return a truthy value if authentication succeeds.

- **onMessage(type: string, handler: Function): SxServer**  
  Register a handler for a given message type. When a message with a matching type is received, the provided handler function is invoked.

- **setupListeners()**  
  Automatically configures event listeners for client connection, message reception, disconnection, and error handling.

- **handleMessage(socket, message, callback)**  
  Internally processes incoming messages and routes them to the appropriate registered handler.

### SxClient

The `SxClient` class simplifies creating a client that connects to a Shotx server with features like offline queuing and easy message sending.

**Constructor**
```javascript
new SxClient({ url, token })
```

- `url` (optional): The server URL. Defaults to `http://localhost:3000`.
- `token` (optional): The authentication token. Defaults to a generated UUID if not provided.

**Methods**

- **connect(): Promise<any>**  
  Connect to the server. Returns a promise that resolves when the server sends an authentication success event.

- **disconnect()**  
  Disconnects from the server and stops all communication.

- **emit(eventName: string, data: any, meta?: object): Promise<any>**  
  Sends a raw event to the server with optional metadata. If the client is offline, the message is queued.

- **send(type: string, data: any): Promise<any>**  
  A helper method that sets the event name to a default route (usually `message`) and adds a type to the message metadata.


## Contributing

Contributions are welcome! Please open an issue or submit a pull request on GitHub to contribute improvements or fixes.

## License

Shotx is released under the MIT License.