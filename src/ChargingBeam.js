import * as THREE from 'three';

/**
 * A live "preview beam" shown while the power is charging.
 * - Connects the charged player to the nearest alive player.
 * - TAPERED: wider & brighter at the shooter, thinner & dimmer at the target.
 * - Grows in opacity / thickness as charge % increases.
 * - Uses a custom shader for smooth opacity gradient along the beam.
 * - Electric lightning arcs crackle along the beam path.
 *
 * Performance notes:
 * - Lightning arcs reuse a pool of pre-allocated Line objects instead of
 *   creating/disposing geometry+material every refresh.
 * - Reusable Vector3/Color/Quaternion objects avoid per-frame GC pressure.
 */

/* ── Gradient shader ──────────────────────────── */
const beamVertexShader = /* glsl */`
    varying float vGradient;
    void main() {
        // uv.y: 0 = bottom (shooter), 1 = top (target)
        vGradient = uv.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const beamFragmentShader = /* glsl */`
    uniform vec3  uColor;
    uniform float uOpacity;
    uniform float uGradientStrength;  // 0 = no gradient, 1 = full fade at target end
    varying float vGradient;
    void main() {
        // Fade from dim at shooter (v=0) to full intensity at target (v=1)
        float fade = (1.0 - uGradientStrength) + vGradient * uGradientStrength;
        fade = max(fade, 0.03);
        gl_FragColor = vec4(uColor, uOpacity * fade);
    }
