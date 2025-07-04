import SxServer from './server.js';
import { createServer } from 'http';

const httpServer = createServer();

// Ejemplo 1: Uso por defecto (memoria)
const server1 = new SxServer({ server: httpServer });

// Ejemplo 2: Persistencia personalizada
const messages = new Map();

const server2 = new SxServer({ 
    server: httpServer,
    onAdd: (room, message) => {
        if (!messages.has(room)) messages.set(room, []);
        messages.get(room).push(message);
        console.log(`Guardado en ${room}:`, message);
    },
    onList: (room) => {
        const msgs = messages.get(room) || [];
        console.log(`Listando ${room}: ${msgs.length} mensajes`);
        return msgs;
    }
});

// Ejemplo 3: Persistencia con archivos
import fs from 'fs';

const server3 = new SxServer({
    server: httpServer,
    onAdd: (room, message) => {
        const file = `./messages-${room}.json`;
        let msgs = [];
        try { msgs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
        msgs.push(message);
        fs.writeFileSync(file, JSON.stringify(msgs));
    },
    onList: (room) => {
        try {
            return JSON.parse(fs.readFileSync(`./messages-${room}.json`, 'utf8'));
        } catch {
            return [];
        }
    }
});