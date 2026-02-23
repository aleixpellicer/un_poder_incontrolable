import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// Serve production build
app.use(express.static(join(__dirname, '..', 'dist')));

/* ── Constants ──────────────────────────────── */
const TICK_RATE = 20;
const ROOM_SIZE = 40;
const HALF_ROOM = ROOM_SIZE / 2 - 1;
const POWER_MIN = 8;
const POWER_MAX = 12;
const PLAYER_RADIUS = 1.0;

const MIN_PLAYERS = 6;          // bots fill up to this minimum
const MAX_PLAYERS = 14;         // hard cap
const RESPAWN_COOLDOWN = 4;     // seconds before respawn
const SPAWN_PROTECTION = 5;     // seconds of invulnerability after spawn/respawn

/* ── Defense Power-ups ─────────────────────── */
const POWERUP_MAX = 3;      // max simultaneous power-ups on the field
const POWERUP_SPAWN_MIN = 8;      // min seconds between spawns
const POWERUP_SPAWN_MAX = 15;     // max seconds between spawns
const POWERUP_RADIUS = 1.5;    // pickup radius
const POWERUP_SHIELD_TIME = 30;     // how long the shield lasts (seconds)
let powerUps = [];                  // { id, x, z, type }
let powerUpIdCounter = 0;
let powerUpSpawnTimer = randPowerUpTimer();

function randPowerUpTimer() {
    return POWERUP_SPAWN_MIN + Math.random() * (POWERUP_SPAWN_MAX - POWERUP_SPAWN_MIN);
}

function spawnPowerUp() {
    if (powerUps.length >= POWERUP_MAX) return;
    const margin = 4;
    const maxCoord = HALF_ROOM - margin;
    let x, z, tooClose;
    let attempts = 0;
    do {
        x = (Math.random() * 2 - 1) * maxCoord;
        z = (Math.random() * 2 - 1) * maxCoord;
        tooClose = false;
        // Don't spawn too close to center or other power-ups
        if (Math.abs(x) < 3 && Math.abs(z) < 3) tooClose = true;
        for (const pu of powerUps) {
            const dx = pu.x - x;
            const dz = pu.z - z;
            if (Math.sqrt(dx * dx + dz * dz) < 5) { tooClose = true; break; }
        }
        // Don't spawn inside arena boxes
        for (const box of arenaBoxes) {
            const halfW = (box.w || 3) / 2 + 1;
            const halfD = (box.d || 3) / 2 + 1;
            if (x > box.x - halfW && x < box.x + halfW &&
                z > box.z - halfD && z < box.z + halfD) {
                tooClose = true; break;
            }
        }
        attempts++;
    } while (tooClose && attempts < 30);

    if (!tooClose) {
        const pu = { id: powerUpIdCounter++, x, z, type: 'shield' };
        powerUps.push(pu);
        io.emit('powerUpSpawned', pu);
        console.log(`  🛡️  Power-up spawned at (${x.toFixed(1)}, ${z.toFixed(1)})`);
    }
}

function checkPowerUpPickups() {
    for (const [, p] of players) {
        if (!p.alive) continue;
        for (let i = powerUps.length - 1; i >= 0; i--) {
            const pu = powerUps[i];
            const dx = p.position.x - pu.x;
            const dz = p.position.z - pu.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist < POWERUP_RADIUS + PLAYER_RADIUS) {
                // Player picks up the power-up!
                p.defenseShield = POWERUP_SHIELD_TIME;
                powerUps.splice(i, 1);
                io.emit('powerUpCollected', { playerId: p.id, playerName: p.name, powerUpId: pu.id, type: pu.type });
                console.log(`  🛡️  ${p.name} picked up defense shield!`);
            }
        }
    }
}

/* ── Arena boxes (cover) ────────────────────── */
const BOX_SIZE = 3;
const BOX_HEIGHT = 4;
const BOX_COUNT = 4;
const BOX_SPEED = 0.8;
const BOX_DIR_CHANGE_MIN = 3;
const BOX_DIR_CHANGE_MAX = 7;
let arenaBoxes = generateBoxes();

