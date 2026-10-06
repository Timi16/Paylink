// pm2 process file: the API and the worker (one codebase, two processes).
// The web app (apps/web) is not run here: it is deployed on Vercel.
//   pm2 start ecosystem.config.cjs && pm2 save
//   pm2 reload ecosystem.config.cjs --update-env     (after a deploy)
// Both read the repo-root .env through Node's --env-file.
const path = require("node:path");

const common = {
  cwd: path.join(__dirname, "apps/api"),
  node_args: "--max-old-space-size=192 --env-file=../../.env",
  // One instance is right for the 1-core server. More API instances are safe if ever
  // needed: live updates reach every instance through Postgres NOTIFY, and the login
  // throttle and credential rate limit are stored in Postgres. Only the high-volume
  // limits (/v1 per merchant, public per IP, open streams) are per instance, so they
  // scale with the instance count. Run exactly ONE worker.
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  max_memory_restart: "256M",
  exp_backoff_restart_delay: 1000,
  env: { NODE_ENV: "production" },
  time: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: "paylink-api",
      script: "dist/server.js",
      // SIGTERM -> stop accepting, close SSE streams, wait up to 10 s, disconnect.
      kill_timeout: 15000,
    },
    {
      ...common,
      name: "paylink-worker",
      script: "dist/worker.js",
      // SIGTERM -> finish the current batch transaction, then exit. The watchdog also exits
      // the process when ingestion hangs, and pm2 restarts it from the saved cursor.
      kill_timeout: 70000,
    },
  ],
};