`;

function makeBeamMaterial(color) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uColor: { value: new THREE.Color(color) },
            uOpacity: { value: 0 },
            uGradientStrength: { value: 0.85 }
        },
        vertexShader: beamVertexShader,
        fragmentShader: beamFragmentShader,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending
    });
}

/* ── Lightning pool constants ──────────────────── */
const MAX_ARC_LINES = 20;     // max primary + branch lines at any time
const ARC_SEGMENTS = 20;      // max vertex count per arc line

/* ── Transition constants ─────────────────────── */
const TRANSITION_DURATION = 0.35; // seconds for the beam to sweep to new target
const TRANSITION_PARTICLES = 10;  // energy particles during transition
const TRANSITION_ARC_HEIGHT = 2.5; // how high the arc sweeps upward

export class ChargingBeam {
    constructor() {
        this.group = new THREE.Group();
        this.active = false;

        /* ── Core beam (inner) — tapered ───────── */
        this.beamGeo = new THREE.CylinderGeometry(0.08, 0.02, 1, 8, 1, true);
        this.beamMat = makeBeamMaterial(0x00ffc8);
        this.beam = new THREE.Mesh(this.beamGeo, this.beamMat);
        this.group.add(this.beam);

        /* ── Outer glow — tapered ──────────────── */
        this.glowGeo = new THREE.CylinderGeometry(0.22, 0.06, 1, 8, 1, true);
        this.glowMat = makeBeamMaterial(0x00ffc8);
        this.glowMat.uniforms.uGradientStrength.value = 0.90;
        this.glowBeam = new THREE.Mesh(this.glowGeo, this.glowMat);
        this.group.add(this.glowBeam);

        /* ── Wide halo — tapered ───────────────── */
        this.haloGeo = new THREE.CylinderGeometry(0.45, 0.10, 1, 8, 1, true);
        this.haloMat = makeBeamMaterial(0x00ffc8);
        this.haloMat.uniforms.uGradientStrength.value = 0.95;
        this.haloBeam = new THREE.Mesh(this.haloGeo, this.haloMat);
        this.group.add(this.haloBeam);

        /* ── Point light near target end ───────── */
        this.light = new THREE.PointLight(0x00ffc8, 0, 8);
        this.group.add(this.light);

        /* ── Target lock-on ring ───────────────── */
        const ringGeo = new THREE.TorusGeometry(0.5, 0.04, 8, 24);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0x00ffc8,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.targetRing = new THREE.Mesh(ringGeo, ringMat);
        this.targetRing.rotation.x = Math.PI / 2;
        this.group.add(this.targetRing);

        /* ── Origin glow sphere (shooter end, subtle) ── */
        const originGeo = new THREE.SphereGeometry(0.2, 8, 8);
        const originMat = new THREE.MeshBasicMaterial({
            color: 0x00ffc8,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.originGlow = new THREE.Mesh(originGeo, originMat);
        this.group.add(this.originGlow);

        /* ── Transition flash sphere (discharge at old target) ── */
        const flashGeo = new THREE.SphereGeometry(0.4, 10, 10);
        const flashMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.transitionFlash = new THREE.Mesh(flashGeo, flashMat);
        this.transitionFlash.visible = false;
        this.group.add(this.transitionFlash);

        /* ── Transition shockwave ring (at old target) ── */
        const swGeo = new THREE.TorusGeometry(0.3, 0.06, 6, 24);
        const swMat = new THREE.MeshBasicMaterial({
            color: 0x00ffc8,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.transitionRing = new THREE.Mesh(swGeo, swMat);
        this.transitionRing.rotation.x = Math.PI / 2;
        this.transitionRing.visible = false;
        this.group.add(this.transitionRing);

        /* ── Transition energy particles (pre-allocated) ── */
        const particleGeo = new THREE.SphereGeometry(0.06, 4, 4);
        const particleMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this._transParticles = [];
        this._transParticleGroup = new THREE.Group();
        this.group.add(this._transParticleGroup);
        for (let i = 0; i < TRANSITION_PARTICLES; i++) {
            const p = new THREE.Mesh(particleGeo, particleMat.clone());
            p.visible = false;
            this._transParticleGroup.add(p);
            this._transParticles.push({
                mesh: p,
                progress: 0,
                speed: 0,
                offset: new THREE.Vector3(),
                active: false
            });
        }

        /* ── Transition state ──────────────────── */
        this._transitionActive = false;
        this._transitionTimer = 0;
        this._transOldTarget = new THREE.Vector3();
        this._transNewTarget = new THREE.Vector3();
        this._transInterp = new THREE.Vector3();     // interpolated beam endpoint
        this._prevTarget = null;                      // last frame's toPos (for switch detection)
        this._transFlashTimer = 0;
        this._transSurgeMultiplier = 1;               // beam width/brightness surge

        /* ── Pre-allocated lightning line pool ──── */
        this.lightningGroup = new THREE.Group();
        this.group.add(this.lightningGroup);
        this._lightningPool = [];
        this._lightningActive = 0;
        this._lightningTimer = 0;

        for (let i = 0; i < MAX_ARC_LINES; i++) {
            // Pre-allocate buffer with max segment count
            const posArray = new Float32Array(ARC_SEGMENTS * 3);
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
            geo.setDrawRange(0, 0); // hidden initially

            const mat = new THREE.LineBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0,
                depthWrite: false,
                blending: THREE.AdditiveBlending
            });

            const line = new THREE.Line(geo, mat);
            line.visible = false;
            line.frustumCulled = false;
            this.lightningGroup.add(line);
            this._lightningPool.push(line);
        }

        /* ── Reusable temp objects ──────────────── */
        this._tmpDir = new THREE.Vector3();
        this._tmpMid = new THREE.Vector3();
        this._tmpOrient = new THREE.Quaternion();
        this._tmpUp = new THREE.Vector3(0, 1, 0);
        this._tmpPerp1 = new THREE.Vector3();
        this._tmpPerp2 = new THREE.Vector3();
        this._tmpBasePoint = new THREE.Vector3();
        this._tmpLightPos = new THREE.Vector3();
        this._beamColor = new THREE.Color();
        this._colorA = new THREE.Color();
        this._colorB = new THREE.Color();
        this._tmpBranchDir = new THREE.Vector3();
        this._tmpBranchPt = new THREE.Vector3();

        this.group.visible = false;
    }

    /**
     * Trigger a transition animation from oldTarget to newTarget.
     * Called externally when the beam's target player changes.
     */
    startTransition(oldTarget, newTarget) {
        if (!oldTarget || !newTarget) return;
        // Only trigger if the positions are significantly different
        const dist = oldTarget.distanceTo(newTarget);
        if (dist < 0.5) return;

        this._transitionActive = true;
        this._transitionTimer = 0;
        this._transOldTarget.copy(oldTarget);
        this._transNewTarget.copy(newTarget);
        this._transFlashTimer = 0;
        this._transSurgeMultiplier = 2.5; // big initial surge

        // Position the flash at old target
        this.transitionFlash.position.copy(oldTarget);
        this.transitionFlash.scale.setScalar(0.5);
        this.transitionFlash.material.opacity = 1.0;
        this.transitionFlash.visible = true;

        // Shockwave ring at old target
        this.transitionRing.position.copy(oldTarget);
        this.transitionRing.position.y = 0.1;
        this.transitionRing.scale.setScalar(0.3);
        this.transitionRing.material.opacity = 0.8;
        this.transitionRing.visible = true;

        // Launch energy particles along the transition path
        for (let i = 0; i < TRANSITION_PARTICLES; i++) {
            const p = this._transParticles[i];
            p.active = true;
            p.progress = -i * 0.06; // stagger start times
            p.speed = 2.5 + Math.random() * 1.5;
            p.offset.set(
                (Math.random() - 0.5) * 0.4,
                (Math.random() - 0.5) * 0.4,
                (Math.random() - 0.5) * 0.4
            );
            p.mesh.visible = false; // becomes visible when progress > 0
            p.mesh.material.opacity = 0.9;
            p.mesh.scale.setScalar(0.8 + Math.random() * 0.6);
        }
    }

    /**
     * Update the transition animation. Returns the interpolated
     * beam endpoint (or null if no transition is running).
     */
    _updateTransition(dt, beamColor) {
        if (!this._transitionActive) return null;

        this._transitionTimer += dt;
        const t = Math.min(this._transitionTimer / TRANSITION_DURATION, 1);

        // Smooth ease-in-out (cubic)
        const ease = t < 0.5
            ? 4 * t * t * t
            : 1 - Math.pow(-2 * t + 2, 3) / 2;

        /* ── Interpolate beam endpoint with arc ── */
        this._transInterp.lerpVectors(this._transOldTarget, this._transNewTarget, ease);
        // Add an arc (parabolic upward bulge)
        const arcHeight = TRANSITION_ARC_HEIGHT * Math.sin(ease * Math.PI) * (1 - ease * 0.3);
        this._transInterp.y += arcHeight;

        /* ── Surge multiplier decays ──────────── */
        this._transSurgeMultiplier = 1 + (2.5 - 1) * Math.max(0, 1 - t * 1.5);

        /* ── Discharge flash at old target ─────── */
        this._transFlashTimer += dt;
        const flashFade = Math.max(0, 1 - this._transFlashTimer * 4);
        this.transitionFlash.material.opacity = flashFade;
        this.transitionFlash.scale.setScalar(0.5 + this._transFlashTimer * 6);
        this.transitionFlash.material.color.copy(beamColor).lerp(
            this._colorA.setHex(0xffffff), flashFade * 0.6
        );
        if (flashFade <= 0) this.transitionFlash.visible = false;

        /* ── Shockwave ring expansion ─────────── */
        const ringScale = 0.3 + this._transFlashTimer * 12;
        const ringFade = Math.max(0, 0.8 - this._transFlashTimer * 3);
        this.transitionRing.scale.setScalar(ringScale);
        this.transitionRing.material.opacity = ringFade;
        this.transitionRing.material.color.copy(beamColor);
        if (ringFade <= 0) this.transitionRing.visible = false;

        /* ── Energy particles flying along arc ── */
        for (let i = 0; i < TRANSITION_PARTICLES; i++) {
            const p = this._transParticles[i];
            if (!p.active) continue;
            p.progress += dt * p.speed;
            const pp = Math.min(Math.max(p.progress, 0), 1);

            if (pp <= 0) {
                p.mesh.visible = false;
                continue;
            }

            p.mesh.visible = true;
            // Follow the arc path with offset
            p.mesh.position.lerpVectors(this._transOldTarget, this._transNewTarget, pp);
            p.mesh.position.y += TRANSITION_ARC_HEIGHT * Math.sin(pp * Math.PI) * 0.8;
            p.mesh.position.add(p.offset);

            // Spiral offset for visual flair
            const spiral = pp * Math.PI * 4 + i;
            p.mesh.position.x += Math.cos(spiral) * 0.25 * (1 - pp);
            p.mesh.position.z += Math.sin(spiral) * 0.25 * (1 - pp);

            // Fade out near the end
            p.mesh.material.opacity = Math.max(0, 0.9 * (1 - pp * 0.8));
            p.mesh.material.color.copy(beamColor).lerp(
                this._colorA.setHex(0xffffff), 0.4 + pp * 0.3
            );
            const pScale = (0.8 + Math.random() * 0.2) * (1 - pp * 0.5);
            p.mesh.scale.setScalar(pScale);

            if (pp >= 1) {
                p.active = false;
                p.mesh.visible = false;
            }
        }

        /* ── End transition ────────────────────── */
        if (t >= 1) {
            this._transitionActive = false;
            this._transSurgeMultiplier = 1;
            this.transitionFlash.visible = false;
            this.transitionRing.visible = false;
            for (const p of this._transParticles) {
                p.active = false;
                p.mesh.visible = false;
            }
            return null; // transition complete, use real target
        }

        return this._transInterp;
    }

    /**
     * Update the charging beam each frame.
     * @param {THREE.Vector3} fromPos - shooter position (chest height)
     * @param {THREE.Vector3} toPos   - nearest target position (chest height)
     * @param {number} chargePct      - 0..1 how charged
     */
    update(fromPos, toPos, chargePct) {
        if (!fromPos || !toPos || chargePct <= 0) {
            this.group.visible = false;
            this.active = false;
            this._prevTarget = null;
            return;
        }

        this.active = true;
        this.group.visible = true;

        const dt = 1 / 60; // approximate dt (ChargingBeam doesn't receive dt)
        const pct = Math.min(Math.max(chargePct, 0), 1);
        const t = performance.now() * 0.001; // seconds for animation

        /* ── Detect target switch ──────────────── */
        if (this._prevTarget) {
            const switchDist = this._prevTarget.distanceTo(toPos);
            if (switchDist > 2.0) {
                // Target jumped significantly — trigger transition!
                this.startTransition(this._prevTarget, toPos);
            }
        }
        if (!this._prevTarget) this._prevTarget = new THREE.Vector3();
        this._prevTarget.copy(toPos);

        /* ── Color changes with charge ─────────── */
        if (pct < 0.5) {
            this._beamColor.setHex(0x00ffc8);
        } else if (pct < 0.8) {
            this._colorA.setHex(0x00ffc8);
            this._colorB.setHex(0xffcc00);
            this._beamColor.copy(this._colorA).lerp(this._colorB, (pct - 0.5) / 0.3);
        } else {
            this._colorA.setHex(0xffcc00);
            this._colorB.setHex(0xff2244);
            this._beamColor.copy(this._colorA).lerp(this._colorB, (pct - 0.8) / 0.2);
        }
        const beamColor = this._beamColor;

        /* ── Update transition (may override beam endpoint) ── */
        const transTarget = this._updateTransition(dt, beamColor);
        const effectiveTarget = transTarget || toPos;

        const direction = this._tmpDir.subVectors(effectiveTarget, fromPos);
        const length = direction.length();
        const midpoint = this._tmpMid.addVectors(fromPos, effectiveTarget).multiplyScalar(0.5);

        // Orient: cylinder +Y (top = radiusTop = thin) → target
        //                  -Y (bottom = radiusBottom = wide) → shooter
        const dirNorm = direction.clone().normalize();
        const orient = this._tmpOrient.setFromUnitVectors(
            this._tmpUp.set(0, 1, 0),
            dirNorm
        );

        /* ── Pulse factor when charge is high ──── */
        const basePulse = pct > 0.6 ? 1 + Math.sin(t * 6 + pct * 10) * 0.3 * pct : 1;
        const surge = this._transSurgeMultiplier || 1;
        const pulse = basePulse * surge;

        /* ── Inner beam ────────────────────────── */
        const innerScale = (0.5 + pct * 1.5) * pulse;
        this.beam.scale.set(innerScale, length, innerScale);
        this.beam.position.copy(midpoint);
        this.beam.quaternion.copy(orient);
        this.beamMat.uniforms.uOpacity.value = Math.min((0.06 + pct * 0.55) * pulse, 1.0);
        this.beamMat.uniforms.uColor.value.copy(beamColor);
        this.beamMat.uniforms.uGradientStrength.value = 0.90 - pct * 0.25;

        /* ── Outer glow ────────────────────────── */
        const glowScale = (0.4 + pct * 1.2) * pulse;
        this.glowBeam.scale.set(glowScale, length, glowScale);
        this.glowBeam.position.copy(midpoint);
        this.glowBeam.quaternion.copy(orient);
        this.glowMat.uniforms.uOpacity.value = Math.min((0.03 + pct * 0.22) * pulse, 1.0);
        this.glowMat.uniforms.uColor.value.copy(beamColor);
        this.glowMat.uniforms.uGradientStrength.value = 0.92 - pct * 0.2;

        /* ── Wide halo ─────────────────────────── */
        const haloScale = (0.3 + pct * 1.0) * pulse;
        this.haloBeam.scale.set(haloScale, length, haloScale);
        this.haloBeam.position.copy(midpoint);
        this.haloBeam.quaternion.copy(orient);
        this.haloMat.uniforms.uOpacity.value = Math.min((0.01 + pct * 0.09) * pulse, 1.0);
        this.haloMat.uniforms.uColor.value.copy(beamColor);
        this.haloMat.uniforms.uGradientStrength.value = 0.95 - pct * 0.15;

        /* ── Light — positioned closer to target end ── */
        this._tmpLightPos.lerpVectors(fromPos, effectiveTarget, 0.7);
        this.light.position.copy(this._tmpLightPos);
        this.light.intensity = pct * 2.5 * pulse;
        this.light.color.copy(beamColor);

        /* ── Target ring ───────────────────────── */
        this.targetRing.position.copy(effectiveTarget);
        this.targetRing.position.y = 0.1;
        this.targetRing.material.opacity = (0.05 + pct * 0.6) * pulse;
        this.targetRing.material.color.copy(beamColor);
        const ringScale = (0.4 + pct * 0.3) * (1 + Math.sin(t * 4) * 0.08);
        this.targetRing.scale.setScalar(ringScale);
        this.targetRing.rotation.z = t * 2;

        /* ── Origin glow ───────────────────────── */
        this.originGlow.position.copy(fromPos);
        this.originGlow.material.opacity = (0.03 + pct * 0.25) * pulse;
        this.originGlow.material.color.copy(beamColor);
        const originScale = (0.2 + pct * 0.4) * pulse;
        this.originGlow.scale.setScalar(originScale);

        /* ── Lightning arcs ────────────────────── */
        this._updateLightning(fromPos, effectiveTarget, pct, beamColor, t, dirNorm, length);
    }

    /**
     * Generate procedural lightning arcs along the beam path.
     * Uses a pre-allocated pool of Line objects — just updates their
     * vertex buffers instead of creating/disposing each refresh.
     */
    _updateLightning(fromPos, toPos, pct, beamColor, t, dirNorm, length) {
        // Refresh rate increases with charge
        const refreshInterval = pct > 0.7 ? 0.04 : pct > 0.4 ? 0.08 : 0.14;
        this._lightningTimer += 0.016; // ~60fps tick

        if (this._lightningTimer < refreshInterval) return;
        this._lightningTimer = 0;

        // Hide all lines first
        for (let i = 0; i < this._lightningActive; i++) {
            this._lightningPool[i].visible = false;
        }
        this._lightningActive = 0;

        // Don't show lightning at very low charge
        if (pct < 0.1) return;

        // Number of arcs scales with charge (capped to leave room for branches)
        const arcCount = Math.min(Math.floor(2 + pct * 5), 8);

        // Build perpendicular axes for offset
        const perp1 = this._tmpPerp1.crossVectors(dirNorm, this._tmpUp.set(0, 1, 0));
        if (perp1.lengthSq() < 0.001) perp1.crossVectors(dirNorm, this._tmpUp.set(1, 0, 0));
        perp1.normalize();
        const perp2 = this._tmpPerp2.crossVectors(dirNorm, perp1).normalize();

        let poolIdx = 0;

        for (let a = 0; a < arcCount && poolIdx < MAX_ARC_LINES; a++) {
            const segments = 6 + Math.floor(pct * 8);
            const jitter = (0.1 + pct * 0.5);
            const vertexCount = segments + 1;

            const line = this._lightningPool[poolIdx];
            const posAttr = line.geometry.getAttribute('position');
            const posArray = posAttr.array;

            // Write arc vertices directly into the pre-allocated buffer
            for (let i = 0; i <= segments; i++) {
                const frac = i / segments;
                // Lerp from → to
                let px = fromPos.x + (toPos.x - fromPos.x) * frac;
                let py = fromPos.y + (toPos.y - fromPos.y) * frac;
                let pz = fromPos.z + (toPos.z - fromPos.z) * frac;

                // Add jitter (skip endpoints)
                if (i > 0 && i < segments) {
                    const offset1 = (Math.random() - 0.5) * 2 * jitter;
                    const offset2 = (Math.random() - 0.5) * 2 * jitter;
                    px += perp1.x * offset1 + perp2.x * offset2;
                    py += perp1.y * offset1 + perp2.y * offset2;
                    pz += perp1.z * offset1 + perp2.z * offset2;
                }

                posArray[i * 3] = px;
                posArray[i * 3 + 1] = py;
                posArray[i * 3 + 2] = pz;
            }

            posAttr.needsUpdate = true;
            line.geometry.setDrawRange(0, vertexCount);

            // Update material
            const opacity = (0.2 + pct * 0.7) * (0.6 + Math.random() * 0.4);
            line.material.opacity = opacity;
            this._colorA.copy(beamColor).lerp(this._colorB.setHex(0xffffff), 0.3 + Math.random() * 0.3);
            line.material.color.copy(this._colorA);
            line.visible = true;
            poolIdx++;

            // Small branch arcs at higher charges
            if (pct > 0.4 && Math.random() < pct * 0.5 && poolIdx < MAX_ARC_LINES) {
                const branchIdx = Math.floor(Math.random() * Math.max(1, vertexCount - 2)) + 1;
                const bx = posArray[branchIdx * 3];
                const by = posArray[branchIdx * 3 + 1];
                const bz = posArray[branchIdx * 3 + 2];
                const branchLen = (0.3 + Math.random() * 0.8) * pct;
                this._tmpBranchDir.set(
                    (Math.random() - 0.5) * 2,
                    (Math.random() - 0.5) * 2,
                    (Math.random() - 0.5) * 2
                ).normalize();

                const branchSegs = 3 + Math.floor(Math.random() * 2);
                const bLine = this._lightningPool[poolIdx];
                const bPosAttr = bLine.geometry.getAttribute('position');
                const bPosArray = bPosAttr.array;

                bPosArray[0] = bx;
                bPosArray[1] = by;
                bPosArray[2] = bz;

                for (let s = 1; s <= branchSegs; s++) {
                    const frac = s / branchSegs;
                    this._tmpBranchPt.set(
                        bx + this._tmpBranchDir.x * branchLen * frac + (Math.random() - 0.5) * branchLen * 0.3,
                        by + this._tmpBranchDir.y * branchLen * frac + (Math.random() - 0.5) * branchLen * 0.3,
                        bz + this._tmpBranchDir.z * branchLen * frac + (Math.random() - 0.5) * branchLen * 0.3
                    );
                    bPosArray[s * 3] = this._tmpBranchPt.x;
                    bPosArray[s * 3 + 1] = this._tmpBranchPt.y;
                    bPosArray[s * 3 + 2] = this._tmpBranchPt.z;
                }

                bPosAttr.needsUpdate = true;
                bLine.geometry.setDrawRange(0, branchSegs + 1);
                bLine.material.opacity = opacity * 0.6;
                this._colorA.copy(beamColor).lerp(this._colorB.setHex(0xffffff), 0.5);
                bLine.material.color.copy(this._colorA);
                bLine.visible = true;
                poolIdx++;
            }
        }

        this._lightningActive = poolIdx;
    }

    hide() {
        this.group.visible = false;
        this.active = false;
        this._prevTarget = null;
        // End any active transition
        this._transitionActive = false;
        this._transSurgeMultiplier = 1;
        this.transitionFlash.visible = false;
        this.transitionRing.visible = false;
        for (const p of this._transParticles) {
            p.active = false;
            p.mesh.visible = false;
        }
        // Just hide pool lines (no disposal needed)
        for (let i = 0; i < this._lightningActive; i++) {
            this._lightningPool[i].visible = false;
        }
        this._lightningActive = 0;
    }

    dispose() {
        this.group.traverse(c => {
            if (c.geometry) c.geometry.dispose();
            if (c.material) c.material.dispose();
        });
    }
}
