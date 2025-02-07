import { Server } from 'socket.io';
import LemonLog from 'lemonlog';

const log = new LemonLog("SxServer");

export default class SxServer {
    /**
     * Initialize the socket server
     * @param {Object} args - Configuration arguments
     * @param {http.Server} args.httpServer - HTTP server to use for Socket.IO
     */
    constructor({ httpServer, opts } = {}) {
        if (!httpServer) {
            throw new Error('HTTP server must be provided');
        }

        opts = opts || {};

        if (!opts.cors) {
            opts.cors = {
                origin: '*',
                methods: ['GET', 'POST']
            }
        }

        this.io = new Server(httpServer, opts);

        this.messageHandlers = new Map();
        this.authHandler = this.defaultAuthHandler;

        // Configurar middleware de autenticación
        this.io.use(async (socket, next) => {
            try {
                const token = socket.handshake?.auth?.token;
                if (!token) {
                    return next(new Error("Authentication token not provided"));
                }
                const auth = await this.authHandler(token, socket);
                if (auth) {
                    socket.auth = auth;
                    next();
                } else {
                    return next(new Error("Invalid authentication token"));
                }
            } catch (error) {
                next(error);
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
            log.info(`<-- [${socket.id}] Cliente conectado`);

            // Enviar información de auth al cliente
            socket.emit('auth_success', socket.auth);

            // Listener para mensajes con enrutamiento basado en tipo
            socket.on('message', async (message, callback) => {
                await this.handleMessage(socket, message, callback);
            });

            // Listener para desconexión
            socket.on('disconnect', () => {
                log.info(`<-- [${socket.id}] Cliente desconectado`);
            });

            // Listener para errores
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
            // Validar que el mensaje es un objeto
            if (!message || typeof message !== 'object') {
                return callback({ meta: { success: false, error: 'Invalid message format' }, data: null });
            }

            const { meta, data } = message;

            // Validar que meta existe y que posee un tipo de mensaje válido
            if (!meta || typeof meta.type !== 'string') {
                return callback({ meta: { success: false, error: 'Invalid message type' }, data: null });
            }

            log.info(`<-- [${socket.id}] - ${meta.type}`, message);

            const handler = this.messageHandlers.get(meta.type);
            if (!handler) {
                return callback({ meta: { success: false, error: `Unknown message type: ${meta.type}` }, data: null });
            }

            const result = await handler(socket, data);
            callback({ meta: { success: true }, data: result });
        } catch (error) {
            log.error(`<-- [${socket.id}] Error al procesar el mensaje:`, error);
            callback({ meta: { success: false, error: error.message || 'Error processing message' }, data: null });
        }
    }
}