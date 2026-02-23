import * as THREE from 'three';
import { SceneManager } from './SceneManager.js';
import { PlayerController } from './PlayerController.js';
import { NetworkManager } from './NetworkManager.js';
import { HUD } from './HUD.js';
import { PlayerModel } from './PlayerModel.js';
import { PowerEffect } from './PowerEffect.js';
import { ChargingBeam } from './ChargingBeam.js';

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
        this.chargeState = { chargedPlayerId: null, chargePct: 0 };
        this.clock = new THREE.Clock();
        this.sendAcc = 0;

        /** Pre-loaded FBX assets (from Preloader) */
        this.cachedAssets = cachedAssets || null;

        /** Arena cover boxes (from server) */
        this.arenaBoxes = [];

        /** Match state tracking */
        this.matchState = 'lobby';
        this.isEliminated = false;
        this.localPlayerData = null;
    }

    /* ── Bootstrap ─────────────────────────────── */
    preInitScene() {
        this.scene.init();
    }

    start(name) {
        if (!this.scene.renderer) this.scene.init();
        this.hud.show();
        this.network.connect(name);

        this.network.on('joined', async (d) => {
            this.localId = d.id;
            this.matchState = d.matchState || 'lobby';

            const model = this.cachedAssets
                ? PlayerModel.loadFromCache(d.player.color, this.cachedAssets)
                : await PlayerModel.load(d.player.color);
            model.setName(d.player.name);
            this.scene.scene.add(model.mesh);

            this.ctrl = new PlayerController(model);
            this.ctrl.position.set(d.player.position.x, d.player.position.y, d.player.position.z);

            for (const [id, p] of Object.entries(d.players)) {
                if (id !== this.localId) this._addRemote(id, p);
            }

            this.chargingBeam = new ChargingBeam();
            this.scene.scene.add(this.chargingBeam.group);

            this.arenaBoxes = d.arenaBoxes || [];
            this.scene.buildBoxes(this.arenaBoxes);

            // If we joined during lobby, show lobby screen
            if (this.matchState === 'lobby') {
                this.hud.showLobby(d.lobbyCountdown || 30, Object.keys(d.players).length, 10, d.players);
            }

            this._loop();
        });

        this.network.on('playerJoined', (p) => {
            if (p.id !== this.localId) {
                this._addRemote(p.id, p);
                this.hud.showMessage(`${p.name} se unió`, 2000);
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

        /* ── Lobby state updates ────────────────── */
        this.network.on('lobbyState', (s) => {
            this.matchState = 'lobby';
            this.hud.showLobby(s.countdown, s.filledSlots, s.totalSlots, s.players);

            // Update remote players positions during lobby
            for (const [id, pd] of Object.entries(s.players)) {
                if (id === this.localId) continue;
                const r = this.remotes.get(id);
                if (!r) {
                    // New player joined mid-lobby
                    this._addRemote(id, pd);
                }
            }
        });

        /* ── Match Start ────────────────────────── */
        this.network.on('matchStart', (data) => {
            this.matchState = 'playing';
            this.isEliminated = false;
            this.hud.hideLobby();
            this.hud.hideWinner();
            this.hud.hideEliminated();

            // Update arena boxes
            this.arenaBoxes = data.arenaBoxes || [];
            this.scene.buildBoxes(this.arenaBoxes);

            // Reposition all players
            for (const [id, pd] of Object.entries(data.players)) {
                if (id === this.localId && this.ctrl) {
                    this.ctrl.position.set(pd.position.x, pd.position.y, pd.position.z);
                    this.ctrl.velocity.set(0, 0, 0);
                    this.ctrl.model.mesh.position.copy(this.ctrl.position);
                } else {
                    const r = this.remotes.get(id);
                    if (r) {
                        r.targetPos = new THREE.Vector3(pd.position.x, pd.position.y, pd.position.z);
                        r.model.mesh.position.set(pd.position.x, pd.position.y, pd.position.z);
                        r.data = pd;
                        r.model.setAlive(true);
                    }
                }
            }

            this.hud.showMessage('⚔️ ¡LA PARTIDA HA COMENZADO!', 3000);
            this.scene.shake(0.5, 0.5);
        });

        /* ── Match End (winner declared) ────────── */
        this.network.on('matchEnd', (data) => {
            this.matchState = 'ended';
            this.hud.showWinner(data.winner);
            if (data.winner && data.winner.id === this.localId) {
                this.hud.showMessage('🏆 ¡ERES EL GANADOR! 🏆', 5000);
            }
        });

        /* ── Match Reset ────────────────────────── */
        this.network.on('matchReset', (data) => {
            this.matchState = 'lobby';
            this.isEliminated = false;
            this.hud.hideWinner();
            this.hud.hideEliminated();
            this.hud.hideAliveCount();

            // Remove all remote models (bots will be re-added)
            for (const [id, r] of this.remotes) {
                this.scene.scene.remove(r.model.mesh);
                r.model.dispose();
            }
            this.remotes.clear();

            // Re-add current players
            for (const [id, pd] of Object.entries(data.players)) {
                if (id === this.localId && this.ctrl) {
                    this.ctrl.position.set(pd.position.x, pd.position.y, pd.position.z);
                    this.ctrl.velocity.set(0, 0, 0);
                    this.ctrl.model.mesh.position.copy(this.ctrl.position);
                    // Update color
                    this.ctrl.model.updateColor(pd.color);
                } else {
                    this._addRemote(id, pd);
                }
            }

            this.hud.showLobby(data.lobbyCountdown, Object.keys(data.players).length, 10, data.players);
            this.hud.showMessage('🔄 Nueva partida en breve...', 3000);
        });

        /* ── Eliminated (no respawn) ────────────── */
        this.network.on('eliminated', (data) => {
            this.isEliminated = true;
            this.hud.showEliminated(data.placement, data.totalPlayers, data.killedBy);
        });

        // Remove old respawn handler — no more respawning
        this.network.on('respawn', () => {
            // No-op in battle royale mode
        });
    }

    /* ── Remote helpers ────────────────────────── */
    async _addRemote(id, data) {
        const model = this.cachedAssets
            ? PlayerModel.loadFromCache(data.color, this.cachedAssets)
            : await PlayerModel.load(data.color);
        model.setName(data.name);
        this.scene.scene.add(model.mesh);
        model.mesh.position.set(data.position.x, data.position.y, data.position.z);
        this.remotes.set(id, { model, targetPos: null, data, prevPos: null });
    }

    /* ── State sync ────────────────────────────── */
    _onState(state) {
        if (state.matchState) this.matchState = state.matchState;

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
                if (this.ctrl) {
                    this.ctrl.model.updateCharge(playerCharge, isCharged);
                }
                continue;
            }

            const r = this.remotes.get(id);
            if (r) {
                const newPos = new THREE.Vector3(pd.position.x, pd.position.y, pd.position.z);

                if (r.targetPos) {
                    const dist = r.targetPos.distanceTo(newPos);
                    if (dist > 0.05) {
                        r.model.play('run');
                    } else {
                        r.model.play('idle');
                    }
                }

                r.targetPos = newPos;
                r.data = pd;
                r.model.updateCharge(playerCharge, isCharged);
                r.model.setAlive(pd.alive);
            } else {
                // Player exists on server but not on client — add them
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

                if (ev.targetId === this.localId) {
                    this.hud.showMessage(`⚡ ¡ELIMINADO por ${ev.shooterName}!`, 2500);
                } else if (ev.shooterId === this.localId) {
                    this.hud.showMessage(`⚡ ¡RAYO eliminó a ${ev.targetName}!`, 2000);
                } else {
                    this.hud.showMessage(`💀 ${ev.targetName} eliminado por ${ev.shooterName}`, 2000);
                }
            }
        }

        this.hud.updateScoreboard(state.players);

        if (state.arenaBoxes && this.arenaBoxes.length === 0) {
            this.arenaBoxes = state.arenaBoxes;
            this.scene.buildBoxes(this.arenaBoxes);
        }
    }

    /* ── Render loop ───────────────────────────── */
    _loop() {
        requestAnimationFrame(() => this._loop());
        const dt = this.clock.getDelta();

        // Local player
        if (this.ctrl) {
            // Only allow movement during active play (not lobby, not eliminated, not ended)
            const canMove = this.matchState === 'playing' && !this.isEliminated;

            if (canMove) {
                this.ctrl.update(dt);
            } else {
                // Still tick animation but don't process input
                this.ctrl.model.play('idle');
            }

            // Client-side collision against remote players
            if (canMove) {
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
                this.ctrl.model.play(this.ctrl.moveState);
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

        // Interpolate remotes & tick their animations
        for (const [, r] of this.remotes) {
            if (r.targetPos) r.model.mesh.position.lerp(r.targetPos, 0.15);
            if (r.data) r.model.mesh.rotation.y = r.data.rotation || 0;
            r.model.tick(dt);
        }

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
        if (this.chargingBeam && this.matchState === 'playing') {
            const { chargedPlayerId, chargePct } = this.chargeState;
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

                    for (const [id, r] of this.remotes) {
                        if (id === chargedPlayerId) continue;
                        if (r.data && !r.data.alive) continue;
                        const pos = r.model.mesh.position;
                        if (!this._hasLineOfSight(chargedPos, pos)) continue;
                        const dx = pos.x - chargedPos.x;
                        const dz = pos.z - chargedPos.z;
                        const dist = Math.sqrt(dx * dx + dz * dz);
                        if (dist < nearestDist) {
                            nearestDist = dist;
                            nearestPos = pos.clone();
                        }
                    }

                    if (chargedPlayerId !== this.localId && this.ctrl) {
                        const pos = this.ctrl.model.mesh.position;
                        if (this._hasLineOfSight(chargedPos, pos)) {
                            const dx = pos.x - chargedPos.x;
                            const dz = pos.z - chargedPos.z;
                            const dist = Math.sqrt(dx * dx + dz * dz);
                            if (dist < nearestDist) {
                                nearestDist = dist;
                                nearestPos = pos.clone();
                            }
                        }
                    }

                    if (nearestPos) {
                        const from = chargedPos.clone();
                        from.y += 1.5;
                        const to = nearestPos.clone();
                        to.y += 1.0;
                        this.chargingBeam.update(from, to, chargePct);
                    } else {
                        this.chargingBeam.hide();
                    }
                } else {
                    this.chargingBeam.hide();
                }
            } else {
                this.chargingBeam.hide();
            }
        } else if (this.chargingBeam) {
            this.chargingBeam.hide();
        }

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
