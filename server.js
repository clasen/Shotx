import { Server } from 'socket.io';
import LemonLog from 'lemonlog';
import DeepBase from 'deepbase';
import { fileTypeFromBuffer } from 'file-type';

const log = new LemonLog("SxServer");

export default class SxServer {

    constructor({ server, opts } = {}) {
        if (!server) {
            throw new Error('HTTP(s) server must be provided');
        }

        opts = opts || {};

        if (!opts.cors) {
            opts.cors = {
                origin: '*',
                methods: ['GET', 'POST']
            }
        }

        opts.maxHttpBufferSize = opts.maxHttpBufferSize || (2 * 1024 * 1024); // 2 MB

        this.io = new Server(server, opts);

        this.messageHandlers = new Map();
        this.fileHandlers = new Map();
        this.authHandler = this.defaultAuthHandler;
        this.db = new DeepBase({ name: 'shotx' });

        // Configurar middleware de autenticación
        this.io.use(async (socket, next) => {
            try {
                const token = socket.handshake?.auth?.token;
                if (!token) {
                    log.warn(`<-- [${socket.id}] (AUTH_NULL) Authentication failed: No token provided`);
                    return next(new Error('AUTH_NULL'));
                }
                const auth = await this.authHandler(token, socket);
                if (auth) {
                    socket.auth = auth;
                    next();
                } else {
                    log.warn(`<-- [${socket.id}] (AUTH_FAIL) Authentication failed: Invalid credentials`);
                    return next(new Error('AUTH_FAIL'));
                }
            } catch (error) {
                log.error(`<-- [${socket.id}] (AUTH_ERROR) Authentication error`, error);
                next(new Error('AUTH_ERROR'));
            }
        });

        this.setupListeners();
    }

    setAuthHandler(handler) {
        if (typeof handler !== 'function') {
            throw new Error('Authentication handler must be a function');
        }
        this.authHandler = handler;
        return this;
    }

    defaultAuthHandler(token, socket) {
        return {};
    }

    onMessage(route, handler) {
        if (typeof route !== 'string' || typeof handler !== 'function') {
            throw new Error('Invalid parameters for onMessage');
        }
        this.messageHandlers.set(route, handler);
        return this;
    }

    onFile(route, handler) {
        if (typeof route !== 'string' || typeof handler !== 'function') {
            throw new Error('Invalid parameters for onFile');
        }
        this.fileHandlers.set(route, handler);
        return this;
    }

    setupListeners() {
        this.io.on('connection', (socket) => {
            log.info(`<-- [${socket.id}] Client connected`);

            // Send auth information to client
            socket.emit('auth_success', socket.auth);

            // Listener for messages with type-based routing
            socket.on('message', async (message, callback) => {
                await this.handleMessage(socket, message, callback);
            });

            // Listener for disconnection
            socket.on('disconnect', () => {
                log.info(`<-- [${socket.id}] Client disconnected`);
            });

            // Listener for errors
            socket.on('error', (error) => {
                log.error(`<-- [${socket.id}] Error:`, error);
            });
        });

        // Listener for join room
        this.onMessage('sx_join', async (data, socket) => {
            socket.join(data.room);
            log.info(`<-- [${socket.id}] Joined room: ${data.room}`);
            this.processRoomMessages(data.room);
        });

        // Listener for leave room
        this.onMessage('sx_leave', async (data, socket) => {
            socket.leave(data.room);
            log.info(`<-- [${socket.id}] Left room: ${data.room}`);
        });

        // Listener for file messages with automatic type detection
        this.onMessage('sx_file', async (data, socket) => {
            const { route, fileData, extraData } = data;

            const handler = this.fileHandlers.get(route);

            if (!handler) {
                log.warn(`<-- [${socket.id}] Unknown file route: ${route}`);
                return;
            }

            try {
                // Convert base64 back to buffer
                const fileBuffer = Buffer.from(fileData, 'base64');

                // Detect file type using magic numbers
                const fileType = await fileTypeFromBuffer(fileBuffer);
                const meta = {
                    mimeType: fileType?.mime || 'application/octet-stream',
                    extension: fileType?.ext || 'bin'
                };

                log.info(`<-- [${socket.id}] File detected: ${fileType.mimeType} (${fileBuffer.length} bytes)`);

                // Create enhanced file data with detection info
                const enhancedFileData = {
                    meta,
                    ...extraData
                };

                const result = await handler(fileBuffer, enhancedFileData, socket);
                log.info(`<-- [${socket.id}] File processed: ${route} (${fileBuffer.length} bytes)`);
                return result;
            } catch (error) {
                log.error(`<-- [${socket.id}] Error processing file:`, error);
                throw error;
            }
        });
    }

