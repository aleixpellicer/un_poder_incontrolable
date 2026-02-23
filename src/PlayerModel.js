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
 * Loads the Mixamo FBX character with idle / run / dash animations.
 * `await PlayerModel.load(color)` returns a ready-to-use instance.
 *
 * For cached/preloaded assets use:
 * `PlayerModel.loadFromCache(color, cachedAssets)` — synchronous, no network.
 */

/* ── Shared geometry cache (created once, reused by all players) ── */
let _sharedShieldGeo = null;
let _sharedLocalIndicatorGeo = null;

function getSharedShieldGeo() {
    if (!_sharedShieldGeo) _sharedShieldGeo = new THREE.SphereGeometry(1.35, 32, 24);
    return _sharedShieldGeo;
}
function getSharedLocalIndicatorGeo() {
    if (!_sharedLocalIndicatorGeo) _sharedLocalIndicatorGeo = new THREE.RingGeometry(0.9, 1.15, 48);
    return _sharedLocalIndicatorGeo;
}
export class PlayerModel {
    // Reusable Color objects to avoid per-frame GC pressure
    static _tmpColorA = new THREE.Color();
    static _tmpColorB = new THREE.Color();
    constructor(color) {
        this.color = new THREE.Color(color);
        this.mesh = new THREE.Group();      // root group added to scene
        this.mixer = null;                   // AnimationMixer
        this.actions = {};                   // { idle, run, dash }
        this.current = null;                 // current action name
        this._nameSprite = null;

        /* Small glow light */
        this.glow = new THREE.PointLight(this.color, 0.5, 6);
        this.glow.position.y = 1;
        this.mesh.add(this.glow);

        /* ── Shield sphere (blue transparent bubble) ── */
        this._shieldActive = false;
        this._shieldOpacity = 0;           // for smooth fade-in/out
        const shieldMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            uniforms: {
                uTime: { value: 0 },
                uOpacity: { value: 0 },
                uColor: { value: new THREE.Color(0x3399ff) },
            },
            vertexShader: /* glsl */`
                varying vec3 vNormal;
                varying vec3 vViewDir;
                void main() {
                    vNormal  = normalize(normalMatrix * normal);
                    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                    vViewDir = normalize(-mvPos.xyz);
                    gl_Position = projectionMatrix * mvPos;
                }
            `,
            fragmentShader: /* glsl */`
                uniform float uTime;
                uniform float uOpacity;
                uniform vec3  uColor;
                varying vec3  vNormal;
                varying vec3  vViewDir;
                void main() {
                    float fresnel = 1.0 - abs(dot(vNormal, vViewDir));
                    fresnel = pow(fresnel, 2.0);
                    float pulse = 0.85 + 0.15 * sin(uTime * 3.0);
                    float alpha = fresnel * pulse * uOpacity * 0.7;
                    // Inner subtle base so the sphere isn't invisible head-on
                    alpha += 0.06 * uOpacity;
                    gl_FragColor = vec4(uColor, alpha);
                }
            `,
        });
        this.shieldSphere = new THREE.Mesh(getSharedShieldGeo(), shieldMat);
        this.shieldSphere.position.y = 1.0;   // centred on character torso
        this.shieldSphere.visible = false;
        this.shieldSphere.renderOrder = 999;   // draw after opaque
        this.mesh.add(this.shieldSphere);

        /* ── Ground indicator circle (blue = local player, transitions to red when charged) ── */
        this._isLocalPlayer = false;
        this._indicatorBaseColor = new THREE.Color(0x2299ff); // blue
        const indicatorMat = new THREE.MeshBasicMaterial({
            color: 0x2299ff,
            transparent: true,
            opacity: 0.45,
            side: THREE.DoubleSide,
            depthWrite: false,
        });
        this._localIndicator = new THREE.Mesh(getSharedLocalIndicatorGeo(), indicatorMat);
        this._localIndicator.rotation.x = -Math.PI / 2; // flat on the ground
        this._localIndicator.position.y = 0.06;          // just above floor
        this._localIndicator.visible = false;
        this._localIndicator.renderOrder = 1;
        this.mesh.add(this._localIndicator);
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
    _setupAnimations(idleFbx, runFbx, dashFbx) {
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
        if (dashFbx.animations.length) {
            const clip = dashFbx.animations[0].clone();
            stripRootMotion(clip);
            clip.duration = Math.min(clip.duration, 0.6); // snappy dash tackle
            this.actions.dash = this.mixer.clipAction(clip);
            this.actions.dash.setLoop(THREE.LoopOnce);
            this.actions.dash.clampWhenFinished = true;
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
        pm._setupAnimations(cachedAssets.idle, cachedAssets.run, cachedAssets.dash);

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
        const [idleFbx, runFbx, dashFbx] = await Promise.all([
            fbx('/models/Idle.fbx'),
            fbx('/models/Running.fbx'),
            fbx('/models/Dash.fbx'),
        ]);

        pm._setupAnimations(idleFbx, runFbx, dashFbx);
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

        // ── Shield sphere animation ──
        if (this.shieldSphere) {
            const target = this._shieldActive ? 1 : 0;
            this._shieldOpacity += (target - this._shieldOpacity) * Math.min(dt * 6, 1);
            if (this._shieldOpacity < 0.01 && !this._shieldActive) {
                this._shieldOpacity = 0;
                this.shieldSphere.visible = false;
            } else {
                this.shieldSphere.visible = true;
            }
            const mat = this.shieldSphere.material;
            mat.uniforms.uOpacity.value = this._shieldOpacity;
            mat.uniforms.uTime.value = performance.now() * 0.001;
            // Gentle slow rotation
            this.shieldSphere.rotation.y += dt * 0.4;
        }

        // ── Local player ground indicator animation ──
        if (this._localIndicator && this._localIndicator.visible) {
            const t = performance.now() * 0.001;
            // Gentle pulse opacity between 0.25 and 0.55
            this._localIndicator.material.opacity = 0.35 + 0.15 * Math.sin(t * 2.0);
            // Slow rotation
            this._localIndicator.rotation.z += dt * 0.5;
        }
    }

    /* ── Charge visual 0..1, isCharged = whether this player has the power ── */
    updateCharge(pct, isCharged = false) {
        pct = Math.min(Math.max(pct, 0), 1);

        if (!isCharged) {
            // Not the charged player — reset indicator to blue, neutral glow
            if (this._localIndicator && this._isLocalPlayer) {
                this._localIndicator.material.color.copy(this._indicatorBaseColor);
                this._localIndicator.scale.setScalar(1);
            }
            this.glow.intensity = 0.5;
            this.glow.color.copy(this.color);
            this._setEmissiveTint(this.color, 0.2);
            return;
        }

        // This player IS the charged one — transition ground circle blue → red
        // Only show the indicator on the LOCAL player model (remote players don't get circles)
        if (this._localIndicator && this._isLocalPlayer) {
            this._localIndicator.visible = true;
            // Lerp color: blue(0x2299ff) → orange(0xff6600) → red(0xff2244)
            PlayerModel._tmpColorA.copy(this._indicatorBaseColor); // blue
            PlayerModel._tmpColorB.setHex(0xff2244);               // target red
            PlayerModel._tmpColorA.lerp(PlayerModel._tmpColorB, pct);
            this._localIndicator.material.color.copy(PlayerModel._tmpColorA);
            // Increase opacity as charge builds
            this._localIndicator.material.opacity = 0.4 + pct * 0.5;
            // Pulsing scale — faster and bigger as charge increases
            const pulse = 1 + Math.sin(performance.now() * 0.012 * (1 + pct * 2)) * (0.1 + pct * 0.25);
            this._localIndicator.scale.setScalar(pulse);
        }

        // Red glowing light — intensity increases with charge
        const glowIntensity = 1.0 + pct * 3.0;
        const flickerIntensity = Math.sin(performance.now() * 0.015) * 0.5 * pct;
        this.glow.intensity = glowIntensity + flickerIntensity;
        this.glow.color.setHex(0xff2244);
        this.glow.distance = 8 + pct * 6; // farther red glow reach

        // Tint the character model emissive RED
        PlayerModel._tmpColorA.setHex(0xff1133);
        const emissiveStrength = 0.3 + pct * 0.7; // gets more intense
        this._setEmissiveTint(PlayerModel._tmpColorA, emissiveStrength);
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

    setAlive(alive) {
        this.mesh.visible = alive;
        // Ensure no visual remnants when dead
        if (!alive) {
            this.glow.intensity = 0;
            if (this._localIndicator && !this._isLocalPlayer) {
                this._localIndicator.visible = false;
            }
        } else {
            this.glow.intensity = 0.5;
        }
    }

    /* ── Shield: show / hide the blue bubble ── */
    setShield(active) {
        this._shieldActive = !!active;
    }

    /* ── Mark this model as the local player (shows blue ground circle) ── */
    setLocalPlayer(isLocal) {
        this._isLocalPlayer = !!isLocal;
        if (this._localIndicator) {
            this._localIndicator.visible = this._isLocalPlayer;
        }
    }

    setName(name) {
        this.setNameWithRank(name, -1);
    }

    setNameWithRank(name, rank) {
        if (this._nameSprite) this.mesh.remove(this._nameSprite);
        this._currentName = name;
        this._currentRank = rank;

        // High-res canvas (2× for crisp text, no blurriness)
        const canvas = document.createElement('canvas');
        canvas.width = 1024; canvas.height = 256;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, 1024, 256);

        const isTop3 = rank >= 1 && rank <= 3;

        if (isTop3) {
            // Subtle border only — NO opaque fill so it doesn't cover the shield
            const borderColors = {
                1: 'rgba(255, 200, 50, 0.7)',
                2: 'rgba(180, 195, 220, 0.6)',
                3: 'rgba(205, 140, 70, 0.6)',
            };
            const pillW = 720, pillH = 128, pillX = 512 - pillW / 2, pillY = 40;
            ctx.beginPath();
            ctx.roundRect(pillX, pillY, pillW, pillH, 64);
            // Very subtle transparent background instead of opaque
            ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
            ctx.fill();
            ctx.strokeStyle = borderColors[rank];
            ctx.lineWidth = 4;
            ctx.stroke();
        }

        // Rank badge for top 3
        if (isTop3) {
            const badges = { 1: '👑', 2: '🥈', 3: '🥉' };
            ctx.font = '72px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(badges[rank], 210, 132);
        }

        // Player name — bigger font (2× coords for hi-res canvas)
        const nameColors = {
            1: '#FFD700',
            2: '#D0D8E8',
            3: '#E0A050',
        };
        ctx.font = 'bold 96px Rajdhani, sans-serif';
        ctx.textAlign = 'center';

        if (isTop3) {
            // Dark outline for contrast
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
            ctx.lineWidth = 10;
            ctx.lineJoin = 'round';
            ctx.strokeText(name, 550, 132);

            // Colored glow
            const glowColors = { 1: 'rgba(255, 215, 0, 0.7)', 2: 'rgba(200, 210, 230, 0.6)', 3: 'rgba(220, 160, 80, 0.6)' };
            ctx.shadowColor = glowColors[rank];
            ctx.shadowBlur = 20;
            ctx.fillStyle = nameColors[rank];
            ctx.fillText(name, 550, 132);
            ctx.fillText(name, 550, 132);
            ctx.shadowBlur = 0;
        } else {
            // Dark outline for regular names too
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.lineWidth = 8;
            ctx.lineJoin = 'round';
            ctx.strokeText(name, 512, 144);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(name, 512, 144);
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.needsUpdate = true;
        // depthWrite: false so the name label never occludes the shield sphere
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.95, depthWrite: false });
        this._nameSprite = new THREE.Sprite(mat);
        this._nameSprite.scale.set(5.0, 1.3, 1);
        this._nameSprite.position.y = 2.8;
        this._nameSprite.renderOrder = 1000;  // draw on top of shield
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
            // Don't dispose shared geometries (shield, indicator) — they are reused
            if (c.geometry && c.geometry !== _sharedShieldGeo && c.geometry !== _sharedLocalIndicatorGeo) {
                c.geometry.dispose();
            }
            if (c.material) {
                if (c.material.map) c.material.map.dispose();
                c.material.dispose();
            }
        });
    }
}
