import * as THREE from 'three';

/* ── Distortion sphere shader ──────────────────────── */
const distortVertexShader = /* glsl */`
    uniform float uTime;
    uniform float uIntensity;
    varying vec2 vUv;
    varying float vDistort;

    // Simple noise
    float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    float noise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
            mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
            f.z
        );
    }

    void main() {
        vUv = uv;
        vec3 pos = position;

        // Distort the sphere vertices with animated noise
        float n = noise(pos * 2.0 + uTime * 3.0) * 2.0 - 1.0;
        float n2 = noise(pos * 4.0 - uTime * 5.0) * 2.0 - 1.0;
        vDistort = n * 0.5 + 0.5;

        pos += normal * (n * 0.4 + n2 * 0.2) * uIntensity;

        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
`;

const distortFragmentShader = /* glsl */`
    uniform vec3 uColor;
    uniform float uOpacity;
    uniform float uTime;
    varying vec2 vUv;
    varying float vDistort;

    void main() {
        // Create swirling energy pattern
        float pattern = sin(vUv.x * 12.0 + uTime * 4.0) * sin(vUv.y * 12.0 - uTime * 3.0);
        pattern = pattern * 0.5 + 0.5;

        // Edge glow — stronger at the silhouette edges
        float edge = pow(1.0 - abs(dot(vec3(0.0, 0.0, 1.0), vec3(vUv * 2.0 - 1.0, 0.5))), 2.0);

        // Combine: bright wisps with see-through interior
        float alpha = (pattern * 0.3 + edge * 0.4 + vDistort * 0.2) * uOpacity;
        alpha = clamp(alpha, 0.0, 1.0);

        // Hot core → cooler edge color shift
        vec3 hotColor = vec3(1.0, 0.95, 0.8); // white-hot
        vec3 finalColor = mix(uColor, hotColor, pattern * vDistort * 0.6);

        gl_FragColor = vec4(finalColor, alpha);
    }
`;

/* ── Shockwave ring shader ─────────────────────────── */
const shockwaveVertexShader = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const shockwaveFragmentShader = /* glsl */`
    uniform vec3 uColor;
    uniform float uOpacity;
    uniform float uRingWidth;
    varying vec2 vUv;

    void main() {
        // Distance from center of the ring quad
        vec2 centered = vUv * 2.0 - 1.0;
        float dist = length(centered);

        // Create a thin ring
        float ring = smoothstep(1.0 - uRingWidth, 1.0 - uRingWidth * 0.5, dist)
                   * smoothstep(1.0, 1.0 - uRingWidth * 0.3, dist);

        float alpha = ring * uOpacity;
        if (alpha < 0.01) discard;

        gl_FragColor = vec4(uColor, alpha);
    }
`;


/**
 * Animated energy BEAM that strikes instantly from shooter → target.
 * A bright laser-like beam with a see-through distortion explosion on impact.
 */
export class PowerEffect {
    constructor(from, to, color) {
        this.group = new THREE.Group();
        this.from = from.clone();
        this.to = to.clone();
        this.age = 0;
        this.maxAge = 1.2;

        const c = new THREE.Color(color);
        const direction = new THREE.Vector3().subVectors(to, from);
        const length = direction.length();
        const midpoint = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);

