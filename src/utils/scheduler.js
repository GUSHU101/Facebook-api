function createTrackedCronScheduler(cron, { onError = () => {} } = {}) {
    if (!cron || typeof cron.validate !== 'function' || typeof cron.schedule !== 'function') {
        throw new TypeError('A cron implementation with validate() and schedule() is required');
    }

    const tasks = [];
    const inFlight = new Set();
    let stopping = false;

    function reportError(error, label) {
        try {
            onError(error, label);
        } catch {
            // Error reporting must never turn an already-contained scheduled
            // task failure into an unhandled rejection.
        }
    }

    function run(handler, label = 'background-task') {
        if (stopping) return undefined;
        if (typeof handler !== 'function') throw new TypeError('Background handler must be a function');

        const execution = Promise.resolve()
            .then(handler)
            .catch(error => reportError(error, label))
            .finally(() => inFlight.delete(execution));
        inFlight.add(execution);
        return execution;
    }

    function schedule(expression, handler, label = expression) {
        if (stopping) throw new Error('Cannot schedule a cron task after shutdown has started');
        if (!cron.validate(expression)) throw new Error(`Invalid cron expression: ${expression}`);
        if (typeof handler !== 'function') throw new TypeError('Cron handler must be a function');

        let activeExecution = null;
        const task = cron.schedule(expression, () => {
            if (stopping || activeExecution) return undefined;

            const execution = run(handler, label);
            if (!execution) return undefined;
            activeExecution = execution;
            void execution.finally(() => {
                if (activeExecution === execution) activeExecution = null;
            });
            return execution;
        });
        tasks.push(task);
        return task;
    }

    function stop() {
        if (stopping) return;
        stopping = true;
        for (const task of tasks) {
            try {
                task.stop();
            } catch (error) {
                reportError(error, 'stop');
            }
        }
    }

    async function stopAndDrain() {
        stop();
        while (inFlight.size > 0) {
            await Promise.allSettled([...inFlight]);
        }
    }

    return {
        run,
        schedule,
        stop,
        stopAndDrain,
        activeCount: () => inFlight.size,
        isStopping: () => stopping,
    };
}

module.exports = { createTrackedCronScheduler };
