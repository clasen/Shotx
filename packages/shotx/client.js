import { io } from 'socket.io-client';
import LemonLog from 'lemonlog';
import { v7 as uuidv7 } from 'uuid';

function validateReliableConfig(reliable) {
    if (!reliable || typeof reliable !== 'object') {
        throw new Error('reliable must be an object');
    }
    if (reliable.enabled !== undefined && typeof reliable.enabled !== 'boolean') {
        throw new Error('reliable.enabled must be a boolean');
    }
    if (reliable.id !== undefined && (typeof reliable.id !== 'string' || reliable.id.length === 0)) {
        throw new Error('reliable.id must be a non-empty string');
    }

    return {
        enabled: reliable.enabled ?? false,
        id: reliable.id ?? null
    };
}

export default class SxClient {
    constructor(url = 'http://localhost:3000', opts = {}, { debug = 'none', timeout = 0, reliable } = {}) {
        this.url = url;
        this.log = new LemonLog("SxClient", debug);
        this.timeout = timeout;
        this.reliable = reliable === undefined ? { enabled: false, id: null } : validateReliableConfig(reliable);

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
        this.serverReliable = false;
        this.reliableServerEpoch = null;
        this.reliableOutboundEpoch = undefined;
        this.reliableReadyPromise = null;
        this.reliableOutbox = new Map();
        this.reliableOutboundPending = new Map();
        this.reliableOutboundFlush = null;
        this.reliableOutboundBlocked = null;
        this.nextReliableOutboundSeq = 1;

        // Add default event name for routing
        this.routeEvent = 'message';

        // IndexedDB support
        this.db = null;
        this.dbName = 'ShotxOfflineQueue';
        this.dbVersion = 4;
        this.storeName = 'messages';
        this.cursorStoreName = 'reliableCursors';
        this.metadataStoreName = 'reliableMetadata';
        this.outboxStoreName = 'reliableOutbox';
        this.useIndexedDB = this._checkIndexedDBSupport();

        // Initialize IndexedDB if available
        this.dbReady = this.useIndexedDB ? this._initIndexedDB() : Promise.resolve();
        this.reliableIdPromise = this._resolveReliableId();
        this.reliableOutboxReady = this.useIndexedDB ? this._loadReliableOutbox() : Promise.resolve();
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
                    if (!db.objectStoreNames.contains(this.outboxStoreName)) {
                        db.createObjectStore(this.outboxStoreName, { keyPath: 'key' });
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
        await this.dbReady;
        if (!this.useIndexedDB || !this.db) return;

        const transaction = this.db.transaction([this.storeName], 'readwrite');
        const request = transaction.objectStore(this.storeName).add({
            ...message,
            timestamp: Date.now()
        });
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve(request.result);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('Message persistence aborted'));
        });
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
                const { timestamp, id, ...queueMessage } = message;
                queueMessage.persistedId = id;
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

    async _deletePersistedMessage(id) {
        if (id === undefined || !this.useIndexedDB || !this.db) return;

        const transaction = this.db.transaction([this.storeName], 'readwrite');
        transaction.objectStore(this.storeName).delete(id);
        await new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('Message deletion aborted'));
        });
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
            return Number.isSafeInteger(record?.seq) && record.seq >= 0
                ? { seq: record.seq, epoch: record.epoch ?? null }
                : null;
        } catch (error) {
            this.log.warn('> Failed to load reliable cursor:', error.message);
            return null;
        }
    }

    async _saveReliableCursor(room, seq, { replace = false, epoch = this.reliableRooms.get(room)?.epoch ?? null } = {}) {
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
                    const savedSeq = (request.result?.epoch ?? null) === epoch && Number.isSafeInteger(request.result?.seq)
                        ? request.result.seq : -1;
                    const putRequest = store.put({ key, seq: replace ? seq : Math.max(savedSeq, seq), epoch });
                    putRequest.onsuccess = () => resolve();
                    putRequest.onerror = () => reject(putRequest.error);
                };
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            this.log.warn('> Failed to save reliable cursor:', error.message);
        }
    }

    _reliableOutboundPrefix(reliableId) {
        return `${this.url}\u0000${reliableId}\u0000`;
    }

    _reliableOutboundSequenceKey(reliableId) {
        return `outbound-sequence\u0000${this.url}\u0000${reliableId}`;
    }

    async _loadReliableOutbox() {
        await this.dbReady;
        const reliableId = await this.reliableIdPromise;
        if (!this.useIndexedDB || !this.db) return;

        const transaction = this.db.transaction([this.outboxStoreName, this.metadataStoreName], 'readonly');
        const outboxStore = transaction.objectStore(this.outboxStoreName);
        const metadataStore = transaction.objectStore(this.metadataStoreName);
        const [records, sequence] = await Promise.all([
            new Promise((resolve, reject) => {
                const request = outboxStore.getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            }),
            new Promise((resolve, reject) => {
                const request = metadataStore.get(this._reliableOutboundSequenceKey(reliableId));
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            })
        ]);

        const prefix = this._reliableOutboundPrefix(reliableId);
        const matching = records
            .filter((record) => record.key.startsWith(prefix))
            .sort((left, right) => left.seq - right.seq);
        for (const record of matching) {
            this.reliableOutbox.set(record.seq, record);
        }
        const afterOutbox = (matching.at(-1)?.seq ?? 0) + 1;
        this.nextReliableOutboundSeq = Math.max(sequence?.nextSeq ?? 1, afterOutbox);
        this.reliableOutboundEpoch = sequence?.epoch;
    }

    async _createReliableOutboundRecord(eventName, data, meta) {
        await this.reliableOutboxReady;
        const reliableId = await this.reliableIdPromise;
        let seq = this.nextReliableOutboundSeq;
        const record = {
            key: `${this._reliableOutboundPrefix(reliableId)}${seq}`,
            eventName,
            data,
            meta: { ...meta, stream: reliableId, seq },
            seq,
            storedAt: Date.now()
        };

        if (this.useIndexedDB && this.db) {
            const transaction = this.db.transaction([this.outboxStoreName, this.metadataStoreName], 'readwrite');
            const outboxStore = transaction.objectStore(this.outboxStoreName);
            const metadataStore = transaction.objectStore(this.metadataStoreName);
            const sequenceKey = this._reliableOutboundSequenceKey(reliableId);
            seq = await new Promise((resolve, reject) => {
                const request = metadataStore.get(sequenceKey);
                request.onsuccess = () => {
                    const allocated = Math.max(request.result?.nextSeq ?? 1, this.nextReliableOutboundSeq);
                    record.seq = allocated;
                    record.key = `${this._reliableOutboundPrefix(reliableId)}${allocated}`;
                    record.meta.seq = allocated;
                    metadataStore.put({ key: sequenceKey, nextSeq: allocated + 1, epoch: this.reliableOutboundEpoch });
                    outboxStore.put(record);
                    resolve(allocated);
                };
                request.onerror = () => reject(request.error);
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () => reject(transaction.error);
            });
            await new Promise((resolve, reject) => {
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () => reject(transaction.error);
            });
        }

        this.nextReliableOutboundSeq = seq + 1;
        this.reliableOutbox.set(seq, record);
        return record;
    }

    async _deleteReliableOutboundRecord(record) {
        if (this.useIndexedDB && this.db) {
            const transaction = this.db.transaction([this.outboxStoreName], 'readwrite');
            transaction.objectStore(this.outboxStoreName).delete(record.key);
            await new Promise((resolve, reject) => {
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () => reject(transaction.error);
            });
        }
        this.reliableOutbox.delete(record.seq);
    }

    async _adoptReliableServerSequence(nextSeq, epoch = null) {
        await this.reliableOutboxReady;
        const epochChanged = this.reliableOutboundEpoch !== undefined && this.reliableOutboundEpoch !== epoch;
        const firstPendingSeq = Math.min(...this.reliableOutbox.keys());
        if (Number.isFinite(firstPendingSeq)) {
            if (epochChanged) {
                const error = new Error('Reliable server history changed while client messages are pending');
                error.code = 'RELIABLE_RESYNC_REQUIRED';
                throw error;
            }
            if (firstPendingSeq > nextSeq) {
                const error = new Error(`Reliable client outbox is missing sequence ${nextSeq}`);
                error.code = 'RELIABLE_RESYNC_REQUIRED';
                throw error;
            }
        } else if (!epochChanged && this.nextReliableOutboundSeq > nextSeq) {
            const error = new Error(`Reliable server expects sequence ${nextSeq}, client expects ${this.nextReliableOutboundSeq}`);
            error.code = 'RELIABLE_RESYNC_REQUIRED';
            throw error;
        }
        const adoptedSeq = Number.isFinite(firstPendingSeq) ? this.nextReliableOutboundSeq : nextSeq;
        if (this.nextReliableOutboundSeq === adoptedSeq && this.reliableOutboundEpoch === epoch) return;

        this.nextReliableOutboundSeq = adoptedSeq;
        this.reliableOutboundEpoch = epoch;
        if (this.useIndexedDB && this.db) {
            const reliableId = await this.reliableIdPromise;
            const transaction = this.db.transaction([this.metadataStoreName], 'readwrite');
            transaction.objectStore(this.metadataStoreName).put({
                key: this._reliableOutboundSequenceKey(reliableId),
                nextSeq: adoptedSeq,
                epoch
            });
            await new Promise((resolve, reject) => {
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () => reject(transaction.error);
            });
        }
    }

    _blockReliableOutbox(error) {
        this.reliableOutboundBlocked = error;
        for (const pending of this.reliableOutboundPending.values()) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.reliableOutboundPending.clear();
    }

    _isReliableApplicationMessage(eventName, meta) {
        return eventName === this.routeEvent
            && typeof meta.type === 'string'
            && !meta.type.startsWith('sx_');
    }

    async _sendReliableMessage(eventName, data, meta, { timeout } = {}) {
        if (this.reliableOutboundBlocked) throw this.reliableOutboundBlocked;
        const record = await this._createReliableOutboundRecord(eventName, data, meta);
        const ms = timeout ?? this.timeout;

        const delivery = new Promise((resolve, reject) => {
            let timer;
            if (ms > 0) {
                timer = setTimeout(() => {
                    reject(new Error(`TIMEOUT: ${meta.type || eventName} (${ms}ms)`));
                }, ms);
            }
            this.reliableOutboundPending.set(record.seq, { resolve, reject, timer });
        });
        this._scheduleReliableOutboxFlush();
        return delivery;
    }

    _scheduleReliableOutboxFlush() {
        if (this.reliableOutboundFlush || !this.serverReliable || !this.isConnected || !this.socket) return;

        this.reliableOutboundFlush = this._flushReliableOutbox()
            .catch((error) => {
                this._blockReliableOutbox(error);
                this.log.error('> Reliable client outbox failed:', error);
            })
            .finally(() => {
                this.reliableOutboundFlush = null;
                if (!this.reliableOutboundBlocked && this.serverReliable && this.isConnected && this.reliableOutbox.size > 0) {
                    this._scheduleReliableOutboxFlush();
                }
            });
    }

    async _flushReliableOutbox() {
        await this.reliableOutboxReady;
        while (this.serverReliable && this.isConnected && this.socket && this.reliableOutbox.size > 0) {
            let record;
            for (const pending of this.reliableOutbox.values()) {
                if (!record || pending.seq < record.seq) record = pending;
            }
            const attempt = await this._emitReliableRecord(record);
            if (attempt.disconnected) return;

            const { response } = attempt;
            if (response?.meta?.code === 'RELIABLE_REPLAY_REQUIRED') {
                if (!this.reliableOutbox.has(response.meta.expectedSeq)) {
                    const error = new Error(`Reliable client outbox is missing sequence ${response.meta.expectedSeq}`);
                    error.code = 'RELIABLE_RESYNC_REQUIRED';
                    throw error;
                }
                continue;
            }
            if (response?.meta?.code === 'RELIABLE_RESYNC_REQUIRED'
                || response?.meta?.code === 'RELIABLE_SEQUENCE_CONFLICT') {
                const error = new Error(response.meta.error);
                error.code = response.meta.code;
                error.expectedSeq = response.meta.expectedSeq;
                throw error;
            }
            if (response?.meta?.reliable !== true || response.meta.seq !== record.seq || response.meta.id !== record.meta.id) {
                throw new Error(`Invalid reliable acknowledgement for sequence ${record.seq}`);
            }

            await this._deleteReliableOutboundRecord(record);
            const pending = this.reliableOutboundPending.get(record.seq);
            if (pending) {
                if (pending.timer) clearTimeout(pending.timer);
                this.reliableOutboundPending.delete(record.seq);
                if (response.meta.success) {
                    pending.resolve(response.data);
                } else {
                    const error = new Error(response.meta.error || 'Unknown error');
                    error.code = response.meta.code;
                    pending.reject(error);
                }
            }
        }
    }

    _emitReliableRecord(record) {
        const socket = this.socket;
        return new Promise((resolve) => {
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                socket.off('disconnect', onDisconnect);
                resolve(result);
            };
            const onDisconnect = () => finish({ disconnected: true });
            socket.once('disconnect', onDisconnect);
            socket.emit(record.eventName, { meta: record.meta, data: record.data }, (response) => {
                finish({ response });
            });
        });
    }

    // ============ Main send method ============
    async emit(eventName, data, meta = {}, { timeout } = {}) {
        // Add UUID to meta
        meta.id = uuidv7();

        if (this.reliable.enabled && this._isReliableApplicationMessage(eventName, meta)) {
            return this._sendReliableMessage(eventName, data, meta, { timeout });
        }

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
                    queueMessage.persistence = this._saveMessageToIndexedDB(persistableMessage);
                    queueMessage.persistence.catch((error) => {
                        const index = this.offlineQueue.indexOf(queueMessage);
                        if (index !== -1) this.offlineQueue.splice(index, 1);
                        reject(error);
                    });
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
        await this.dbReady;
        if (!this.isConnected) return;
        if (this.offlineQueue.length > 0) {
            this.log.info(`> processQueue (${this.offlineQueue.length} messages).`);
        }

        while (this.isConnected && this.offlineQueue.length > 0) {
            const { eventName, data, meta, resolve, reject, persistence, persistedId } = this.offlineQueue.shift();
            try {
                const delivery = Promise.resolve(persistence ?? persistedId).then(async (id) => {
                    const result = this.reliable.enabled && this._isReliableApplicationMessage(eventName, meta)
                        ? await this._sendReliableMessage(eventName, data, meta)
                        : await this._emitMessage(eventName, data, meta);
                    await this._deletePersistedMessage(id);
                    return result;
                });
                if (resolve && reject) {
                    delivery.then(resolve, reject);
                } else {
                    await delivery;
                }
            } catch (error) {
                this.log.error('> Error processQueue', error);
                if (reject) reject(error);
            }
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
                if (error.code === 'RELIABLE_RESYNC_REQUIRED') {
                    await this._notifyReliableResync(this.reliableRooms.get(room), error.details);
                }
            }
        }
    }

    // Internal method to join room without tracking
    async _joinRoom(room) {
        const state = await this._prepareReliableRoom(room);
        if (state.lastSeq === null) state.epoch = this.reliableServerEpoch;
        const data = { room, epoch: state.epoch };
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
            const cursor = afterSeq === undefined ? await this._loadReliableCursor(room) : null;
            state = {
                room,
                lastSeq: afterSeq ?? cursor?.seq ?? null,
                epoch: cursor ? cursor.epoch : this.reliableServerEpoch,
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
                epoch: this.reliableServerEpoch,
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
            await this._saveReliableCursor(state.room, seq, { epoch: state.epoch });
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
        state.replayPromise = this.send('sx_replay', { room: state.room, fromSeq, epoch: state.epoch })
            .then(async (result) => {
                if (result?.status !== 'resync_required') return;
                await this.send('sx_leave', { room: state.room });
                await this._notifyReliableResync(state, result);
            })
            .catch((error) => {
                state.lastReplayFrom = null;
                this.log.error(`> Failed to replay reliable room ${state.room}:`, error);
            })
            .finally(() => {
                state.replayPromise = null;
            });
    }

    async _notifyReliableResync(state, details) {
        state.resyncRequired = details;
        this.joinedRooms.delete(state.room);
        this.log.error(`> Reliable room requires resynchronization: ${state.room}`, details);
        const handler = this.messageHandlers.get('sx_resync_required');
        if (handler) {
            try {
                await handler({ room: state.room, ...details }, this.socket);
            } catch (error) {
                this.log.error('> Error in resynchronization handler:', error);
            }
        }
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

            const attemptConnection = async () => {
                if (this.socket) {
                    this.socket.disconnect();
                }
                const reliableId = await this.reliableIdPromise;
                this.serverReliable = false;
                this.reliableReadyPromise = null;
                this.opts.auth = { token, reliableId, reliableEnabled: this.reliable.enabled };
                this.socket = io(this.url, this.opts);
                const socket = this.socket;

                this.socket.on('connect', () => {
                    this.log.info('> connect');
                    this.isConnected = true;
                    retryCount = 0; // Reset retry count on successful connection
                    this._setupMessageRouting(); // Setup message routing after connection
                });

                this.socket.on('connect_error', (error) => {
                    this.isConnected = false;
                    if (!socket.active) {
                        if (timer) clearTimeout(timer);
                        this.log.warn(`> Connection rejected: ${error.message}`);
                        reject(error);
                        return;
                    }
                    retryCount++;
                    const delay = Math.min(1000 * Math.pow(2, retryCount - 1), this.opts.reconnectionDelayMax);
                    this.log.warn(`> connect_error (attempt ${retryCount}): ${error.message}, retrying in ${delay}ms`);
                    // Don't reject, let Socket.IO handle reconnection
                });

                this.socket.on('disconnect', () => {
                    this.log.info('> disconnect');
                    this.isConnected = false;
                    this.serverReliable = false;
                    this.reliableReadyPromise = null;
                });

                this.socket.on('sx_reliable_ready', ({ nextSeq, epoch = null }) => {
                    this.reliableServerEpoch = epoch;
                    if (!this.reliable.enabled) return;
                    this.reliableReadyPromise = Promise.resolve().then(async () => {
                        if (!Number.isSafeInteger(nextSeq) || nextSeq < 1
                            || (epoch !== null && (typeof epoch !== 'string' || epoch.length === 0))) {
                            throw new Error('Invalid reliable server state');
                        }
                        await this._adoptReliableServerSequence(nextSeq, epoch);
                        if (this.socket !== socket || !this.isConnected) return;
                        this.serverReliable = true;
                        this._scheduleReliableOutboxFlush();
                    });
                    this.reliableReadyPromise.catch((error) => this._blockReliableOutbox(error));
                });

                this.socket.on('auth_success', async (data) => {
                    if (timer) clearTimeout(timer);
                    this.log.info('> auth_success', data);
                    if (this.reliable.enabled) {
                        if (!this.reliableReadyPromise) {
                            const error = new Error('Server does not support reliable client delivery');
                            error.code = 'RELIABLE_UNSUPPORTED';
                            this.socket.disconnect();
                            reject(error);
                            return;
                        }
                        try {
                            await this.reliableReadyPromise;
                        } catch (error) {
                            this.socket.disconnect();
                            reject(error);
                            return;
                        }
                    }
                    await this.processQueue();
                    await this.rejoinRooms();
                    this._scheduleReliableOutboxFlush();
                    resolve(data);
                });
            };

            attemptConnection().catch(reject);
        });
    }

    disconnect() {
        if (this.socket) {
            this.log.info('> Disconnecting');
            this.isConnected = false;
            this.serverReliable = false;
            this.reliableReadyPromise = null;
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
