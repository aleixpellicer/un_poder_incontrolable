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

const MAX_PLAYERS = 10;
const LOBBY_WAIT_SECONDS = 30;
const MATCH_RESTART_DELAY = 8000; // ms after winner is declared before restarting

/* ── Match states ───────────────────────────── */
const MATCH_STATE = {
    LOBBY: 'lobby',       // Waiting for players
    PLAYING: 'playing',   // Match in progress
    ENDED: 'ended'        // Match ended, showing winner
};

/* ── Arena boxes (cover) ────────────────────── */
const BOX_SIZE = 3;
const BOX_HEIGHT = 4;
const BOX_COUNT = 4;
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
        if (!tooClose) boxes.push({ x, z, w: BOX_SIZE, d: BOX_SIZE });
    }
    return boxes;
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

let matchState = MATCH_STATE.LOBBY;
let lobbyTimer = 0;           // seconds elapsed in lobby
let lobbyCountdown = LOBBY_WAIT_SECONDS;
let matchWinner = null;        // player data of winner
let matchRestartTimer = null;  // timeout handle for restart

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

/** Generate a spawn position spread around the arena edges */
function getSpawnPosition(index, total) {
    const angle = (index / total) * Math.PI * 2;
    const radius = 12 + Math.random() * 4;
    return {
        x: Math.cos(angle) * radius,
        y: 0,
        z: Math.sin(angle) * radius
    };
}

class Player {
    constructor(id, name) {
        this.id = id;
        this.name = name;
        this.position = { x: (Math.random() - 0.5) * 30, y: 0, z: (Math.random() - 0.5) * 30 };
        this.rotation = 0;
        this.alive = true;
        this.color = SPAWN_COLORS[colorIndex++ % SPAWN_COLORS.length];
        this.kills = 0;
        this.deaths = 0;
        this.isBot = false;
        this.placement = 0; // final placement (1 = winner)
    }
}

function serialize(p) {
    return {
        id: p.id, name: p.name, position: { ...p.position }, rotation: p.rotation,
        alive: p.alive,
        color: p.color, kills: p.kills, deaths: p.deaths,
        placement: p.placement
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
        if (p.alive && id !== lastChargedPlayerId) alive.push(id);
    }
    if (alive.length === 0) {
        for (const [id, p] of players) {
            if (p.alive) alive.push(id);
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
    const realPlayerCount = getRealPlayerCount();
    const botsNeeded = MAX_PLAYERS - realPlayerCount - bots.length;
    if (botsNeeded <= 0) return;

    for (let i = 0; i < botsNeeded; i++) {
        const nameIdx = bots.length;
        const name = nameIdx < BOT_NAMES.length ? BOT_NAMES[nameIdx] : `Bot ${nameIdx + 1}`;
        const botId = 'bot-' + name.toLowerCase().replace(/\s/g, '-');

        // Skip if bot with this id already exists
        if (players.has(botId)) continue;

        const bot = new Player(botId, name);
        bot.isBot = true;
        bot.targetX = (Math.random() - 0.5) * 30;
        bot.targetZ = (Math.random() - 0.5) * 30;
        bot.moveTimer = 0;
        players.set(botId, bot);
        bots.push(bot);

        // Notify all clients
        io.emit('playerJoined', serialize(bot));
    }
    console.log(`  🤖 Added bots to fill. Total bots: ${bots.length}, Total players: ${players.size}`);
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
    if (matchState !== MATCH_STATE.PLAYING) return;

    const BOT_SPEED = 6;
    const FLEE_SPEED = 9;

    for (const bot of bots) {
        if (!bot.alive) continue;

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

        bot.position.x = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, bot.position.x));
        bot.position.z = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, bot.position.z));
        resolveBoxCollisions(bot.position);
    }
}

/* ── Match management ───────────────────────── */
let nextPlacement = MAX_PLAYERS; // counts down as players die

function startMatch() {
    console.log('\n🎮 MATCH STARTING!');
    matchState = MATCH_STATE.PLAYING;
    matchWinner = null;
    nextPlacement = players.size;

    // Regenerate arena boxes for variety
    arenaBoxes = generateBoxes();

    // Assign spawn positions
    let idx = 0;
    const total = players.size;
    for (const [, p] of players) {
        const spawn = getSpawnPosition(idx, total);
        p.position = spawn;
        p.alive = true;
        p.kills = 0;
        p.deaths = 0;
        p.placement = 0;
        idx++;
    }

    // Reset charge state
    chargedPlayerId = null;
    lastChargedPlayerId = null;
    chargeTimer = 0;
    chargeDuration = randCharge();

    // Pick first charged player
    pickChargedPlayer();

    // Notify all clients that the match started
    io.emit('matchStart', {
        players: allPlayersState(),
        arenaBoxes
    });

    console.log(`  Players in match: ${players.size}`);
}

