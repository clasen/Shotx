import { io } from 'socket.io-client';
import LemonLog from 'lemonlog';
import { v7 as uuidv7 } from 'uuid';

const log = new LemonLog("SxClient");

export default class SxClient {
    constructor({ url, token } = {}) {
        this.url = url || 'http://localhost:3000';
        this.token = token || uuidv7();
        this.socket = null;
        this.isConnected = false;
        this.offlineQueue = [];

        // Add default event name for routing
        this.routeEvent = 'message';
    }

    // ============ Main send method ============
    async emit(eventName, data, meta = {}) {
        // Add UUID to meta
        meta.id = uuidv7();
        
        // If offline, queue the message
        if (!this.isConnected) {
            log.info('--> Offline. Queuing message:', data);
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
            log.info(`--> emit: ${eventName}`, message);

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
            log.info(`--> processQueue (${this.offlineQueue.length} messages).`);
        }

        while (this.offlineQueue.length > 0) {
            const { eventName, data, meta } = this.offlineQueue.shift();
            try {
                await this._emitMessage(eventName, data, meta);
            } catch (error) {
                log.error('--> Error processQueue', error);
            }
        }
    }

    // Connect to the server with a token
    async connect() {
        if (this.isConnected) {
            return;
        }

        return new Promise((resolve, reject) => {
            this.socket = io(this.url, { auth: { token: this.token } });

            this.socket.on('connect', () => {
                log.info('--> Connected to server');
                this.isConnected = true;
            });

            this.socket.on('connect_error', (error) => {
                log.error('--> Connection error:', error.message);
                this.isConnected = false;
            });

            this.socket.on('auth_success', (data) => {
                log.info('--> auth success:', data);
                this.processQueue();
                resolve(data);
            });
        });
    }

    disconnect() {
        if (this.socket) {
            log.info('--> Disconnecting');
            this.isConnected = false;
            this.socket.disconnect();
            this.socket = null;
        }
    }

    async send(type, data) {
        const meta = { type };
        return this.emit(this.routeEvent, data, meta);
    }
} 