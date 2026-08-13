import { io } from 'socket.io-client';
import LemonLog from 'lemonlog';
import { v7 as uuidv7 } from 'uuid';

function validateReliableConfig(reliable) {
    if (!reliable || typeof reliable !== 'object') {
        throw new Error('reliable must be an object');
    }
    if (reliable.id !== undefined && (typeof reliable.id !== 'string' || reliable.id.length === 0)) {
        throw new Error('reliable.id must be a non-empty string');
    }

    return { id: reliable.id ?? null };
}

export default class SxClient {
    constructor(url = 'http://localhost:3000', opts = {}, { debug = 'none', timeout = 0, reliable } = {}) {
        this.url = url;
        this.log = new LemonLog("SxClient", debug);
        this.timeout = timeout;
        this.reliable = reliable === undefined ? { id: null } : validateReliableConfig(reliable);

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
        this.reliableRooms = new Map();

        // Add default event name for routing
        this.routeEvent = 'message';

        // IndexedDB support
        this.db = null;
        this.dbName = 'ShotxOfflineQueue';
        this.dbVersion = 3;
        this.storeName = 'messages';
        this.cursorStoreName = 'reliableCursors';
        this.metadataStoreName = 'reliableMetadata';
        this.useIndexedDB = this._checkIndexedDBSupport();

        // Initialize IndexedDB if available
        this.dbReady = this.useIndexedDB ? this._initIndexedDB() : Promise.resolve();
        this.reliableIdPromise = this._resolveReliableId();
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
                    if (!db.objectStoreNames.contains(this.cursorStoreName)) {
                        db.createObjectStore(this.cursorStoreName, { keyPath: 'key' });
                    }
                    if (!db.objectStoreNames.contains(this.metadataStoreName)) {
                        db.createObjectStore(this.metadataStoreName, { keyPath: 'key' });
                    }
                };
            });

            // Load persisted messages into memory queue
            await this._loadPersistedMessages();
            this.log.info('> IndexedDB initialized successfully');
        } catch (error) {
            this.log.warn('> Failed to initialize IndexedDB:', error.message);
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
            this.log.warn('> Failed to save message to IndexedDB:', error.message);
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
                this.log.info(`> Loaded ${messages.length} persisted messages from IndexedDB:`);
                messages.forEach((msg, i) => {
                    this.log.info(`  ${i + 1}. ${msg.meta?.type || msg.eventName} - ${JSON.stringify(msg.data)}`);
                });
            }
        } catch (error) {
            this.log.warn('> Failed to load persisted messages:', error.message);
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
            this.log.warn('> Failed to clear persisted messages:', error.message);
        }
    }

    _reliableIdentityKey() {
        return `identity\u0000${this.url}`;
    }

    async _resolveReliableId() {
        if (this.reliable.id) return this.reliable.id;

        await this.dbReady;
        const generatedId = uuidv7();
        if (!this.useIndexedDB || !this.db) return generatedId;

        try {
            const transaction = this.db.transaction([this.metadataStoreName], 'readwrite');
            const store = transaction.objectStore(this.metadataStoreName);
            return await new Promise((resolve, reject) => {
                const key = this._reliableIdentityKey();
                const request = store.get(key);
                request.onsuccess = () => {
                    if (typeof request.result?.id === 'string' && request.result.id.length > 0) {
                        resolve(request.result.id);
                        return;
                    }
                    const putRequest = store.put({ key, id: generatedId });
                    putRequest.onsuccess = () => resolve(generatedId);
                    putRequest.onerror = () => reject(putRequest.error);
                };
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            this.log.warn('> Failed to persist reliable client ID:', error.message);
            return generatedId;
        }
    }

    _reliableCursorKey(room, reliableId) {
        return `${this.url}\u0000${reliableId}\u0000${room}`;
    }

    async _loadReliableCursor(room) {
        await this.dbReady;
        if (!this.useIndexedDB || !this.db) return null;

        try {
            const reliableId = await this.reliableIdPromise;
            const transaction = this.db.transaction([this.cursorStoreName], 'readonly');
            const store = transaction.objectStore(this.cursorStoreName);
            const record = await new Promise((resolve, reject) => {
                const request = store.get(this._reliableCursorKey(room, reliableId));
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            return Number.isSafeInteger(record?.seq) && record.seq >= 0 ? record.seq : null;
        } catch (error) {
            this.log.warn('> Failed to load reliable cursor:', error.message);
            return null;
        }
    }

    async _saveReliableCursor(room, seq, { replace = false } = {}) {
        await this.dbReady;
        if (!this.useIndexedDB || !this.db) return;

        try {
            const reliableId = await this.reliableIdPromise;
            const transaction = this.db.transaction([this.cursorStoreName], 'readwrite');
            const store = transaction.objectStore(this.cursorStoreName);
            await new Promise((resolve, reject) => {
                const key = this._reliableCursorKey(room, reliableId);
                const request = store.get(key);
                request.onsuccess = () => {
                    const savedSeq = Number.isSafeInteger(request.result?.seq) ? request.result.seq : -1;
                    const putRequest = store.put({ key, seq: replace ? seq : Math.max(savedSeq, seq) });
                    putRequest.onsuccess = () => resolve();
                    putRequest.onerror = () => reject(putRequest.error);
                };
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            this.log.warn('> Failed to save reliable cursor:', error.message);
        }
    }

    // ============ Main send method ============
    async emit(eventName, data, meta = {}, { timeout } = {}) {
        // Add UUID to meta
        meta.id = uuidv7();

        // Si está offline, devolvemos una promesa que se resuelve/rechaza cuando se procese
        if (!this.isConnected) {
            this.log.info('> Offline. Queuing message:', data);
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
        return this._emitMessage(eventName, data, meta, { timeout });
    }

    // ============ Internal method to emit a message ============
    _emitMessage(eventName, data, meta = {}, { timeout } = {}) {
        const ms = timeout ?? this.timeout;

        return new Promise((resolve, reject) => {
            const message = { meta, data };
            this.log.info(`> emit: ${eventName}`, message);

            let timer;
            if (ms > 0) {
                timer = setTimeout(() => {
                    reject(new Error(`TIMEOUT: ${meta.type || eventName} (${ms}ms)`));
                }, ms);
            }

            // Emit event to server
            this.socket.emit(eventName, message, (response) => {
                if (timer) clearTimeout(timer);
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
            this.log.info(`> processQueue (${this.offlineQueue.length} messages).`);
        }

        const originalQueueLength = this.offlineQueue.length;
        let processedCount = 0;

        while (this.offlineQueue.length > 0) {
            const { eventName, data, meta, resolve, reject } = this.offlineQueue.shift();
            try {
                // Si hay resolve/reject (mensaje encolado offline), los usamos
                if (resolve && reject) {
                    this.log.info(`> Processing queued message (live): ${meta.type || eventName}`);
                    this._emitMessage(eventName, data, meta)
                        .then(resolve)
                        .catch(reject);
                } else {
                    // Mensaje persistido desde IndexedDB, solo enviamos
                    this.log.info(`> Processing persisted message: ${meta.type || eventName}`, data);
                    await this._emitMessage(eventName, data, meta);
                }
                processedCount++;
            } catch (error) {
                this.log.error('> Error processQueue', error);
                if (reject) reject(error);
            }
        }

        // Clear IndexedDB after successfully processing all messages
        if (processedCount === originalQueueLength && this.useIndexedDB) {
            await this._clearPersistedMessages();
            this.log.info('> Cleared persisted messages from IndexedDB');
        }
    }

    // Rejoin all previously joined rooms after reconnection
    async rejoinRooms() {
        if (!this.isConnected || this.joinedRooms.size === 0) return;

        this.log.info(`> Rejoining ${this.joinedRooms.size} rooms after reconnection`);

        for (const room of this.joinedRooms) {
            try {
                await this._joinRoom(room);
                this.log.info(`> Rejoined room: ${room}`);
            } catch (error) {
                this.log.error(`> Failed to rejoin room ${room}:`, error);
            }
        }
    }

    // Internal method to join room without tracking
    async _joinRoom(room) {
        const data = { room };
        const state = await this._prepareReliableRoom(room);
        if (state.lastSeq !== null) {
            data.afterSeq = state.lastSeq;
        }

        const result = await this.send('sx_join', data);
        if (result?.reliable?.status === 'resync_required') {
            throw this._createResyncError(room, result.reliable);
        }
        return result;
    }

    async _prepareReliableRoom(room, afterSeq) {
        if (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
            throw new Error('afterSeq must be a non-negative integer');
        }

        let state = this.reliableRooms.get(room);
        if (!state || afterSeq !== undefined) {
            const cursor = afterSeq ?? await this._loadReliableCursor(room);
            state = {
                room,
                lastSeq: cursor,
                buffer: new Map(),
                processing: Promise.resolve(),
                replayPromise: null,
                lastReplayFrom: null,
                resyncRequired: null
            };
            this.reliableRooms.set(room, state);
        }
        return state;
    }

    _createResyncError(room, details) {
        const error = new Error(`Reliable room requires resynchronization: ${room}`);
        error.code = 'RELIABLE_RESYNC_REQUIRED';
        error.room = room;
        error.details = details;
        return error;
    }

    _handleReliableMessage(message) {
        const { id, stream, seq } = message.meta;
        if (typeof id !== 'string' || typeof stream !== 'string' || !Number.isSafeInteger(seq) || seq < 1) {
            this.log.warn('> Received invalid reliable message envelope');
            return;
        }

        let state = this.reliableRooms.get(stream);
        if (!state) {
            state = {
                room: stream,
                lastSeq: null,
                buffer: new Map(),
                processing: Promise.resolve(),
                replayPromise: null,
                lastReplayFrom: null,
                resyncRequired: null
            };
            this.reliableRooms.set(stream, state);
        }

        if (state.lastSeq !== null && seq <= state.lastSeq) return;
        if (state.buffer.has(seq)) {
            this._scheduleReliableDrain(state);
            return;
        }

        if (state.lastSeq === null) {
            state.lastSeq = seq - 1;
        }
        state.buffer.set(seq, message);

        if (seq > state.lastSeq + 1) {
            this._requestReliableReplay(state, state.lastSeq + 1);
        }

        this._scheduleReliableDrain(state);
    }

    _scheduleReliableDrain(state) {
        state.processing = state.processing
            .then(() => this._drainReliableRoom(state))
            .catch((error) => {
                this.log.error(`> Reliable room processing failed for ${state.room}:`, error);
            });
    }

    async _drainReliableRoom(state) {
        while (state.buffer.has(state.lastSeq + 1)) {
            const seq = state.lastSeq + 1;
            const message = state.buffer.get(seq);
            const handler = this.messageHandlers.get(message.meta.type);
            if (!handler) {
                this.log.warn(`> No handler for reliable route: ${message.meta.type}`);
                return;
            }

            try {
                await handler(message.data, this.socket, message.meta);
            } catch (error) {
                this.log.error(`> Error in reliable handler for route ${message.meta.type}:`, error);
                return;
            }

            state.buffer.delete(seq);
            state.lastSeq = seq;
            if (state.lastReplayFrom !== null && state.lastSeq >= state.lastReplayFrom) {
                state.lastReplayFrom = null;
            }
            await this._saveReliableCursor(state.room, seq);
        }

        const bufferedSeqs = [...state.buffer.keys()];
        if (bufferedSeqs.length > 0) {
            const firstBuffered = Math.min(...bufferedSeqs);
            if (firstBuffered > state.lastSeq + 1) {
                this._requestReliableReplay(state, state.lastSeq + 1);
            }
        }
    }

    _requestReliableReplay(state, fromSeq) {
        if (!this.isConnected || state.replayPromise || state.lastReplayFrom === fromSeq || state.resyncRequired) {
            return;
        }

        state.lastReplayFrom = fromSeq;
        state.replayPromise = this.send('sx_replay', { room: state.room, fromSeq })
            .then(async (result) => {
                if (result?.status !== 'resync_required') return;
                state.resyncRequired = result;
                const error = this._createResyncError(state.room, result);
                this.log.error(`> ${error.message}`, result);
                await this.send('sx_leave', { room: state.room });
                this.joinedRooms.delete(state.room);
                const handler = this.messageHandlers.get('sx_resync_required');
                if (handler) {
                    await handler({ room: state.room, ...result }, this.socket);
                }
            })
            .catch((error) => {
                state.lastReplayFrom = null;
                this.log.error(`> Failed to replay reliable room ${state.room}:`, error);
            })
            .finally(() => {
                state.replayPromise = null;
            });
    }

    // Setup centralized message routing
    _setupMessageRouting() {
        if (!this.socket) return;

        // Remove any existing listener to avoid duplicates
        this.socket.off(this.routeEvent);

        // Single listener that routes all messages
        this.socket.on(this.routeEvent, async (message) => {
            if (!message.meta || !message.meta.type) {
                this.log.warn('> Received message without meta.type');
                return;
            }

            if (message.meta.seq !== undefined || message.meta.stream !== undefined) {
                this._handleReliableMessage(message);
                return;
            }

            const { type } = message.meta;
            const handler = this.messageHandlers.get(type);

            if (handler) {
                try {
                    await handler(message.data, this.socket, message.meta);
                } catch (error) {
                    this.log.error(`> Error in message handler for route ${type}:`, error);
                }
            }
        });
    }

    // Connect to the server with a token
    async connect(token, { timeout } = {}) {
        if (this.isConnected) {
            return;
        }

        token = token ?? uuidv7();
        const ms = timeout ?? this.timeout;

        return new Promise((resolve, reject) => {
            let retryCount = 0;
            let timer;

            if (ms > 0) {
                timer = setTimeout(() => {
                    reject(new Error(`TIMEOUT: connect (${ms}ms)`));
                }, ms);
            }

            const attemptConnection = () => {
                if (this.socket) {
                    this.socket.disconnect();
                }
                this.opts.auth = { token };
                this.socket = io(this.url, this.opts);

                this.socket.on('connect', () => {
                    this.log.info('> connect');
                    this.isConnected = true;
                    retryCount = 0; // Reset retry count on successful connection
                    this._setupMessageRouting(); // Setup message routing after connection
                });

                this.socket.on('connect_error', (error) => {
                    retryCount++;
                    const delay = Math.min(1000 * Math.pow(2, retryCount - 1), this.opts.reconnectionDelayMax);
                    this.log.warn(`> connect_error (attempt ${retryCount}): ${error.message}, retrying in ${delay}ms`);
                    this.isConnected = false;
                    // Don't reject, let Socket.IO handle reconnection
                });

                this.socket.on('disconnect', () => {
                    this.log.info('> disconnect');
                    this.isConnected = false;
                });

                this.socket.on('auth_success', async (data) => {
                    if (timer) clearTimeout(timer);
                    this.log.info('> auth_success', data);
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
            this.log.info('> Disconnecting');
            this.isConnected = false;
            this.socket.disconnect();
            this.socket = null;
        }
    }

    async send(type, data, { timeout } = {}) {
        const meta = { type };
        return this.emit(this.routeEvent, data, meta, { timeout });
    }

    async join(room, { afterSeq } = {}) {
        await this._prepareReliableRoom(room, afterSeq);
        const result = await this._joinRoom(room);
        if (afterSeq !== undefined) {
            await this._saveReliableCursor(room, this.reliableRooms.get(room).lastSeq, { replace: true });
        }
        this.joinedRooms.add(room); // Track joined room
        this.log.info(`> Joined room: ${room}`);
        return result;
    }

    async leave(room) {
        const result = await this.send('sx_leave', { room });
        this.joinedRooms.delete(room); // Remove from tracked rooms
        this.reliableRooms.delete(room);
        this.log.info(`> Left room: ${room}`);
        return result;
    }

    onMessage(route, handler) {
        if (!this.socket) {
            this.log.warn('> Cannot set message handler - not connected');
            return;
        }

        this.messageHandlers.set(route, handler);
        this.log.info(`> Registered message handler for route: ${route}`);

        for (const state of this.reliableRooms.values()) {
            this._scheduleReliableDrain(state);
        }
    }
}
