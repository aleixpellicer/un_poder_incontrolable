import * as THREE from 'three';

const HALF_ROOM = 19;

export class PlayerController {
    constructor(model) {
        this.model = model;

        this.position = new THREE.Vector3();
        this.velocity = new THREE.Vector3();
        this.rotation = 0;

        this.speed = 11;
        this.jumpForce = 13;
        this.gravity = -32;
        this.grounded = false;
        this.moveState = 'idle';          // 'idle' | 'run' | 'jump'

        this.keys = {};

        document.addEventListener('keydown', (e) => { this.keys[e.code] = true; });
        document.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    }

    update(dt) {
        /* World-space directions (matches static camera perspective) */
        const dir = new THREE.Vector3();
        if (this.keys['KeyW'] || this.keys['ArrowUp']) dir.z -= 1;
        if (this.keys['KeyS'] || this.keys['ArrowDown']) dir.z += 1;
        if (this.keys['KeyA'] || this.keys['ArrowLeft']) dir.x -= 1;
        if (this.keys['KeyD'] || this.keys['ArrowRight']) dir.x += 1;

        if (dir.lengthSq() > 0) {
            dir.normalize();
            this.rotation = Math.atan2(dir.x, dir.z);
        }

        this.velocity.x = dir.x * this.speed;
        this.velocity.z = dir.z * this.speed;

        /* Jump */
        if (this.keys['Space'] && this.grounded) {
            this.velocity.y = this.jumpForce;
            this.grounded = false;
        }

        /* Gravity */
        this.velocity.y += this.gravity * dt;

        /* Integrate */
        this.position.addScaledVector(this.velocity, dt);

        /* Ground */
        if (this.position.y <= 0) {
            this.position.y = 0;
            this.velocity.y = 0;
            this.grounded = true;
        }

        /* Room bounds */
        this.position.x = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, this.position.x));
        this.position.z = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, this.position.z));

        /* Apply to model */
        this.model.mesh.position.copy(this.position);
        this.model.mesh.rotation.y = this.rotation;

        /* Movement state for animations */
        if (!this.grounded) {
            this.moveState = 'jump';
        } else if (dir.lengthSq() > 0) {
            this.moveState = 'run';
        } else {
            this.moveState = 'idle';
        }
    }
}
