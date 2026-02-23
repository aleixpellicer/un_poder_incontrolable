import * as THREE from 'three';

const ROOM = 40;
const WALL_H = 8;
const BOX_HEIGHT = 4;

export class SceneManager {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;

        // Screen-shake state
        this._shakeIntensity = 0;
        this._shakeDuration = 0;
        this._shakeTimer = 0;
        this._baseCamPos = null;

        /** Arena box data (from server) */
        this.arenaBoxes = [];
        this._boxMeshes = [];
    }

    init() {
        /* Scene – clean white background */
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xf8f8f8);

        /* Camera – fixed, looking down at the room */
        this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 200);
        this.camera.position.set(0, 28, 36);
        this.camera.lookAt(0, 0, 2);

        /* Renderer */
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        this.renderer.setSize(innerWidth, innerHeight);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.LinearToneMapping;
        this.renderer.toneMappingExposure = 1.0;
        document.getElementById('game-container').appendChild(this.renderer.domElement);

        window.addEventListener('resize', () => {
            this.camera.aspect = innerWidth / innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(innerWidth, innerHeight);
        });

        this._buildFloor();
        this._buildWalls();
        this._buildLights();
    }

    /* ── Floor – near-white with shadow depth ──── */
    _buildFloor() {
        const geo = new THREE.PlaneGeometry(ROOM, ROOM);
        const mat = new THREE.MeshStandardMaterial({
            color: 0xffffff, roughness: 0.45, metalness: 0.0,
            envMapIntensity: 0.3
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
    }


    /* ── Walls – near-white with shadow depth ──── */
    _buildWalls() {
        const half = ROOM / 2;

        const wallMat = new THREE.MeshStandardMaterial({
            color: 0xfcfcfc, roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide,
            envMapIntensity: 0.2
        });
        const edgeMat = new THREE.LineBasicMaterial({
            color: 0xd8d8d8, transparent: true, opacity: 0.4
        });

        /* Baseboard – subtle dark strip at floor/wall junction for depth */
        const baseboardMat = new THREE.MeshStandardMaterial({
            color: 0xe8e8e8, roughness: 0.6, metalness: 0.0
        });

        const specs = [
            { p: [0, WALL_H / 2, -half], r: [0, 0, 0] },
            { p: [0, WALL_H / 2, half], r: [0, 0, 0], front: true },
            { p: [-half, WALL_H / 2, 0], r: [0, Math.PI / 2, 0] },
            { p: [half, WALL_H / 2, 0], r: [0, Math.PI / 2, 0] },
        ];

        for (const s of specs) {
            // Skip the front wall (closest to camera) so the view is unobstructed
            if (s.front) continue;

            const geo = new THREE.BoxGeometry(ROOM, WALL_H, 0.15);
            const wall = new THREE.Mesh(geo, wallMat);
            wall.position.set(...s.p);
            wall.rotation.set(...s.r);
            wall.receiveShadow = true;
            wall.castShadow = true;
            this.scene.add(wall);

            const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
            edges.position.copy(wall.position);
            edges.rotation.copy(wall.rotation);
            this.scene.add(edges);

            /* Baseboard strip – 0.3 units tall at the base of each wall */
            const bbGeo = new THREE.BoxGeometry(ROOM, 0.3, 0.2);
            const bb = new THREE.Mesh(bbGeo, baseboardMat);
            bb.position.set(s.p[0], 0.15, s.p[2]);
            bb.rotation.set(...s.r);
            bb.receiveShadow = true;
            this.scene.add(bb);
        }

        /* No ceiling — camera looks in from above */
    }

    /* ── Arena cover boxes ────────────────────── */
    buildBoxes(boxes) {
        // Remove any old box meshes
        for (const m of this._boxMeshes) this.scene.remove(m);
        this._boxMeshes = [];
        this.arenaBoxes = boxes || [];

        const boxMat = new THREE.MeshStandardMaterial({
            color: 0xe8e6e1,
            roughness: 0.45,
            metalness: 0.05,
        });
        const edgeMat = new THREE.LineBasicMaterial({
            color: 0xbbbbbb, transparent: true, opacity: 0.7
        });
        const topMat = new THREE.MeshStandardMaterial({
            color: 0xd4d2cc,
            roughness: 0.35,
            metalness: 0.1,
            emissive: 0x222222,
            emissiveIntensity: 0.15
        });

        for (const box of this.arenaBoxes) {
            const w = box.w || 3;
            const d = box.d || 3;
            const h = BOX_HEIGHT;

            const group = new THREE.Group();

            // Main body
            const geo = new THREE.BoxGeometry(w, h, d);
            const mesh = new THREE.Mesh(geo, boxMat);
            mesh.position.set(box.x, h / 2, box.z);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            group.add(mesh);

            // Edge wireframe for definition
            const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
            edges.position.copy(mesh.position);
            group.add(edges);

            // Accent top strip (slightly inset, brighter)
            const topGeo = new THREE.BoxGeometry(w - 0.15, 0.12, d - 0.15);
            const topStrip = new THREE.Mesh(topGeo, topMat);
            topStrip.position.set(box.x, h + 0.06, box.z);
            group.add(topStrip);

            // Subtle base glow ring
            const ringGeo = new THREE.RingGeometry(Math.max(w, d) * 0.52, Math.max(w, d) * 0.58, 4);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0xcccccc,
                transparent: true,
                opacity: 0.18,
                side: THREE.DoubleSide,
                depthWrite: false
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.rotation.x = -Math.PI / 2;
            ring.rotation.z = Math.PI / 4; // rotate 45° so diamond shape matches box
            ring.position.set(box.x, 0.02, box.z);
            group.add(ring);

            this.scene.add(group);
            this._boxMeshes.push(group);
        }
    }

    /* ── Lighting – white room with visible shadows ── */
    _buildLights() {
        /* Hemisphere light – soft sky/ground gradient for ambient occlusion feel */
        const hemi = new THREE.HemisphereLight(0xffffff, 0xe0e0e0, 0.5);
        hemi.position.set(0, 20, 0);
        this.scene.add(hemi);

        /* Reduced ambient so shadows are clearly visible */
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.45));

        /* Main overhead directional – strong shadows */
        const dir = new THREE.DirectionalLight(0xffffff, 1.0);
        dir.position.set(8, 22, 10);
        dir.castShadow = true;
        dir.shadow.mapSize.set(4096, 4096);
        dir.shadow.camera.near = 1;
        dir.shadow.camera.far = 60;
        dir.shadow.camera.left = -25;
        dir.shadow.camera.right = 25;
        dir.shadow.camera.top = 25;
        dir.shadow.camera.bottom = -25;
        dir.shadow.bias = -0.0005;
        dir.shadow.normalBias = 0.02;
        dir.shadow.radius = 3;  /* Softer shadow edges */
        this.scene.add(dir);

        /* Secondary directional – cross-shadows for depth */
        const dir2 = new THREE.DirectionalLight(0xf8f8ff, 0.4);
        dir2.position.set(-10, 18, -8);
        dir2.castShadow = true;
        dir2.shadow.mapSize.set(2048, 2048);
        dir2.shadow.camera.near = 1;
        dir2.shadow.camera.far = 60;
        dir2.shadow.camera.left = -25;
        dir2.shadow.camera.right = 25;
        dir2.shadow.camera.top = 25;
        dir2.shadow.camera.bottom = -25;
        dir2.shadow.bias = -0.0005;
        dir2.shadow.normalBias = 0.02;
        dir2.shadow.radius = 4;
        this.scene.add(dir2);

        /* Slight warm fill from the side – no shadow, just softening */
        const fill = new THREE.DirectionalLight(0xfff8f0, 0.2);
        fill.position.set(-10, 15, -5);
        this.scene.add(fill);

        /* Ceiling point lights – softer, mostly for white-room feel */
        const positions = [[0, 7.8, 0], [-12, 7.8, -12], [12, 7.8, -12], [-12, 7.8, 12], [12, 7.8, 12]];
        for (const p of positions) {
            const l = new THREE.PointLight(0xffffff, 0.15, 25);
            l.position.set(...p);
            this.scene.add(l);
        }
    }

    /**
     * Trigger a camera shake / arena tremble.
     * @param {number} intensity  Max offset in world units (0.3 = subtle, 1.0 = violent)
     * @param {number} duration   Seconds the shake lasts
     */
    shake(intensity = 0.5, duration = 0.4) {
        // Allow stacking — keep the strongest active shake
        if (intensity > this._shakeIntensity) {
            this._shakeIntensity = intensity;
        }
        this._shakeDuration = Math.max(this._shakeDuration, duration);
        this._shakeTimer = 0;
        if (!this._baseCamPos) {
            this._baseCamPos = this.camera.position.clone();
        }
    }

    render() {
        // Apply screen shake
        if (this._shakeIntensity > 0 && this._baseCamPos) {
            this._shakeTimer += 1 / 60; // approx dt per frame
            const progress = this._shakeTimer / this._shakeDuration;

            if (progress >= 1) {
                // Shake finished — restore camera
                this.camera.position.copy(this._baseCamPos);
                this._shakeIntensity = 0;
                this._shakeDuration = 0;
                this._shakeTimer = 0;
                this._baseCamPos = null;
            } else {
                // Decay intensity over time (easeOut)
                const decay = 1 - progress;
                const strength = this._shakeIntensity * decay;

                // Random offsets with high-frequency trembling
                const ox = (Math.random() * 2 - 1) * strength;
                const oy = (Math.random() * 2 - 1) * strength * 0.6;
                const oz = (Math.random() * 2 - 1) * strength * 0.4;

                this.camera.position.set(
                    this._baseCamPos.x + ox,
                    this._baseCamPos.y + oy,
                    this._baseCamPos.z + oz
                );
            }
        }

        this.renderer.render(this.scene, this.camera);
    }
}