function endMatch(winner) {
    console.log(`\n🏆 MATCH ENDED! Winner: ${winner.name}`);
    matchState = MATCH_STATE.ENDED;
    winner.placement = 1;
    matchWinner = serialize(winner);

    // Reset charge
    chargedPlayerId = null;
    chargeTimer = 0;

    io.emit('matchEnd', { winner: matchWinner });

    // Schedule restart
    matchRestartTimer = setTimeout(() => {
        resetForNewMatch();
    }, MATCH_RESTART_DELAY);
}

function resetForNewMatch() {
    console.log('\n🔄 Resetting for new match...');

    // Remove all bots
    for (const bot of bots) {
        players.delete(bot.id);
        io.emit('playerLeft', bot.id);
    }
    bots.length = 0;

    // Reset all real players
    colorIndex = 0;
    for (const [, p] of players) {
        p.alive = true;
        p.kills = 0;
        p.deaths = 0;
        p.placement = 0;
        p.color = SPAWN_COLORS[colorIndex++ % SPAWN_COLORS.length];
        p.position = { x: (Math.random() - 0.5) * 30, y: 0, z: (Math.random() - 0.5) * 30 };
    }

    // Reset match state
    matchState = MATCH_STATE.LOBBY;
    lobbyTimer = 0;
    lobbyCountdown = LOBBY_WAIT_SECONDS;
    matchWinner = null;
    chargedPlayerId = null;
    lastChargedPlayerId = null;
    chargeTimer = 0;

    io.emit('matchReset', {
        players: allPlayersState(),
        lobbyCountdown: LOBBY_WAIT_SECONDS
    });

    console.log(`  Real players waiting: ${getRealPlayerCount()}`);

    // If we already have players, start lobby countdown
    if (getRealPlayerCount() > 0) {
        console.log(`  Lobby countdown started: ${LOBBY_WAIT_SECONDS}s`);
    }
}

function checkForWinner() {
    if (matchState !== MATCH_STATE.PLAYING) return;

    const alive = getAlivePlayers();
    if (alive.length <= 1) {
        if (alive.length === 1) {
            endMatch(alive[0]);
        } else {
            // Edge case: everyone died simultaneously — no winner
            console.log('  No survivors — restarting...');
            matchState = MATCH_STATE.ENDED;
            io.emit('matchEnd', { winner: null });
            matchRestartTimer = setTimeout(() => {
                resetForNewMatch();
            }, MATCH_RESTART_DELAY);
        }
    }
}

/* ── Connections ─────────────────────────────── */
io.on('connection', (socket) => {
    console.log(`[+] ${socket.id}`);

    socket.on('join', ({ name }) => {
        const player = new Player(socket.id, name || 'Anónimo');
        players.set(socket.id, player);

        // Determine remaining lobby time
        let remainingLobby = LOBBY_WAIT_SECONDS;
        if (matchState === MATCH_STATE.LOBBY && lobbyTimer > 0) {
            remainingLobby = Math.max(0, LOBBY_WAIT_SECONDS - lobbyTimer);
        }

        socket.emit('joined', {
            id: socket.id,
            player: serialize(player),
            players: allPlayersState(),
            arenaBoxes,
            matchState,
            lobbyCountdown: Math.ceil(remainingLobby),
            matchWinner
        });
        socket.broadcast.emit('playerJoined', serialize(player));
        console.log(`    ${player.name} joined (${players.size} total, ${getRealPlayerCount()} real, ${bots.length} bots)`);

        // If we're in lobby and this is the first real player, start the countdown
        if (matchState === MATCH_STATE.LOBBY && getRealPlayerCount() === 1 && lobbyTimer === 0) {
            console.log(`  ⏳ Lobby countdown started: ${LOBBY_WAIT_SECONDS}s`);
        }

        // If we're in ENDED state and a new player joins, they'll just wait for the reset
    });

    socket.on('move', (data) => {
        const p = players.get(socket.id);
        if (!p || !p.alive) return;
        if (matchState !== MATCH_STATE.PLAYING) return; // Can't move unless match is playing
        p.position.x = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, data.position.x));
        p.position.y = Math.max(0, data.position.y);
        p.position.z = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, data.position.z));
        resolveBoxCollisions(p.position);
        p.rotation = data.rotation ?? 0;
    });

    socket.on('disconnect', () => {
        const p = players.get(socket.id);
        players.delete(socket.id);
        io.emit('playerLeft', socket.id);
        console.log(`[-] ${p ? p.name : socket.id} left (${players.size} total)`);

        if (chargedPlayerId === socket.id) {
            pickChargedPlayer();
        }

        // Check if match should end (someone leaving could make only 1 alive)
        if (matchState === MATCH_STATE.PLAYING) {
            checkForWinner();
        }

        // If all real players have left during lobby, reset
        if (matchState === MATCH_STATE.LOBBY && getRealPlayerCount() === 0) {
            lobbyTimer = 0;
        }
    });
});

