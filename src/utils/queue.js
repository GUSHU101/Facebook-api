const crypto = require('crypto');

const LIVE_JOB_STATES = new Set([
    'active',
    'delayed',
    'prioritized',
    'waiting',
    'waiting-children',
]);

async function enqueueReschedulableJob(queue, name, data, options, uniqueId = crypto.randomUUID) {
    const job = await queue.add(name, data, options);
    const state = await job.getState();
    if (LIVE_JOB_STATES.has(state)) return job;

    // BullMQ keeps terminal jobs for diagnostics, while automatic retention can
    // remove a just-finished job between add() and getState(), yielding
    // "unknown". In both cases the stable ID no longer proves that runnable
    // work exists, so create a unique follow-up. PostgreSQL delivery leases keep
    // an extra runnable job harmless while avoiding a rescue-scan delay.
    return queue.add(name, data, {
        ...options,
        jobId: `${options.jobId}-${uniqueId()}`,
    });
}

module.exports = { LIVE_JOB_STATES, enqueueReschedulableJob };