function generateBoxes() {
    const boxes = [];
    const minDist = BOX_SIZE * 2.5;
    const margin = 4;
    const maxCoord = HALF_ROOM - margin;

    while (boxes.length < BOX_COUNT) {
        const x = (Math.random() * 2 - 1) * maxCoord;
        const z = (Math.random() * 2 - 1) * maxCoord;

        let tooClose = false;
        for (const b of boxes) {
            const dx = b.x - x;
            const dz = b.z - z;
            if (Math.sqrt(dx * dx + dz * dz) < minDist) { tooClose = true; break; }
        }
        if (Math.abs(x) < 3 && Math.abs(z) < 3) tooClose = true;
        if (!tooClose) {
            const angle = Math.random() * Math.PI * 2;
            const speed = BOX_SPEED * (0.4 + Math.random() * 0.6);
            boxes.push({
                x, z, w: BOX_SIZE, d: BOX_SIZE,
                vx: Math.cos(angle) * speed,
                vz: Math.sin(angle) * speed,
                dirTimer: BOX_DIR_CHANGE_MIN + Math.random() * (BOX_DIR_CHANGE_MAX - BOX_DIR_CHANGE_MIN)
            });
        }
    }
    return boxes;
}

/** Move arena boxes slowly, resolve box-box collisions and keep in-bounds */
function updateBoxes(dt) {
    const margin = 4;
    const maxCoord = HALF_ROOM - margin;
    const minBoxDist = BOX_SIZE * 2.0;

    for (const box of arenaBoxes) {
        box.dirTimer -= dt;
        if (box.dirTimer <= 0) {
            const angle = Math.random() * Math.PI * 2;
            const speed = BOX_SPEED * (0.4 + Math.random() * 0.6);
            box.vx = Math.cos(angle) * speed;
            box.vz = Math.sin(angle) * speed;
            box.dirTimer = BOX_DIR_CHANGE_MIN + Math.random() * (BOX_DIR_CHANGE_MAX - BOX_DIR_CHANGE_MIN);
        }

        box.x += box.vx * dt;
        box.z += box.vz * dt;

        if (box.x < -maxCoord) { box.x = -maxCoord; box.vx = Math.abs(box.vx); }
        if (box.x > maxCoord) { box.x = maxCoord; box.vx = -Math.abs(box.vx); }
        if (box.z < -maxCoord) { box.z = -maxCoord; box.vz = Math.abs(box.vz); }
        if (box.z > maxCoord) { box.z = maxCoord; box.vz = -Math.abs(box.vz); }
    }

    for (let i = 0; i < arenaBoxes.length; i++) {
        for (let j = i + 1; j < arenaBoxes.length; j++) {
            const a = arenaBoxes[i];
            const b = arenaBoxes[j];
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < minBoxDist && dist > 0.001) {
                const overlap = (minBoxDist - dist) / 2;
                const nx = dx / dist;
                const nz = dz / dist;
                a.x -= nx * overlap;
                a.z -= nz * overlap;
                b.x += nx * overlap;
                b.z += nz * overlap;

                const relVx = a.vx - b.vx;
                const relVz = a.vz - b.vz;
                const dot = relVx * nx + relVz * nz;
                if (dot > 0) {
                    a.vx -= dot * nx;
                    a.vz -= dot * nz;
                    b.vx += dot * nx;
                    b.vz += dot * nz;
                }
            } else if (dist <= 0.001) {
                a.x -= 1;
                b.x += 1;
            }

            a.x = Math.max(-maxCoord, Math.min(maxCoord, a.x));
            a.z = Math.max(-maxCoord, Math.min(maxCoord, a.z));
            b.x = Math.max(-maxCoord, Math.min(maxCoord, b.x));
            b.z = Math.max(-maxCoord, Math.min(maxCoord, b.z));
        }
    }
}

