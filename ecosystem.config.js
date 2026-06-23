module.exports = {
    apps: [
        {
            name: 'capi-api',
            cwd: __dirname,
            script: 'src/server.js',
            instances: 1,
            exec_mode: 'fork',
            watch: false,
            max_memory_restart: '512M',
            env: {
                NODE_ENV: 'production',
            },
        },
        {
            name: 'capi-worker',
            cwd: __dirname,
            script: 'src/worker.js',
            instances: 1,
            exec_mode: 'fork',
            watch: false,
            max_memory_restart: '512M',
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};
