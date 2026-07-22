module.exports = {
  apps: [{
    name: "joblink-v2-staging",
    script: "server.js",
    cwd: "/root/joblink-v2-staging",
    interpreter: "/opt/node22/bin/node",
    env_file: "/root/joblink-v2-staging/.env",
    env: {
      NODE_ENV: "staging",
    },
    error_file: "/root/.pm2/logs/joblink-v2-staging-error.log",
    out_file: "/root/.pm2/logs/joblink-v2-staging-out.log",
    merge_logs: true,
    max_restarts: 10,
    restart_delay: 3000,
  }]
};
