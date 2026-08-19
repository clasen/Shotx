# Shotx

🚅 Shotx - Powerful real-time communication library.

Shotx features built-in token-based authentication, asynchronous message handling, offline message queuing, and room-based communication. It's designed to simplify the development of applications requiring robust, event-driven communication.

## Features

- **Socket Server**: Easily set up a Socket.IO server with custom authentication and message routing.
- **Socket Client**: Connect to a server with built-in support for offline message queuing and auto-reconnection.
- **Room Support**: Join/leave rooms with automatic message persistence for offline clients.
- **Custom Message Handlers**: Register specific handlers for different message types.
- **Asynchronous Authentication**: Use async functions to validate tokens and authorize connections.
- **Message Persistence**: Offline messages are queued and delivered when clients reconnect. In browser environments, messages are persisted using IndexedDB for durability across page reloads.
- **Timeouts**: Configurable timeouts for connection and messages, with global defaults and per-call overrides.


## Usage

### Browser close/reopen persistence test

The repository includes a browser scenario that sends numbered messages to the authenticated user's room and checks that the sequence remains complete after the tab is closed and reopened.

Run these commands in separate terminals:

```bash
npm run test:browser:server
npm run test:browser:ui
```

Open `http://127.0.0.1:3001/room-reconnect.html`, wait for a few messages, close the tab, wait a few seconds, and open the same URL again. The page persists the received sequence in `localStorage` and reports `PASS` only when there are no gaps after reopening.

### Server Setup

The server component creates a Socket.IO server and allows you to set up a custom authentication handler and message handlers.

```javascript
// server.js
import { createServer } from 'http';
import SxServer from 'shotx/server';

const server = createServer();
const sxServer = new SxServer(server);

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
const sxServer = new SxServer(server);

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

#### Reliable Delivery (Optional)

Reliable delivery is enabled independently on each sender and defaults to `false`. Enabling it on `SxServer` protects server-to-client room messages. Enabling it on `SxClient` protects client-to-server application messages. Receiving reliable messages is automatic and does not require enabling the receiving side.

Enable both instances for bidirectional delivery. The existing `send()` methods are used without adding another public method:

```javascript
const sxServer = new SxServer(server, {}, {
    reliable: { enabled: true }
});

const client = new SxClient('http://localhost:3000', {}, {
    reliable: { enabled: true }
});

