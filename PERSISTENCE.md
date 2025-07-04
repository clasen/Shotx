# Persistencia Flexible en SxServer

## Resumen

SxServer ahora soporta persistencia configurable mediante callbacks, lo que permite cambiar fácilmente entre diferentes técnicas de almacenamiento sin modificar el código principal.

## Conceptos Clave

### Callbacks de Persistencia

El sistema de persistencia se basa en tres callbacks principales:

- **`addMessage(room, message)`**: Guarda un mensaje para una sala específica
- **`getMessages(room)`**: Recupera todos los mensajes pendientes de una sala
- **`clearMessages(room)`**: Elimina todos los mensajes de una sala

### Ventajas

✅ **Flexibilidad**: Cambia entre diferentes sistemas de persistencia sin modificar código  
✅ **Escalabilidad**: Desde memoria simple hasta bases de datos distribuidas  
✅ **Testabilidad**: Fácil usar mocks para testing  
✅ **Compatibilidad**: Mantiene compatibilidad con DeepBase existente  
✅ **Dinámico**: Puedes cambiar la persistencia en tiempo de ejecución  

## Uso Básico

### 1. Persistencia por Defecto (Memoria)

```javascript
import SxServer from './server.js';
import { createServer } from 'http';

const httpServer = createServer();
const server = new SxServer({ server: httpServer });
// Usa persistencia en memoria automáticamente
```

### 2. Persistencia Personalizada en Constructor

```javascript
const customPersistence = {
    async addMessage(room, message) {
        // Tu lógica para guardar mensaje
        console.log(`Saving message for room ${room}:`, message);
    },
    
    async getMessages(room) {
        // Tu lógica para recuperar mensajes
        console.log(`Getting messages for room ${room}`);
        return []; // Array de mensajes
    },
    
    async clearMessages(room) {
        // Tu lógica para limpiar mensajes
        console.log(`Clearing messages for room ${room}`);
    }
};

const server = new SxServer({ 
    server: httpServer,
    persistence: customPersistence 
});
```

### 3. Cambiar Persistencia Dinámicamente

```javascript
const server = new SxServer({ server: httpServer });

// Más tarde...
server.setPersistence({
    async addMessage(room, message) {
        // Nueva implementación
    },
    async getMessages(room) {
        return [];
    },
    async clearMessages(room) {
        // Nueva implementación
    }
});
```

## Ejemplos de Implementaciones

### Persistencia con Archivos JSON

```javascript
import fs from 'fs/promises';
import path from 'path';

const filePersistence = {
    async addMessage(room, message) {
        const dir = './message-storage';
        await fs.mkdir(dir, { recursive: true });
        
        const filePath = path.join(dir, `${room}.json`);
        let messages = [];
        
        try {
            const data = await fs.readFile(filePath, 'utf8');
            messages = JSON.parse(data);
        } catch (error) {
            // Archivo no existe
        }
        
        messages.push({
            ...message,
            timestamp: new Date().toISOString()
        });
        
        await fs.writeFile(filePath, JSON.stringify(messages, null, 2));
    },
    
    async getMessages(room) {
        try {
            const filePath = path.join('./message-storage', `${room}.json`);
            const data = await fs.readFile(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            return [];
        }
    },
    
    async clearMessages(room) {
        try {
            const filePath = path.join('./message-storage', `${room}.json`);
            await fs.unlink(filePath);
        } catch (error) {
            // Archivo no existe
        }
    }
};
```

### Persistencia con Redis

```javascript
import { createClient } from 'redis';

const redis = createClient();
await redis.connect();

const redisPersistence = {
    async addMessage(room, message) {
        await redis.lPush(
            `room:${room}:messages`, 
            JSON.stringify(message)
        );
    },
    
    async getMessages(room) {
        const messages = await redis.lRange(`room:${room}:messages`, 0, -1);
        return messages.map(msg => JSON.parse(msg));
    },
    
    async clearMessages(room) {
        await redis.del(`room:${room}:messages`);
    }
};
```

### Persistencia con Base de Datos

```javascript
// Ejemplo con PostgreSQL/MySQL
const dbPersistence = {
    async addMessage(room, message) {
        await db.query(
            'INSERT INTO room_messages (room, type, data, created_at) VALUES (?, ?, ?, ?)',
            [room, message.type, JSON.stringify(message.data), new Date()]
        );
    },
    
    async getMessages(room) {
        const rows = await db.query(
            'SELECT type, data FROM room_messages WHERE room = ? ORDER BY created_at ASC',
            [room]
        );
        return rows.map(row => ({
            type: row.type,
            data: JSON.parse(row.data)
        }));
    },
    
    async clearMessages(room) {
        await db.query('DELETE FROM room_messages WHERE room = ?', [room]);
    }
};
```

