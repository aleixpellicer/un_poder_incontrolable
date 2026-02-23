import * as THREE from 'three';
import { SceneManager } from './SceneManager.js';
import { PlayerController } from './PlayerController.js';
import { NetworkManager } from './NetworkManager.js';
import { HUD } from './HUD.js';
import { PlayerModel } from './PlayerModel.js';
import { PowerEffect } from './PowerEffect.js';
import { ChargingBeam } from './ChargingBeam.js';
import { DashDust } from './DashDust.js';

export class Game {
    constructor(cachedAssets) {
        this.scene = new SceneManager();
        this.network = new NetworkManager();
        this.hud = new HUD();
        this.ctrl = null;
        this.localId = null;

        this.remotes = new Map();       // id → { model, targetPos, data }
        this.effects = [];              // PowerEffect[]
        this.chargingBeam = null;       // ChargingBeam (live preview)
        this.dashDust = null;           // DashDust particle system
        this._wasDashing = false;       // track dash start for burst emit
        this.chargeState = { chargedPlayerId: null, chargePct: 0 };
        this._isTargeted = false;       // whether local player is the nearest target
        this.clock = new THREE.Clock();
        this.sendAcc = 0;

        /** Pre-loaded FBX assets (from Preloader) */
        this.cachedAssets = cachedAssets || null;

        /** Arena cover boxes (from server) */
        this.arenaBoxes = [];

        /** Player state */
        this.isAlive = true;
        this.localPlayerData = null;

        /** Spawn protection tracking */
        this._hasSpawnProtection = false;

        /** FPS tracking */
        this._fpsFrames = 0;
        this._fpsAccum = 0;
        this._fpsCurrent = 0;
        this._fpsMin = Infinity;
        this._fpsMax = 0;
        this._fpsWarmup = 2; // seconds to skip before tracking min/max
        this._ping = 0;     // server latency in ms

        /** Reusable Vector3 to reduce GC pressure in _onState */
        this._tmpVec3 = new THREE.Vector3();

        /** Throttle leaderboard DOM rebuilds (max 2x/sec) */
        this._leaderboardThrottle = 0;
        this._leaderboardInterval = 0.5; // seconds between rebuilds

        /** Queue for staggering name sprite rebuilds across frames */
        this._pendingNameUpdates = [];
        this._nameUpdatesPerFrame = 2; // max sprites rebuilt per frame

        /** Serialise _addRemote calls to avoid concurrent heavy cloning */
        this._addRemoteQueue = [];
        this._addRemoteRunning = false;

        /** PowerEffect object pool (pre-created, reused) */
        this._effectPool = [];
        this._effectPoolSize = 4;

        /** Whether the render loop is already running */
        this._loopRunning = false;
    }

    /* ── Bootstrap ─────────────────────────────── */
    preInitScene() {
        this.scene.init();
        // Pre-create persistent objects and warm all shaders with real render passes
        this._warmUpGPU();
    }

