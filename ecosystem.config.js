module.exports = {
  apps: [{
    name: 'paysap-api',
    script: 'server.js',
    instances: 1,           // Single process to prevent multi-worker concurrency collisions with JSON persistence
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
