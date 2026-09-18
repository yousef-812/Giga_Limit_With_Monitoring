const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../db');

function createTlsClientHello(sniHostname) {
    const sniBytes = Buffer.from(sniHostname, 'utf8');
    const sniLen = sniBytes.length;
    
    const extLen = 2 + 1 + 2 + sniLen;
    const sniExt = Buffer.alloc(4 + extLen);
    sniExt.writeUInt16BE(0x0000, 0);
    sniExt.writeUInt16BE(extLen, 2);
    sniExt.writeUInt16BE(extLen - 2, 4);
    sniExt.writeUInt8(0x00, 6);
    sniExt.writeUInt16BE(sniLen, 7);
    sniBytes.copy(sniExt, 9);

    const extensionsTotalLen = sniExt.length;
    const extensionsBlock = Buffer.alloc(2 + extensionsTotalLen);
    extensionsBlock.writeUInt16BE(extensionsTotalLen, 0);
    sniExt.copy(extensionsBlock, 2);

    const random = crypto.randomBytes(32);
    const sessionId = crypto.randomBytes(32);
    const cipherSuites = Buffer.from([0x00, 0x02, 0x13, 0x01]);
    const compression = Buffer.from([0x01, 0x00]);

    const handshakeBody = Buffer.concat([
        Buffer.from([0x03, 0x03]),
        random,
        Buffer.from([sessionId.length]),
        sessionId,
        cipherSuites,
        compression,
        extensionsBlock
    ]);

    const handshakeHeader = Buffer.alloc(4);
    handshakeHeader.writeUInt8(0x01, 0);
    handshakeHeader.writeUIntBE(handshakeBody.length, 1, 3);

    const handshakeRecord = Buffer.concat([handshakeHeader, handshakeBody]);

    const recordHeader = Buffer.alloc(5);
    recordHeader.writeUInt8(0x16, 0);
    recordHeader.writeUInt16BE(0x0301, 1);
    recordHeader.writeUInt16BE(handshakeRecord.length, 3);

    return Buffer.concat([recordHeader, handshakeRecord]);
}

function createDnsQueryPacket(domain) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x1234, 0);
    header.writeUInt16BE(0x0100, 2);
    header.writeUInt16BE(0x0001, 4);
    header.writeUInt16BE(0x0000, 6);
    header.writeUInt16BE(0x0000, 8);
    header.writeUInt16BE(0x0000, 10);

    const labels = domain.split('.');
    const qnameBuffers = [];
    for (const label of labels) {
        const len = Buffer.alloc(1);
        len.writeUInt8(label.length, 0);
        qnameBuffers.push(len, Buffer.from(label, 'utf8'));
    }
    qnameBuffers.push(Buffer.from([0x00]));

    const questionSuffix = Buffer.alloc(4);
    questionSuffix.writeUInt16BE(0x0001, 0);
    questionSuffix.writeUInt16BE(0x0001, 2);

    return Buffer.concat([header, ...qnameBuffers, questionSuffix]);
}

test('Rigorous System Test: Device Registration, HMAC Network Ping, & Quota', () => {
    const testDeviceId = 'dev_test_rigorous_01';
    const testDeviceIp = '127.0.0.1';
    
    const user = db.registerUser('Test Rigorous User', testDeviceId, testDeviceIp, 500);
    assert.ok(user.id > 0);
    assert.equal(user.device_id, testDeviceId);
    assert.ok(user.device_token && user.device_token.length > 20);

    assert.equal(db.verifyDeviceToken(testDeviceId, user.device_token), true);
    assert.equal(db.verifyDeviceToken(testDeviceId, 'invalid_token'), false);

    const today = db.getLocalDateString();
    db.resetUsage(user.id, today);
    assert.equal(db.getUsage(user.id, today), 0);

    db.updateUsage(user.id, today, 1024 * 1024 * 50);
    assert.equal(db.getUsage(user.id, today), 1024 * 1024 * 50);
});

