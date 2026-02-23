import './style.css';
import { Game } from './Game.js';
import { Preloader } from './Preloader.js';

/* ── DOM refs ─────────────────────────────────── */
const joinScreen = document.getElementById('join-screen');
const joinBtn = document.getElementById('join-btn');
const nameInput = document.getElementById('player-name');
const progressBar = document.getElementById('preload-bar');
const progressTxt = document.getElementById('preload-text');

/* ── Disable join until assets are ready ──────── */
joinBtn.disabled = true;
joinBtn.textContent = 'CARGANDO…';

let assetsReady = false;
let game = null;

/* ── Start preloading immediately ─────────────── */
const preloader = new Preloader((loaded, total) => {
    const pct = Math.round((loaded / total) * 100);
    if (progressBar) progressBar.style.width = pct + '%';
    if (progressTxt) progressTxt.textContent = `Cargando recursos… ${pct}%`;
});

preloader.loadAll().then(() => {
    assetsReady = true;

    // Create the game with cached assets
    game = new Game(preloader.assets);

    // Pre-build the 3D room in the background (canvas is hidden by join-screen)
    game.preInitScene();

    // Enable the button
    joinBtn.disabled = false;
    joinBtn.textContent = 'ENTRAR A LA ARENA';
    if (progressTxt) progressTxt.textContent = '¡Listo!';

    // Fade out the progress bar
    const preloadContainer = document.getElementById('preload-container');
    if (preloadContainer) {
        preloadContainer.classList.add('preload-done');
    }
}).catch((err) => {
    console.error('Preload failed:', err);
    // Fallback: let user play anyway, assets will load on demand
    game = new Game();
    joinBtn.disabled = false;
    joinBtn.textContent = 'ENTRAR A LA ARENA';
    if (progressTxt) progressTxt.textContent = '¡Listo (parcial)!';
});

/* ── Join handler ─────────────────────────────── */
joinBtn.addEventListener('click', () => {
    if (joinBtn.disabled) return;
    const name = nameInput.value.trim() || 'Jugador';
    joinScreen.style.display = 'none';
    game.start(name);
});

nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click();
});

nameInput.focus();
