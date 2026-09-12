// Nama proses = nama folder, supaya ~/lpcopy dan ~/lpcopy2 bisa hidup berdampingan di satu VPS.
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
    // Server ini cuma 1,9 GB dan sudah menampung rht + robinhood-lp + omniroute.
    // Batas 250M memberi ruang aman; pemakaian normal Quiver ~80M.
    max_memory_restart: '250M',
    out_file: `logs/${name}.log`,
    error_file: `logs/${name}.err.log`,
    time: true
  }]
};
