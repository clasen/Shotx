import { Server } from 'socket.io';
import LemonLog from 'lemonlog';
import DeepBase from 'deepbase';
import { isAbsolute } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

const reliableRoomStore = 'sxReliableRooms';
const reliableClientStore = 'sxReliableClients';
const defaultReliableRetentionMs = 24 * 60 * 60 * 1000;
const defaultReliableMaxMessages = 10_000;
const reliableStorages = ['memory', 'disk'];

function snapshotReliableValue(value) {
    return JSON.parse(JSON.stringify(value));
}

function validateReliableConfig(reliable) {
    if (reliable === undefined) {
        return {
            enabled: false,
            retentionMs: defaultReliableRetentionMs,
            maxMessagesPerRoom: defaultReliableMaxMessages,
            identity: null,
            storage: 'memory'
        };
    }
    if (!reliable || typeof reliable !== 'object') {
        throw new Error('reliable must be an object');
    }
    if (reliable.enabled !== undefined && typeof reliable.enabled !== 'boolean') {
        throw new Error('reliable.enabled must be a boolean');
    }
    if (reliable.retentionMs !== undefined
        && (!Number.isSafeInteger(reliable.retentionMs) || reliable.retentionMs <= 0)) {
        throw new Error('reliable.retentionMs must be a positive integer');
    }
    if (reliable.maxMessagesPerRoom !== undefined
        && (!Number.isSafeInteger(reliable.maxMessagesPerRoom) || reliable.maxMessagesPerRoom <= 0)) {
        throw new Error('reliable.maxMessagesPerRoom must be a positive integer');
    }
    if (reliable.identity !== undefined && typeof reliable.identity !== 'function') {
        throw new Error('reliable.identity must be a function');
    }
    if (reliable.storage !== undefined && !reliableStorages.includes(reliable.storage)) {
        throw new Error(`reliable.storage must be one of: ${reliableStorages.join(', ')}`);
    }

    return {
        enabled: reliable.enabled ?? false,
        retentionMs: reliable.retentionMs ?? defaultReliableRetentionMs,
        maxMessagesPerRoom: reliable.maxMessagesPerRoom ?? defaultReliableMaxMessages,
        identity: reliable.identity ?? null,
        storage: reliable.storage ?? 'memory'
    };
}

export default class SxServer {

