// Process name = folder name, so ~/lpcopy and ~/lpcopy2 can live side by side on one VPS.
const name = require('path').basename(__dirname);

module.exports = {
  apps: [{
    name,
    script: 'src/index.js',
    node_args: '--no-warnings',
    cwd: __dirname,
    autorestart: true,
    max_restarts: 50,
    restart_delay: 5000,
    // Time pm2 gives between SIGINT and SIGKILL. The default 1.6 seconds cuts an entry
    // in the middle (zap done, mint not yet). index.js waits for in-flight work for at most 100 s.
    kill_timeout: 120000,
    // This server is only 1.9 GB and already hosts rht + robinhood-lp + omniroute.
    // A 250M limit leaves a safe margin; normal Quiver usage is ~80M.
    max_memory_restart: '250M',
    out_file: `logs/${name}.log`,
    error_file: `logs/${name}.err.log`,
    time: true
  }]
};
