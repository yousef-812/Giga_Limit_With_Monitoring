const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const net = require('net');
const url = require('url');
const { Transform } = require('stream');
const db = require('./db');

const app = express();
const API_PORT = 3000;
const PROXY_PORT = 8080;

// --- THROTTLE STREAM ---
class ThrottleStream extends Transform {
    constructor(bytesPerSecond) {
        super();
        this.rate = bytesPerSecond;
        this.sent = 0;
        this.start = Date.now();
    }
    _transform(chunk, enc, cb) {
        this.sent += chunk.length;
        const elapsed = Date.now() - this.start;
        const expected = (this.sent / this.rate) * 1000;
        const wait = Math.max(0, expected - elapsed);
        if (wait > 0) {
            setTimeout(() => { this.push(chunk); cb(); }, wait);
        } else {
            this.push(chunk);
            cb();
        }
    }
}

function getThrottleBps() {
    const enabled = db.getSetting('throttle_enabled');
    if (!enabled) return 0;
    const kbps = db.getSetting('throttle_speed_kbps') || 50;
    return kbps * 1024 / 8;
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/app.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/download', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'download.html'));
});

app.get('/download_app', (req, res) => {
    const fs = require('fs');
    // Look for GigaLimit_App.apk in the same folder as the server .exe
    const apkPath = path.join(process.cwd(), 'GigaLimit_App.apk');
    if (fs.existsSync(apkPath)) {
        res.download(apkPath, 'GigaLimit_App.apk');
    } else {
        res.status(404).send('APK not found on server.');
    }
});

const getCleanIp = (req) => {
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (ip.includes('::ffff:')) ip = ip.split('::ffff:')[1];
    return ip;
};

// --- MOBILE APP API ---

app.post('/api/register', (req, res) => {
    const { device_id, name } = req.body;
    const ip = getCleanIp(req);
    
    if (!device_id || !name) return res.status(400).json({ error: 'device_id and name required' });

    const defaultLimit = db.getSetting('global_daily_limit_mb') || 1024;
    const user = db.registerUser(name, device_id, ip, defaultLimit);
    
    res.json({ success: true, user, registered_ip: ip });
});

app.post('/api/ping', (req, res) => {
    const { device_id } = req.body;
    const ip = getCleanIp(req);
    db.updateUserIp(device_id, ip);
    res.json({ success: true });
});

app.post('/api/clear_notification', (req, res) => {
    const { device_id } = req.body;
    const user = db.getUserByDeviceId(device_id);
    if (user) {
        db.clearNotification(user.id);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

app.all('/api/status/:device_id', (req, res) => {
    const device_id = req.params.device_id;
    const ip = getCleanIp(req);
    const today = db.getLocalDateString();
    
    const user = db.getUserByDeviceId(device_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Auto-update IP if the device changed networks (e.g. from Main Router to Access Point)
    if (user.current_ip !== ip) {
        db.updateUserIp(device_id, ip);
        user.current_ip = ip;
    }
    
    const bytes_used = db.getUsage(user.id, today);
    const weekly_bytes_used = db.getWeeklyUsage(user.id);
    const daily_limit_bytes = user.daily_limit_mb * 1024 * 1024;
    const weekly_limit_bytes = (user.weekly_limit_mb || (user.daily_limit_mb * 7)) * 1024 * 1024;
    
    // Calculate if the client should take a screenshot right now
    const { current_app, is_screen_on, is_locked } = req.body || {};
    let take_screenshot = false;

    if (user.monitoring_enabled && is_screen_on && !is_locked && current_app) {
        const targetApps = db.getSetting('target_apps') || [];
        const isSocialApp = targetApps.some(app => current_app.toLowerCase().includes(app.toLowerCase()));
        if (isSocialApp) {
            take_screenshot = true;
        }
    }
    
    res.json({
        user,
        usage_today_bytes: bytes_used,
        daily_remaining_bytes: Math.max(0, daily_limit_bytes - bytes_used),
        weekly_usage_bytes: weekly_bytes_used,
        weekly_limit_bytes: weekly_limit_bytes,
        can_connect: user.status === 'unlimited' || (user.status === 'active' && bytes_used < daily_limit_bytes && weekly_bytes_used < weekly_limit_bytes),
        pending_notification: user.pending_notification || null,
        monitoring_enabled: user.monitoring_enabled || false,
        take_screenshot: take_screenshot
    });
});

// --- ADMIN API ---
const adminAuth = (req, res, next) => {
    const password = req.headers['authorization'];
    if (password === db.getSetting('admin_password')) next();
    else res.status(401).json({ error: 'Unauthorized' });
};

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === db.getSetting('admin_password')) res.json({ success: true, token: password });
    else res.status(401).json({ error: 'Invalid password' });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
    const today = db.getLocalDateString();
    res.json(db.getUsersWithUsage(today));
});

app.post('/api/admin/update_user', adminAuth, (req, res) => {
    const { id, status, daily_limit_mb, weekly_limit_mb } = req.body;
    if (db.updateUserSettings(id, status, daily_limit_mb, weekly_limit_mb)) {
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'User not found' });
    }
});