/** Check if a segment from (ax,az)->(bx,bz) intersects an axis-aligned box */
function segmentIntersectsBox(ax, az, bx, bz, box) {
    const halfW = box.w / 2 + 0.2;
    const halfD = box.d / 2 + 0.2;
    const minX = box.x - halfW;
    const maxX = box.x + halfW;
    const minZ = box.z - halfD;
    const maxZ = box.z + halfD;

    let tMin = 0, tMax = 1;
    const dx = bx - ax;
    const dz = bz - az;

    if (Math.abs(dx) < 1e-8) {
        if (ax < minX || ax > maxX) return false;
    } else {
        let t1 = (minX - ax) / dx;
        let t2 = (maxX - ax) / dx;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) return false;
    }

    if (Math.abs(dz) < 1e-8) {
        if (az < minZ || az > maxZ) return false;
    } else {
        let t1 = (minZ - az) / dz;
        let t2 = (maxZ - az) / dz;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) return false;
    }

    return true;
}

function hasLineOfSight(fromPos, toPos) {
    for (const box of arenaBoxes) {
        if (segmentIntersectsBox(fromPos.x, fromPos.z, toPos.x, toPos.z, box)) {
            return false;
        }
    }
    return true;
}

function resolveBoxCollisions(pos) {
    for (const box of arenaBoxes) {
        const halfW = box.w / 2 + PLAYER_RADIUS;
        const halfD = box.d / 2 + PLAYER_RADIUS;

        if (pos.x > box.x - halfW && pos.x < box.x + halfW &&
            pos.z > box.z - halfD && pos.z < box.z + halfD) {
            const overlapLeft = (box.x - halfW) - pos.x;
            const overlapRight = (box.x + halfW) - pos.x;
            const overlapBack = (box.z - halfD) - pos.z;
            const overlapFront = (box.z + halfD) - pos.z;

            const absL = Math.abs(overlapLeft);
            const absR = Math.abs(overlapRight);
            const absB = Math.abs(overlapBack);
            const absF = Math.abs(overlapFront);

            const minOverlap = Math.min(absL, absR, absB, absF);
            if (minOverlap === absL) pos.x = box.x - halfW;
            else if (minOverlap === absR) pos.x = box.x + halfW;
            else if (minOverlap === absB) pos.z = box.z - halfD;
            else pos.z = box.z + halfD;
        }
    }
}

/* ── State ──────────────────────────────────── */
const players = new Map();

/** The ID of the player currently charging the power */
let chargedPlayerId = null;
let lastChargedPlayerId = null;
let chargeTimer = 0;
let chargeDuration = randCharge();

function randCharge() {
    return POWER_MIN + Math.random() * (POWER_MAX - POWER_MIN);
}

const SPAWN_COLORS = [
    '#ff4466', '#00ffc8', '#ff8800', '#aa55ff',
    '#00aaff', '#ffee00', '#ff55aa', '#55ff88',
    '#ff6633', '#33ccff', '#ff33aa', '#88ff33'
];
let colorIndex = 0;

/** Generate a random spawn position (high in the sky so player falls down) */
function getSpawnPosition() {
    const angle = Math.random() * Math.PI * 2;
    const radius = 8 + Math.random() * 8;
    return {
        x: Math.cos(angle) * radius,
        y: 30,
        z: Math.sin(angle) * radius
    };
}

class Player {
    constructor(id, name) {
        this.id = id;
        this.name = name;
        this.position = getSpawnPosition();
        this.rotation = 0;
        this.alive = true;
        this.color = SPAWN_COLORS[colorIndex++ % SPAWN_COLORS.length];
        this.kills = 0;
        this.totalKills = 0;       // lifetime kills
        this.deaths = 0;
        this.isBot = false;

        // Survival time tracking
        this.aliveStartTime = Date.now();   // when this life began
        this.survivalTime = 0;              // current survival time in seconds (updated each tick)
        this.bestSurvivalTime = 0;          // best ever survival time

        // Respawn
        this.respawnTimer = 0;              // countdown in seconds (0 = alive or ready)

        // Spawn protection — cannot be targeted for N seconds after spawn/respawn
        this.spawnProtection = SPAWN_PROTECTION;

        // Defense shield power-up (seconds remaining, 0 = none)
        this.defenseShield = 0;
    }
}

