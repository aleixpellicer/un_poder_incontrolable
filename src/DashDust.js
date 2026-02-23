import * as THREE from 'three';

/**
 * DashDust – a burst of brown/tan dust particles spawned during a dash.
 * Attach the `group` to the scene. Call `emit(position, direction)` to
 * spawn a burst, and `update(dt)` every frame.
 */
export class DashDust {
    constructor() {
        this.group = new THREE.Group();
        this.particles = [];

        // Shared geometry & material pool
        const geo = new THREE.CircleGeometry(0.5, 16);
        this._geo = geo;

        // Multiple brown/tan shades for natural look
        this._colors = [
            0x8B6914, // dark goldenrod
            0xA0825A, // tan brown
            0xC4A56C, // sandy
            0x7A6032, // dark earth
            0x9E8B6E, // dusty brown
        ];
    }

    /**
     * Spawn a burst of dust particles at a world position.
     * @param {THREE.Vector3} pos – world position (feet of the character)
     * @param {THREE.Vector3} dashDir – normalized dash direction
     */
    emit(pos, dashDir) {
        const count = 6 + Math.floor(Math.random() * 4); // 6-9 particles

        for (let i = 0; i < count; i++) {
            const color = this._colors[Math.floor(Math.random() * this._colors.length)];
            const mat = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.3 + Math.random() * 0.2,
                side: THREE.DoubleSide,
                depthWrite: false,
            });

            const mesh = new THREE.Mesh(this._geo, mat);
            const size = 0.3 + Math.random() * 0.5;
            mesh.scale.setScalar(size);

            // Position: at feet level with slight random offset
            mesh.position.set(
                pos.x + (Math.random() - 0.5) * 1.2,
                0.05 + Math.random() * 0.3,
                pos.z + (Math.random() - 0.5) * 1.2
            );

            // Lay flat on the ground, random rotation
            mesh.rotation.x = -Math.PI / 2;
            mesh.rotation.z = Math.random() * Math.PI * 2;

            // Velocity: mostly spread sideways/backward from dash direction
            const spread = (Math.random() - 0.5) * 4;
            const backward = -1 - Math.random() * 2; // go opposite to dash
            const up = 0.5 + Math.random() * 1.5;

            const vel = new THREE.Vector3(
                dashDir.x * backward + dashDir.z * spread,
                up,
                dashDir.z * backward - dashDir.x * spread
            );

            this.group.add(mesh);
            this.particles.push({
                mesh,
                mat,
                vel,
                life: 0,
                maxLife: 0.4 + Math.random() * 0.4, // 0.4–0.8s
                growRate: 1.5 + Math.random() * 1.0,
                startSize: size,
            });
        }
    }

    /**
     * Spawn trailing dust (called every frame during a dash).
     * Much smaller burst for a continuous trail effect.
     */
    emitTrail(pos, dashDir, progress = 0) {
        const fade = 1 - progress; // 1 at start → 0 at end
        const count = 1 + Math.floor(Math.random() * 2); // 1-2 particles

        for (let i = 0; i < count; i++) {
            const color = this._colors[Math.floor(Math.random() * this._colors.length)];
            const mat = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: (0.25 + Math.random() * 0.15) * fade,
                side: THREE.DoubleSide,
                depthWrite: false,
            });

            const mesh = new THREE.Mesh(this._geo, mat);
            const size = (0.2 + Math.random() * 0.3) * (0.3 + 0.7 * fade);
            mesh.scale.setScalar(size);

            mesh.position.set(
                pos.x + (Math.random() - 0.5) * 0.8,
                0.05 + Math.random() * 0.15,
                pos.z + (Math.random() - 0.5) * 0.8
            );

            mesh.rotation.x = -Math.PI / 2;
            mesh.rotation.z = Math.random() * Math.PI * 2;

            const spread = (Math.random() - 0.5) * 2 * fade;
            const backward = (-0.5 - Math.random() * 1.0) * fade;
            const up = (0.3 + Math.random() * 0.8) * fade;

            const vel = new THREE.Vector3(
                dashDir.x * backward + dashDir.z * spread,
                up,
                dashDir.z * backward - dashDir.x * spread
            );

            this.group.add(mesh);
            this.particles.push({
                mesh,
                mat,
                vel,
                life: 0,
                maxLife: (0.3 + Math.random() * 0.3) * (0.4 + 0.6 * fade),
                growRate: (1.0 + Math.random() * 0.8) * fade,
                startSize: size,
            });
        }
    }

    update(dt) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.life += dt;

            const t = p.life / p.maxLife; // 0..1

            // Move
            p.mesh.position.x += p.vel.x * dt;
            p.mesh.position.y += p.vel.y * dt;
            p.mesh.position.z += p.vel.z * dt;

            // Slow down (air resistance)
            p.vel.multiplyScalar(1 - 3.0 * dt);

            // Gravity on Y
            p.vel.y -= 2.0 * dt;

            // Don't go below floor
            if (p.mesh.position.y < 0.02) {
                p.mesh.position.y = 0.02;
                p.vel.y = 0;
            }

            // Grow over time (dust expands)
            const scale = p.startSize + p.growRate * t;
            p.mesh.scale.setScalar(scale);

            // Fade out
            const smooth = (1 - t) * (1 - t); // quadratic ease-out
            p.mat.opacity = smooth * 0.45;

            // Remove dead particles
            if (t >= 1) {
                this.group.remove(p.mesh);
                p.mat.dispose();
                this.particles.splice(i, 1);
            }
        }
    }

    dispose() {
        for (const p of this.particles) {
            this.group.remove(p.mesh);
            p.mat.dispose();
        }
        this.particles.length = 0;
        this._geo.dispose();
    }
}
