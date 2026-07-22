module.exports = {
  apps: [{
    name: "joblink-v2",
    script: "server.js",
    cwd: "/root/joblink-v2",
    interpreter: "/opt/node22/bin/node",
    env: {
      NODE_ENV: "production",
    },
    error_file: "/root/.pm2/logs/joblink-v2-error.log",
    out_file: "/root/.pm2/logs/joblink-v2-out.log",
    merge_logs: true,
    max_restarts: 10,
    restart_delay: 3000,
  }]
};