function serialize(p) {
    return {
        id: p.id, name: p.name, position: { ...p.position }, rotation: p.rotation,
        alive: p.alive,
        color: p.color, kills: p.kills, totalKills: p.totalKills, deaths: p.deaths,
        survivalTime: p.survivalTime,
        bestSurvivalTime: p.bestSurvivalTime,
        respawnTimer: Math.ceil(p.respawnTimer),
        spawnProtection: Math.max(0, p.spawnProtection),
        defenseShield: Math.max(0, p.defenseShield)
    };
}

function allPlayersState() {
    const s = {};
    for (const [id, p] of players) s[id] = serialize(p);
    return s;
}

/* ── Charged player assignment ───────────────── */
function pickChargedPlayer() {
    const alive = [];
    for (const [id, p] of players) {
        if (p.alive && id !== lastChargedPlayerId && p.spawnProtection <= 0) alive.push(id);
    }
    if (alive.length === 0) {
        for (const [id, p] of players) {
            if (p.alive && p.spawnProtection <= 0) alive.push(id);
        }
    }
    if (alive.length === 0) {
        chargedPlayerId = null;
        return;
    }
    chargedPlayerId = alive[Math.floor(Math.random() * alive.length)];
    chargeTimer = 0;
    chargeDuration = randCharge();
}

/* ── Player-to-player collision ─────────────── */
function resolvePlayerCollisions() {
    const alivePlayers = [];
    for (const [, p] of players) {
        if (p.alive) alivePlayers.push(p);
    }

    const minDist = PLAYER_RADIUS * 2;

    for (let i = 0; i < alivePlayers.length; i++) {
        for (let j = i + 1; j < alivePlayers.length; j++) {
            const a = alivePlayers[i];
            const b = alivePlayers[j];

            const dx = b.position.x - a.position.x;
            const dz = b.position.z - a.position.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < minDist && dist > 0.001) {
                const overlap = (minDist - dist) / 2;
                const nx = dx / dist;
                const nz = dz / dist;

                a.position.x -= nx * overlap;
                a.position.z -= nz * overlap;
                b.position.x += nx * overlap;
                b.position.z += nz * overlap;

                a.position.x = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, a.position.x));
                a.position.z = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, a.position.z));
                b.position.x = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, b.position.x));
                b.position.z = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, b.position.z));
            } else if (dist <= 0.001) {
                a.position.x -= 0.5;
                b.position.x += 0.5;
            }
        }
    }
}

/* ── Bots ────────────────────────────────────── */
const bots = [];

const BOT_NAMES = [
    'Bot Alfa', 'Bot Beta', 'Bot Gamma', 'Bot Delta',
    'Bot Épsilon', 'Bot Zeta', 'Bot Eta', 'Bot Theta',
    'Bot Iota', 'Bot Kappa'
];

function addBotsToFill() {
    const totalPlayers = players.size;
    const botsNeeded = Math.max(0, MIN_PLAYERS - totalPlayers);
    if (botsNeeded <= 0) return;

    for (let i = 0; i < botsNeeded; i++) {
        const nameIdx = bots.length;
        const name = nameIdx < BOT_NAMES.length ? BOT_NAMES[nameIdx] : `Bot ${nameIdx + 1}`;
        const botId = 'bot-' + name.toLowerCase().replace(/\s/g, '-');

        if (players.has(botId)) continue;

        const bot = new Player(botId, name);
        bot.isBot = true;
        bot.position.y = 0; // bots stay on the ground (no sky-fall)
        bot.targetX = (Math.random() - 0.5) * 30;
        bot.targetZ = (Math.random() - 0.5) * 30;
        bot.moveTimer = 0;
        players.set(botId, bot);
        bots.push(bot);

        io.emit('playerJoined', serialize(bot));
    }
    if (botsNeeded > 0) {
        console.log(`  🤖 Added ${botsNeeded} bots. Total players: ${players.size}`);
    }
}

