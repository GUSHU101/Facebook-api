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

function looksLikeEncryptedToken(text) {
    return /^[a-f0-9]{32}:[a-f0-9]{32}:(?:[a-f0-9]{2})+$/i.test(String(text || ''));
}

function decryptTokenIfPossible(text) {
    if (!text) return text;
    if (!looksLikeEncryptedToken(text)) return text;
    try {
        return decryptToken(text);
    } catch (error) {
        const wrapped = new Error('Encrypted credential could not be decrypted; verify AES_SECRET_KEY');
        wrapped.code = 'CREDENTIAL_DECRYPTION_FAILED';
        wrapped.cause = error;
        throw wrapped;
    }
}

function credentialFingerprint(platform, token, rateLimitGroup) {
    const normalizedPlatform = String(platform || '').trim().toLowerCase();
    const normalizedToken = String(token || '').trim();
    const normalizedGroup = String(rateLimitGroup || '').trim().toLowerCase();
    if (!normalizedPlatform || !normalizedToken) return null;
    return crypto.createHash('sha256')
        .update(`${normalizedPlatform}\0${normalizedGroup ? `group:${normalizedGroup}` : `token:${normalizedToken}`}`, 'utf8')
        .digest('hex');
}

function timingSafeCompare(generatedHash, hmacHeader) {
    if (!generatedHash || !hmacHeader) return false;
    const left = Buffer.from(String(generatedHash), 'base64');
    const right = Buffer.from(String(hmacHeader), 'base64');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function timingSafeStringCompare(expected, supplied) {
    if (!expected || !supplied) return false;
    const left = Buffer.from(String(expected), 'utf8');
    const right = Buffer.from(String(supplied), 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizeForHash(data, type = 'default', context = {}) {
    if (data === undefined || data === null) return undefined;
    let normalized = String(data).trim().toLowerCase();
    switch (type) {
    case 'email':
        // Meta requires lowercase plus trimming, not removal of characters
        // inside the address. Reject whitespace instead of hashing a value
        // that cannot match the customer's actual email.
        if (/\s/.test(normalized)) return undefined;
        break;
    case 'phone':
        {
            const rawPhone = String(data).trim();
            const hasInternationalPrefix = /^\+|^00/.test(rawPhone);
            normalized = rawPhone.replace(/[^\d]/g, '').replace(/^0+/, '');
            const phoneCountry = String(context.country || '').trim().toLowerCase();
            if (!hasInternationalPrefix) {
                if (['us', 'usa', 'unitedstates', 'unitedstatesofamerica', 'ca', 'canada'].includes(phoneCountry)) {
                    if (/^\d{10}$/.test(normalized)) normalized = `1${normalized}`;
                    else if (!/^1\d{10}$/.test(normalized)) normalized = '';
                } else {
                    // Without an international prefix there is no reliable way
                    // to infer the calling code for every market. Omitting the
                    // value is more accurate than hashing an unmatchable local number.
                    normalized = '';
                }
            }
        }
        break;
    case 'name':
        // Preserve UTF-8 letters such as é and CJK characters. Meta's own
        // normalization example hashes "valéry", not "valery".
        normalized = normalized.replace(/[^\p{L}\p{N}]/gu, '');
        break;
    case 'city':
    case 'state':
        normalized = normalized
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\p{L}\p{N}]/gu, '');
        if (type === 'state') {
            const stateCountry = String(context.country || '').trim().toLowerCase();
            if (['us', 'usa', 'unitedstates', 'unitedstatesofamerica'].includes(stateCountry)
                && !/^[a-z]{2}$/.test(normalized)) {
                normalized = '';
            }
        }
        break;
    case 'zip': {
        normalized = normalized.replace(/[^a-z0-9]/g, '');
        const country = String(context.country || '').trim().toLowerCase();
        if (['us', 'usa', 'unitedstates', 'unitedstatesofamerica'].includes(country)) {
            const usZip = normalized.match(/^\d{5}/)?.[0];
            normalized = usZip || '';
        }
        break;
    }
    case 'country':
        // Meta requires ISO 3166-1 alpha-2. Hashing a display name such as
        // "United States" produces a valid SHA-256 value that can never match.
        normalized = /^[a-z]{2}$/.test(normalized) ? normalized : '';
        break;
    default:
        normalized = normalized.replace(/\s+/g, '');
    }
    return normalized || undefined;
}

function hashUserData(data, type = 'default', context = {}) {
    const normalized = normalizeForHash(data, type, context);
    if (!normalized) return undefined;
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

function normalizeMetaHashedValue(value) {
    const normalized = String(value || '').trim();
    // Meta's Parameter Builder can append a case-sensitive 8-character
    // appendix (or the legacy 2-character form) to a normalized SHA-256
    // value. The complete returned value must be forwarded byte-for-byte;
    // lowercasing or re-hashing it destroys the match signal.
    return /^[a-f0-9]{64}(?:\.(?:[A-Za-z0-9]{2}|[A-Za-z0-9]{8}))?$/.test(normalized)
        ? normalized
        : undefined;
}

function isSha256Hash(value) {
    return Boolean(normalizeMetaHashedValue(value));
}

function boundedScalarValues(value, maximum = 50) {
    const output = [];
    const stack = Array.isArray(value) ? [...value].reverse() : [value];
    while (stack.length && output.length < maximum) {
        const current = stack.pop();
        if (Array.isArray(current)) {
            for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
        } else if (['string', 'number', 'bigint'].includes(typeof current)) {
            output.push(current);
        }
    }
    return output;
}

function collectHashedUserData(explicitHashes = [], rawValues = [], type = 'default', context = {}) {
    const output = [];
    const seen = new Set();
    const append = value => {
        const normalized = normalizeMetaHashedValue(value);
        if (normalized && !seen.has(normalized)) {
            seen.add(normalized);
            output.push(normalized);
        }
    };

    for (const value of boundedScalarValues(explicitHashes)) {
        if (isSha256Hash(value)) append(value);
    }
    for (const value of boundedScalarValues(rawValues)) {
        const normalized = normalizeMetaHashedValue(value);
        if (isSha256Hash(normalized)) append(normalized);
        else append(hashUserData(value, type, context));
    }
    return output.length ? output : undefined;
}

module.exports = {
    encryptToken,
    decryptToken,
    decryptTokenIfPossible,
    looksLikeEncryptedToken,
    credentialFingerprint,
    timingSafeCompare,
    timingSafeStringCompare,
    hashUserData,
    collectHashedUserData,
    boundedScalarValues,
    isSha256Hash,
    normalizeMetaHashedValue,
    normalizeForHash,
};
