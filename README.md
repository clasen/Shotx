# Shotx

🚅 Shotx - Powerful real-time communication library.

Shotx features built-in token-based authentication, asynchronous message handling, offline message queuing, and room-based communication. It's designed to simplify the development of applications requiring robust, event-driven communication.

## Features

- **Socket Server**: Easily set up a Socket.IO server with custom authentication and message routing.
- **Socket Client**: Connect to a server with built-in support for offline message queuing and auto-reconnection.
- **Room Support**: Join/leave rooms with automatic message persistence for offline clients.
- **Custom Message Handlers**: Register specific handlers for different message types.
- **Asynchronous Authentication**: Use async functions to validate tokens and authorize connections.
- **Message Persistence**: Offline messages are queued and delivered when clients reconnect.


## Usage

### Server Setup

The server component creates a Socket.IO server and allows you to set up a custom authentication handler and message handlers.

```javascript
// server.js
import { createServer } from 'http';
import SxServer from 'shotx/server';

const server = createServer();
const sxServer = new SxServer({ server });

// Set a custom authentication handler and register message handlers
sxServer
    .setAuthHandler(async (token, socket) => {
        // Validate token using your preferred logic or database
        return token === 'valid' ? { userId: 'user123' } : null;
    })
    .onMessage('test_route', async (data, socket) => {
        // Handle the "test_route" message type
        return { status: 'ok', data, auth: socket.auth };
    });

server.listen(3000, () => {
    console.log('Server running at http://localhost:3000');
});
```

### Client Setup

The client component manages the socket connection, performs authentication, and queues messages if offline.

``` javascript
import SxClient from 'shotx/client';

const client = new SxClient();

try {
    const login = await client.connect('valid');
    console.log('CLIENT --> Login:', login); // { userId: 'user123' }
} catch (error) {
    console.error('CLIENT --> ', error.message === 'AUTH_FAIL' ? 'Invalid token' : error.message);
}

let messageCount = 0;

// Periodically send messages to the server every 500ms
setInterval(async () => {
    messageCount++;

    const response = await client.send('test_route', { messageCount });
    console.log('Message sent:', response);
}, 500);
```

### Room-based Communication

Shotx supports room-based communication with message persistence for offline clients.

#### Server with Rooms

```javascript
import { createServer } from 'http';
import SxServer from 'shotx/server';

const server = createServer();
const sxServer = new SxServer({ server });

sxServer.setAuthHandler(async (token, socket) => {
    return token === 'valid' ? { userId: 'user123' } : null;
});

server.listen(3000, () => {
    console.log('Server running at http://localhost:3000');

    // Send messages to specific rooms
    setInterval(() => {
        // Messages are persisted if room is offline
        sxServer.to('user-room').send('notification', { 
            message: 'Hello from server!', 
            timestamp: Date.now() 
        });
    }, 5000);
});
```

#### Client with Rooms

```javascript
import SxClient from 'shotx/client';

const client = new SxClient();

try {
    const login = await client.connect('valid');
    console.log('CLIENT --> Login:', login);

    // Join a room
    await client.join('user-room');
    console.log('CLIENT --> Joined room: user-room');

    // Set up message handlers for specific routes
    client.onMessage('notification', async (data, socket) => {
        console.log('CLIENT --> Received notification:', data);
    });

} catch (error) {
    console.error('CLIENT --> Error:', error.message);
}
```

## API Documentation

### SxServer

The `SxServer` class provides a framework for building the server side of your real-time communication system.

**Constructor**
```javascript
new SxServer({ server, opts })
```
- `server` (required): An instance of an HTTP(s) server that Socket.IO will attach to.
- `opts` (optional): Socket.IO server options. CORS is configured by default to allow all origins.

**Methods**

- **setAuthHandler(handler: Function): SxServer**  
  Set a custom authentication handler. The function receives the client's token and socket, and should return a truthy value if authentication succeeds, or null/falsy if it fails.

- **onMessage(type: string, handler: Function): SxServer**  
  Register a handler for a given message type. When a message with a matching type is received, the provided handler function is invoked with `(data, socket)` parameters.

- **to(room: string): Object**  
  Returns an object with a `send` method to send messages to a specific room. Messages are persisted if the room is offline and delivered when clients join.

- **setupListeners()**  
  Automatically configures event listeners for client connection, message reception, disconnection, and error handling. Called automatically in constructor.

- **handleMessage(socket, message, callback)**  
  Internally processes incoming messages and routes them to the appropriate registered handler.

**Built-in Message Types**
- `sx_join`: Handles room joining (automatically registered)
- `sx_leave`: Handles room leaving (automatically registered)

### SxClient

The `SxClient` class simplifies creating a client that connects to a Shotx server with features like offline queuing, auto-reconnection, and room management.

**Constructor**
```javascript
new SxClient({ url })
```

- `url` (optional): The server URL. Defaults to `http://localhost:3000`.

**Methods**

- **connect(token?: string): Promise<any>**  
  Connect to the server with the provided token. If no token is provided, generates a UUID. Returns a promise that resolves when authentication succeeds.

- **disconnect()**  
  Disconnects from the server and stops all communication.

- **emit(eventName: string, data: any, meta?: object): Promise<any>**  
  Sends a raw event to the server with optional metadata. If the client is offline, the message is queued and sent when reconnected.

- **send(type: string, data: any): Promise<any>**  
  A helper method that sends a message with the specified type. This is the primary method for sending typed messages.

- **join(room: string): Promise<any>**  
  Join a specific room. The client will automatically rejoin this room if disconnected and reconnected.

- **leave(room: string): Promise<any>**  
  Leave a specific room. The client will no longer automatically rejoin this room on reconnection.

- **onMessage(route: string, handler: Function): void**  
  Register a handler for incoming messages of a specific type. The handler receives `(data, socket)` parameters.

**Auto-reconnection Features**
- Automatic reconnection with exponential backoff
- Automatic rejoining of previously joined rooms
- Automatic processing of queued offline messages
- Persistent room membership across reconnections

## Message Format

All messages use a standardized format:

```javascript
{
    meta: {
        type: 'message_type',
        id: 'uuid-v7-generated-id',
        success: true/false,    // Only in responses
        code: 2001,            // Only in error responses
        error: 'error message' // Only in error responses
    },
    data: {
        // Your actual message data
    }
}
```

## Error Codes

- `2001`: Invalid message format
- `2002`: Invalid message type
- `2003`: Unknown message type
- `2004`: Error processing message
- `AUTH_NULL`: No authentication token provided
- `AUTH_FAIL`: Invalid authentication credentials
- `AUTH_ERROR`: Authentication process error

## Examples

### Basic Client-Server Communication

See `demo/sx-server.js` and `demo/sx-client.js` for basic examples.

### Room-based Communication

See `demo/sx-server-room.js` and `demo/sx-client-room.js` for room-based examples.

## Dependencies

- `socket.io`: WebSocket communication
- `socket.io-client`: Client-side WebSocket communication
- `deepbase`: Message persistence for offline rooms
- `lemonlog`: Structured logging
- `uuid`: UUID generation for message IDs

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on GitHub to contribute improvements or fixes.

## License

Shotx is released under the MIT License.