/** Remove excess bots when real players join */
function trimBots() {
    const realCount = getRealPlayerCount();
    // Only keep bots if we need them to reach MIN_PLAYERS
    const botsNeeded = Math.max(0, MIN_PLAYERS - realCount);
    while (bots.length > botsNeeded) {
        const bot = bots.pop();
        players.delete(bot.id);
        io.emit('playerLeft', bot.id);
        if (chargedPlayerId === bot.id) {
            pickChargedPlayer();
        }
    }
}

function getRealPlayerCount() {
    let count = 0;
    for (const [, p] of players) {
        if (!p.isBot) count++;
    }
    return count;
}

function getAlivePlayers() {
    const alive = [];
    for (const [, p] of players) {
        if (p.alive) alive.push(p);
    }
    return alive;
}

function updateBots(dt) {
    const BOT_SPEED = 6;
    const FLEE_SPEED = 9;

    for (const bot of bots) {
        // Handle bot respawn
        if (!bot.alive) {
            bot.respawnTimer -= dt;
            if (bot.respawnTimer <= 0) {
                respawnPlayer(bot);
            }
            continue;
        }

        let fleeing = false;
        if (chargedPlayerId && chargedPlayerId !== bot.id) {
            const chargedPlayer = players.get(chargedPlayerId);
            if (chargedPlayer && chargedPlayer.alive) {
                const chargePct = chargeTimer / chargeDuration;
                const dx = chargedPlayer.position.x - bot.position.x;
                const dz = chargedPlayer.position.z - bot.position.z;
                const dist = Math.sqrt(dx * dx + dz * dz);

                if (dist < 14 && chargePct > 0.5) {
                    const len = dist || 1;
                    bot.position.x -= (dx / len) * FLEE_SPEED * dt;
                    bot.position.z -= (dz / len) * FLEE_SPEED * dt;
                    bot.rotation = Math.atan2(-dx / len, -dz / len);
                    fleeing = true;
                }
            }
        }

        if (!fleeing) {
            // Try to seek a nearby power-up if bot has no shield
            let seekingPowerUp = false;
            if (bot.defenseShield <= 0 && powerUps.length > 0) {
                let nearestPU = null;
                let nearestDist = Infinity;
                for (const pu of powerUps) {
                    const dx = pu.x - bot.position.x;
                    const dz = pu.z - bot.position.z;
                    const d = Math.sqrt(dx * dx + dz * dz);
                    if (d < nearestDist) { nearestDist = d; nearestPU = pu; }
                }
                if (nearestPU && nearestDist < 12) {
                    const dx = nearestPU.x - bot.position.x;
                    const dz = nearestPU.z - bot.position.z;
                    const dist = Math.sqrt(dx * dx + dz * dz);
                    if (dist > 0.5) {
                        bot.position.x += (dx / dist) * BOT_SPEED * dt;
                        bot.position.z += (dz / dist) * BOT_SPEED * dt;
                        bot.rotation = Math.atan2(dx / dist, dz / dist);
                        seekingPowerUp = true;
                    }
                }
            }

            if (!seekingPowerUp) {
                bot.moveTimer -= dt;
                if (bot.moveTimer <= 0) {
                    bot.targetX = (Math.random() - 0.5) * 34;
                    bot.targetZ = (Math.random() - 0.5) * 34;
                    bot.moveTimer = 2 + Math.random() * 4;
                }

                const dx = bot.targetX - bot.position.x;
                const dz = bot.targetZ - bot.position.z;
                const dist = Math.sqrt(dx * dx + dz * dz);

                if (dist > 0.5) {
                    bot.position.x += (dx / dist) * BOT_SPEED * dt;
                    bot.position.z += (dz / dist) * BOT_SPEED * dt;
                    bot.rotation = Math.atan2(dx / dist, dz / dist);
                }
            }
        }

        bot.position.x = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, bot.position.x));
        bot.position.z = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, bot.position.z));
        resolveBoxCollisions(bot.position);
    }
}