### Persistencia Híbrida con TTL

```javascript
const hybridPersistence = {
    storage: new Map(),
    TTL_MS: 60000, // 1 minuto
    
    async addMessage(room, message) {
        if (!this.storage.has(room)) {
            this.storage.set(room, []);
        }
        
        this.storage.get(room).push({
            ...message,
            expiresAt: Date.now() + this.TTL_MS
        });
    },
    
    async getMessages(room) {
        const now = Date.now();
        const messages = this.storage.get(room) || [];
        
        // Filtrar mensajes expirados
        const validMessages = messages.filter(msg => msg.expiresAt > now);
        this.storage.set(room, validMessages);
        
        return validMessages;
    },
    
    async clearMessages(room) {
        this.storage.delete(room);
    }
};
```

## Migración desde DeepBase

Si ya tienes código usando DeepBase, puedes migrar fácilmente:

### Antes (hardcodeado):
```javascript
// En server.js - línea 26
this.db = new DeepBase({ name: 'shotx' });

// En método to() - línea 148
this.db.add(room, { type, data });

// En processRoomMessages() - líneas 159-160
const pendingMessages = await this.db.values(room) || [];
this.db.del(room);
```

### Después (flexible):
```javascript
import DeepBase from 'deepbase';

const db = new DeepBase({ name: 'shotx' });

const deepBasePersistence = {
    async addMessage(room, message) {
        db.add(room, message);
    },
    
    async getMessages(room) {
        return await db.values(room) || [];
    },
    
    async clearMessages(room) {
        db.del(room);
    }
};

const server = new SxServer({ 
    server: httpServer,
    persistence: deepBasePersistence 
});
```

## Casos de Uso Avanzados

### 1. Persistencia Condicional

```javascript
const conditionalPersistence = {
    async addMessage(room, message) {
        // Solo persistir ciertos tipos de mensajes
        if (message.type === 'chat' || message.type === 'notification') {
            await this.primaryStorage.add(room, message);
        }
    },
    
    async getMessages(room) {
        return await this.primaryStorage.get(room);
    },
    
    async clearMessages(room) {
        await this.primaryStorage.clear(room);
    }
};
```

### 2. Persistencia con Respaldo

```javascript
const backupPersistence = {
    async addMessage(room, message) {
        try {
            await this.primaryDB.add(room, message);
        } catch (error) {
            console.warn('Primary failed, using backup');
            await this.backupDB.add(room, message);
        }
    },
    
    async getMessages(room) {
        try {
            return await this.primaryDB.get(room);
        } catch (error) {
            return await this.backupDB.get(room);
        }
    }
};
```

### 3. Persistencia con Métricas

```javascript
const metricsWrapper = {
    async addMessage(room, message) {
        const start = Date.now();
        await this.storage.add(room, message);
        this.metrics.recordAddTime(Date.now() - start);
        this.metrics.incrementAddCount();
    },
    
    async getMessages(room) {
        const start = Date.now();
        const messages = await this.storage.get(room);
        this.metrics.recordGetTime(Date.now() - start);
        return messages;
    }
};
```

## Testing

La persistencia flexible hace el testing mucho más fácil:

```javascript
// Mock para testing
const mockPersistence = {
    messages: new Map(),
    
    async addMessage(room, message) {
        if (!this.messages.has(room)) {
            this.messages.set(room, []);
        }
        this.messages.get(room).push(message);
    },
    
    async getMessages(room) {
        return this.messages.get(room) || [];
    },
    
    async clearMessages(room) {
        this.messages.delete(room);
    }
};

// En tus tests
const server = new SxServer({ 
    server: httpServer,
    persistence: mockPersistence 
});
```

## Consideraciones de Rendimiento

1. **Memoria**: La persistencia por defecto es rápida pero limitada por RAM
2. **Archivos**: Buena para volúmenes moderados, puede ser lenta con muchas escrituras
3. **Redis**: Excelente para alta concurrencia y velocidad
4. **Base de Datos**: Mejor para persistencia a largo plazo y consultas complejas

## Conclusión

La persistencia flexible mediante callbacks te permite:

- ✅ Empezar simple (memoria) y evolucionar según necesites
- ✅ Cambiar de tecnología sin reescribir código
- ✅ Testear fácilmente con mocks
- ✅ Implementar lógica de negocio específica (TTL, filtros, etc.)
- ✅ Mantener compatibilidad con sistemas existentes