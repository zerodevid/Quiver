module.exports = {
  apps: [{
    name: 'lpcopy',
    script: 'src/index.js',
    node_args: '--no-warnings',
    cwd: __dirname,
    autorestart: true,
    max_restarts: 50,
    restart_delay: 5000,
    // Server ini cuma 1,9 GB dan sudah menampung rht + robinhood-lp + omniroute.
    // Batas 250M memberi ruang aman; pemakaian normal Quiver ~80M.
    max_memory_restart: '250M',
    out_file: 'logs/lpcopy.log',
    error_file: 'logs/lpcopy.err.log',
    time: true
  }]
};