    async handleMessage(socket, message, callback) {
        try {
            // Validate that message is an object
            if (!message || typeof message !== 'object') {
                return callback({ meta: { success: false, code: 2001, error: 'Invalid message format' }, data: null });
            }

            const { meta, data } = message;

            // Validate that meta exists and has a valid message type
            if (!meta || typeof meta.type !== 'string') {
                return callback({ meta: { success: false, code: 2002, error: 'Invalid message type' }, data: null });
            }

            log.info(`<-- [${socket.id}] - ${meta.type}`, message);

            // Handle regular message
            const handler = this.messageHandlers.get(meta.type);
            if (!handler) {
                return callback({ meta: { success: false, code: 2003, error: `Unknown message type: ${meta.type}` }, data: null });
            }

            const result = await handler(data, socket);
            callback({ meta: { success: true }, data: result });
        } catch (error) {
            log.error(`<-- [${socket.id}] Error al procesar el mensaje:`, error);
            callback({ meta: { success: false, code: 2004, error: error.message || 'Error processing message' }, data: null });
        }
    }

    /**
     * Send message to a specific room
     * @param {string} room - Room name
     * @returns {Object} - Object with send method
     */
    to(room) {
        const roomSender = {
            send: (type, data) => {
                const message = {
                    meta: { type },
                    data
                };

                // Check if room has connected clients
                const roomSockets = this.io.sockets.adapter.rooms.get(room);

                if (roomSockets && roomSockets.size > 0) {
                    // Room has connected clients, send message immediately
                    log.info(`--> [room:${room}] Sending message: ${type}`, message);
                    this.io.to(room).emit('message', message);
                } else {
                    // Room is offline, persist the message
                    log.info(`--> [room:${room}] Room offline, persisting message: ${type}`, message);
                    this.db.add(room, { type, data });
                }
            },

            sendFile: (route, fileBuffer, extraData = {}) => {
                if (!Buffer.isBuffer(fileBuffer)) {
                    throw new Error('File must be a Buffer');
                }

                fileTypeFromBuffer(fileBuffer).then(fileType => {
                    extraData.meta = {
                        mimeType: fileType?.mime || 'application/octet-stream',
                        extension: fileType?.ext || 'bin'
                    };

                    // Use the internal message system
                    const fileData = {
                        route,
                        fileData: fileBuffer.toString('base64'),
                        extraData
                    };

                    // Reuse the send method to avoid duplicating offline logic
                    roomSender.send('sx_file', fileData);
                });
            }
        };

        return roomSender;
    }

    /**
     * Process pending messages for a room when a client joins
     * @param {string} room - Room name
     */
    async processRoomMessages(room) {
        try {
            const pendingMessages = await this.db.values(room) || [];

            console.log(pendingMessages);
            if (pendingMessages.length > 0) {
                log.info(`--> [room:${room}] Processing ${pendingMessages.length} pending messages`);

                for (const msg of pendingMessages) {
                    const message = {
                        meta: {
                            type: msg.type
                        },
                        data: msg.data
                    };

                    this.io.to(room).emit('message', message);
                    log.info(`--> [room:${room}] Sent pending message: ${msg.type}`, message);
                }

                // Clear processed messages
                this.db.del(room);
            }
        } catch (error) {
            log.error(`Error processing room messages for ${room}:`, error);
        }
    }
}