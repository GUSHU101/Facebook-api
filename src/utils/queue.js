const crypto = require('crypto');

async function enqueueReschedulableJob(queue, name, data, options, uniqueId = crypto.randomUUID) {
    const job = await queue.add(name, data, options);
    const state = await job.getState();
    if (state !== 'completed' && state !== 'failed') return job;

    // BullMQ keeps terminal jobs for diagnostics. Re-adding the same jobId
    // returns that old job instead of creating work, so use a unique follow-up
    // whenever a coalescing ID has already reached a terminal state.
    return queue.add(name, data, {
        ...options,
        jobId: `${options.jobId}-${uniqueId()}`,
    });
}

module.exports = { enqueueReschedulableJob };
