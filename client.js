import { io } from 'socket.io-client';
import LemonLog from 'lemonlog';
import { v7 as uuidv7 } from 'uuid';

const log = new LemonLog("SxClient");

export default class SxClient {
    constructor({ url } = {}) {
        this.url = url || 'http://localhost:3000';
        this.socket = null;
        this.isConnected = false;
        this.offlineQueue = [];
        this.joinedRooms = new Set(); // Track joined rooms for reconnection
        this.fileHandlers = new Map();

        // Add default event name for routing
        this.routeEvent = 'message';
    }

    // ============ Main send method ============
    async emit(eventName, data, meta = {}) {
        // Add UUID to meta
        meta.id = uuidv7();

        // If offline, queue the message
        if (!this.isConnected) {
            log.info('> Offline. Queuing message:', data);
            this.offlineQueue.push({ eventName, data, meta });
            return;
        }

        // If online, emit immediately
        return this._emitMessage(eventName, data, meta);
    }

    // ============ Internal method to emit a message ============
    _emitMessage(eventName, data, meta = {}) {
        return new Promise((resolve, reject) => {
            const message = { meta, data };
            log.info(`> emit: ${eventName}`, message);

            // Emit event to server
            this.socket.emit(eventName, message, (response) => {
                const { meta, data } = response;

                if (!meta.success) {
                    reject(new Error(meta.error || 'Unknown error'));
                    return;
                }

                resolve(data);
            });
        });
    }

    // Process queued messages after reconnection
    async processQueue() {
        if (!this.isConnected) return;
        if (this.offlineQueue.length > 0) {
            log.info(`> processQueue (${this.offlineQueue.length} messages).`);
        }

        while (this.offlineQueue.length > 0) {
            const { eventName, data, meta } = this.offlineQueue.shift();
            try {
                await this._emitMessage(eventName, data, meta);
            } catch (error) {
                log.error('> Error processQueue', error);
            }
        }
    }

    // Rejoin all previously joined rooms after reconnection
    async rejoinRooms() {
        if (!this.isConnected || this.joinedRooms.size === 0) return;

        log.info(`> Rejoining ${this.joinedRooms.size} rooms after reconnection`);

        for (const room of this.joinedRooms) {
            try {
                await this._joinRoom(room);
                log.info(`> Rejoined room: ${room}`);
            } catch (error) {
                log.error(`> Failed to rejoin room ${room}:`, error);
            }
        }
    }

    // Internal method to join room without tracking
    async _joinRoom(room) {
        return this.send('sx_join', { room });
    }

    // Connect to the server with a token
    async connect(token) {
        if (this.isConnected) {
            return;
        }

        token = token ?? uuidv7();

        return new Promise((resolve) => {
            let retryCount = 0;
            const maxRetryDelay = 30000; // Max 30 seconds
            
            const attemptConnection = () => {
                if (this.socket) {
                    this.socket.disconnect();
                }

                this.socket = io(this.url, { 
                    auth: { token },
                    autoConnect: true,
                    reconnection: true,
                    reconnectionDelay: 1000,
                    reconnectionDelayMax: maxRetryDelay,
                    maxReconnectionAttempts: Infinity
                });

                this.socket.on('connect', () => {
                    log.info('> connect');
                    this.isConnected = true;
                    retryCount = 0; // Reset retry count on successful connection
                });

                this.socket.on('connect_error', (error) => {
                    retryCount++;
                    const delay = Math.min(1000 * Math.pow(2, retryCount - 1), maxRetryDelay);
                    log.warn(`> connect_error (attempt ${retryCount}): ${error.message}, retrying in ${delay}ms`);
                    this.isConnected = false;
                    // Don't reject, let Socket.IO handle reconnection
                });

                this.socket.on('disconnect', () => {
                    log.info('> disconnect');
                    this.isConnected = false;
                });

                this.socket.on('auth_success', async (data) => {
                    log.info('> auth_success', data);
                    await this.processQueue();
                    await this.rejoinRooms();
                    resolve(data);
                });

                // Setup message listener for files
                this.socket.on(this.routeEvent, async (message) => {
                    if (message.meta && message.meta.isFile) {
                        const handler = this.fileHandlers.get(message.meta.type);
                        if (handler) {
                            try {
                                // Convert base64 back to buffer
                                const fileBuffer = Buffer.from(message.data.fileData, 'base64');
                                await handler(fileBuffer, message.data.extraData, this.socket);
                            } catch (error) {
                                log.error(`> Error in file handler for route ${message.meta.type}:`, error);
                            }
                        }
                    }
                });
            };

            attemptConnection();
        });
    }

    disconnect() {
        if (this.socket) {
            log.info('> Disconnecting');
            this.isConnected = false;
            this.socket.disconnect();
            this.socket = null;
        }
    }

    async send(type, data) {
        const meta = { type };
        return this.emit(this.routeEvent, data, meta);
    }

    async sendFile(route, fileBuffer, extraData = {}) {
        if (!Buffer.isBuffer(fileBuffer)) {
            throw new Error('File must be a Buffer');
        }

        const meta = { 
            type: route,
            isFile: true 
        };
        
        const data = {
            fileData: fileBuffer.toString('base64'),
            extraData
        };

        log.info(`> Sending file: ${route} (${fileBuffer.length} bytes)`);
        return this.emit(this.routeEvent, data, meta);
    }

    async join(room) {
        const result = await this._joinRoom(room);
        this.joinedRooms.add(room); // Track joined room
        log.info(`> Joined room: ${room}`);
        return result;
    }

    async leave(room) {
        const result = await this.send('sx_leave', { room });
        this.joinedRooms.delete(room); // Remove from tracked rooms
        log.info(`> Left room: ${room}`);
        return result;
    }

    onMessage(route, handler) {
        if (!this.socket) {
            log.warn('> Cannot set message handler - not connected');
            return;
        }

        this.socket.on(this.routeEvent, async (message) => {
            if (message.meta && message.meta.type === route && !message.meta.isFile) {
                try {
                    await handler(this.socket, message.data);
                } catch (error) {
                    log.error(`> Error in message handler for route ${route}:`, error);
                }
            }
        });
    }

    onFile(route, handler) {
        if (typeof route !== 'string' || typeof handler !== 'function') {
            throw new Error('Invalid parameters for onFile');
        }
        this.fileHandlers.set(route, handler);
        log.info(`> Registered file handler for route: ${route}`);
    }
} 