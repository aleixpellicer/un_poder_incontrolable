/**
 * GitHub Webhook listener for auto-deploy
 * Listens on port 9000, triggers deploy.sh when a push to main is received
 *
 * Set WEBHOOK_SECRET env var to your GitHub webhook secret
 */

import http from 'http';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 9000;
const SECRET = process.env.WEBHOOK_SECRET || '';
const DEPLOY_SCRIPT = join(__dirname, 'deploy.sh');
const BRANCH = 'main';

function verifySignature(payload, signature) {
    if (!SECRET) return true; // No secret configured, accept all
    const hmac = crypto.createHmac('sha256', SECRET);
    hmac.update(payload);
    const digest = 'sha256=' + hmac.digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature || ''), Buffer.from(digest));
}

let deploying = false;

const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook') {
        res.writeHead(404);
        res.end('Not found');
        return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        // Verify GitHub signature
        const signature = req.headers['x-hub-signature-256'];
        if (SECRET && !verifySignature(body, signature)) {
            console.log('❌ Invalid signature');
            res.writeHead(401);
            res.end('Invalid signature');
            return;
        }

        try {
            const payload = JSON.parse(body);
            const ref = payload.ref || '';

            // Only deploy on pushes to main branch
            if (ref !== `refs/heads/${BRANCH}`) {
                console.log(`ℹ️  Push to ${ref}, ignoring (only deploying ${BRANCH})`);
                res.writeHead(200);
                res.end('OK - ignored branch');
                return;
            }

            if (deploying) {
                console.log('⏳ Deploy already in progress, skipping');
                res.writeHead(200);
                res.end('OK - deploy in progress');
                return;
            }

            console.log(`\n🔔 Push to ${BRANCH} detected! Starting deploy...`);
            deploying = true;

            res.writeHead(200);
            res.end('OK - deploying');

            execFile('bash', [DEPLOY_SCRIPT], { cwd: dirname(DEPLOY_SCRIPT) }, (err, stdout, stderr) => {
                deploying = false;
                if (err) {
                    console.error('❌ Deploy failed:', err.message);
                    console.error(stderr);
                } else {
                    console.log(stdout);
                    console.log('✅ Deploy finished successfully');
                }
            });
        } catch (e) {
            console.error('❌ Failed to parse webhook payload:', e.message);
            res.writeHead(400);
            res.end('Bad request');
        }
    });
});

server.listen(PORT, () => {
    console.log(`\n🪝 Webhook server listening on port ${PORT}`);
    console.log(`   POST http://YOUR_VPS_IP:${PORT}/webhook`);
    if (!SECRET) console.log('   ⚠️  No WEBHOOK_SECRET set — accepting all requests');
});
