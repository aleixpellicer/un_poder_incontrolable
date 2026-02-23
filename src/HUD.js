export class HUD {
    constructor() {
        this.el = document.getElementById('hud');
        this.chargeBar = document.getElementById('charge-bar');
        this.chargeLabel = document.getElementById('charge-label');
        this.chargeContainer = document.getElementById('charge-container');
        this.messageBox = document.getElementById('message-box');
        this.scoreboard = document.getElementById('scoreboard');
        this.deathScreen = document.getElementById('death-screen');
        this.chargeWarning = document.getElementById('charge-warning');
        this.lobbyScreen = document.getElementById('lobby-screen');
        this.lobbyCountdown = document.getElementById('lobby-countdown');
        this.lobbyPlayers = document.getElementById('lobby-players');
        this.winnerScreen = document.getElementById('winner-screen');
        this.winnerName = document.getElementById('winner-name');
        this.winnerRestart = document.getElementById('winner-restart-text');
        this.aliveCounter = document.getElementById('alive-counter');
        this.eliminatedScreen = document.getElementById('eliminated-screen');
        this.eliminatedPlacement = document.getElementById('eliminated-placement');
        this.eliminatedKiller = document.getElementById('eliminated-killer');
        this._msgTimer = null;
    }

    show() { this.el.style.display = 'block'; }

    /* ── Lobby ───────────────────────────────── */
    showLobby(countdown, filledSlots, totalSlots, players) {
        if (this.lobbyScreen) {
            this.lobbyScreen.style.display = 'flex';
        }
        if (this.lobbyCountdown) {
            this.lobbyCountdown.textContent = countdown;
        }
        if (this.lobbyPlayers) {
            let html = '';
            const playerList = players ? Object.values(players) : [];
            for (const p of playerList) {
                html += `<div class="lobby-player" style="border-left-color:${p.color}">
                    <span class="lobby-player-name">${p.name}</span>
                </div>`;
            }
            // Empty slots
            const emptySlots = totalSlots - filledSlots;
            for (let i = 0; i < emptySlots; i++) {
                html += `<div class="lobby-player lobby-empty">
                    <span class="lobby-player-name">Esperando…</span>
                </div>`;
            }
            this.lobbyPlayers.innerHTML = html;
        }
        // Hide other screens
        if (this.winnerScreen) this.winnerScreen.style.display = 'none';
        if (this.deathScreen) this.deathScreen.style.display = 'none';
        if (this.eliminatedScreen) this.eliminatedScreen.style.display = 'none';
    }

    hideLobby() {
        if (this.lobbyScreen) this.lobbyScreen.style.display = 'none';
    }

    /* ── Winner screen ───────────────────────── */
    showWinner(winner) {
        if (this.winnerScreen) {
            this.winnerScreen.style.display = 'flex';
            if (this.winnerName) {
                this.winnerName.textContent = winner ? winner.name : 'Nadie';
                if (winner) {
                    this.winnerName.style.color = winner.color;
                }
            }
        }
        if (this.eliminatedScreen) this.eliminatedScreen.style.display = 'none';
        if (this.deathScreen) this.deathScreen.style.display = 'none';
    }

    hideWinner() {
        if (this.winnerScreen) this.winnerScreen.style.display = 'none';
    }

    /* ── Eliminated screen ───────────────────── */
    showEliminated(placement, totalPlayers, killedBy) {
        if (this.eliminatedScreen) {
            this.eliminatedScreen.style.display = 'flex';
        }
        if (this.eliminatedPlacement) {
            this.eliminatedPlacement.textContent = `#${placement} / ${totalPlayers}`;
        }
        if (this.eliminatedKiller) {
            this.eliminatedKiller.textContent = killedBy;
        }
        if (this.deathScreen) this.deathScreen.style.display = 'none';
    }

    hideEliminated() {
        if (this.eliminatedScreen) this.eliminatedScreen.style.display = 'none';
    }

    /* ── Alive counter ───────────────────────── */
    updateAliveCount(alive, total) {
        if (this.aliveCounter) {
            this.aliveCounter.textContent = `${alive} / ${total}`;
            this.aliveCounter.style.display = 'flex';
        }
    }

    hideAliveCount() {
        if (this.aliveCounter) this.aliveCounter.style.display = 'none';
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

        // Death screen — only if not already showing eliminated screen
        if (!data.alive && this.eliminatedScreen && this.eliminatedScreen.style.display !== 'flex') {
            this.deathScreen.style.display = 'flex';
        } else if (data.alive) {
            this.deathScreen.style.display = 'none';
        }
    }

    showMessage(text, duration = 2500) {
        this.messageBox.textContent = text;
        this.messageBox.style.opacity = 1;
        clearTimeout(this._msgTimer);
        this._msgTimer = setTimeout(() => { this.messageBox.style.opacity = 0; }, duration);
    }

    updateScoreboard(players) {
        const sorted = Object.values(players).sort((a, b) => b.kills - a.kills);
        let html = '<div class="sb-header">PUNTUACIÓN</div>';
        for (const p of sorted) {
            const deadClass = p.alive ? '' : ' sb-dead';
            const aliveIcon = p.alive ? '🟢' : '💀';
            html += `<div class="sb-row${deadClass}" style="border-left-color:${p.color}">
        <span class="sb-name">${aliveIcon} ${p.name}</span>
        <span class="sb-score">${p.kills}E</span>
      </div>`;
        }
        this.scoreboard.innerHTML = html;
    }
}