app.post('/api/admin/set_usage', adminAuth, (req, res) => {
    const { id, daily_bytes, weekly_bytes } = req.body;
    if (db.setUsageDirectly(id, daily_bytes, weekly_bytes)) {
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'User not found' });
    }
});

app.post('/api/admin/send_notification', adminAuth, (req, res) => {
    const { id, message } = req.body;
    if (db.setNotification(id, message)) {
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'User not found' });
    }
});

app.post('/api/admin/renew_daily', adminAuth, (req, res) => {
    const { id } = req.body;
    const today = db.getLocalDateString();
    db.resetUsage(id, today);
    res.json({ success: true });
});

app.post('/api/admin/renew_weekly', adminAuth, (req, res) => {
    const { id } = req.body;
    db.resetWeeklyUsage(id);
    res.json({ success: true });
});

app.get('/api/admin/global_settings', adminAuth, (req, res) => {
    res.json({ 
        global_limit: db.getSetting('global_daily_limit_mb') || 1024,
        global_weekly_limit: db.getSetting('global_weekly_limit_mb') || 7000,
        global_total_bytes: db.getSetting('global_total_bytes_used') || 0,
        server_date: db.getLocalDateString(),
        server_time: new Date().toLocaleTimeString()
    });
});

app.post('/api/admin/global_settings', adminAuth, (req, res) => {
    const { global_limit, global_weekly_limit } = req.body;
    db.updateGlobalLimit(global_limit, global_weekly_limit);
    res.json({ success: true });
});

app.get('/api/admin/auto_renew_settings', adminAuth, (req, res) => {
    res.json(db.getAutoRenewSettings());
});

app.post('/api/admin/auto_renew_settings', adminAuth, (req, res) => {
    db.setAutoRenewSettings(req.body);
    res.json({ success: true });
});

app.get('/api/admin/throttle_settings', adminAuth, (req, res) => {
    res.json(db.getThrottleSettings());
});

app.post('/api/admin/throttle_settings', adminAuth, (req, res) => {
    db.setThrottleSettings(req.body);
    res.json({ success: true });
});

app.post('/api/admin/reset_user', adminAuth, (req, res) => {
    const { id } = req.body;
    db.resetUserToDefault(id);
    res.json({ success: true });
});

app.post('/api/admin/reset_global_total', adminAuth, (req, res) => {
    db.resetGlobalTotal();
    res.json({ success: true });
});

app.post('/api/admin/delete_user', adminAuth, (req, res) => {
    const { id } = req.body;
    if (db.deleteUser(id)) {
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'User not found' });
    }
});

app.post('/api/admin/toggle_monitoring', adminAuth, (req, res) => {
    const { id, enabled } = req.body;
    db.setMonitoring(id, enabled);
    res.json({ success: true });
});

app.post('/api/upload_screenshot', express.raw({ type: 'image/jpeg', limit: '5mb' }), (req, res) => {
    const device_id = req.headers['x-device-id'];
    if (!device_id || !req.body || !req.body.length) {
        return res.status(400).json({ error: 'Missing data' });
    }
    
    const user = db.getUserByDeviceId(device_id);
    if (!user || !user.monitoring_enabled) {
        return res.status(403).json({ error: 'Monitoring not enabled' });
    }

    const fs = require('fs');
    const path = require('path');
    const today = db.getLocalDateString();
    
    const baseDir = 'D:\\Alaa';
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    
    const deviceDir = path.join(baseDir, user.name);
    if (!fs.existsSync(deviceDir)) fs.mkdirSync(deviceDir);
    
    const dateDir = path.join(deviceDir, today);
    if (!fs.existsSync(dateDir)) fs.mkdirSync(dateDir);
    
    const timestamp = Date.now();
    const filePath = path.join(dateDir, `${timestamp}.jpg`);
    
    fs.writeFileSync(filePath, req.body);
    res.json({ success: true });
});