    constructor(server, opts = {}, { auto404 = true, debug = 'none', reliable, path } = {}) {
        if (!server) {
            throw new Error('HTTP(s) server must be provided');
        }
        if (typeof path !== 'string' || path.trim() === '' || !isAbsolute(path)) {
            throw new Error('path must be an absolute directory path');
        }

        this.log = new LemonLog("SxServer", debug);
        this.reliable = validateReliableConfig(reliable);
        this.reliableEpoch = this.reliable.storage === 'memory' ? uuidv7() : null;

        const defaultOptions = {
            path: '/shotx/',
            cors: {
                origin: '*',
                methods: ['GET', 'POST']
            },
            maxHttpBufferSize: (2 * 1024 * 1024)
        }
        opts = { ...defaultOptions, ...opts };
        this.io = new Server(server, opts);

        if (auto404) {
            server.on('request', (req, res) => {
                if (req.url && req.url.startsWith(opts.path)) return;
                res.writeHead(404);
                res.end();
            });
        }

        this.messageHandlers = new Map();
        this.authHandler = this.defaultAuthHandler;
        this.db = new DeepBase({ path, name: 'shotx', stringify: JSON.stringify });
        this.roomOperations = new Map();
        this.clientOperations = new Map();
        this.memoryRoomStates = new Map();
        this.memoryClientStates = new Map();
        this.reliableSaves = [];
        this.reliableSaveRunning = false;

        // Configurar middleware de autenticación
        this.io.use(async (socket, next) => {
            try {
                const token = socket.handshake?.auth?.token;
                if (!token) {
                    this.log.warn(`<-- [${socket.id}] (AUTH_NULL) Authentication failed: No token provided`);
                    return next(new Error('AUTH_NULL'));
                }
                const auth = await this.authHandler(token, socket);
                if (auth) {
                    socket.auth = auth;
                    const reliableEnabled = socket.handshake?.auth?.reliableEnabled ?? false;
                    if (typeof reliableEnabled !== 'boolean') {
                        return next(new Error('RELIABLE_CONFIG_INVALID'));
                    }
                    socket.reliableClientEnabled = reliableEnabled;
                    if (reliableEnabled) {
                        const clientId = socket.handshake?.auth?.reliableId;
                        if (typeof clientId !== 'string' || clientId.length === 0) {
                            return next(new Error('RELIABLE_ID_REQUIRED'));
                        }
                        let principalId = null;
                        if (this.reliable.identity) {
                            principalId = await this.reliable.identity(auth, socket);
                            if (typeof principalId !== 'string' || principalId.length === 0) {
                                return next(new Error('RELIABLE_IDENTITY_REQUIRED'));
                            }
                        }
                        socket.reliableClientId = clientId;
                        socket.reliableClientKey = JSON.stringify([principalId, clientId]);
                    }
                    next();
                } else {
                    this.log.warn(`<-- [${socket.id}] (AUTH_FAIL) Authentication failed: Invalid credentials`);
                    return next(new Error('AUTH_FAIL'));
                }
            } catch (error) {
                this.log.error(`<-- [${socket.id}] (AUTH_ERROR) Authentication error`, error);
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

    setupListeners() {
        this.io.on('connection', async (socket) => {
            this.log.info(`<-- [${socket.id}] Client connected`);

            // Listener for messages with type-based routing
            socket.on('message', async (message, callback) => {
                await this.handleMessage(socket, message, callback);
            });

            // Listener for disconnection
            socket.on('disconnect', () => {
                this.log.info(`<-- [${socket.id}] Client disconnected`);
            });

            // Listener for errors
            socket.on('error', (error) => {
                this.log.error(`<-- [${socket.id}] Error:`, error);
            });

            try {
                if (socket.reliableClientEnabled || this.reliable.enabled) {
                    const nextSeq = socket.reliableClientEnabled
                        ? await this.getReliableClientNextSeq(socket.reliableClientKey)
                        : undefined;
                    socket.emit('sx_reliable_ready', { epoch: this.reliableEpoch, nextSeq });
                }
                socket.emit('auth_success', socket.auth);
            } catch (error) {
                this.log.error(`<-- [${socket.id}] Reliable initialization failed:`, error);
                socket.disconnect(true);
            }
        });

        // Listener for join room
        this.onMessage('sx_join', async (data, socket) => {
            if (this.reliable.enabled) {
                const replay = await this.replayReliableMessages(data.room, socket, {
                    startSeq: Number.isSafeInteger(data.afterSeq) ? data.afterSeq + 1 : null,
                    hasCursor: Number.isSafeInteger(data.afterSeq),
                    epoch: data.epoch ?? null,
                    joinSocket: true
                });
                if (replay.status === 'resync_required') {
                    return { reliable: replay };
                }
                this.log.info(`<-- [${socket.id}] Joined reliable room: ${data.room}`);
                return { reliable: replay };
            }

            await socket.join(data.room);
            this.log.info(`<-- [${socket.id}] Joined room: ${data.room}`);
            await this.processRoomMessages(data.room);
        });

        // Listener for leave room
        this.onMessage('sx_leave', async (data, socket) => {
            await socket.leave(data.room);
            this.log.info(`<-- [${socket.id}] Left room: ${data.room}`);
        });

        this.onMessage('sx_replay', async (data, socket) => {
            if (!this.reliable.enabled) {
                throw new Error('Reliable room delivery is not configured');
            }
            if (!data || typeof data.room !== 'string' || !Number.isSafeInteger(data.fromSeq) || data.fromSeq < 1) {
                throw new Error('Invalid reliable replay request');
            }
            if (!socket.rooms.has(data.room)) {
                throw new Error(`Socket is not joined to room: ${data.room}`);
            }

            return this.replayReliableMessages(data.room, socket, {
                startSeq: data.fromSeq,
                hasCursor: true,
                epoch: data.epoch ?? null
            });
        });
    }

    async handleMessage(socket, message, callback) {
        const respond = typeof callback === 'function' ? callback : () => {};
        try {
            // Validate that message is an object
            if (!message || typeof message !== 'object') {
                return respond({ meta: { success: false, code: 2001, error: 'Invalid message format' }, data: null });
            }

            const { meta, data } = message;

            // Validate that meta exists and has a valid message type
            if (!meta || typeof meta.type !== 'string') {
                return respond({ meta: { success: false, code: 2002, error: 'Invalid message type' }, data: null });
            }

            this.log.info(`<-- [${socket.id}] - ${meta.type}`, message);

            if (socket.reliableClientEnabled && (meta.seq !== undefined || meta.stream !== undefined)) {
                return respond(await this.handleReliableClientMessage(socket, message));
            }

            respond(await this.executeMessageHandler(socket, meta, data));
        } catch (error) {
            this.log.error(`<-- [${socket.id}] Error al procesar el mensaje:`, error);
            respond({ meta: { success: false, code: 2004, error: error.message || 'Error processing message' }, data: null });
        }
    }

    async executeMessageHandler(socket, meta, data) {
        const handler = this.messageHandlers.get(meta.type);
        if (!handler) {
            return { meta: { success: false, code: 2003, error: `Unknown message type: ${meta.type}` }, data: null };
        }

        try {
            const result = await handler(data, socket, meta);
            return { meta: { success: true }, data: result };
        } catch (error) {
            this.log.error(`<-- [${socket.id}] Error al procesar el mensaje:`, error);
            return { meta: { success: false, code: 2004, error: error.message || 'Error processing message' }, data: null };
        }
    }

    to(room) {
        const roomSender = {
            send: (type, data) => {
                if (this.reliable.enabled) {
                    return this._sendReliableRoomMessage(room, type, data);
                }

                const message = {
                    meta: { type },
                    data
                };

                // Check if room has connected clients
                const roomSockets = this.io.sockets.adapter.rooms.get(room);

                if (roomSockets && roomSockets.size > 0) {
                    // Room has connected clients, send message immediately
                    this.log.info(`--> [room:${room}] Sending message: ${type}`, message);
                    this.io.to(room).emit('message', message);
                } else {
                    // Room is offline, persist the message
                    this.log.info(`--> [room:${room}] Room offline, persisting message: ${type}`, message);
                    this.db.add(room, { type, data });
                }
            },
        };

        return roomSender;
    }

    _sendReliableRoomMessage(room, type, data) {
        if (typeof room !== 'string' || typeof type !== 'string') {
            return Promise.reject(new Error('Reliable room and message type must be strings'));
        }

        return this.runRoomOperation(room, async () => {
            const state = await this.loadReliableState(room);
            const now = Date.now();
            this.pruneReliableState(state, now);

            const message = {
                meta: {
                    type,
                    id: uuidv7(),
                    stream: room,
                    seq: state.nextSeq
                },
                data,
                storedAt: now
            };

            const storedMessage = this.reliable.storage === 'memory' ? snapshotReliableValue(message) : message;
            state.nextSeq += 1;
            state.messages.push(storedMessage);
            this.pruneReliableState(state, now);
            await this.saveReliableState(reliableRoomStore, room, state);

            const envelope = this.toReliableEnvelope(message);
            this.io.to(room).emit('message', envelope);
            this.log.info(`--> [room:${room}] Sent reliable message: ${type}`, envelope);

            return { id: message.meta.id, seq: message.meta.seq };
        });
    }

    runRoomOperation(room, operation) {
        const previous = this.roomOperations.get(room) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        this.roomOperations.set(room, current);

        const cleanup = () => {
            if (this.roomOperations.get(room) === current) {
                this.roomOperations.delete(room);
            }
        };
        current.then(cleanup, cleanup);
        return current;
    }

    async loadReliableState(room) {
        if (this.reliable.storage === 'memory') {
            let state = this.memoryRoomStates.get(room);
            if (!state) {
                state = { nextSeq: 1, messages: [] };
                this.memoryRoomStates.set(room, state);
            }
            return state;
        }

        const stored = await this.db.get(reliableRoomStore, room);
        if (stored === null) {
            return { nextSeq: 1, messages: [] };
        }
        if (!Number.isSafeInteger(stored.nextSeq) || stored.nextSeq < 1 || !Array.isArray(stored.messages)) {
            throw new Error(`Corrupt reliable room state: ${room}`);
        }
        for (let index = 0; index < stored.messages.length; index += 1) {
            const message = stored.messages[index];
            const previous = stored.messages[index - 1];
            if (!Number.isSafeInteger(message?.meta?.seq)
                || message.meta.seq < 1
                || !Number.isSafeInteger(message.storedAt)
                || message.storedAt < 0
                || (previous && message.meta.seq !== previous.meta.seq + 1)) {
                throw new Error(`Corrupt reliable room log: ${room}`);
            }
        }
        if (stored.messages.at(-1)?.meta?.seq >= stored.nextSeq) {
            throw new Error(`Corrupt reliable room sequence: ${room}`);
        }
        return stored;
    }

    pruneReliableState(state, now) {
        const cutoff = now - this.reliable.retentionMs;
        state.messages = state.messages
            .filter((message) => message.storedAt >= cutoff)
            .slice(-this.reliable.maxMessagesPerRoom);
    }

    toReliableEnvelope(message) {
        return {
            meta: { ...message.meta },
            data: message.data
        };
    }

    replayReliableMessages(room, socket, { startSeq, hasCursor, joinSocket = false, epoch = this.reliableEpoch }) {
        return this.runRoomOperation(room, async () => {
            const state = await this.loadReliableState(room);
            const originalLength = state.messages.length;
            this.pruneReliableState(state, Date.now());
            if (state.messages.length !== originalLength) {
                await this.saveReliableState(reliableRoomStore, room, state);
            }

            const latestSeq = state.nextSeq - 1;
            const earliestSeq = state.messages[0]?.meta?.seq ?? state.nextSeq;
            const requestedSeq = startSeq ?? earliestSeq;

            if (hasCursor && epoch !== this.reliableEpoch) {
                return {
                    status: 'resync_required',
                    reason: 'server_restarted',
                    earliestSeq,
                    latestSeq
                };
            }
            if (hasCursor && requestedSeq < earliestSeq && requestedSeq <= latestSeq) {
                return {
                    status: 'resync_required',
                    reason: 'cursor_expired',
                    earliestSeq,
                    latestSeq
                };
            }
            if (hasCursor && requestedSeq > latestSeq + 1) {
                return {
                    status: 'resync_required',
                    reason: 'cursor_ahead',
                    earliestSeq,
                    latestSeq
                };
            }

            if (joinSocket) {
                await socket.join(room);
            }

            let replayed = 0;
            for (const message of state.messages) {
                if (message.meta.seq < requestedSeq) continue;
                socket.emit('message', this.toReliableEnvelope(message));
                replayed += 1;
            }

            return { status: 'ok', replayed, earliestSeq, latestSeq };
        });
    }

    runClientOperation(clientKey, operation) {
        const previous = this.clientOperations.get(clientKey) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        this.clientOperations.set(clientKey, current);

        const cleanup = () => {
            if (this.clientOperations.get(clientKey) === current) {
                this.clientOperations.delete(clientKey);
            }
        };
        current.then(cleanup, cleanup);
        return current;
    }

    saveReliableState(store, key, state) {
        if (this.reliable.storage === 'memory') {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            this.reliableSaves.push({ store, key, state, resolve, reject });
            if (!this.reliableSaveRunning) {
                this.reliableSaveRunning = true;
                setImmediate(() => this.flushReliableSaves());
            }
        });
    }

    async flushReliableSaves() {
        const entries = this.reliableSaves;
        this.reliableSaves = [];
        try {
            if (entries.length === 1) {
                const [entry] = entries;
                await this.db.set(entry.store, entry.key, entry.state);
            } else if (entries.length > 1) {
                await this.db.upd((root) => {
                    if (root === null || typeof root !== 'object' || Array.isArray(root)) {
                        throw new Error('Corrupt persistence root');
                    }
                    for (const entry of entries) {
                        const stored = root[entry.store];
                        if (stored !== undefined && stored !== null && (typeof stored !== 'object' || Array.isArray(stored))) {
                            throw new Error(`Corrupt reliable store: ${entry.store}`);
                        }
                        const storeNode = stored ?? {};
                        Object.defineProperty(storeNode, entry.key, {
                            value: entry.state,
                            writable: true,
                            enumerable: true,
                            configurable: true
                        });
                        Object.defineProperty(root, entry.store, {
                            value: storeNode,
                            writable: true,
                            enumerable: true,
                            configurable: true
                        });
                    }
                    return root;
                });
            }
            for (const entry of entries) entry.resolve();
        } catch (error) {
            for (const entry of entries) entry.reject(error);
        } finally {
            if (this.reliableSaves.length > 0) {
                setImmediate(() => this.flushReliableSaves());
            } else {
                this.reliableSaveRunning = false;
            }
        }
    }

    async loadReliableClientState(clientKey) {
        if (this.reliable.storage === 'memory') {
            let state = this.memoryClientStates.get(clientKey);
            if (!state) {
                state = { nextSeq: 1, responses: [] };
                this.memoryClientStates.set(clientKey, state);
            }
            return state;
        }

        const stored = await this.db.get(reliableClientStore, clientKey);
        if (stored === null) {
            return { nextSeq: 1, responses: [] };
        }
        if (!Number.isSafeInteger(stored.nextSeq) || stored.nextSeq < 1 || !Array.isArray(stored.responses)) {
            throw new Error('Corrupt reliable client state');
        }
        for (let index = 0; index < stored.responses.length; index += 1) {
            const response = stored.responses[index];
            const previous = stored.responses[index - 1];
            if (!Number.isSafeInteger(response?.seq)
                || response.seq < 1
                || typeof response.id !== 'string'
                || !Number.isSafeInteger(response.storedAt)
                || response.storedAt < 0
                || !response.response?.meta
                || (previous && response.seq !== previous.seq + 1)) {
                throw new Error('Corrupt reliable client log');
            }
        }
        if (stored.responses.at(-1)?.seq >= stored.nextSeq) {
            throw new Error('Corrupt reliable client sequence');
        }
        return stored;
    }

    pruneReliableClientState(state, now) {
        const cutoff = now - this.reliable.retentionMs;
        state.responses = state.responses
            .filter((response) => response.storedAt >= cutoff)
            .slice(-this.reliable.maxMessagesPerRoom);
    }

    getReliableClientNextSeq(clientKey) {
        return this.runClientOperation(clientKey, async () => {
            const state = await this.loadReliableClientState(clientKey);
            const originalLength = state.responses.length;
            this.pruneReliableClientState(state, Date.now());
            if (state.responses.length !== originalLength) {
                await this.saveReliableState(reliableClientStore, clientKey, state);
            }
            return state.nextSeq;
        });
    }

    handleReliableClientMessage(socket, message) {
        const { meta, data } = message;
        if (typeof meta.id !== 'string'
            || meta.stream !== socket.reliableClientId
            || !Number.isSafeInteger(meta.seq)
            || meta.seq < 1) {
            return Promise.resolve({
                meta: { success: false, code: 'RELIABLE_INVALID_MESSAGE', error: 'Invalid reliable client message' },
                data: null
            });
        }

        return this.runClientOperation(socket.reliableClientKey, async () => {
            const state = await this.loadReliableClientState(socket.reliableClientKey);
            const now = Date.now();
            this.pruneReliableClientState(state, now);

            if (meta.seq < state.nextSeq) {
                const stored = state.responses.find((entry) => entry.seq === meta.seq);
                if (!stored) {
                    return {
                        meta: {
                            success: false,
                            code: 'RELIABLE_RESYNC_REQUIRED',
                            error: 'Reliable response is no longer retained',
                            expectedSeq: state.nextSeq
                        },
                        data: null
                    };
                }
                if (stored.id !== meta.id) {
                    return {
                        meta: {
                            success: false,
                            code: 'RELIABLE_SEQUENCE_CONFLICT',
                            error: 'Reliable sequence already belongs to another message',
                            expectedSeq: state.nextSeq
                        },
                        data: null
                    };
                }
                return stored.response;
            }

            if (meta.seq > state.nextSeq) {
                return {
                    meta: {
                        success: false,
                        code: 'RELIABLE_REPLAY_REQUIRED',
                        error: 'Reliable client sequence has a gap',
                        expectedSeq: state.nextSeq
                    },
                    data: null
                };
            }

            const handled = await this.executeMessageHandler(socket, meta, data);
            const response = {
                meta: { ...handled.meta, reliable: true, seq: meta.seq, id: meta.id },
                data: handled.data
            };
            const storedResponse = this.reliable.storage === 'memory' ? snapshotReliableValue(response) : response;
            state.nextSeq += 1;
            state.responses.push({
                seq: meta.seq,
                id: meta.id,
                response: storedResponse,
                storedAt: now
            });
            this.pruneReliableClientState(state, now);
            await this.saveReliableState(reliableClientStore, socket.reliableClientKey, state);
            return response;
        });
    }

    async processRoomMessages(room) {
        try {
            const pendingMessages = await this.db.values(room) || [];

            if (pendingMessages.length > 0) {
                this.log.info(`--> [room:${room}] Processing ${pendingMessages.length} pending messages`);

                for (const msg of pendingMessages) {
                    const message = {
                        meta: {
                            type: msg.type
                        },
                        data: msg.data
                    };

                    this.io.to(room).emit('message', message);
                    this.log.info(`--> [room:${room}] Sent pending message: ${msg.type}`, message);
                }

                // Clear processed messages
                await this.db.del(room);
            }
        } catch (error) {
            this.log.error(`Error processing room messages for ${room}:`, error);
        }
    }
}