/* ── Respawn logic ──────────────────────────── */
function respawnPlayer(player) {
    player.alive = true;
    player.position = getSpawnPosition();
    if (player.isBot) player.position.y = 0; // bots stay on the ground
    player.respawnTimer = 0;
    player.aliveStartTime = Date.now();
    player.survivalTime = 0;
    player.kills = 0; // reset current-life kills
    player.spawnProtection = SPAWN_PROTECTION; // grant invulnerability

    io.emit('playerRespawned', serialize(player));

    // If this was the charged player, re-pick
    if (chargedPlayerId === player.id) {
        pickChargedPlayer();
    }

    console.log(`  🔄 ${player.name} respawned (${SPAWN_PROTECTION}s protection)`);
}

/* ── Connections ─────────────────────────────── */
io.on('connection', (socket) => {
    console.log(`[+] ${socket.id}`);

    socket.on('join', ({ name }) => {
        const player = new Player(socket.id, name || 'Anónimo');
        players.set(socket.id, player);

        // Trim excess bots when a real player joins
        trimBots();

        socket.emit('joined', {
            id: socket.id,
            player: serialize(player),
            players: allPlayersState(),
            arenaBoxes,
            powerUps
        });
        socket.broadcast.emit('playerJoined', serialize(player));
        console.log(`    ${player.name} joined (${players.size} total, ${getRealPlayerCount()} real, ${bots.length} bots)`);

        // If no charged player yet, pick one
        if (!chargedPlayerId) {
            pickChargedPlayer();
        }

        // Ensure minimum bots
        addBotsToFill();
    });

    // Ping measurement — just acknowledge immediately
    socket.on('clientPing', (_, callback) => {
        if (typeof callback === 'function') callback();
    });

    socket.on('move', (data) => {
        const p = players.get(socket.id);
        if (!p || !p.alive) return;
        p.position.x = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, data.position.x));
        p.position.y = Math.max(0, data.position.y);
        p.position.z = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, data.position.z));
        resolveBoxCollisions(p.position);
        p.rotation = data.rotation ?? 0;
    });

    socket.on('requestRespawn', () => {
        const p = players.get(socket.id);
        if (!p) return;
        if (p.alive) return; // already alive
        if (p.respawnTimer > 0) return; // still on cooldown

        respawnPlayer(p);
    });

    socket.on('disconnect', () => {
        const p = players.get(socket.id);
        players.delete(socket.id);
        io.emit('playerLeft', socket.id);
        console.log(`[-] ${p ? p.name : socket.id} left (${players.size} total)`);

        if (chargedPlayerId === socket.id) {
            pickChargedPlayer();
        }

        // Add bots if needed
        addBotsToFill();
    });
});

/* ── Game Loop ───────────────────────────────── */
let lastTime = Date.now();

function nearestAlive(shooter) {
    let best = null, bestDist = Infinity;
    for (const [id, p] of players) {
        if (id === shooter.id || !p.alive) continue;
        if (p.spawnProtection > 0) continue;  // skip spawn-protected players
        if (!hasLineOfSight(shooter.position, p.position)) continue;
        const dx = p.position.x - shooter.position.x;
        const dy = p.position.y - shooter.position.y;
        const dz = p.position.z - shooter.position.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < bestDist) { bestDist = d; best = p; }
    }
    return { target: best, distance: bestDist };
}