await client.connect('valid');
client.onMessage('notification', async (data) => applyNotification(data));
await client.join('user-room');
```

With only the server enabled, delivery is reliable only from server to client. With only the client enabled, delivery is reliable only from client to server. The server retains messages and cached acknowledgements for 24 hours, up to 10,000 entries per stream, unless `retentionMs` or `maxMessagesPerRoom` overrides those defaults.

In browsers, Shotx generates a UUIDv7 client ID and persists it in IndexedDB by server URL. An explicit, non-secret ID overrides the generated one when separate logical consumers are needed:

```javascript
const client = new SxClient('http://localhost:3000', {}, {
    reliable: { enabled: true, id: 'user-123-device-1' }
});
```

For server-to-client delivery, the cursor advances only after the client message handler resolves. A new consumer without a saved cursor receives the currently retained room history. Non-browser consumers can restore a durable cursor explicitly with `join(room, { afterSeq })`.

For client-to-server delivery, the client persists each application message before sending it. The server processes messages in sequence and persists the handler response before acknowledging them. If the connection closes after the handler runs but before the acknowledgement arrives, the client resends the same UUIDv7 and sequence; the server returns the stored response without running the handler again. Internal Shotx control messages are not part of the application sequence.

Each logical consumer tracks a broadcast room independently; one consumer's progress never acknowledges messages for another. Browser clients using the generated ID share one logical installation per server URL. Broadcast subscribers and authenticated users that must advance independently should configure distinct `reliable.id` values. A server can additionally provide `reliable.identity(auth, socket)` to scope client sequences by authenticated principal even when its own `enabled` flag is `false`. The identity must be stable and non-secret; never use or persist the authentication token itself. In Node.js, an explicit ID lets a recreated client adopt the server's next sequence when no messages are pending, but the in-memory outbox does not survive a process crash. If a cursor falls outside retained history, Shotx reports `RELIABLE_RESYNC_REQUIRED`; normal gaps inside retention are replayed transparently.

Reliable delivery provides ordered at-least-once transport with deduplication inside the configured retention window. It cannot make arbitrary external side effects exactly-once across a process crash; handlers that call an external system should pass `meta.id` as that system's idempotency key. Reliable storage currently requires a single `SxServer` writer for the DeepBase file. Multi-process deployments need a shared transactional sequence, inbox, and room log store.

## API Documentation

### SxServer

The `SxServer` class provides a framework for building the server side of your real-time communication system.

**Constructor**
```javascript
new SxServer(server, opts, { auto404, debug, reliable })
```
- `server` (required): An instance of an HTTP(s) server that Socket.IO will attach to.
- `opts` (optional): Socket.IO server options. CORS is configured by default to allow all origins.
- `auto404` (optional): Automatically respond with 404 to non-Shotx HTTP requests. Defaults to `true`.
- `debug` (optional): Log level for the server instance. Defaults to `'none'`. See [Logging](#logging).
- `reliable` (optional): Reliable configuration for messages sent by this server. `enabled` defaults to `false`. `retentionMs` defaults to 24 hours and `maxMessagesPerRoom` defaults to 10,000; both also govern cached responses for reliable clients. Optional `identity(auth, socket)` scopes incoming client sequences by authenticated principal.

**Methods**

- **setAuthHandler(handler: Function): SxServer**  
  Set a custom authentication handler. The function receives the client's token and socket, and should return a truthy value if authentication succeeds, or null/falsy if it fails.

- **onMessage(type: string, handler: Function): SxServer**
  Register a handler for a given message type. When a message with a matching type is received, the provided handler function is invoked with `(data, socket, meta)` parameters.

- **to(room: string): Object**  
  Returns an object with the existing `send` method. When reliable delivery is enabled on the server, `send` returns a promise and persists a sequenced message before emitting it. Otherwise, it retains the legacy offline-room behavior.

- **setupListeners()**  
  Automatically configures event listeners for client connection, message reception, disconnection, and error handling. Called automatically in constructor.

- **handleMessage(socket, message, callback)**  
  Internally processes incoming messages and routes them to the appropriate registered handler.

**Built-in Message Types**
- `sx_join`: Handles room joining (automatically registered)
- `sx_leave`: Handles room leaving (automatically registered)
- `sx_replay`: Replays reliable room messages from a requested sequence (automatically used by the client)
- `sx_reliable_ready`: Announces the server-side client sequence when the connecting client enables reliable delivery (automatically used by the client)

### SxClient

The `SxClient` class simplifies creating a client that connects to a Shotx server with features like offline queuing, auto-reconnection, and room management.

**Constructor**
```javascript
new SxClient(url, opts, { debug, timeout, reliable })
```
- `url` (optional): The server URL. Defaults to `http://localhost:3000`.
- `opts` (optional): Socket.IO client options.
- `debug` (optional): Log level for the client instance. Defaults to `'none'`. See [Logging](#logging).
- `timeout` (optional): Default timeout in milliseconds for `connect()` and `send()` calls. `0` disables timeouts. Defaults to `0`.
- `reliable` (optional): Reliable configuration for messages sent by this client. `enabled` defaults to `false`; `id` optionally overrides the generated logical client identity. Browsers persist the generated ID with the outbound outbox; Node.js generates one for the current instance. Receiving reliable server messages is automatic regardless of this flag.

**Methods**

- **connect(token?: string, opts?: { timeout?: number }): Promise<any>**  
  Connect to the server with the provided token. If no token is provided, generates a UUID. Returns a promise that resolves when authentication succeeds. Rejects with `TIMEOUT` error if `timeout` ms elapse before auth succeeds.

- **disconnect()**  
  Disconnects from the server and stops all communication.

- **emit(eventName: string, data: any, meta?: object, opts?: { timeout?: number }): Promise<any>**  
  Sends a raw event to the server with optional metadata. If the client is offline, the message is queued and sent when reconnected (timeout does not apply to queued messages).

- **send(type: string, data: any, opts?: { timeout?: number }): Promise<any>**  
  A helper method that sends a message with the specified type. When reliable delivery is enabled on the client, application messages are persisted, sequenced, replayed, and deduplicated automatically. Supports per-call timeout override; timing out the caller does not discard an already persisted reliable message.

- **join(room: string, opts?: { afterSeq?: number }): Promise<any>**
  Join a specific room. The client automatically sends its reliable cursor and rejoins after reconnection. `afterSeq` restores a cursor explicitly.

- **leave(room: string): Promise<any>**  
  Leave a specific room. The client will no longer automatically rejoin this room on reconnection.

- **onMessage(route: string, handler: Function): void**  
  Register a handler for incoming messages of a specific type. The handler receives `(data, socket, meta)` parameters. Reliable metadata includes the UUIDv7 `id`, room `stream`, and integer `seq`.

**Auto-reconnection Features**
- Automatic reconnection with exponential backoff
- Automatic rejoining of previously joined rooms
- Automatic processing of queued offline messages
- Persistent room membership across reconnections

### Timeouts

Timeouts prevent promises from hanging indefinitely when the server doesn't respond. Set a global default in the constructor or override per call.

```javascript
// Global default: all calls timeout after 10s
const client = new SxClient('http://localhost:3000', {}, { timeout: 10000 });

await client.connect('my-token');                        // uses 10s default
await client.send('my_route', data);                     // uses 10s default
await client.send('slow_route', data, { timeout: 30000 }); // override: 30s
await client.send('critical', data, { timeout: 0 });    // no timeout for this call
```

**Behavior:**

| Situation | What happens |
|---|---|
| Offline | Message is queued. Timeout does **not** apply. |
| Online, response in time | Promise resolves with data. |
| Online, no response in time | Promise rejects with `TIMEOUT` error. Message was already sent — it is **not** re-queued. |

Timeout errors follow the format `TIMEOUT: <type> (<ms>ms)` for easy identification:

```javascript
try {
    await client.send('slow_route', data, { timeout: 5000 });
} catch (err) {
    console.log(err.message); // "TIMEOUT: slow_route (5000ms)"
}
```

## Message Format

All messages use a standardized format:

```javascript
{
    meta: {
        type: 'message_type',
        id: 'uuid-v7-generated-id',
        stream: 'room-or-client-id', // Reliable messages only
        seq: 7,                       // Reliable messages only
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
- `RELIABLE_REPLAY_REQUIRED`: The server is missing an earlier client sequence and requests replay
- `RELIABLE_RESYNC_REQUIRED`: A room cursor or cached client response is outside the retention window
- `RELIABLE_SEQUENCE_CONFLICT`: A client sequence was reused with a different message ID
- `RELIABLE_ID_REQUIRED`: A reliable client did not provide its logical client ID during authentication
- `RELIABLE_IDENTITY_REQUIRED`: `reliable.identity` did not return a stable authenticated identity
- `RELIABLE_CONFIG_INVALID`: A client sent an invalid reliable handshake option
- `RELIABLE_UNSUPPORTED`: A client enabled reliable sending but the server did not negotiate support
- `AUTH_NULL`: No authentication token provided
- `AUTH_FAIL`: Invalid authentication credentials
- `AUTH_ERROR`: Authentication process error

## Logging

Shotx uses [LemonLog](https://www.npmjs.com/package/lemonlog) for structured logging. By default, logging is set to `'none'` (silent). You can enable it by passing a `debug` level to the constructor.

**Available log levels** (from most to least verbose):

| Level   | Description                          |
|---------|--------------------------------------|
| `debug` | All logs including debug details     |
| `info`  | Informational messages and above     |
| `warn`  | Warnings and errors only             |
| `error` | Errors only                          |
| `none`  | Silent (default)                     |

**Enabling logs on the server:**

```javascript
const sxServer = new SxServer(server, {}, { debug: 'info' });
```

**Enabling logs on the client:**

```javascript
const client = new SxClient('http://localhost:3000', {}, { debug: 'info' });
```

**Important:** LemonLog is built on top of the [debug](https://www.npmjs.com/package/debug) package, so you also need to set the `DEBUG` environment variable to see the output:

```bash
# Enable all Shotx logs
DEBUG=Sx* node your-app.js

# Enable only server logs
DEBUG=SxServer* node your-app.js

# Enable only client logs
DEBUG=SxClient* node your-app.js
```

In browser environments, set `localStorage.debug` instead:

```javascript
localStorage.debug = 'Sx*';
```

The log instance is also accessible as `this.log` on both `SxServer` and `SxClient` instances, in case you need to log from outside the class:

```javascript
const sxServer = new SxServer(server, {}, { debug: 'info' });
sxServer.log.info('Custom log message');
```

## Examples

### Basic Client-Server Communication

See `demo/sx-server.js` and `demo/sx-client.js` for basic examples.

### Room-based Communication

See `demo/sx-server-room.js` and `demo/sx-client-room.js` for room-based examples.

## Demo Usage

The `demo/` directory contains working examples:

### Node.js Demo
- **sx-server.js**: Basic server setup with token validation and test_route handler
- **sx-client.js**: Client that connects and sends periodic messages
- Run server first, then client to see real-time communication

### Browser Demo (IndexedDB Testing)
- **index.html**: Interactive web interface to test IndexedDB persistence
- **package.json**: Vite configuration for browser testing

To test IndexedDB persistence in browser:

1. **Start the demo server:**
   ```bash
   DEBUG=Sx* node demo/sx-server.js
   ```

2. **Install dependencies and start Vite dev server:**
   ```bash
   cd demo
   npm install
   npm run dev
   ```

3. **Test offline persistence:**
   - Send messages while disconnected (they get queued in IndexedDB)
   - Refresh the page (messages persist across sessions)
   - Connect to see persisted messages being processed automatically

## Dependencies

- `socket.io`: WebSocket communication
- `socket.io-client`: Client-side WebSocket communication
- `deepbase`: Message server persistence for offline rooms
- `lemonlog`: Structured logging
- `uuid`: UUID generation for message IDs

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on GitHub to contribute improvements or fixes.

## License

Shotx is released under the MIT License.
