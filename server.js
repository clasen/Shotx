import { Server } from 'socket.io';
import LemonLog from 'lemonlog';

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

        this.io = new Server(server, opts);

        this.messageHandlers = new Map();
        this.authHandler = this.defaultAuthHandler;

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

    /**
     * Registers a handler for a message type
     * @param {string} type - Message type
     * @param {Function} handler - Handler function for the message
     * @returns {SxServer} - Instance for chaining
     */
    onMessage(type, handler) {
        if (typeof type !== 'string' || typeof handler !== 'function') {
            throw new Error('Invalid parameters for onMessage');
        }
        this.messageHandlers.set(type, handler);
        return this;
    }

    /**
     * Sets up Socket.IO listeners for connection, messages, disconnection and errors
     */
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
    }

    /**
     * Handles incoming message processing
     * Validates message structure, routes by type, and responds via callback
     * @param {SocketIO.Socket} socket - Client socket
     * @param {Object} message - Received message
     * @param {Function} callback - Callback function for response
     */
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

            const handler = this.messageHandlers.get(meta.type);
            if (!handler) {
                return callback({ meta: { success: false, code: 2003, error: `Unknown message type: ${meta.type}` }, data: null });
            }

            const result = await handler(socket, data);
            callback({ meta: { success: true }, data: result });
        } catch (error) {
            log.error(`<-- [${socket.id}] Error al procesar el mensaje:`, error);
            callback({ meta: { success: false, code: 2004, error: error.message || 'Error processing message' }, data: null });
        }
    }
}