function tick() {
    const now = Date.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    // Update survival times for alive players
    for (const [, p] of players) {
        if (p.alive) {
            p.survivalTime = (now - p.aliveStartTime) / 1000;
            if (p.survivalTime > p.bestSurvivalTime) {
                p.bestSurvivalTime = p.survivalTime;
            }
            // Tick spawn protection countdown
            if (p.spawnProtection > 0) {
                p.spawnProtection -= dt;
                if (p.spawnProtection < 0) p.spawnProtection = 0;
            }
        }
        // Tick respawn cooldown for dead players
        if (!p.alive && p.respawnTimer > 0) {
            p.respawnTimer -= dt;
            if (p.respawnTimer < 0) p.respawnTimer = 0;
        }
    }

    updateBots(dt);
    updateBoxes(dt);
    resolvePlayerCollisions();

    // Also resolve box collisions for all alive players
    for (const [, p] of players) {
        if (p.alive) resolveBoxCollisions(p.position);
    }

    // Tick defense shields
    for (const [, p] of players) {
        if (p.defenseShield > 0) {
            p.defenseShield -= dt;
            if (p.defenseShield < 0) p.defenseShield = 0;
        }
    }

    // Power-up spawning
    powerUpSpawnTimer -= dt;
    if (powerUpSpawnTimer <= 0) {
        spawnPowerUp();
        powerUpSpawnTimer = randPowerUpTimer();
    }

    // Check power-up pickups
    checkPowerUpPickups();

    const powerEvents = [];

    if (chargedPlayerId) {
        const chargedPlayer = players.get(chargedPlayerId);
        if (chargedPlayer && chargedPlayer.alive) {
            chargeTimer += dt;

            if (chargeTimer >= chargeDuration) {
                const { target, distance } = nearestAlive(chargedPlayer);
                if (target) {
                    // Check if target has a defense shield
                    if (target.defenseShield > 0) {
                        // Shield absorbs the hit!
                        target.defenseShield = 0;

                        powerEvents.push({
                            shooterId: chargedPlayer.id, shooterName: chargedPlayer.name,
                            targetId: target.id, targetName: target.name,
                            shooterPos: { ...chargedPlayer.position }, targetPos: { ...target.position },
                            killed: false, shieldBlocked: true, distance
                        });

                        // Notify the shielded player
                        if (!target.isBot) {
                            io.to(target.id).emit('shieldBlocked', {
                                attackerName: chargedPlayer.name
                            });
                        }

                        console.log(`  🛡️  ${target.name}'s shield blocked ${chargedPlayer.name}'s beam!`);
                    } else {
                        // Kill — but they can respawn!
                        // Record survival time before death
                        target.survivalTime = (now - target.aliveStartTime) / 1000;
                        if (target.survivalTime > target.bestSurvivalTime) {
                            target.bestSurvivalTime = target.survivalTime;
                        }

                        target.alive = false;
                        target.respawnTimer = RESPAWN_COOLDOWN;
                        chargedPlayer.kills++;
                        chargedPlayer.totalKills++;
                        target.deaths++;

                        powerEvents.push({
                            shooterId: chargedPlayer.id, shooterName: chargedPlayer.name,
                            targetId: target.id, targetName: target.name,
                            shooterPos: { ...chargedPlayer.position }, targetPos: { ...target.position },
                            killed: true, shieldBlocked: false, distance
                        });

                        // Notify killed player
                        if (!target.isBot) {
                            io.to(target.id).emit('killed', {
                                killedBy: chargedPlayer.name,
                                survivalTime: Math.floor(target.survivalTime),
                                respawnIn: RESPAWN_COOLDOWN
                            });
                        }
                    }
                }

                lastChargedPlayerId = chargedPlayerId;
                pickChargedPlayer();
            }
        } else {
            pickChargedPlayer();
        }
    }

    // Ensure there's always a charged player if there are alive players
    if (!chargedPlayerId) {
        const alive = getAlivePlayers();
        if (alive.length >= 2) {
            pickChargedPlayer();
        }
    }

    const alivePlayers = getAlivePlayers();

    io.emit('gameState', {
        players: allPlayersState(),
        powerEvents,
        chargedPlayerId,
        chargeTimer,
        chargeDuration,
        arenaBoxes,
        powerUps,
        aliveCount: alivePlayers.length,
        totalPlayers: players.size
    });
}

setInterval(tick, 1000 / TICK_RATE);

// Periodically ensure we have enough bots
setInterval(() => {
    addBotsToFill();
}, 5000);

/* ── Start ───────────────────────────────────── */
const PORT = 3000;
httpServer.listen(PORT, () => {
    console.log(`\n⚡  Game server on http://localhost:${PORT}`);
    console.log(`   Continuous mode — players can join anytime!\n`);
    addBotsToFill();
});
