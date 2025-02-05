import { io } from 'socket.io-client';
import LemonLog from 'lemonlog';
import { v7 as uuidv7 } from 'uuid';

const log = new LemonLog("SxClient");

export class SxClient {
    constructor(args = {}) {
        this.url = args.url || 'http://localhost:3000';
        this.token = args.token || uuidv7();
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
            log.info('CLIENT --> Offline. Queuing message:', data);
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
            log.info(`CLIENT --> Sending:`, message);

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
            log.info(`CLIENT --> Processing offline queue (${this.offlineQueue.length} messages).`);
        }

        while (this.offlineQueue.length > 0) {
            const { eventName, data, meta } = this.offlineQueue.shift();
            try {
                await this._emitMessage(eventName, data, meta);
            } catch (error) {
                log.error('CLIENT --> Error sending offline message:', error);
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
                log.info('CLIENT --> Connected to server');
                this.isConnected = true;
            });

            this.socket.on('connect_error', (error) => {
                log.error('CLIENT --> Connection error:', error.message);
                this.isConnected = false;
            });

            this.socket.on('auth_success', (data) => {
                log.info('CLIENT --> auth success:', data);
                this.processQueue();
                resolve(data);
            });

            this.socket.on('new_message', (message) => {
                log.info('CLIENT <-- new_message:', message);
            });
        });
    }

    disconnect() {
        if (this.socket) {
            log.info('CLIENT --> Disconnecting');
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