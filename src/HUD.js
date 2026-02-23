export class HUD {
    constructor() {
        this.el = document.getElementById('hud');
        this.chargeBar = document.getElementById('charge-bar');
        this.chargeLabel = document.getElementById('charge-label');
        this.chargeContainer = document.getElementById('charge-container');
        this.messageBox = document.getElementById('message-box');
        this.scoreboard = document.getElementById('scoreboard');
        this.chargeWarning = document.getElementById('charge-warning');
        this.aliveCounter = document.getElementById('alive-counter');
        this.targetedWarning = document.getElementById('targeted-warning');
        this.deathOverlay = document.getElementById('death-overlay');
        this.deathKiller = document.getElementById('death-killer');
        this.deathSurvival = document.getElementById('death-survival-time');
        this.deathCountdown = document.getElementById('death-countdown');
        this.respawnBtn = document.getElementById('respawn-btn');
        this._msgTimer = null;
        this._respawnCallback = null;
        this.spawnProtectionBanner = document.getElementById('spawn-protection-banner');
        this._spawnProtectionVisible = false;
        this._spawnProtectionFading = false;

        // Shield status
        this.shieldIndicator = document.getElementById('shield-indicator');
        this.shieldTimer = document.getElementById('shield-timer');

        // FPS counter
        this.fpsCurrent = document.getElementById('fps-current');
        this.fpsMs = document.getElementById('fps-ms');
        this.fpsMin = document.getElementById('fps-min');
        this.fpsMax = document.getElementById('fps-max');
        this.fpsPing = document.getElementById('fps-ping');

        // Wire up respawn button
        if (this.respawnBtn) {
            this.respawnBtn.addEventListener('click', () => {
                if (this._respawnCallback) this._respawnCallback();
            });
        }
    }

    show() { this.el.style.display = 'block'; }

    /* ── FPS Counter ─────────────────────────── */
    updateFPS(current, ms, min, max) {
        if (this.fpsCurrent) this.fpsCurrent.textContent = current;
        if (this.fpsMs) this.fpsMs.textContent = ms.toFixed(1);
        if (this.fpsMin) this.fpsMin.textContent = min === Infinity ? '—' : min;
        if (this.fpsMax) this.fpsMax.textContent = max === 0 ? '—' : max;
    }

    updatePing(ping) {
        if (this.fpsPing) this.fpsPing.textContent = ping + 'ms';
    }

    onRespawnClick(callback) {
        this._respawnCallback = callback;
    }

    /* ── Shield Status ───────────────────────── */
    updateShieldStatus(secondsLeft) {
        if (!this.shieldIndicator) return;
        if (secondsLeft > 0) {
            this.shieldIndicator.style.display = 'flex';
            if (this.shieldTimer) {
                this.shieldTimer.textContent = `${Math.ceil(secondsLeft)}s`;
            }
            // Pulse when about to expire
            if (secondsLeft <= 5) {
                this.shieldIndicator.classList.add('shield-expiring');
            } else {
                this.shieldIndicator.classList.remove('shield-expiring');
            }
        } else {
            this.shieldIndicator.style.display = 'none';
            this.shieldIndicator.classList.remove('shield-expiring');
        }
    }

    /* ── Death / Respawn ─────────────────────── */
    showDeathScreen(killedBy, survivalTime, respawnIn) {
        if (this.deathOverlay) this.deathOverlay.style.display = 'flex';
        if (this.deathKiller) this.deathKiller.textContent = killedBy;
        if (this.deathSurvival) this.deathSurvival.textContent = formatTime(survivalTime);
        if (this.deathCountdown) {
            this.deathCountdown.textContent = `Renacimiento en ${respawnIn}s...`;
            this.deathCountdown.style.display = 'block';
        }
        if (this.respawnBtn) {
            this.respawnBtn.style.display = 'none';
            this.respawnBtn.disabled = true;
        }
    }

    updateRespawnCountdown(seconds) {
        if (this.deathCountdown) {
            this.deathCountdown.textContent = `Renacimiento en ${Math.ceil(seconds)}s...`;
        }
        if (this.respawnBtn) {
            this.respawnBtn.style.display = 'none';
            this.respawnBtn.disabled = true;
        }
    }

    showRespawnReady() {
        if (this.deathCountdown) {
            this.deathCountdown.style.display = 'none';
        }
        if (this.respawnBtn) {
            this.respawnBtn.style.display = 'inline-block';
            this.respawnBtn.disabled = false;
        }
    }

    hideDeathScreen() {
        if (this.deathOverlay) this.deathOverlay.style.display = 'none';
    }

    /* ── Alive counter ───────────────────────── */
    updateAliveCount(alive, total) {
        if (this.aliveCounter) {
            this.aliveCounter.textContent = `${alive} / ${total}`;
            this.aliveCounter.style.display = 'flex';
        }
    }

    updateLocalPlayer(data, isCharged, chargePct) {
        // Charge bar — only visible when this player is the charged one
        if (isCharged) {
            this.chargeContainer.style.display = 'flex';
            const pct = Math.min(chargePct * 100, 100);
            this.chargeBar.style.width = pct + '%';

            if (pct >= 90) {
                this.chargeBar.style.background = 'linear-gradient(90deg,#ff2244,#ff6644)';
                this.chargeLabel.textContent = '⚡ INMINENTE ⚡';
                this.chargeLabel.style.color = '#ff4466';
            } else if (pct >= 50) {
                this.chargeBar.style.background = 'linear-gradient(90deg,#ffaa00,#ffee00)';
                this.chargeLabel.textContent = 'CARGANDO ' + Math.round(pct) + '%';
                this.chargeLabel.style.color = '#ffcc00';
            } else {
                this.chargeBar.style.background = 'linear-gradient(90deg,#00ffc8,#00aaff)';
                this.chargeLabel.textContent = 'CARGANDO ' + Math.round(pct) + '%';
                this.chargeLabel.style.color = 'rgba(255,255,255,0.6)';
            }
        } else {
            this.chargeContainer.style.display = 'none';
        }

        // Warning indicator when another player has the power
        if (this.chargeWarning) {
            if (!isCharged && data.alive) {
                this.chargeWarning.style.display = 'block';
            } else {
                this.chargeWarning.style.display = 'none';
            }
        }
    }

    showMessage(text, duration = 2500) {
        this.messageBox.textContent = text;
        this.messageBox.style.opacity = 1;
        clearTimeout(this._msgTimer);
        this._msgTimer = setTimeout(() => { this.messageBox.style.opacity = 0; }, duration);
    }

    /* ── Targeted warning ─────────────────── */
    showTargetedWarning(chargePct) {
        if (!this.targetedWarning) return;
        this.targetedWarning.style.display = 'flex';

        if (chargePct > 0.75) {
            this.targetedWarning.textContent = '⚡ ¡CORRE! ¡VAS A SER ELIMINADO! ⚡';
            this.targetedWarning.className = 'targeted-critical';
        } else if (chargePct > 0.4) {
            this.targetedWarning.textContent = '⚠ ¡ERES EL OBJETIVO! ¡ALÉJATE! ⚠';
            this.targetedWarning.className = 'targeted-danger';
        } else {
            this.targetedWarning.textContent = '⚠ ¡Te están apuntando! Muévete';
            this.targetedWarning.className = 'targeted-warning';
        }
    }

    hideTargetedWarning() {
        if (!this.targetedWarning) return;
        this.targetedWarning.style.display = 'none';
    }

    /* ── Spawn Protection Banner ─────────────── */
    showSpawnProtection(secondsLeft) {
        if (!this.spawnProtectionBanner) return;
        if (this._spawnProtectionFading) {
            this.spawnProtectionBanner.classList.remove('sp-fading');
            this._spawnProtectionFading = false;
        }
        this.spawnProtectionBanner.style.display = 'flex';
        this._spawnProtectionVisible = true;

        const timerEl = this.spawnProtectionBanner.querySelector('.sp-timer');
        if (timerEl) timerEl.textContent = `${Math.ceil(secondsLeft)}s`;

        // Update hint based on remaining time
        const hintEl = this.spawnProtectionBanner.querySelector('.sp-hint');
        if (hintEl) {
            if (secondsLeft <= 2) {
                hintEl.textContent = '⚠ ¡Protección por acabar! ¡MUÉVETE!';
                hintEl.style.color = 'rgba(255, 200, 50, .9)';
            } else {
                hintEl.textContent = '¡Aléjate del peligro!';
                hintEl.style.color = 'rgba(0, 255, 220, .8)';
            }
        }
    }

    hideSpawnProtection() {
        if (!this.spawnProtectionBanner || !this._spawnProtectionVisible) return;
        this._spawnProtectionVisible = false;
        this._spawnProtectionFading = true;
        this.spawnProtectionBanner.classList.add('sp-fading');
        setTimeout(() => {
            if (this._spawnProtectionFading) {
                this.spawnProtectionBanner.style.display = 'none';
                this.spawnProtectionBanner.classList.remove('sp-fading');
                this._spawnProtectionFading = false;
            }
        }, 500);
    }

    /* ── Leaderboard (sorted by survival time) ─── */
    updateLeaderboard(players) {
        const sorted = Object.values(players).sort((a, b) => {
            // Alive players first, sorted by survival time (longest first)
            if (a.alive && !b.alive) return -1;
            if (!a.alive && b.alive) return 1;
            if (a.alive && b.alive) return b.survivalTime - a.survivalTime;
            // Both dead: sort by best survival time
            return b.bestSurvivalTime - a.bestSurvivalTime;
        });

        let html = '<div class="sb-header">🏆 SUPERVIVENCIA</div>';
        let rank = 0;
        for (const p of sorted) {
            rank++;
            const deadClass = p.alive ? '' : ' sb-dead';
            const rankClass = rank <= 3 ? ` sb-row-${rank}` : '';
            const aliveIcon = p.alive ? '🟢' : '💀';
            const shieldIcon = (p.defenseShield && p.defenseShield > 0) ? ' 🛡️' : '';
            const timeStr = p.alive
                ? formatTime(Math.floor(p.survivalTime))
                : (p.respawnTimer > 0 ? `⏳ ${Math.ceil(p.respawnTimer)}s` : '💤');
            const rankBadge = rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : `#${rank}`;

            html += `<div class="sb-row${deadClass}${rankClass}" style="border-left-color:${p.color}">
                <span class="sb-rank">${rankBadge}</span>
                <span class="sb-name">${aliveIcon}${shieldIcon} ${p.name}</span>
                <span class="sb-score">${timeStr}</span>
            </div>`;
        }
        this.scoreboard.innerHTML = html;
    }
}

function formatTime(seconds) {
    if (seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
    return `${s}s`;
}
