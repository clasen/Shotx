import { io } from 'socket.io-client';
import LemonLog from 'lemonlog';
import { v7 as uuidv7 } from 'uuid';

const log = new LemonLog("SxClient");

export default class SxClient {
    constructor(url = 'http://localhost:3000', opts = {}) {
        this.url = url;

        const defaultOpts = {
            path: '/shotx/',
            autoConnect: true,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 30000,
            maxReconnectionAttempts: Infinity
        };

        this.opts = { ...defaultOpts, ...opts };
        this.socket = null;
        this.isConnected = false;
        this.offlineQueue = [];
        this.joinedRooms = new Set(); // Track joined rooms for reconnection
        this.messageHandlers = new Map(); // Track message handlers

        // Add default event name for routing
        this.routeEvent = 'message';

        // IndexedDB support
        this.db = null;
        this.dbName = 'ShotxOfflineQueue';
        this.dbVersion = 1;
        this.storeName = 'messages';
        this.useIndexedDB = this._checkIndexedDBSupport();

        // Initialize IndexedDB if available
        if (this.useIndexedDB) {
            this._initIndexedDB();
        }
    }

    // ============ IndexedDB Methods ============
    _checkIndexedDBSupport() {
        return typeof window !== 'undefined' && 'indexedDB' in window;
    }

    async _initIndexedDB() {
        if (!this.useIndexedDB) return;

        try {
            this.db = await new Promise((resolve, reject) => {
                const request = indexedDB.open(this.dbName, this.dbVersion);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve(request.result);

                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(this.storeName)) {
                        const store = db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
                        store.createIndex('timestamp', 'timestamp', { unique: false });
                    }
                };
            });

            // Load persisted messages into memory queue
            await this._loadPersistedMessages();
            log.info('> IndexedDB initialized successfully');
        } catch (error) {
            log.warn('> Failed to initialize IndexedDB:', error.message);
            this.useIndexedDB = false;
        }
    }

    async _saveMessageToIndexedDB(message) {
        if (!this.useIndexedDB || !this.db) return;

        try {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            
            const messageWithTimestamp = {
                ...message,
                timestamp: Date.now()
            };
            
            await new Promise((resolve, reject) => {
                const request = store.add(messageWithTimestamp);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            log.warn('> Failed to save message to IndexedDB:', error.message);
        }
    }

    async _loadPersistedMessages() {
        if (!this.useIndexedDB || !this.db) return;

        try {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            
            const messages = await new Promise((resolve, reject) => {
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });

            // Sort by timestamp and add to queue
            messages.sort((a, b) => a.timestamp - b.timestamp);
            for (const message of messages) {
                // Remove timestamp and id before adding to queue
                const { timestamp, id, ...queueMessage } = message;
                // Add null resolve/reject for persisted messages since they can't be serialized
                queueMessage.resolve = null;
                queueMessage.reject = null;
                this.offlineQueue.push(queueMessage);
            }

            if (messages.length > 0) {
                log.info(`> Loaded ${messages.length} persisted messages from IndexedDB:`);
                messages.forEach((msg, i) => {
                    log.info(`  ${i + 1}. ${msg.meta?.type || msg.eventName} - ${JSON.stringify(msg.data)}`);
                });
            }
        } catch (error) {
            log.warn('> Failed to load persisted messages:', error.message);
        }
    }

    async _clearPersistedMessages() {
        if (!this.useIndexedDB || !this.db) return;

        try {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            
            await new Promise((resolve, reject) => {
                const request = store.clear();
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            log.warn('> Failed to clear persisted messages:', error.message);
        }
    }

    // ============ Main send method ============
    async emit(eventName, data, meta = {}) {
        // Add UUID to meta
        meta.id = uuidv7();

        // Si está offline, devolvemos una promesa que se resuelve/rechaza cuando se procese
        if (!this.isConnected) {
            log.info('> Offline. Queuing message:', data);
            return new Promise((resolve, reject) => {
                const queueMessage = { eventName, data, meta, resolve, reject };
                this.offlineQueue.push(queueMessage);
                
                // Persist to IndexedDB if available
                if (this.useIndexedDB) {
                    // Create a serializable version without resolve/reject functions
                    const persistableMessage = { eventName, data, meta };
                    this._saveMessageToIndexedDB(persistableMessage);
                }
            });
        }

        // Si está online, emitimos inmediatamente
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

        const originalQueueLength = this.offlineQueue.length;
        let processedCount = 0;

        while (this.offlineQueue.length > 0) {
            const { eventName, data, meta, resolve, reject } = this.offlineQueue.shift();
            try {
                // Si hay resolve/reject (mensaje encolado offline), los usamos
                if (resolve && reject) {
                    log.info(`> Processing queued message (live): ${meta.type || eventName}`);
                    this._emitMessage(eventName, data, meta)
                        .then(resolve)
                        .catch(reject);
                } else {
                    // Mensaje persistido desde IndexedDB, solo enviamos
                    log.info(`> Processing persisted message: ${meta.type || eventName}`, data);
                    await this._emitMessage(eventName, data, meta);
                }
                processedCount++;
            } catch (error) {
                log.error('> Error processQueue', error);
                if (reject) reject(error);
            }
        }

        // Clear IndexedDB after successfully processing all messages
        if (processedCount === originalQueueLength && this.useIndexedDB) {
            await this._clearPersistedMessages();
            log.info('> Cleared persisted messages from IndexedDB');
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

    // Setup centralized message routing
    _setupMessageRouting() {
        if (!this.socket) return;

        // Remove any existing listener to avoid duplicates
        this.socket.off(this.routeEvent);

        // Single listener that routes all messages
        this.socket.on(this.routeEvent, async (message) => {
            if (!message.meta || !message.meta.type) {
                log.warn('> Received message without meta.type');
                return;
            }

            const { type } = message.meta;
            const handler = this.messageHandlers.get(type);

            if (handler) {
                try {
                    await handler(message.data, this.socket);
                } catch (error) {
                    log.error(`> Error in message handler for route ${type}:`, error);
                }
            }
        });
    }

    // Connect to the server with a token
    async connect(token) {
        if (this.isConnected) {
            return;
        }

        token = token ?? uuidv7();

        return new Promise((resolve) => {
            let retryCount = 0;

            const attemptConnection = () => {
                if (this.socket) {
                    this.socket.disconnect();
                }
                this.opts.auth = { token };
                this.socket = io(this.url, this.opts);

                this.socket.on('connect', () => {
                    log.info('> connect');
                    this.isConnected = true;
                    retryCount = 0; // Reset retry count on successful connection
                    this._setupMessageRouting(); // Setup message routing after connection
                });

                this.socket.on('connect_error', (error) => {
                    retryCount++;
                    const delay = Math.min(1000 * Math.pow(2, retryCount - 1), this.opts.reconnectionDelayMax);
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

        this.messageHandlers.set(route, handler);
        log.info(`> Registered message handler for route: ${route}`);
    }
} 