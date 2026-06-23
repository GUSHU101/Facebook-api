const crypto = require('crypto');
const config = require('../config');

const ENCRYPTION_KEY = crypto.createHash('sha256').update(config.aesSecretKey).digest();

function encryptToken(text) {
    if (!text) return text;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return [
        iv.toString('hex'),
        cipher.getAuthTag().toString('hex'),
        encrypted.toString('hex'),
    ].join(':');
}

function decryptToken(text) {
    if (!text) return text;
    const parts = String(text).split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted token format');

    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(parts[0], 'hex'));
    decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
    return Buffer.concat([
        decipher.update(Buffer.from(parts[2], 'hex')),
        decipher.final(),
    ]).toString('utf8');
}

function decryptTokenIfPossible(text) {
    if (!text) return text;
    try {
        return decryptToken(text);
    } catch (error) {
        return text;
    }
}

function timingSafeCompare(generatedHash, hmacHeader) {
    if (!generatedHash || !hmacHeader) return false;
    const left = Buffer.from(String(generatedHash), 'base64');
    const right = Buffer.from(String(hmacHeader), 'base64');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizeForHash(data, type = 'default') {
    if (data === undefined || data === null) return undefined;
    let normalized = String(data).trim().toLowerCase();
    if (type === 'phone') {
        normalized = normalized.replace(/[^\d]/g, '');
    } else if (type === 'name' || type === 'city' || type === 'state' || type === 'zip' || type === 'country') {
        normalized = normalized.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '');
    } else {
        normalized = normalized.replace(/\s+/g, '');
    }
    return normalized || undefined;
}

function hashUserData(data, type = 'default') {
    const normalized = normalizeForHash(data, type);
    if (!normalized) return undefined;
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

module.exports = {
    encryptToken,
    decryptToken,
    decryptTokenIfPossible,
    timingSafeCompare,
    hashUserData,
    normalizeForHash,
};
