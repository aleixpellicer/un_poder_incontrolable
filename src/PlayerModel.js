import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

/**
 * Strip root-motion position tracks from a clip so the animation
 * plays in-place and doesn't move the character away from its
 * game-logic position.
 */
function stripRootMotion(clip) {
    clip.tracks = clip.tracks.filter(track => {
        // Remove position tracks on hips / root bone
        const isPosition = track.name.endsWith('.position');
        const isRoot = /hips/i.test(track.name) || /root/i.test(track.name);
        return !(isPosition && isRoot);
    });
    return clip;
}

/**
 * Loads the Mixamo FBX character with idle / run / jump animations.
 * `await PlayerModel.load(color)` returns a ready-to-use instance.
 *
 * For cached/preloaded assets use:
 * `PlayerModel.loadFromCache(color, cachedAssets)` — synchronous, no network.
 */
export class PlayerModel {
    constructor(color) {
        this.color = new THREE.Color(color);
        this.mesh = new THREE.Group();      // root group added to scene
        this.mixer = null;                   // AnimationMixer
        this.actions = {};                   // { idle, run, jump }
        this.current = null;                 // current action name
        this._nameSprite = null;

        /* Charge ring (only visible when this player is charged) */
        const ringGeo = new THREE.TorusGeometry(0.7, 0.06, 8, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.0 });
        this.ring = new THREE.Mesh(ringGeo, ringMat);
        this.ring.rotation.x = Math.PI / 2;
        this.ring.position.y = 0.05;
        this.ring.visible = false;
        this.mesh.add(this.ring);