// Auto Archiver (Runs once a day)
setInterval(() => {
    const fs = require('fs');
    const path = require('path');
    const { exec } = require('child_process');
    const baseDir = 'D:\\Alaa';
    if (!fs.existsSync(baseDir)) return;
    
    const users = fs.readdirSync(baseDir);
    const now = Date.now();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    
    users.forEach(user => {
        const userPath = path.join(baseDir, user);
        if (!fs.statSync(userPath).isDirectory()) return;
        
        const dates = fs.readdirSync(userPath);
        dates.forEach(date => {
            const datePath = path.join(userPath, date);
            if (!fs.statSync(datePath).isDirectory()) return;
            
            const timeDiff = now - new Date(date).getTime();
            if (timeDiff > SEVEN_DAYS) {
                const zipPath = path.join(userPath, `${date}.zip`);
                if (!fs.existsSync(zipPath)) {
                    exec(`powershell Compress-Archive -Path '${datePath}\\*' -DestinationPath '${zipPath}' -Force`, (err) => {
                        if (!err) fs.rmSync(datePath, { recursive: true, force: true });
                    });
                }
            }
        });
    });
}, 24 * 60 * 60 * 1000);

// --- AUTO-RENEW SCHEDULER ---
let lastDailyRenewDate = null;
let lastWeeklyRenewDate = null;

setInterval(() => {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const todayDate = db.getLocalDateString();

    const settings = db.getAutoRenewSettings();

    // Daily Auto-Renew
    if (settings.auto_renew_daily_enabled && currentTime === settings.auto_renew_daily_time && lastDailyRenewDate !== todayDate) {
        db.resetAllDailyUsage();
        lastDailyRenewDate = todayDate;
    }

    // Weekly Auto-Renew (check if today is Saturday and time matches)
    if (settings.auto_renew_weekly_enabled && currentTime === settings.auto_renew_weekly_time && lastWeeklyRenewDate !== todayDate) {
        const day = now.getDay(); // 0 = Sunday, 6 = Saturday
        if (day === 6) { // Saturday
            db.resetAllWeeklyUsage();
            lastWeeklyRenewDate = todayDate;
        }
    }
}, 60000); // Check every minute

// --- PROXY ENGINE ---
const proxyServer = http.createServer((req, res) => {
    let clientIp = req.socket.remoteAddress;
    if (clientIp.includes('::ffff:')) clientIp = clientIp.split('::ffff:')[1];

    const parsedUrl = url.parse(req.url);
    
    if (!parsedUrl.hostname) {
        res.writeHead(400);
        res.end('Direct access not allowed. Please use port 3000 to access the Control Panel or Web App.');
        return;
    }

    const isLocal = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost' || (parsedUrl.hostname && parsedUrl.hostname.startsWith('192.168.'));

    if (!isLocal && !isAllowed(clientIp)) {
        res.writeHead(403);
        res.end('Forbidden: Not Registered or Quota Exceeded');
        return;
    }

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.path,
        method: req.method,
        headers: { ...req.headers, 'x-forwarded-for': clientIp }
    };

    try {
        const proxyReq = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (e) => {
            if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
            }
        });

        req.on('error', () => {});
        res.on('error', () => {});

        req.pipe(proxyReq);
    } catch (err) {
        console.error('Invalid Proxy Request:', err.message);
        if (!res.headersSent) {
            res.writeHead(400);
            res.end('Bad Request');
        }
    }
});

const authCache = new Map();

const isAllowed = (ip) => {
    const now = Date.now();
    if (authCache.has(ip) && now - authCache.get(ip).time < 10000) {
        return authCache.get(ip).allowed;
    }

    const today = db.getLocalDateString();
    const user = db.getUserByIp(ip);
    
    if (!user || user.status === 'blocked') {
        authCache.set(ip, { allowed: false, user: null, time: now });
        return false;
    }
    
    if (user.status === 'unlimited') {
        authCache.set(ip, { allowed: true, user: user, time: now });
        return true;
    }

    const bytes_used = db.getUsage(user.id, today);
    const weekly_bytes_used = db.getWeeklyUsage(user.id);
    const daily_limit_bytes = user.daily_limit_mb * 1024 * 1024;
    const weekly_limit_bytes = (user.weekly_limit_mb || (user.daily_limit_mb * 7)) * 1024 * 1024;
    
    const overQuota = bytes_used >= daily_limit_bytes || weekly_bytes_used >= weekly_limit_bytes;
    
    if (overQuota) {
        const throttleBps = getThrottleBps();
        if (throttleBps > 0) {
            authCache.set(ip, { allowed: true, user: user, time: now });
            return true;
        }
        authCache.set(ip, { allowed: false, user: user, time: now });
        return false;
    }
    
    authCache.set(ip, { allowed: true, user: user, time: now });
    return true;
};

