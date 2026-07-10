module.exports = {
  apps: [{
    name: 'portal-mm-solutions',
    script: 'src/index.js',
    max_restarts: 50,
    min_uptime: 10000,
    restart_delay: 15000,
    exp_backoff_restart_delay: 100,
    error_file: '/root/.pm2/logs/portal-mm-solutions-error.log',
    out_file: '/root/.pm2/logs/portal-mm-solutions-out.log',
  }]
};