    /**
     * Full GPU warm-up: pre-creates persistent game objects (ChargingBeam,
     * DashDust, PowerEffect pool) and does actual render passes to force
     * the GPU driver to fully compile and cache every shader pipeline.
     *
     * `renderer.compile()` alone is not enough on many drivers — they
     * still defer actual machine-code generation until the first real draw.
     * So we render the scene twice with all materials visible.
     */
    _warmUpGPU() {
        const scene = this.scene.scene;
        const camera = this.scene.camera;
        const renderer = this.scene.renderer;
        if (!renderer || !scene || !camera) return;

        const tempDummies = []; // things we remove after warm-up

        try {
            // ── 1. Pre-create ChargingBeam (persists for the whole game) ──
            this.chargingBeam = new ChargingBeam();
            scene.add(this.chargingBeam.group);
            // Make it visible for the warm-up render
            const dummyFrom = new THREE.Vector3(0, 1, 0);
            const dummyTo = new THREE.Vector3(3, 1, 3);
            this.chargingBeam.update(dummyFrom, dummyTo, 0.5);

            // ── 2. Pre-create DashDust (persists for the whole game) ──
            this.dashDust = new DashDust();
            scene.add(this.dashDust.group);
            // Emit a dummy burst so the material gets compiled
            this.dashDust.emit(dummyFrom, new THREE.Vector3(1, 0, 0));

            // ── 3. Pre-create PowerEffect pool (reused during gameplay) ──
            for (let i = 0; i < this._effectPoolSize; i++) {
                const fx = new PowerEffect(dummyFrom, dummyTo, i % 2 === 0 ? '#ff4466' : '#00ffc8');
                fx.group.visible = true;  // visible for the warm-up render
                scene.add(fx.group);
                this._effectPool.push(fx);
            }

            // ── 4. Temporary PlayerModel with shield to warm those shaders ──
            if (this.cachedAssets) {
                const pm = PlayerModel.loadFromCache('#ff4466', this.cachedAssets);
                pm.setShield(true);
                pm.shieldSphere.visible = true;
                pm.shieldSphere.material.uniforms.uOpacity.value = 1;
                pm.mesh.position.set(0, 0, 0);
                scene.add(pm.mesh);
                tempDummies.push({ group: pm.mesh, dispose: () => pm.dispose() });
            }

            // ── 5. Force compile + ACTUAL RENDER PASS (this is the key!) ──
            renderer.compile(scene, camera);
            renderer.render(scene, camera);
            // Second render to ensure all deferred GPU work is done
            renderer.render(scene, camera);

        } catch (e) {
            console.warn('GPU warm-up error (non-fatal):', e);
        }

        // ── Clean up temp dummies (PlayerModel) ──
        for (const d of tempDummies) {
            scene.remove(d.group);
            try { d.dispose(); } catch (_) { /* ok */ }
        }

        // ── Hide the pre-created objects until the game actually starts ──
        this.chargingBeam.hide();

        // Clean up the DashDust warm-up particles
        this.dashDust.update(10); // advance far enough to kill all particles

        // Hide and reset all pooled PowerEffects
        for (const fx of this._effectPool) {
            fx.group.visible = false;
            scene.remove(fx.group);
        }

        // Clear the canvas so the user doesn't see the warm-up frame
        renderer.clear();
    }

    /**
     * Get a PowerEffect from the pool, or create a new one if pool is empty.
     * Pool objects are recycled when their animation completes.
     */
    _spawnEffect(from, to, color) {
        let fx;
        if (this._effectPool.length > 0) {
            // Reuse from pool: dispose old state, re-init
            fx = this._effectPool.pop();
            this.scene.scene.remove(fx.group);
            fx.dispose();
        }
        // Create fresh (either pool was empty, or we recycled)
        fx = new PowerEffect(from, to, color);
        this.scene.scene.add(fx.group);
        this.effects.push(fx);
    }

