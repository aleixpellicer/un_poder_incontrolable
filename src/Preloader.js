import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

/**
 * Preloads all heavy assets (FBX models & animations) in the background
 * during the splash screen so the game starts instantly.
 *
 * Usage:
 *   const preloader = new Preloader(onProgress);
 *   await preloader.loadAll();
 *   // preloader.assets is now populated
 */
export class Preloader {
    constructor(onProgress) {
        /** @type {(loaded: number, total: number) => void} */
        this.onProgress = onProgress || (() => { });

        /** Cached FBX objects – filled after loadAll() resolves */
        this.assets = {
            character: null,
            idle: null,
            run: null,
            dash: null,
        };
    }

    /**
     * Kick off all downloads in parallel. Resolves when every asset is ready.
     */
    async loadAll() {
        const loader = new FBXLoader();

        const urls = [
            { key: 'character', url: '/models/character.fbx' },
            { key: 'idle', url: '/models/Idle.fbx' },
            { key: 'run', url: '/models/Running.fbx' },
            { key: 'dash', url: '/models/Dash.fbx' },
        ];

        const totalFiles = urls.length;
        let filesLoaded = 0;
        // Track individual file progress (bytes)
        const fileProgress = new Array(totalFiles).fill(0);
        const fileTotals = new Array(totalFiles).fill(0);

        const reportProgress = () => {
            const loaded = fileProgress.reduce((a, b) => a + b, 0);
            const total = fileTotals.reduce((a, b) => a + b, 0);
            this.onProgress(loaded, total || 1);
        };

        const promises = urls.map((entry, index) => {
            return new Promise((resolve, reject) => {
                loader.load(
                    entry.url,
                    (fbx) => {
                        this.assets[entry.key] = fbx;
                        filesLoaded++;
                        // Ensure progress shows 100% for this file
                        fileProgress[index] = fileTotals[index] || 1;
                        reportProgress();
                        resolve(fbx);
                    },
                    (xhr) => {
                        if (xhr.lengthComputable) {
                            fileTotals[index] = xhr.total;
                            fileProgress[index] = xhr.loaded;
                        } else {
                            // Estimate ~30MB per file
                            fileTotals[index] = 30_000_000;
                            fileProgress[index] = Math.min(xhr.loaded, 30_000_000);
                        }
                        reportProgress();
                    },
                    reject
                );
            });
        });

        await Promise.all(promises);
    }
}
