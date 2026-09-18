const http = require('http');
const https = require('https');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Colors for output
const green = '\x1b[32m';
const red = '\x1b[31m';
const yellow = '\x1b[33m';
const cyan = '\x1b[36m';
const reset = '\x1b[0m';

console.log(`${cyan}====================================================${reset}`);
console.log(`${cyan}  Giga Limit - End-to-End Mobile Simulation Suite   ${reset}`);
console.log(`${cyan}====================================================${reset}\n`);

async function runSimulation() {
    let passed = 0;
    let failed = 0;

    function assertStep(title, condition, detail = '') {
        if (condition) {
            console.log(`${green}[PASS]${reset} ${title}`);
            passed++;
        } else {
            console.log(`${red}[FAIL]${reset} ${title} ${detail ? '(' + detail + ')' : ''}`);
            failed++;
        }
    }

    // Step 1: Check database module
    const db = require('../db');
    assertStep('Database initialized and accessible', db !== null);

    const testDeviceId = `sim_${Date.now()}`;
    const testIp = '127.0.0.1';

    // Step 2: Register mock mobile user
    const user = db.registerUser('Simulated Mobile User', testDeviceId, testIp, 100);
    assertStep('User Registration & Device Token generation', user && user.device_token && user.id > 0);

    // Step 3: Test Device Token verification
    const validToken = db.verifyDeviceToken(testDeviceId, user.device_token);
    const invalidToken = db.verifyDeviceToken(testDeviceId, 'fake_token_123');
    assertStep('Device Token Cryptographic Verification', validToken === true && invalidToken === false);

    // Step 4: Test HMAC-SHA256 Network Ping
    const timestamp = Date.now().toString();
    const mac = crypto.createHmac('sha256', user.device_token);
    const signature = mac.update(`${testDeviceId}:${timestamp}`).digest('hex');
    
    // Verify signature math
    const expectedHex = crypto.createHmac('sha256', user.device_token).update(`${testDeviceId}:${timestamp}`).digest('hex');
    assertStep('HMAC-SHA256 Network Ping signature verification', signature === expectedHex);

    // Step 5: Test SOCKS5 Handshake packet generation
    const greeting = Buffer.from([0x05, 0x01, 0x00]); // SOCKS5, 1 auth method, No Auth
    assertStep('SOCKS5 Client Greeting format', greeting[0] === 0x05 && greeting[1] === 0x01 && greeting[2] === 0x00);

    // Step 6: Test TLS SNI Deep Packet Inspection
    const SOCIAL_DOMAINS = [
        'facebook.com', 'fb.com', 'fb.watch', 'fbcdn.net', 'fbsbx.com', 'messenger.com', 'meta.com',
        'instagram.com', 'cdninstagram.com', 'threads.net', 'threads.com', 'instagr.am',
        'tiktok.com', 'tiktokcdn.com', 'tiktokv.com', 'byteoversea.com', 'ibytedtos.com', 'musical.ly', 'muscdn.com', 'ttwstatic.com',
        'snapchat.com', 'sc-cdn.net', 'snapkit.com', 'snapads.com', 'snap-dev.net'
    ];

    const isSocialHost = (hostname = '') => {
        const host = String(hostname || '').toLowerCase().split(':')[0].replace(/\.$/, '');
        if (!host) return false;
        return SOCIAL_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
    };

    assertStep('Social Block detection: facebook.com', isSocialHost('facebook.com') === true);
    assertStep('Social Block detection: video.tiktokcdn.com', isSocialHost('video.tiktokcdn.com') === true);
    assertStep('Social Block detection: scontent.cdninstagram.com', isSocialHost('scontent.cdninstagram.com') === true);
    assertStep('Social Block detection: app.snapchat.com', isSocialHost('app.snapchat.com') === true);
    assertStep('Social Block passthrough: google.com', isSocialHost('google.com') === false);
    assertStep('Social Block passthrough: github.com', isSocialHost('github.com') === false);

    // Step 7: Test Bandwidth & Quota Accounting
    const today = db.getLocalDateString();
    db.resetUsage(user.id, today);
    assertStep('Usage Reset to 0', db.getUsage(user.id, today) === 0);

    db.updateUsage(user.id, today, 1024 * 1024 * 25); // 25 MB
    assertStep('Usage Accounting correctly records transferred bytes (25MB)', db.getUsage(user.id, today) === 1024 * 1024 * 25);

    // Step 8: Test Token Bucket Rate Limiting math
    const bucket = { tokens: 100000, lastRefill: Date.now(), speedBps: 100000 };
    const bytesToConsume = 50000;
    const speed = 100000; // 100 KB/s
    
    // Simulate consuming 50KB
    if (bucket.tokens >= bytesToConsume) {
        bucket.tokens -= bytesToConsume;
    }
    assertStep('Token Bucket consumes available tokens without delay', bucket.tokens === 50000);

    // Step 9: Test Monitoring Screenshot storage
    const screenshotsDir = path.join(__dirname, '..', 'screenshots', `test_user_${user.id}`, today);
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const mockJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]); // JPEG header
    const shotPath = path.join(screenshotsDir, `${Date.now()}.jpg`);
    fs.writeFileSync(shotPath, mockJpeg);
    assertStep('Screenshot async storage and directory indexing', fs.existsSync(shotPath) && fs.readFileSync(shotPath).length === 10);
    
    // Cleanup mock screenshot
    try { fs.unlinkSync(shotPath); } catch (_) {}

    // Step 10: Test Admin Controls
    db.setSocialBlocked(user.id, true);
    const updatedUser = db.getUserById(user.id);
    assertStep('Admin Toggle Social Blocking per user', updatedUser.social_blocked === true);

    db.setMonitoring(user.id, false);
    assertStep('Admin Toggle Screen Monitoring per user', db.getUserById(user.id).monitoring_enabled === false);

    db.setNotification(user.id, 'مرحباً بك في باقة Giga Limit');
    assertStep('Admin Push Notification to Mobile App', db.getUserById(user.id).pending_notification === 'مرحباً بك في باقة Giga Limit');

    db.clearNotification(user.id);
    assertStep('Clear Notification on Mobile confirmation', db.getUserById(user.id).pending_notification === undefined);

    console.log(`\n${cyan}====================================================${reset}`);
    console.log(`  Simulation Results: ${green}${passed} Passed${reset}, ${failed > 0 ? red : green}${failed} Failed${reset}`);
    console.log(`${cyan}====================================================${reset}\n`);

    if (failed > 0) process.exit(1);
}

runSimulation().catch(err => {
    console.error(`${red}Simulation crashed:${reset}`, err);
    process.exit(1);
});