    start(name) {
        if (!this.scene.renderer) this.scene.init();
        this.hud.show();
        this.network.connect(name);

        this.network.on('joined', async (d) => {
            this.localId = d.id;
            this.isAlive = true;

            // ── Step 1: Create the local player (highest priority) ──
            const model = this.cachedAssets
                ? PlayerModel.loadFromCache(d.player.color, this.cachedAssets)
                : await PlayerModel.load(d.player.color);
            model.setName(d.player.name);
            model.setLocalPlayer(true);  // blue ground circle indicator
            this.scene.scene.add(model.mesh);

            this.ctrl = new PlayerController(model);
            this.ctrl.position.set(d.player.position.x, d.player.position.y, d.player.position.z);

            // If spawning in the sky, start falling
            if (d.player.position.y > 0) {
                this.ctrl.startFalling();
                this.ctrl.model.mesh.position.copy(this.ctrl.position);
            }

            // ── Step 2: ChargingBeam + DashDust already pre-created in _warmUpGPU ──
            // Just make sure they're in the scene (they should be already)
            if (!this.chargingBeam.group.parent) {
                this.scene.scene.add(this.chargingBeam.group);
            }
            if (!this.dashDust.group.parent) {
                this.scene.scene.add(this.dashDust.group);
            }

            // ── Step 3: Start the render loop IMMEDIATELY ──
            // The player sees themselves right away, remotes load in the background
            if (!this._loopRunning) {
                this._loopRunning = true;
                this._loop();
            }

            // ── Step 4: Build arena (spread across next frame) ──
            await new Promise(r => requestAnimationFrame(r));
            this.arenaBoxes = d.arenaBoxes || [];
            this.scene.buildBoxes(this.arenaBoxes);

            // ── Step 5: Power-ups (next frame) ──
            await new Promise(r => requestAnimationFrame(r));
            if (d.powerUps) {
                for (const pu of d.powerUps) {
                    this.scene.addPowerUp(pu);
                }
            }

            // ── Step 6: Remote players (staggered via the queue) ──
            for (const [id, p] of Object.entries(d.players)) {
                if (id !== this.localId) this._addRemote(id, p);
            }

            // Show initial spawn protection
            if (d.player.spawnProtection > 0) {
                this._hasSpawnProtection = true;
                this.hud.showSpawnProtection(d.player.spawnProtection);
                this.hud.showMessage('🛡️ ¡Protección activa! ¡Aléjate del peligro!', 3000);
            }
        });

        // ── Ping measurement (every 2s) ─────────
        this.network.on('joined', () => {
            this._pingInterval = setInterval(() => {
                if (this.network.socket && this.network.socket.connected) {
                    const start = performance.now();
                    this.network.socket.volatile.emit('clientPing', null, () => {
                        this._ping = Math.round(performance.now() - start);
                        this.hud.updatePing(this._ping);
                    });
                }
            }, 2000);
        });

        this.network.on('playerJoined', (p) => {
            if (p.id !== this.localId) {
                this._addRemote(p.id, p);
                this.hud.showMessage(`${p.name} entró a la arena`, 2000);
            }
        });

        this.network.on('playerLeft', (id) => {
            const r = this.remotes.get(id);
            if (r) {
                this.hud.showMessage(`${r.data.name} se fue`, 2000);
                this.scene.scene.remove(r.model.mesh);
                r.model.dispose();
                this.remotes.delete(id);
            }
        });

        this.network.on('gameState', (s) => this._onState(s));

        /* ── Killed (can respawn) ─────────────────── */
        this.network.on('killed', (data) => {
            this.isAlive = false;
            this.hud.showDeathScreen(data.killedBy, data.survivalTime, data.respawnIn);
        });

        /* ── Player respawned ─────────────────────── */
        this.network.on('playerRespawned', (p) => {
            if (p.id === this.localId) {
                // Local player respawned
                this.isAlive = true;
                this.hud.hideDeathScreen();
                if (this.ctrl) {
                    this.ctrl.position.set(p.position.x, p.position.y, p.position.z);
                    this.ctrl.velocity.set(0, 0, 0);
                    this.ctrl.model.mesh.position.copy(this.ctrl.position);
                    this.ctrl.model.setAlive(true);
                    // Fall from the sky on respawn
                    if (p.position.y > 0) {
                        this.ctrl.startFalling();
                    }
                }
                this.hud.showMessage('🔄 ¡Cayendo del cielo! 🛡️ Protección activa', 3000);
                this._hasSpawnProtection = true;
            } else {
                const r = this.remotes.get(p.id);
                if (r) {
                    r.targetPos = new THREE.Vector3(p.position.x, p.position.y, p.position.z);
                    r.model.mesh.position.set(p.position.x, p.position.y, p.position.z);
                    r.data = p;
                    r.model.setAlive(true);
                }
            }
        });

        /* ── Respawn request (button click) ──────── */
        this.hud.onRespawnClick(() => {
            this.network.requestRespawn();
        });

        /* ── Power-up events ──────────────────────── */
        this.network.on('powerUpSpawned', (pu) => {
            this.scene.addPowerUp(pu);
        });

        this.network.on('powerUpCollected', (data) => {
            this.scene.removePowerUp(data.powerUpId);
            if (data.playerId === this.localId) {
                this.hud.showMessage('🛡️ ¡ESCUDO DE DEFENSA ACTIVADO!', 3000);
                this.scene.shake(0.25, 0.2);
            } else {
                this.hud.showMessage(`🛡️ ${data.playerName} recogió un escudo`, 2000);
            }
        });

        this.network.on('shieldBlocked', (data) => {
            this.hud.showMessage(`🛡️ ¡Tu escudo bloqueó el rayo de ${data.attackerName}!`, 3000);
            this.scene.shake(0.5, 0.4);
        });
    }