const isThrottled = (ip) => {
    const now = Date.now();
    const cached = authCache.get(ip);
    if (!cached || now - cached.time >= 10000 || !cached.allowed || !cached.user || cached.user.status !== 'active') {
        return false;
    }
    const today = db.getLocalDateString();
    const user = cached.user;
    const bytes_used = db.getUsage(user.id, today);
    const weekly_bytes_used = db.getWeeklyUsage(user.id);
    const daily_limit_bytes = user.daily_limit_mb * 1024 * 1024;
    const weekly_limit_bytes = (user.weekly_limit_mb || (user.daily_limit_mb * 7)) * 1024 * 1024;
    return (bytes_used >= daily_limit_bytes || weekly_bytes_used >= weekly_limit_bytes) && getThrottleBps() > 0;
};

proxyServer.on('connect', (req, clientSocket, head) => {
    let clientIp = req.socket.remoteAddress;
    if (clientIp.includes('::ffff:')) clientIp = clientIp.split('::ffff:')[1];

    if (!isAllowed(clientIp)) {
        return;
    }

    req.on('error', () => {});
    clientSocket.on('error', () => {});

    const { port, hostname } = url.parse(`http://${req.url}`);
    const throttled = isThrottled(clientIp);
    const throttleBps = throttled ? getThrottleBps() : 0;
    let currentThrottleBps = throttleBps;

    const applyPipes = (srvSocket) => {
        clientSocket.unpipe();
        srvSocket.unpipe();
        if (currentThrottleBps > 0) {
            const t1 = new ThrottleStream(currentThrottleBps);
            const t2 = new ThrottleStream(currentThrottleBps);
            clientSocket.pipe(t1).pipe(srvSocket);
            srvSocket.pipe(t2).pipe(clientSocket);
        } else {
            clientSocket.pipe(srvSocket);
            srvSocket.pipe(clientSocket);
        }
    };
    
    try {
        const serverSocket = net.connect(port || 443, hostname, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            serverSocket.write(head);
            applyPipes(serverSocket);
        });

        const user = db.getUserByIp(clientIp);
        const userId = user ? user.id : null;

        let bytesTransferred = 0;
        serverSocket.on('data', (chunk) => bytesTransferred += chunk.length);
        clientSocket.on('data', (chunk) => bytesTransferred += chunk.length);

        const saveStats = () => {
            if (bytesTransferred > 0 && userId) {
                const today = db.getLocalDateString();
                db.updateUsage(userId, today, bytesTransferred);
                bytesTransferred = 0;
            }
            if (!isAllowed(clientIp)) {
                clientSocket.pause();
                if (serverSocket) serverSocket.pause();
            } else if (isThrottled(clientIp)) {
                const newBps = getThrottleBps();
                if (newBps > 0 && newBps !== currentThrottleBps) {
                    currentThrottleBps = newBps;
                    applyPipes(serverSocket);
                } else if (newBps === 0 && currentThrottleBps > 0) {
                    currentThrottleBps = 0;
                    applyPipes(serverSocket);
                }
            } else if (currentThrottleBps > 0) {
                currentThrottleBps = 0;
                applyPipes(serverSocket);
            }
        };

        const interval = setInterval(saveStats, 5000);

        const onEnd = () => {
            clearInterval(interval);
            saveStats();
        };

        serverSocket.on('end', onEnd);
        clientSocket.on('end', onEnd);
        serverSocket.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => {
            if (serverSocket) serverSocket.destroy();
        });
    } catch (err) {
        console.error('Invalid Connect Request:', err.message);
        clientSocket.destroy();
    }
});

try {
    const fs = require('fs');
    const https = require('https');
    const sslOptions = {
        key: fs.readFileSync(path.join(__dirname, 'server.key')),
        cert: fs.readFileSync(path.join(__dirname, 'server.cert'))
    };
    https.createServer(sslOptions, app).listen(API_PORT, '0.0.0.0', () => {
        console.log(`Giga Limit API running securely on HTTPS port ${API_PORT}`);
    });
} catch (e) {
    console.log('SSL certs not found, falling back to HTTP');
    app.listen(API_PORT, '0.0.0.0', () => {
        console.log(`Giga Limit API running on port ${API_PORT}`);
    });
}