        /* ── Main beam (cylinder) ─────────────────── */
        const beamGeo = new THREE.CylinderGeometry(0.08, 0.08, length, 8, 1, true);
        const beamMat = new THREE.MeshBasicMaterial({
            color: c,
            transparent: true,
            opacity: 1.0,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.beam = new THREE.Mesh(beamGeo, beamMat);
        this.beam.position.copy(midpoint);
        this.beam.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            direction.clone().normalize()
        );
        this.group.add(this.beam);

        /* ── Outer glow beam (wider, transparent) ──── */
        const glowGeo = new THREE.CylinderGeometry(0.25, 0.25, length, 8, 1, true);
        const glowMat = new THREE.MeshBasicMaterial({
            color: c,
            transparent: true,
            opacity: 0.35,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.glowBeam = new THREE.Mesh(glowGeo, glowMat);
        this.glowBeam.position.copy(midpoint);
        this.glowBeam.quaternion.copy(this.beam.quaternion);
        this.group.add(this.glowBeam);

        /* ── Wide halo beam (very faint) ───────────── */
        const haloGeo = new THREE.CylinderGeometry(0.5, 0.5, length, 8, 1, true);
        const haloMat = new THREE.MeshBasicMaterial({
            color: c,
            transparent: true,
            opacity: 0.12,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.haloBeam = new THREE.Mesh(haloGeo, haloMat);
        this.haloBeam.position.copy(midpoint);
        this.haloBeam.quaternion.copy(this.beam.quaternion);
        this.group.add(this.haloBeam);

        /* ── Point light along beam ──────────────── */
        this.lightSource = new THREE.PointLight(c, 3, 20);
        this.lightSource.position.copy(midpoint);
        this.group.add(this.lightSource);

        /* ── Origin flash ────────────────────────── */
        const originFlashGeo = new THREE.SphereGeometry(0.6, 12, 12);
        const originFlashMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.7,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.originFlash = new THREE.Mesh(originFlashGeo, originFlashMat);
        this.originFlash.position.copy(from);
        this.group.add(this.originFlash);

        /* ── Impact distortion sphere (see-through!) ─ */
        const distortGeo = new THREE.SphereGeometry(1.2, 24, 24);
        const distortMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: c.clone() },
                uOpacity: { value: 0.6 },
                uTime: { value: 0 },
                uIntensity: { value: 1.0 }
            },
            vertexShader: distortVertexShader,
            fragmentShader: distortFragmentShader,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending
        });
        this.distortSphere = new THREE.Mesh(distortGeo, distortMat);
        this.distortSphere.position.copy(to);
        this.group.add(this.distortSphere);

        /* ── Shockwave rings (multiple, expanding) ─── */
        this.shockwaves = [];
        for (let i = 0; i < 3; i++) {
            const ringGeo = new THREE.PlaneGeometry(6, 6);
            const ringMat = new THREE.ShaderMaterial({
                uniforms: {
                    uColor: { value: c.clone() },
                    uOpacity: { value: 0.5 },
                    uRingWidth: { value: 0.15 + i * 0.05 }
                },
                vertexShader: shockwaveVertexShader,
                fragmentShader: shockwaveFragmentShader,
                transparent: true,
                depthWrite: false,
                side: THREE.DoubleSide,
                blending: THREE.AdditiveBlending
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.position.copy(to);
            ring.rotation.x = -Math.PI / 2;
            ring.position.y = 0.1 + i * 0.05;
            this.group.add(ring);
            this.shockwaves.push({ mesh: ring, delay: i * 0.08 });
        }

        /* ── Energy sparks (small additive sprites) ── */
        this.sparks = [];
        const sparkCount = 12;
        for (let i = 0; i < sparkCount; i++) {
            const sparkGeo = new THREE.SphereGeometry(0.06 + Math.random() * 0.08, 6, 6);
            const sparkMat = new THREE.MeshBasicMaterial({
                color: c.clone().lerp(new THREE.Color(0xffffff), 0.5),
                transparent: true,
                opacity: 0.8,
                depthWrite: false,
                blending: THREE.AdditiveBlending
            });
            const spark = new THREE.Mesh(sparkGeo, sparkMat);
            spark.position.copy(to);

            // Random direction for each spark
            const angle = (Math.PI * 2 * i) / sparkCount + (Math.random() - 0.5) * 0.5;
            const elevation = (Math.random() - 0.3) * Math.PI * 0.6;
            const speed = 3 + Math.random() * 5;
            const velocity = new THREE.Vector3(
                Math.cos(angle) * Math.cos(elevation) * speed,
                Math.sin(elevation) * speed * 0.7 + 2,
                Math.sin(angle) * Math.cos(elevation) * speed
            );

            this.group.add(spark);
            this.sparks.push({ mesh: spark, velocity, life: 0.4 + Math.random() * 0.6 });
        }

        /* ── Inner flash (very brief, small, additive) ── */
        const flashGeo = new THREE.SphereGeometry(0.5, 12, 12);
        const flashMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.impactFlash = new THREE.Mesh(flashGeo, flashMat);
        this.impactFlash.position.copy(to);
        this.group.add(this.impactFlash);

        /* ── Impact point light ──────────────────── */
        this.impactLight = new THREE.PointLight(c, 5, 18);
        this.impactLight.position.copy(to);
        this.group.add(this.impactLight);
    }

    update(dt) {
        this.age += dt;
        const t = this.age / this.maxAge;  // 0 → 1

        // Beam fades out
        const beamOpacity = Math.max(0, 1 - t * 1.5);
        this.beam.material.opacity = beamOpacity;
        this.glowBeam.material.opacity = beamOpacity * 0.35;
        this.haloBeam.material.opacity = beamOpacity * 0.12;

        // Light fades
        this.lightSource.intensity = Math.max(0, 3 * (1 - t));
        this.impactLight.intensity = Math.max(0, 5 * (1 - t * 1.2));

        // Origin flash shrinks fast
        const originScale = Math.max(0, 1 - t * 3);
        this.originFlash.scale.setScalar(originScale);
        this.originFlash.material.opacity = originScale * 0.7;

        /* ── Distortion sphere — expands, wobbles, fades ── */
        const distortScale = 1 + t * 3.5;
        this.distortSphere.scale.setScalar(distortScale);
        this.distortSphere.material.uniforms.uTime.value = this.age;
        this.distortSphere.material.uniforms.uOpacity.value = Math.max(0, 0.5 * (1 - t * 1.3));
        this.distortSphere.material.uniforms.uIntensity.value = Math.max(0, 1.0 - t * 0.8);
        // Rotate slowly for extra visual chaos
        this.distortSphere.rotation.y += dt * 2;
        this.distortSphere.rotation.x += dt * 1.3;

        /* ── Shockwave rings — staggered expansion ───── */
        for (const sw of this.shockwaves) {
            const ringT = Math.max(0, (this.age - sw.delay) / (this.maxAge * 0.7));
            if (ringT <= 0) continue;
            const ringScale = 1 + ringT * 6;
            sw.mesh.scale.set(ringScale, ringScale, 1);
            sw.mesh.material.uniforms.uOpacity.value = Math.max(0, 0.45 * (1 - ringT));
        }

        /* ── Energy sparks — fly outward with gravity ──── */
        for (const spark of this.sparks) {
            if (this.age > spark.life) {
                spark.mesh.visible = false;
                continue;
            }
            const sparkT = this.age / spark.life;
            spark.mesh.position.x += spark.velocity.x * dt;
            spark.mesh.position.y += spark.velocity.y * dt;
            spark.mesh.position.z += spark.velocity.z * dt;
            spark.velocity.y -= 9.8 * dt; // gravity
            spark.mesh.material.opacity = Math.max(0, 0.8 * (1 - sparkT));
            const sparkScale = 1 + sparkT * 0.5;
            spark.mesh.scale.setScalar(sparkScale);
        }

        /* ── Inner flash — very quick pop ───────────── */
        const flashT = Math.min(t * 5, 1); // completes in ~20% of total time
        this.impactFlash.scale.setScalar(1 + flashT * 2);
        this.impactFlash.material.opacity = Math.max(0, 0.6 * (1 - flashT));
    }

    isDone() {
        return this.age >= this.maxAge;
    }

    dispose() {
        this.group.traverse(c => {
            if (c.geometry) c.geometry.dispose();
            if (c.material) c.material.dispose();
        });
    }
}