/* ── Game Loop ───────────────────────────────── */
let lastTime = Date.now();

function nearestAlive(shooter) {
    let best = null, bestDist = Infinity;
    for (const [id, p] of players) {
        if (id === shooter.id || !p.alive) continue;
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

    /* ── LOBBY STATE ──────────────────────────── */
    if (matchState === MATCH_STATE.LOBBY) {
        if (getRealPlayerCount() > 0) {
            lobbyTimer += dt;
            lobbyCountdown = Math.max(0, LOBBY_WAIT_SECONDS - lobbyTimer);

            // Check if lobby time is up
            if (lobbyTimer >= LOBBY_WAIT_SECONDS) {
                // Fill remaining slots with bots
                addBotsToFill();
                // Small delay so clients see the bots before match starts
                setTimeout(() => {
                    startMatch();
                }, 500);
                // Set state to prevent re-triggering
                matchState = MATCH_STATE.PLAYING;
                // We'll properly start in the setTimeout above
                // For now, prevent the lobby from continuing
                return;
            }

            // If we already have MAX_PLAYERS, start immediately
            if (players.size >= MAX_PLAYERS) {
                console.log('  ✅ All slots filled! Starting match now.');
                startMatch();
                return;
            }
        }

        // Send lobby state to clients
        io.emit('lobbyState', {
            players: allPlayersState(),
            countdown: Math.ceil(lobbyCountdown),
            totalSlots: MAX_PLAYERS,
            filledSlots: players.size
        });
        return;
    }

    /* ── ENDED STATE ──────────────────────────── */
    if (matchState === MATCH_STATE.ENDED) {
        // Just keep sending state so clients can see the scoreboard
        io.emit('gameState', {
            players: allPlayersState(),
            powerEvents: [],
            chargedPlayerId: null,
            chargeTimer: 0,
            chargeDuration: 1,
            arenaBoxes,
            matchState,
            matchWinner
        });
        return;
    }

    /* ── PLAYING STATE ────────────────────────── */
    updateBots(dt);
    resolvePlayerCollisions();

    // Also resolve box collisions for all alive players
    for (const [, p] of players) {
        if (p.alive) resolveBoxCollisions(p.position);
    }

    const powerEvents = [];

    if (chargedPlayerId) {
        const chargedPlayer = players.get(chargedPlayerId);
        if (chargedPlayer && chargedPlayer.alive) {
            chargeTimer += dt;

            if (chargeTimer >= chargeDuration) {
                const { target, distance } = nearestAlive(chargedPlayer);
                if (target) {
                    // Kill — NO respawn in this mode
                    target.alive = false;
                    chargedPlayer.kills++;
                    target.deaths++;
                    target.placement = nextPlacement--;

                    powerEvents.push({
                        shooterId: chargedPlayer.id, shooterName: chargedPlayer.name,
                        targetId: target.id, targetName: target.name,
                        shooterPos: { ...chargedPlayer.position }, targetPos: { ...target.position },
                        killed: true, distance
                    });

                    // Notify eliminated player
                    if (!target.isBot) {
                        io.to(target.id).emit('eliminated', {
                            placement: target.placement,
                            totalPlayers: players.size,
                            killedBy: chargedPlayer.name
                        });
                    }
                }

                lastChargedPlayerId = chargedPlayerId;
                pickChargedPlayer();
            }
        } else {
            pickChargedPlayer();
        }
    }

    // Check for winner after kills
    checkForWinner();

    // Count alive players
    const alivePlayers = getAlivePlayers();

    io.emit('gameState', {
        players: allPlayersState(),
        powerEvents,
        chargedPlayerId,
        chargeTimer,
        chargeDuration,
        arenaBoxes,
        matchState,
        matchWinner,
        aliveCount: alivePlayers.length,
        totalPlayers: players.size
    });
}

setInterval(tick, 1000 / TICK_RATE);

/* ── Start ───────────────────────────────────── */
const PORT = 3000;
httpServer.listen(PORT, () => {
    console.log(`\n⚡  Game server on http://localhost:${PORT}`);
    console.log(`   Waiting for players... (${MAX_PLAYERS} needed, ${LOBBY_WAIT_SECONDS}s lobby)\n`);
});
