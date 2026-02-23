import * as THREE from 'three';

/**
 * A live "preview beam" shown while the power is charging.
 * - Connects the charged player to the nearest alive player.
 * - TAPERED: wider & brighter at the shooter, thinner & dimmer at the target.
 * - Grows in opacity / thickness as charge % increases.
 * - Uses a custom shader for smooth opacity gradient along the beam.
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

export class ChargingBeam {
    constructor() {
        this.group = new THREE.Group();
        this.active = false;

        /* ── Core beam (inner) — tapered ───────── */
        // radiusTop = target end (wide), radiusBottom = shooter end (thin)
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
        const originGeo = new THREE.SphereGeometry(0.2, 12, 12);
        const originMat = new THREE.MeshBasicMaterial({
            color: 0x00ffc8,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.originGlow = new THREE.Mesh(originGeo, originMat);
        this.group.add(this.originGlow);

        this.group.visible = false;
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
            return;
        }

        this.active = true;
        this.group.visible = true;

        const pct = Math.min(Math.max(chargePct, 0), 1);
        const t = performance.now() * 0.001; // seconds for animation

        const direction = new THREE.Vector3().subVectors(toPos, fromPos);
        const length = direction.length();
        const midpoint = new THREE.Vector3().addVectors(fromPos, toPos).multiplyScalar(0.5);

        // Orient: cylinder +Y (top = radiusTop = thin) → target
        //                  -Y (bottom = radiusBottom = wide) → shooter
        const orient = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            direction.clone().normalize()
        );

        /* ── Color changes with charge ─────────── */
        let beamColor;
        if (pct < 0.5) {
            beamColor = new THREE.Color(0x00ffc8);
        } else if (pct < 0.8) {
            beamColor = new THREE.Color(0x00ffc8).lerp(new THREE.Color(0xffcc00), (pct - 0.5) / 0.3);
        } else {
            beamColor = new THREE.Color(0xffcc00).lerp(new THREE.Color(0xff2244), (pct - 0.8) / 0.2);
        }

        /* ── Pulse factor when charge is high ──── */
        const pulse = pct > 0.6 ? 1 + Math.sin(t * 6 + pct * 10) * 0.3 * pct : 1;

        /* ── Inner beam ────────────────────────── */
        // Width scale grows with charge (tapered shape is baked in geometry)
        const innerScale = (0.5 + pct * 1.5) * pulse;
        this.beam.scale.set(innerScale, length, innerScale);
        this.beam.position.copy(midpoint);
        this.beam.quaternion.copy(orient);
        this.beamMat.uniforms.uOpacity.value = (0.06 + pct * 0.55) * pulse;
        this.beamMat.uniforms.uColor.value.copy(beamColor);
        // Gradient gets slightly less harsh as charge builds (beam becomes more "solid")
        this.beamMat.uniforms.uGradientStrength.value = 0.90 - pct * 0.25;

        /* ── Outer glow ────────────────────────── */
        const glowScale = (0.4 + pct * 1.2) * pulse;
        this.glowBeam.scale.set(glowScale, length, glowScale);
        this.glowBeam.position.copy(midpoint);
        this.glowBeam.quaternion.copy(orient);
        this.glowMat.uniforms.uOpacity.value = (0.03 + pct * 0.22) * pulse;
        this.glowMat.uniforms.uColor.value.copy(beamColor);
        this.glowMat.uniforms.uGradientStrength.value = 0.92 - pct * 0.2;

        /* ── Wide halo ─────────────────────────── */
        const haloScale = (0.3 + pct * 1.0) * pulse;
        this.haloBeam.scale.set(haloScale, length, haloScale);
        this.haloBeam.position.copy(midpoint);
        this.haloBeam.quaternion.copy(orient);
        this.haloMat.uniforms.uOpacity.value = (0.01 + pct * 0.09) * pulse;
        this.haloMat.uniforms.uColor.value.copy(beamColor);
        this.haloMat.uniforms.uGradientStrength.value = 0.95 - pct * 0.15;

        /* ── Light — positioned closer to target end ── */
        // Place light 70% from the shooter toward the target
        const lightPos = new THREE.Vector3().lerpVectors(fromPos, toPos, 0.7);
        this.light.position.copy(lightPos);
        this.light.intensity = pct * 2.5 * pulse;
        this.light.color.copy(beamColor);

        /* ── Target ring — prominent (beam is intense here) ── */
        this.targetRing.position.copy(toPos);
        this.targetRing.position.y = 0.1;
        this.targetRing.material.opacity = (0.05 + pct * 0.6) * pulse;
        this.targetRing.material.color.copy(beamColor);
        const ringScale = (0.4 + pct * 0.3) * (1 + Math.sin(t * 4) * 0.08);
        this.targetRing.scale.setScalar(ringScale);
        this.targetRing.rotation.z = t * 2;

        /* ── Origin glow — subtle at shooter ───── */
        this.originGlow.position.copy(fromPos);
        this.originGlow.material.opacity = (0.03 + pct * 0.25) * pulse;
        this.originGlow.material.color.copy(beamColor);
        const originScale = (0.2 + pct * 0.4) * pulse;
        this.originGlow.scale.setScalar(originScale);
    }

    hide() {
        this.group.visible = false;
        this.active = false;
    }

    dispose() {
        this.group.traverse(c => {
            if (c.geometry) c.geometry.dispose();
            if (c.material) c.material.dispose();
        });
    }
}