// Always provide a plain HTTP fallback on port 3001 for devices that reject self-signed HTTPS
const HTTP_PORT = 3001;
app.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`Giga Limit API (Plain HTTP Fallback) running on port ${HTTP_PORT}`);
});

proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`Giga Limit Proxy Engine v3 running on port ${PROXY_PORT}`);
});

// --- SOCKS5 ENGINE ---
const socksServer = net.createServer((clientSocket) => {
    let clientIp = clientSocket.remoteAddress;
    if (clientIp && clientIp.includes('::ffff:')) clientIp = clientIp.split('::ffff:')[1];

    if (!isAllowed(clientIp)) {
        return;
    }

    clientSocket.on('error', () => {});

    clientSocket.once('data', (data) => {
        if (data[0] !== 0x05) {
            clientSocket.end();
            return;
        }
        clientSocket.write(Buffer.from([0x05, 0x00])); // No auth

        clientSocket.once('data', (reqData) => {
            if (reqData[0] !== 0x05 || reqData[1] !== 0x01) {
                clientSocket.end();
                return;
            }

            const atyp = reqData[3];
            let host;
            let portOffset;

            if (atyp === 0x01) {
                host = `${reqData[4]}.${reqData[5]}.${reqData[6]}.${reqData[7]}`;
                portOffset = 8;
            } else if (atyp === 0x03) {
                const domainLen = reqData[4];
                host = reqData.toString('utf8', 5, 5 + domainLen);
                portOffset = 5 + domainLen;
            } else {
                clientSocket.end();
                return;
            }

            const port = reqData.readUInt16BE(portOffset);
            const throttled = isThrottled(clientIp);
            const throttleBps = throttled ? getThrottleBps() : 0;
            let currentThrottleBps = throttleBps;

            const applyPipes = (srvSocket) => {
                clientSocket.unpipe();
                srvSocket.unpipe();
                if (currentThrottleBps > 0) {
                    const t1 = new ThrottleStream(currentThrottleBps);
                    const t2 = new ThrottleStream(currentThrottleBps);
                    clientSocket.pipe(t1).pipe(srvSocket);
                    srvSocket.pipe(t2).pipe(clientSocket);
                } else {
                    clientSocket.pipe(srvSocket);
                    srvSocket.pipe(clientSocket);
                }
            };

            try {
                const serverSocket = net.connect(port, host, () => {
                    const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
                    clientSocket.write(reply);
                    applyPipes(serverSocket);
                });

                const user = db.getUserByIp(clientIp);
                const userId = user ? user.id : null;

                let bytesTransferred = 0;
                serverSocket.on('data', (chunk) => bytesTransferred += chunk.length);
                clientSocket.on('data', (chunk) => bytesTransferred += chunk.length);

                const saveStats = () => {
                    if (bytesTransferred > 0 && userId) {
                        const today = db.getLocalDateString();
                        db.updateUsage(userId, today, bytesTransferred);
                        bytesTransferred = 0;
                    }
                    if (!isAllowed(clientIp)) {
                        clientSocket.pause();
                        if (serverSocket) serverSocket.pause();
                    } else if (isThrottled(clientIp)) {
                        const newBps = getThrottleBps();
                        if (newBps > 0 && newBps !== currentThrottleBps) {
                            currentThrottleBps = newBps;
                            applyPipes(serverSocket);
                        } else if (newBps === 0 && currentThrottleBps > 0) {
                            currentThrottleBps = 0;
                            applyPipes(serverSocket);
                        }
                    } else if (currentThrottleBps > 0) {
                        currentThrottleBps = 0;
                        applyPipes(serverSocket);
                    }
                };

                const interval = setInterval(saveStats, 5000);

                const onEnd = () => {
                    clearInterval(interval);
                    saveStats();
                };

                serverSocket.on('end', onEnd);
                clientSocket.on('end', onEnd);
                serverSocket.on('error', () => clientSocket.end());
                clientSocket.on('error', () => {
                    if (serverSocket) serverSocket.end();
                });
            } catch (err) {
                console.error('Invalid SOCKS5 Request:', err.message);
                clientSocket.end();
            }
        });
    });
});

socksServer.listen(1080, '0.0.0.0', () => {
    console.log(`Giga Limit SOCKS5 Engine running on port 1080`);
});

process.on('uncaughtException', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ETIMEDOUT') {
        // Ignore expected network errors
        return;
    }
    console.error('Unhandled Exception:', err);
});
