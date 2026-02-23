import * as THREE from 'three';

const HALF_ROOM = 19;

export class PlayerController {
    constructor(model) {
        this.model = model;

        this.position = new THREE.Vector3();
        this.velocity = new THREE.Vector3();
        this.rotation = 0;

        this.speed = 11;

        /* ── Dash parameters ────────────────────── */
        this.dashSpeedMultiplier = 4.0;    // initial burst speed = speed * multiplier
        this.dashDuration = 0.35;          // how long the dash lasts (seconds)
        this.dashCooldown = 1.2;           // cooldown between dashes (seconds)
        this.dashCrouchDepth = -0.45;      // how low the model drops during dash
        this._dashTimer = 0;               // remaining dash time
        this._dashCooldownTimer = 0;       // remaining cooldown time
        this._dashDir = new THREE.Vector3(); // cached dash direction
        this._isDashing = false;
        this._dashProgress = 0;            // 0..1 progress through the dash

        this.grounded = true;
        this.moveState = 'idle';           // 'idle' | 'run' | 'dash' | 'falling'

        /* ── Falling / gravity ──────────────────── */
        this.isFalling = false;            // true while airborne after spawn
        this._fallVelocity = 0;            // current downward speed
        this._gravity = 40;                // acceleration (units/s²)
        this._landingTimer = 0;            // squash-stretch timer after landing
        this._landingDuration = 0.35;      // how long the landing animation lasts
        this._isLanding = false;           // true during landing impact animation

        this.keys = {};

        document.addEventListener('keydown', (e) => { this.keys[e.code] = true; });
        document.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    }

    /** Returns dash cooldown progress 0..1 (1 = ready) */
    get dashReady() {
        return this._dashCooldownTimer <= 0 ? 1 : 1 - (this._dashCooldownTimer / this.dashCooldown);
    }

    /** Start falling from current Y position */
    startFalling() {
        this.isFalling = true;
        this._fallVelocity = 0;
        this.grounded = false;
        this._isLanding = false;
        this._landingTimer = 0;
        // Reset model scale in case of previous landing
        this.model.mesh.scale.set(1, 1, 1);
    }

    update(dt) {
        /* ── Handle falling from sky ─────────────── */
        if (this.isFalling) {
            // Apply gravity
            this._fallVelocity += this._gravity * dt;
            this.position.y -= this._fallVelocity * dt;

            // Hit the ground?
            if (this.position.y <= 0) {
                this.position.y = 0;
                this.isFalling = false;
                this.grounded = true;
                this._fallVelocity = 0;

                // Start landing impact animation
                this._isLanding = true;
                this._landingTimer = 0;
            }

            // Update model position while falling (no XZ movement)
            this.model.mesh.position.set(this.position.x, this.position.y, this.position.z);
            this.model.mesh.rotation.y += dt * 3; // slight spin while falling

            this.moveState = 'falling';
            return; // Skip normal movement while falling
        }

        /* ── Landing impact animation ─────────────── */
        if (this._isLanding) {
            this._landingTimer += dt;
            const t = this._landingTimer / this._landingDuration;

            if (t >= 1) {
                // Landing done
                this._isLanding = false;
                this._landingTimer = 0;
                this.model.mesh.scale.set(1, 1, 1);
                this.model.mesh.position.y = 0;
            } else {
                // Squash-and-stretch: squish down then bounce back
                const bounce = Math.sin(t * Math.PI * 2.5) * Math.exp(-t * 4);
                const scaleY = 1 - bounce * 0.35;   // squish Y
                const scaleXZ = 1 + bounce * 0.2;    // stretch XZ
                this.model.mesh.scale.set(scaleXZ, scaleY, scaleXZ);
                this.model.mesh.position.y = 0;
            }
        }

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

        /* ── Tick cooldowns ──────────────────────── */
        if (this._dashCooldownTimer > 0) this._dashCooldownTimer -= dt;
        if (this._dashTimer > 0) this._dashTimer -= dt;

        /* ── Initiate Dash ───────────────────────── */
        if (this.keys['Space'] && this._dashCooldownTimer <= 0 && !this._isDashing && !this._isLanding) {
            this._isDashing = true;
            this._dashTimer = this.dashDuration;
            this._dashCooldownTimer = this.dashCooldown;

            // Dash in movement direction, or facing direction if standing still
            if (dir.lengthSq() > 0) {
                this._dashDir.copy(dir);
            } else {
                // Use facing direction
                this._dashDir.set(Math.sin(this.rotation), 0, Math.cos(this.rotation));
            }
            this._dashDir.normalize();
        }

        /* ── Apply movement ──────────────────────── */
        if (this._isDashing && this._dashTimer > 0) {
            // Allow changing dash direction mid-dash
            if (dir.lengthSq() > 0) {
                this._dashDir.copy(dir).normalize();
                this.rotation = Math.atan2(dir.x, dir.z);
            }

            // Progress 0 → 1 over the dash duration
            this._dashProgress = 1 - (this._dashTimer / this.dashDuration);

            // Friction curve: starts at full speed, eases out toward run speed
            // Using (1 - t)^2 for a smooth deceleration, clamped to never go below run speed
            const friction = (1 - this._dashProgress) * (1 - this._dashProgress);
            const dashSpeed = Math.max(this.speed * this.dashSpeedMultiplier * friction, this.speed);

            this.velocity.x = this._dashDir.x * dashSpeed;
            this.velocity.z = this._dashDir.z * dashSpeed;

            // Lower the model during dash (crouch toward floor)
            // Peak crouch at ~30% through the dash, then gradually rise
            const crouchCurve = Math.sin(this._dashProgress * Math.PI);
            this.model.mesh.position.y = this.dashCrouchDepth * crouchCurve;
        } else {
            // End dash
            if (this._isDashing) {
                this._isDashing = false;
                this._dashProgress = 0;
                this.model.mesh.position.y = 0; // restore height
            }
            // Normal movement
            this.velocity.x = dir.x * this.speed;
            this.velocity.z = dir.z * this.speed;
        }

        // Keep on ground (no gravity/jump)
        this.velocity.y = 0;

        /* Integrate */
        this.position.addScaledVector(this.velocity, dt);

        /* Ground — always on floor */
        this.position.y = 0;

        /* Room bounds */
        this.position.x = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, this.position.x));
        this.position.z = Math.max(-HALF_ROOM, Math.min(HALF_ROOM, this.position.z));

        /* Apply to model (X/Z only, Y is handled by dash crouch or landing) */
        this.model.mesh.position.x = this.position.x;
        this.model.mesh.position.z = this.position.z;
        if (!this._isDashing && !this._isLanding) {
            this.model.mesh.position.y = 0;
        }
        this.model.mesh.rotation.y = this.rotation;

        /* Movement state for animations */
        if (this._isDashing) {
            this.moveState = 'dash';
        } else if (this._isLanding) {
            this.moveState = 'idle';  // play idle during landing squash
        } else if (dir.lengthSq() > 0) {
            this.moveState = 'run';
        } else {
            this.moveState = 'idle';
        }
    }
}
