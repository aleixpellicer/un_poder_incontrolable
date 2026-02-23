module.exports = {
    apps: [
        {
            name: 'game-incontrolable',
            script: 'server/server.js',
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '512M',
            env: {
                NODE_ENV: 'production',
                PORT: 3000
            }
        }
    ]
};