    /* ── Remote helpers ────────────────────────── */
    _addRemote(id, data) {
        // If already queued or already exists, skip
        if (this.remotes.has(id)) return;
        if (this._addRemoteQueue.some(q => q.id === id)) return;

        this._addRemoteQueue.push({ id, data });
        this._processRemoteQueue();
    }

    async _processRemoteQueue() {
        if (this._addRemoteRunning) return;
        this._addRemoteRunning = true;

        while (this._addRemoteQueue.length > 0) {
            const { id, data } = this._addRemoteQueue.shift();

            // Double-check it hasn't been added while waiting
            if (this.remotes.has(id)) continue;

            // Yield to let the renderer breathe between heavy clones
            await new Promise(r => requestAnimationFrame(r));

            const model = this.cachedAssets
                ? PlayerModel.loadFromCache(data.color, this.cachedAssets)
                : await PlayerModel.load(data.color);
            model.setName(data.name);
            model.setAlive(data.alive);
            this.scene.scene.add(model.mesh);
            model.mesh.position.set(data.position.x, data.position.y, data.position.z);
            this.remotes.set(id, { model, targetPos: null, data, prevPos: null });
        }

        this._addRemoteRunning = false;
    }

    /* ── State sync ────────────────────────────── */
    _onState(state) {
        const chargedPlayerId = state.chargedPlayerId;
        const chargePct = state.chargeDuration > 0
            ? Math.min(state.chargeTimer / state.chargeDuration, 1)
            : 0;

        this.chargeState.chargedPlayerId = chargedPlayerId;
        this.chargeState.chargePct = chargePct;

        // Update alive counter
        if (state.aliveCount !== undefined) {
            this.hud.updateAliveCount(state.aliveCount, state.totalPlayers);
        }

        for (const [id, pd] of Object.entries(state.players)) {
            const isCharged = (id === chargedPlayerId);
            const playerCharge = isCharged ? chargePct : 0;

            if (id === this.localId) {
                this.localPlayerData = pd;
                this.hud.updateLocalPlayer(pd, isCharged, chargePct);
                this.hud.updateShieldStatus(pd.defenseShield || 0);
                if (this.ctrl) {
                    this.ctrl.model.updateCharge(playerCharge, isCharged);
                    this.ctrl.model.setAlive(pd.alive);
                    this.ctrl.model.setShield(pd.defenseShield > 0);
                }
                // Update death screen countdown
                if (!pd.alive && pd.respawnTimer > 0) {
                    this.hud.updateRespawnCountdown(pd.respawnTimer);
                } else if (!pd.alive && pd.respawnTimer <= 0) {
                    this.hud.showRespawnReady();
                }

                // Update spawn protection banner
                if (pd.alive && pd.spawnProtection > 0) {
                    this._hasSpawnProtection = true;
                    this.hud.showSpawnProtection(pd.spawnProtection);
                } else if (this._hasSpawnProtection) {
                    this._hasSpawnProtection = false;
                    this.hud.hideSpawnProtection();
                    if (pd.alive) {
                        this.hud.showMessage('⚠ ¡Protección terminada! ¡Cuidado!', 2500);
                    }
                }
                continue;
            }

            const r = this.remotes.get(id);
            if (r) {
                this._tmpVec3.set(pd.position.x, pd.position.y, pd.position.z);

                if (r.targetPos) {
                    const dist = r.targetPos.distanceTo(this._tmpVec3);
                    if (dist > 0.05) {
                        r.model.play('run');
                    } else {
                        r.model.play('idle');
                    }
                    r.targetPos.copy(this._tmpVec3);
                } else {
                    r.targetPos = new THREE.Vector3(pd.position.x, pd.position.y, pd.position.z);
                }
                r.data = pd;
                r.model.updateCharge(playerCharge, isCharged);
                r.model.setAlive(pd.alive);
                r.model.setShield(pd.defenseShield > 0);
            } else {
                this._addRemote(id, pd);
            }
        }

        // Remove remote players that no longer exist in server state
        for (const [id] of this.remotes) {
            if (!state.players[id]) {
                const r = this.remotes.get(id);
                if (r) {
                    this.scene.scene.remove(r.model.mesh);
                    r.model.dispose();
                    this.remotes.delete(id);
                }
            }
        }

        // Power events — beam effect
        if (state.powerEvents) {
            for (const ev of state.powerEvents) {
                const from = new THREE.Vector3(ev.shooterPos.x, ev.shooterPos.y + 1.5, ev.shooterPos.z);
                const to = new THREE.Vector3(ev.targetPos.x, ev.targetPos.y + 1, ev.targetPos.z);
                const color = ev.shooterId === this.localId ? '#00ffc8' : '#ff4466';
                const fx = new PowerEffect(from, to, color);
                this.scene.scene.add(fx.group);
                this.effects.push(fx);

                const isLocal = ev.shooterId === this.localId || ev.targetId === this.localId;
                this.scene.shake(
                    isLocal ? 0.7 : 0.35,
                    isLocal ? 0.5 : 0.3
                );

                if (ev.shieldBlocked) {
                    // Shield block — different visual/messages
                    if (ev.targetId === this.localId) {
                        this.hud.showMessage(`🛡️ ¡Tu escudo absorbió el rayo de ${ev.shooterName}!`, 3000);
                    } else if (ev.shooterId === this.localId) {
                        this.hud.showMessage(`🛡️ ${ev.targetName} bloqueó tu rayo con su escudo`, 2500);
                    } else {
                        this.hud.showMessage(`🛡️ ${ev.targetName} bloqueó el rayo con su escudo`, 2000);
                    }
                } else if (ev.targetId === this.localId) {
                    this.hud.showMessage(`⚡ ¡ELIMINADO por ${ev.shooterName}!`, 2500);
                } else if (ev.shooterId === this.localId) {
                    this.hud.showMessage(`⚡ ¡RAYO eliminó a ${ev.targetName}!`, 2000);
                } else {
                    this.hud.showMessage(`💀 ${ev.targetName} eliminado por ${ev.shooterName}`, 2000);
                }
            }
        }

        // Throttled leaderboard DOM rebuild (max 2x/sec instead of 20x/sec)
        this._leaderboardThrottle -= 1 / 20; // approximate dt at tick rate
        if (this._leaderboardThrottle <= 0) {
            this._leaderboardThrottle = this._leaderboardInterval;
            this.hud.updateLeaderboard(state.players);
        }

        // Sync power-ups from server state
        if (state.powerUps) {
            this.scene.syncPowerUps(state.powerUps);
        }

        // ── Update 3D name sprites with rank badges ──
        // Queue changed ranks; process a few per frame to avoid stalls
        const sorted = Object.entries(state.players).sort(([, a], [, b]) => {
            if (a.alive && !b.alive) return -1;
            if (!a.alive && b.alive) return 1;
            if (a.alive && b.alive) return b.survivalTime - a.survivalTime;
            return b.bestSurvivalTime - a.bestSurvivalTime;
        });
        let rankIdx = 0;
        for (const [id, pd] of sorted) {
            rankIdx++;
            if (id === this.localId) {
                if (this.ctrl && this.ctrl.model) {
                    const prevRank = this.ctrl.model._currentRank;
                    if (prevRank !== rankIdx) {
                        this._pendingNameUpdates.push({ model: this.ctrl.model, name: pd.name, rank: rankIdx });
                    }
                }
            } else {
                const r = this.remotes.get(id);
                if (r && r.model) {
                    const prevRank = r.model._currentRank;
                    if (prevRank !== rankIdx) {
                        this._pendingNameUpdates.push({ model: r.model, name: pd.name, rank: rankIdx });
                    }
                }
            }
        }

        // Sync arena box positions from server
        if (state.arenaBoxes) {
            this.arenaBoxes = state.arenaBoxes;
            this.scene.updateBoxTargets(this.arenaBoxes);
        }
    }