        /* Small glow light */
        this.glow = new THREE.PointLight(this.color, 0.5, 6);
        this.glow.position.y = 1;
        this.mesh.add(this.glow);
    }

    /* ── Internal: setup a character FBX (clone or original) ── */
    _setupCharacter(charFbx) {
        charFbx.scale.setScalar(0.013);
        charFbx.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                if (child.material) {
                    // Clone materials so each player gets unique tinting
                    const srcMats = Array.isArray(child.material) ? child.material : [child.material];
                    const clonedMats = srcMats.map(m => {
                        const cm = m.clone();
                        cm.emissive = this.color.clone().multiplyScalar(0.2);
                        cm.emissiveIntensity = 0.4;
                        return cm;
                    });
                    child.material = clonedMats.length === 1 ? clonedMats[0] : clonedMats;
                }
            }
        });
        this.mesh.add(charFbx);
        this._fbx = charFbx;

        // Find the root bone (hips)
        this._hips = null;
        charFbx.traverse((child) => {
            if (child.isBone && /hips/i.test(child.name) && !this._hips) {
                this._hips = child;
            }
        });

        // Set up mixer
        this.mixer = new THREE.AnimationMixer(charFbx);
    }

    /* ── Internal: setup animation actions from FBX objects ── */
    _setupAnimations(idleFbx, runFbx, jumpFbx) {
        if (idleFbx.animations.length) {
            const clip = idleFbx.animations[0].clone();
            stripRootMotion(clip);
            this.actions.idle = this.mixer.clipAction(clip);
        }
        if (runFbx.animations.length) {
            const clip = runFbx.animations[0].clone();
            stripRootMotion(clip);
            this.actions.run = this.mixer.clipAction(clip);
        }
        if (jumpFbx.animations.length) {
            const clip = jumpFbx.animations[0].clone();
            stripRootMotion(clip);
            this.actions.jump = this.mixer.clipAction(clip);
            this.actions.jump.setLoop(THREE.LoopOnce);
            this.actions.jump.clampWhenFinished = true;
        }

        // Start with idle
        if (this.actions.idle) { this.actions.idle.play(); this.current = 'idle'; }
    }

    /* ── Fast loader using preloaded / cached assets (NO network) ── */
    static loadFromCache(color, cachedAssets) {
        const pm = new PlayerModel(color);

        // Deep-clone the character skeleton so each player is independent
        const charClone = SkeletonUtils.clone(cachedAssets.character);
        pm._setupCharacter(charClone);
        pm._setupAnimations(cachedAssets.idle, cachedAssets.run, cachedAssets.jump);

        return pm;
    }

    /* ── Original loader (fallback — fetches from network) ── */
    static async load(color) {
        const pm = new PlayerModel(color);
        const loader = new FBXLoader();

        // Helper: load an FBX file and return the object
        const fbx = (url) => new Promise((res, rej) => loader.load(url, res, undefined, rej));

        // Load base character
        const charFbx = await fbx('/models/character.fbx');
        pm._setupCharacter(charFbx);

        // Load animations
        const [idleFbx, runFbx, jumpFbx] = await Promise.all([
            fbx('/models/Idle.fbx'),
            fbx('/models/Running.fbx'),
            fbx('/models/Running Jump.fbx'),
        ]);

        pm._setupAnimations(idleFbx, runFbx, jumpFbx);
        return pm;
    }

    /* ── Play a named animation with crossfade ── */
    play(name) {
        if (name === this.current || !this.actions[name]) return;
        const prev = this.actions[this.current];
        const next = this.actions[name];

        if (prev) prev.fadeOut(0.2);
        next.reset().fadeIn(0.2).play();
        this.current = name;
    }

    /* ── Tick (call every frame) ──────────────── */
    tick(dt) {
        if (this.mixer) this.mixer.update(dt);
        // Reset hips position so root motion can't drift the model
        if (this._hips) {
            this._hips.position.x = 0;
            this._hips.position.z = 0;
        }
    }

    /* ── Charge visual 0..1, isCharged = whether this player has the power ── */
    updateCharge(pct, isCharged = false) {
        pct = Math.min(Math.max(pct, 0), 1);

        if (!isCharged) {
            // Not the charged player — hide ring, neutral glow, restore materials
            this.ring.visible = false;
            this.ring.material.opacity = 0;
            this.glow.intensity = 0.5;
            this.glow.color.copy(this.color);
            this._setEmissiveTint(this.color, 0.2);
            return;
        }

        // This player IS the charged one — ATTACKER: red glow!
        this.ring.visible = true;
        this.ring.material.opacity = 0.2 + pct * 0.8;

        // Ring is always red/orange when charged (attacker is dangerous)
        const ringColor = new THREE.Color(0xff2244).lerp(new THREE.Color(0xff6600), 0.3 - pct * 0.3);
        this.ring.material.color.copy(ringColor);

        // Pulsing ring
        const pulse = 1 + Math.sin(performance.now() * 0.012 * (1 + pct * 2)) * (0.1 + pct * 0.25);
        this.ring.scale.setScalar(pulse);

        // Red glowing light — intensity increases with charge
        const glowIntensity = 1.0 + pct * 3.0;
        const flickerIntensity = Math.sin(performance.now() * 0.015) * 0.5 * pct;
        this.glow.intensity = glowIntensity + flickerIntensity;
        this.glow.color.setHex(0xff2244);
        this.glow.distance = 8 + pct * 6; // farther red glow reach

        // Tint the character model emissive RED
        const emissiveColor = new THREE.Color(0xff1133);
        const emissiveStrength = 0.3 + pct * 0.7; // gets more intense
        this._setEmissiveTint(emissiveColor, emissiveStrength);
    }

    /** Set emissive tint on all character meshes */
    _setEmissiveTint(color, intensity) {
        if (!this._fbx) return;
        this._fbx.traverse((child) => {
            if (child.isMesh && child.material) {
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                for (const m of mats) {
                    if (m.emissive) {
                        m.emissive.copy(color).multiplyScalar(intensity);
                        m.emissiveIntensity = intensity;
                    }
                }
            }
        });
    }

    setAlive(alive) { this.mesh.visible = alive; }

    setName(name) {
        if (this._nameSprite) this.mesh.remove(this._nameSprite);
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.font = 'bold 28px Rajdhani, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#333333';
        ctx.fillText(name, 128, 40);
        const tex = new THREE.CanvasTexture(canvas);
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.9 });
        this._nameSprite = new THREE.Sprite(mat);
        this._nameSprite.scale.set(2.5, 0.65, 1);
        this._nameSprite.position.y = 2.6;
        this.mesh.add(this._nameSprite);
    }

    updateColor(color) {
        this.color = new THREE.Color(color);
        this.glow.color.copy(this.color);
        if (this._fbx) {
            this._fbx.traverse((child) => {
                if (child.isMesh && child.material) {
                    const mats = Array.isArray(child.material) ? child.material : [child.material];
                    for (const m of mats) {
                        m.emissive = this.color.clone().multiplyScalar(0.2);
                    }
                }
            });
        }
    }

    dispose() {
        this.mesh.traverse(c => {
            if (c.geometry) c.geometry.dispose();
            if (c.material) {
                if (c.material.map) c.material.map.dispose();
                c.material.dispose();
            }
        });
    }
}
