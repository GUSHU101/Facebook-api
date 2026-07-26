function consumeWeightedWindow(
    store,
    key,
    weight,
    limit,
    options = {},
) {
    const nowMs = Number(options.nowMs ?? Date.now());
    const windowMs = Math.max(1000, Number(options.windowMs || 60_000));
    const maxKeys = Math.max(1, Number(options.maxKeys || 10_000));
    const safeWeight = Math.max(1, Math.ceil(Number(weight) || 1));
    const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
    let entry = store.get(key);

    if (!entry || entry.resetAt <= nowMs) {
        if (!entry && store.size >= maxKeys) {
            for (const [candidateKey, candidate] of store) {
                if (candidate.resetAt <= nowMs) store.delete(candidateKey);
            }
            while (store.size >= maxKeys) store.delete(store.keys().next().value);
        }
        entry = { count: 0, resetAt: nowMs + windowMs };
    }

    entry.count += safeWeight;
    // Refresh insertion order so emergency eviction approximates LRU without
    // timers or a second unbounded index.
    store.delete(key);
    store.set(key, entry);
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000));
    return {
        allowed: entry.count <= safeLimit,
        count: entry.count,
        remaining: Math.max(0, safeLimit - entry.count),
        retryAfterSeconds,
    };
}

module.exports = { consumeWeightedWindow };
