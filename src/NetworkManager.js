import { io } from 'socket.io-client';

export class NetworkManager {
    constructor() {
        this.socket = null;
        this.handlers = {};
    }

    connect(playerName) {
        // In dev (Vite on 5173), connect to localhost:3000
        // In production, connect to the same origin serving the page
        const serverUrl = import.meta.env.DEV ? 'http://localhost:3000' : window.location.origin;
        this.socket = io(serverUrl);
        this.socket.on('connect', () => {
            this.socket.emit('join', { name: playerName });
        });
        // Forward all server events to registered handlers
        [
            'joined', 'playerJoined', 'playerLeft', 'gameState',
            'killed', 'playerRespawned',
            'powerUpSpawned', 'powerUpCollected', 'shieldBlocked'
        ].forEach(evt => {
            this.socket.on(evt, (data) => {
                if (this.handlers[evt]) this.handlers[evt].forEach(fn => fn(data));
            });
        });
    }

    on(event, fn) {
        if (!this.handlers[event]) this.handlers[event] = [];
        this.handlers[event].push(fn);
    }

    sendPosition(position, rotation) {
        if (this.socket && this.socket.connected) {
            this.socket.volatile.emit('move', {
                position: { x: position.x, y: position.y, z: position.z },
                rotation
            });
        }
    }

    requestRespawn() {
        if (this.socket && this.socket.connected) {
            this.socket.emit('requestRespawn');
        }
    }
}