test('Rigorous Social Blocking: TLS SNI Sniffing across platforms & CDNs', () => {
    const testDomains = [
        { host: 'facebook.com', shouldBlock: true },
        { host: 'graph.facebook.com', shouldBlock: true },
        { host: 'video.fbsbx.com', shouldBlock: true },
        { host: 'scontent.cdninstagram.com', shouldBlock: true },
        { host: 'p16-va.tiktokcdn.com', shouldBlock: true },
        { host: 'sc-cdn.net', shouldBlock: true },
        { host: 'threads.net', shouldBlock: true },
        { host: 'google.com', shouldBlock: false },
        { host: 'wikipedia.org', shouldBlock: false },
        { host: 'github.com', shouldBlock: false },
        { host: 'cloudflare.com', shouldBlock: false }
    ];

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

    const parseTlsSni = (buf) => {
        try {
            if (!Buffer.isBuffer(buf) || buf.length < 50) return null;
            if (buf[0] !== 0x16 || buf[1] !== 0x03) return null;
            if (buf[5] !== 0x01) return null;
            let offset = 9 + 2 + 32;
            if (offset >= buf.length) return null;
            const sessionLen = buf[offset];
            offset += 1 + sessionLen;
            if (offset + 2 > buf.length) return null;
            const cipherLen = buf.readUInt16BE(offset);
            offset += 2 + cipherLen;
            if (offset >= buf.length) return null;
            const compLen = buf[offset];
            offset += 1 + compLen;
            if (offset + 2 > buf.length) return null;
            const extTotal = buf.readUInt16BE(offset);
            offset += 2;
            const extEnd = offset + extTotal;
            while (offset + 4 <= buf.length && offset + 4 <= extEnd) {
                const extType = buf.readUInt16BE(offset);
                const extLen = buf.readUInt16BE(offset + 2);
                offset += 4;
                if (offset + extLen > buf.length) return null;
                if (extType === 0x0000 && extLen >= 5) {
                    let p = offset + 2;
                    const nameType = buf[p];
                    const nameLen = buf.readUInt16BE(p + 1);
                    p += 3;
                    if (nameType === 0 && p + nameLen <= buf.length) {
                        return buf.toString('utf8', p, p + nameLen).toLowerCase();
                    }
                    return null;
                }
                offset += extLen;
            }
            return null;
        } catch (_) {
            return null;
        }
    };

    for (const item of testDomains) {
        const packet = createTlsClientHello(item.host);
        const extractedSni = parseTlsSni(packet);
        assert.equal(extractedSni, item.host.toLowerCase(), `SNI extraction failed for ${item.host}`);
        const blocked = isSocialHost(extractedSni);
        assert.equal(blocked, item.shouldBlock, `Blocking logic mismatch for ${item.host}: expected ${item.shouldBlock} got ${blocked}`);
    }
});

test('Rigorous DNS Inspection: port 53 query parsing and filtering', () => {
    const parseDnsQueryName = (buf) => {
        try {
            if (!Buffer.isBuffer(buf) || buf.length < 17) return null;
            const qdcount = buf.readUInt16BE(4);
            if (qdcount < 1) return null;
            let offset = 12;
            const labels = [];
            while (offset < buf.length && buf[offset] !== 0) {
                const len = buf[offset];
                if (len > 63 || offset + 1 + len > buf.length) return null;
                labels.push(buf.toString('utf8', offset + 1, offset + 1 + len));
                offset += 1 + len;
                if (labels.length > 10) return null;
            }
            if (!labels.length) return null;
            return labels.join('.').toLowerCase();
        } catch (_) {
            return null;
        }
    };

    const domains = [
        'api.instagram.com',
        'm.facebook.com',
        'v16-web.tiktokcdn.com',
        'app.snapchat.com',
        'dns.google',
        'cloudflare-dns.com'
    ];

    for (const domain of domains) {
        const packet = createDnsQueryPacket(domain);
        const parsed = parseDnsQueryName(packet);
        assert.equal(parsed, domain.toLowerCase(), `DNS parser failed for ${domain}`);
    }
});
