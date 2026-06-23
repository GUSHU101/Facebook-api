const Redis = require('ioredis');
const config = require('../config');

const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

redis.defineCommand('safePopAndTransfer', {
    numberOfKeys: 2,
    lua: `
        local pendingKey = KEYS[1]
        local processingKey = KEYS[2]
        local count = tonumber(ARGV[1])
        local items = redis.call('LRANGE', pendingKey, 0, count - 1)
        if #items > 0 then
            for _, item in ipairs(items) do
                redis.call('RPUSH', processingKey, item)
            end
            redis.call('LTRIM', pendingKey, count, -1)
        end
        return items
    `,
});

redis.defineCommand('rollbackProcessing', {
    numberOfKeys: 2,
    lua: `
        local processingKey = KEYS[1]
        local pendingKey = KEYS[2]
        local items = redis.call('LRANGE', processingKey, 0, -1)
        if #items > 0 then
            for i = #items, 1, -1 do
                redis.call('LPUSH', pendingKey, items[i])
            end
            redis.call('DEL', processingKey)
        end
        return #items
    `,
});

redis.defineCommand('completeProcessing', {
    numberOfKeys: 2,
    lua: `
        local processingKey = KEYS[1]
        local pendingKey = KEYS[2]
        for i = #ARGV, 1, -1 do
            redis.call('LPUSH', pendingKey, ARGV[i])
        end
        redis.call('DEL', processingKey)
        return #ARGV
    `,
});

redis.on('error', error => {
    console.error('Redis error:', error);
});

module.exports = redis;
