module.exports = {
  apps: [{
    name: 'paysap-api',
    script: 'server.js',
    instances: 'max',       // Cluster mode utilizing all available CPU cores
    exec_mode: 'cluster',
    autorestart: true,
    watch: false,
    max_memory_restart: '800M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