    /* ── Render loop ───────────────────────────── */
    _loop() {
        requestAnimationFrame(() => this._loop());
        const dt = this.clock.getDelta();

        // ── Process pending name sprite rebuilds (staggered) ──
        if (this._pendingNameUpdates.length > 0) {
            const batch = this._pendingNameUpdates.splice(0, this._nameUpdatesPerFrame);
            for (const upd of batch) {
                upd.model.setNameWithRank(upd.name, upd.rank);
            }
        }

        // ── FPS measurement ─────────────────────
        this._fpsFrames++;
        this._fpsAccum += dt;
        if (this._fpsWarmup > 0) {
            this._fpsWarmup -= dt;
        }
        if (this._fpsAccum >= 0.5) {
            this._fpsCurrent = Math.round(this._fpsFrames / this._fpsAccum);
            const ms = (this._fpsAccum / this._fpsFrames) * 1000; // avg frame time
            if (this._fpsWarmup <= 0) {
                if (this._fpsCurrent < this._fpsMin) this._fpsMin = this._fpsCurrent;
                if (this._fpsCurrent > this._fpsMax) this._fpsMax = this._fpsCurrent;
            }
            this.hud.updateFPS(this._fpsCurrent, ms, this._fpsMin, this._fpsMax);
            this._fpsFrames = 0;
            this._fpsAccum = 0;
        }

        // Local player
        if (this.ctrl) {
            const canMove = this.isAlive;
            const isFalling = this.ctrl.isFalling;
            const wasLanding = this.ctrl._isLanding;

            if (canMove) {
                this.ctrl.update(dt);

                // Camera shake on landing impact
                if (wasLanding === false && this.ctrl._isLanding) {
                    // Just landed!
                    this.scene.shake(0.5, 0.4);
                }

                // ── Dash dust particles (skip while falling) ──
                if (this.dashDust && !isFalling) {
                    const isDashing = this.ctrl._isDashing;
                    if (isDashing && !this._wasDashing) {
                        // Dash just started — big burst
                        this.dashDust.emit(this.ctrl.position, this.ctrl._dashDir);
                    } else if (isDashing) {
                        // Ongoing dash — trail particles
                        this.dashDust.emitTrail(this.ctrl.position, this.ctrl._dashDir, this.ctrl._dashProgress);
                    }
                    this._wasDashing = isDashing;
                }
            } else {
                this.ctrl.model.play('idle');
            }

            // Client-side collision against remote players (skip while falling)
            if (canMove && !this.ctrl.isFalling) {
                const PLAYER_RADIUS = 1.0;
                const minDist = PLAYER_RADIUS * 2;
                for (const [, r] of this.remotes) {
                    if (r.data && !r.data.alive) continue;
                    const rPos = r.model.mesh.position;
                    const dx = this.ctrl.position.x - rPos.x;
                    const dz = this.ctrl.position.z - rPos.z;
                    const dist = Math.sqrt(dx * dx + dz * dz);
                    if (dist < minDist && dist > 0.001) {
                        const overlap = minDist - dist;
                        const nx = dx / dist;
                        const nz = dz / dist;
                        this.ctrl.position.x += nx * overlap;
                        this.ctrl.position.z += nz * overlap;
                        const HALF_ROOM = 19;
                        this.ctrl.position.x = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, this.ctrl.position.x));
                        this.ctrl.position.z = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, this.ctrl.position.z));
                        this.ctrl.model.mesh.position.copy(this.ctrl.position);
                    }
                }

                this._resolveBoxCollisions(this.ctrl.position);
                this.ctrl.model.mesh.position.copy(this.ctrl.position);
            }

            // Drive animation from movement state
            if (canMove) {
                let animState = this.ctrl.moveState;
                if (animState === 'falling') animState = 'idle'; // play idle anim while falling
                if (animState === 'dash' && !this.ctrl.model.actions.dash) animState = 'run';
                this.ctrl.model.play(animState);
            }

            // Tick animation mixer
            this.ctrl.model.tick(dt);

            // Send position at ~20 Hz (only during play)
            if (canMove) {
                this.sendAcc += dt;
                if (this.sendAcc >= 0.05) {
                    this.sendAcc = 0;
                    this.network.sendPosition(this.ctrl.position, this.ctrl.rotation);
                }
            }
        }

        // Interpolate remotes & tick their animations (skip dead players)
        for (const [, r] of this.remotes) {
            if (r.data && !r.data.alive) continue; // dead players are invisible
            if (r.targetPos) r.model.mesh.position.lerp(r.targetPos, 0.15);
            if (r.data) r.model.mesh.rotation.y = r.data.rotation || 0;
            r.model.tick(dt);
        }

        // Dash dust
        if (this.dashDust) this.dashDust.update(dt);

        // Power effects
        for (let i = this.effects.length - 1; i >= 0; i--) {
            const fx = this.effects[i];
            fx.update(dt);
            if (fx.isDone()) {
                this.scene.scene.remove(fx.group);
                fx.dispose();
                this.effects.splice(i, 1);
            }
        }

        // Charging beam preview
        if (this.chargingBeam) {
            const { chargedPlayerId, chargePct } = this.chargeState;
            let localIsTargeted = false;

            if (chargedPlayerId && chargePct > 0 && chargePct < 1) {
                let chargedPos = null;
                if (chargedPlayerId === this.localId && this.ctrl) {
                    chargedPos = this.ctrl.model.mesh.position.clone();
                } else {
                    const r = this.remotes.get(chargedPlayerId);
                    if (r) chargedPos = r.model.mesh.position.clone();
                }

                if (chargedPos) {
                    let nearestPos = null;
                    let nearestDist = Infinity;
                    let nearestIsLocal = false;

                    for (const [id, r] of this.remotes) {
                        if (id === chargedPlayerId) continue;
                        if (r.data && !r.data.alive) continue;
                        if (r.data && r.data.spawnProtection > 0) continue; // skip protected players
                        const pos = r.model.mesh.position;
                        if (!this._hasLineOfSight(chargedPos, pos)) continue;
                        const dx = pos.x - chargedPos.x;
                        const dz = pos.z - chargedPos.z;
                        const dist = Math.sqrt(dx * dx + dz * dz);
                        if (dist < nearestDist) {
                            nearestDist = dist;
                            nearestPos = pos.clone();
                            nearestIsLocal = false;
                        }
                    }

                    if (chargedPlayerId !== this.localId && this.ctrl && this.isAlive && !this._hasSpawnProtection) {
                        const pos = this.ctrl.model.mesh.position;
                        if (this._hasLineOfSight(chargedPos, pos)) {
                            const dx = pos.x - chargedPos.x;
                            const dz = pos.z - chargedPos.z;
                            const dist = Math.sqrt(dx * dx + dz * dz);
                            if (dist < nearestDist) {
                                nearestDist = dist;
                                nearestPos = pos.clone();
                                nearestIsLocal = true;
                            }
                        }
                    }

                    if (nearestPos) {
                        const from = chargedPos.clone();
                        from.y += 1.5;
                        const to = nearestPos.clone();
                        to.y += 1.0;
                        this.chargingBeam.update(from, to, chargePct);

                        if (nearestIsLocal && chargedPlayerId !== this.localId) {
                            localIsTargeted = true;
                        }
                    } else {
                        this.chargingBeam.hide();
                    }
                } else {
                    this.chargingBeam.hide();
                }
            } else {
                this.chargingBeam.hide();
            }

            // Update targeted warning state
            if (localIsTargeted && !this._isTargeted) {
                this._isTargeted = true;
                this.hud.showTargetedWarning(chargePct);
            } else if (localIsTargeted && this._isTargeted) {
                this.hud.showTargetedWarning(chargePct);
            } else if (!localIsTargeted && this._isTargeted) {
                this._isTargeted = false;
                this.hud.hideTargetedWarning();
            }

        } else if (this.chargingBeam) {
            this.chargingBeam.hide();
            if (this._isTargeted) {
                this._isTargeted = false;
                this.hud.hideTargetedWarning();
            }
        }

        // Smoothly interpolate arena box visuals
        this.scene.lerpBoxes(dt);

        // Animate power-ups
        this.scene.updatePowerUps(dt);

        this.scene.render();
    }

    /* ── Line-of-sight helper (2D, matches server) ── */
    _segmentIntersectsBox(ax, az, bx, bz, box) {
        const halfW = (box.w || 3) / 2 + 0.2;
        const halfD = (box.d || 3) / 2 + 0.2;
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

    _hasLineOfSight(fromPos, toPos) {
        for (const box of this.arenaBoxes) {
            if (this._segmentIntersectsBox(fromPos.x, fromPos.z, toPos.x, toPos.z, box)) {
                return false;
            }
        }
        return true;
    }

    /* ── Box collision for local player ────────── */
    _resolveBoxCollisions(pos) {
        const PLAYER_RADIUS = 1.0;
        for (const box of this.arenaBoxes) {
            const halfW = (box.w || 3) / 2 + PLAYER_RADIUS;
            const halfD = (box.d || 3) / 2 + PLAYER_RADIUS;

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
}
