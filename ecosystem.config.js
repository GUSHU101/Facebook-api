require('dotenv').config();

function positiveInstances(name, fallback) {
    const value = Number(process.env[name] || fallback);
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

const processKillTimeoutMs = positiveInstances('SHUTDOWN_TIMEOUT_MS', 120000) + 10000;

module.exports = {
    apps: [
        {
            name: 'capi-api',
            cwd: __dirname,
            script: 'src/server.js',
            instances: positiveInstances('API_INSTANCES', 1),
            exec_mode: 'cluster',
            watch: false,
            kill_timeout: processKillTimeoutMs,
            max_memory_restart: '512M',
            env: {
                NODE_ENV: 'production',
            },
        },
        {
            name: 'capi-worker',
            cwd: __dirname,
            script: 'src/worker.js',
            instances: positiveInstances('WORKER_INSTANCES', 1),
            exec_mode: 'cluster',
            watch: false,
            kill_timeout: processKillTimeoutMs,
            max_memory_restart: '512M',
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};
