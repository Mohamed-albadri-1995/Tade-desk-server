/*
 * qp, under pm2, with the guard rails that only exist in a file.
 *
 * WHY THIS FILE EXISTS. `pm2 start ... --min-uptime 10000` is rejected —
 * `min_uptime` and `max_restarts` are ecosystem-file fields, not command-line
 * flags, and pm2 answers `unknown option '--min-uptime'` and STARTS NOTHING.
 * That is how qp ended up stopped instead of guarded.
 *
 * WHAT THE GUARD RAILS ARE FOR. 2026-09-21: pm2 reported qp `online` with
 * 14,502 restarts and an uptime of one second. Port 8765 was held by an older
 * copy of the same server, started by hand before pm2 existed on this box, so
 * uvicorn could not bind and exited — once a second, for weeks, while the
 * process list said `online` the whole time.
 *
 *   min_uptime      a start that dies inside ten seconds did not succeed
 *   max_restarts    after ten of those, pm2 gives up and marks it `errored`
 *
 * A process that is broken should LOOK broken. `online` with five figures in
 * the restart column is a status nobody reads as a failure, and nobody did.
 *
 * chart/server.py now refuses to print its banner before it owns the port, so
 * the log says why in one line. This is the other half: pm2 stops pretending.
 *
 * THE HANDOVER. `pm2 delete qp` followed immediately by a start finds the port
 * still held by the copy being replaced — told to stop, not yet finished
 * letting go. chart/server.py waits up to twenty seconds for it rather than
 * failing on the first try, so a restart is a restart and a port genuinely
 * held by something else is still a named failure. That waiting is why
 * min_uptime is ten seconds and not thirty.
 *
 * Usage, from the repo root:
 *
 *     pm2 delete qp                      # if it is already registered
 *     pm2 start deploy/qp.config.js
 *     pm2 save
 *
 * After that, `pm2 restart qp` is enough — the config is remembered.
 *
 * `cwd` is absolute and derived, not typed: qp is started as `-m chart.server`
 * and that only resolves from quant-platform/.
 */
const path = require('path');

module.exports = {
  apps: [{
    name: 'qp',
    // The interpreter is the script; the module is the argument. pm2 would
    // otherwise try to run a .py file with node.
    script: '/usr/bin/python3',
    args: ['-m', 'chart.server', '--host', '0.0.0.0', '--port', '8765'],
    cwd: path.join(__dirname, '..', 'quant-platform'),
    interpreter: 'none',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    // Ten seconds. A real start takes about one and then stays up for weeks;
    // the failure being guarded against died in under a second, every time.
    min_uptime: 10000,
    max_restarts: 10,
    // Measured: qp sits at 35–90 MB and a decide does not move it much. 500 MB
    // is a leak, not a busy morning.
    max_memory_restart: '500M',
    // The decision path. A crash at 09:34 is a morning with no trade, so the
    // log has to say what happened rather than being rotated away by noon.
    time: true,
  }],
};
