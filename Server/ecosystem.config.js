/**
 * ecosystem.config.js — RapidTyper PM2
 *
 * Usage:
 *   pm2 start ecosystem.config.js              # start all
 *   pm2 start ecosystem.config.js --only main  # start just main server
 *   pm2 start ecosystem.config.js --only school
 *   pm2 reload ecosystem.config.js             # zero-downtime reload
 *   pm2 logs                                   # tail all logs
 *   pm2 logs main --lines 100
 *   pm2 monit                                  # live dashboard
 *
 * Env:
 *   All variables are loaded from the .env file at project root.
 *   Override any value by setting it in the `env_production` block below,
 *   or by exporting the variable before calling `pm2 start`.
 *
 *   To reload env after editing .env:
 *     pm2 reload ecosystem.config.js
 */

'use strict';

const path = require('path');
const ROOT = __dirname;          // wherever this file lives = project root

module.exports = {
    apps: [

        // ── Main Server ────────────────────────────────────────────────────
        {
            name       : 'main',
            script     : path.join(ROOT, 'MainServer', 'server.js'),
            cwd        : path.join(ROOT, 'MainServer'),
            instances  : 1,
            exec_mode  : 'fork',    // NOT cluster — WS state is in-process

            // ── Restart policy ─────────────────────────────────────────────
            autorestart              : true,
            max_restarts             : 20,
            min_uptime               : '10s',   // must stay alive 10s to count as stable
            restart_delay            : 2000,    // flat 2s pause before restart
            exp_backoff_restart_delay: 100,     // exponential on repeated crashes

            // ── Memory guard ───────────────────────────────────────────────
            max_memory_restart: '512M',

            // ── Logs ───────────────────────────────────────────────────────
            error_file     : path.join(ROOT, 'MainServer', 'logs', 'pm2-error.log'),
            out_file       : path.join(ROOT, 'MainServer', 'logs', 'pm2-out.log'),
            merge_logs     : true,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',

            // ── Base env (always loaded) ────────────────────────────────────
            env: {
                NODE_ENV: 'development',
                DEV     : 'true',
            },

            // ── Production env (loaded with --env production) ───────────────
            // Values here OVERRIDE the .env file for that key only.
            // Secrets you don't want in this file: keep them only in .env.
            env_production: {
                NODE_ENV: 'production',
                DEV     : 'false',
                // Uncomment and fill if you need to override .env values:
                // ADMIN_KEY   : 'change_me',
                // STREAM_KEY  : 'change_me',
                // MAIN_SERVER_WS : 'ws://100.x.x.x:5889',
            },

            // ── Watch (off in production, useful in dev) ───────────────────
            watch        : false,
            ignore_watch : ['node_modules', 'logs', 'db', 'data', '*.log'],
        },

        // ── School Server ──────────────────────────────────────────────────
        {
            name       : 'school',
            script     : path.join(ROOT, 'SchoolServer', 'school-server.js'),
            cwd        : path.join(ROOT, 'SchoolServer'),
            instances  : 1,
            exec_mode  : 'fork',

            // ── Restart policy ─────────────────────────────────────────────
            // School server is expected to run on a school laptop that may
            // have an unstable network. Let it restart quickly but not spam.
            autorestart              : true,
            max_restarts             : 30,
            min_uptime               : '5s',
            restart_delay            : 1500,
            exp_backoff_restart_delay: 100,

            max_memory_restart: '256M',

            // ── Logs ───────────────────────────────────────────────────────
            error_file     : path.join(ROOT, 'SchoolServer', 'logs', 'pm2-error.log'),
            out_file       : path.join(ROOT, 'SchoolServer', 'logs', 'pm2-out.log'),
            merge_logs     : true,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',

            env: {
                NODE_ENV: 'development',
                DEV     : 'true',
            },

            env_production: {
                NODE_ENV: 'production',
                DEV     : 'false',
                // These MUST be set in .env or overridden here for production:
                // MAIN_SERVER_WS : 'ws://100.x.x.x:5889',
                // SCHOOL_ID      : 'school-cluj-01',
                // STREAM_KEY     : 'your_stream_key',
                // ADMIN_KEY      : 'your_admin_key',
                // HTTP_PORT      : '8080',
                // HTTPS_PORT     : '8443',
                // VIDEO_PORT     : '5890',
                // LOCAL_PORT     : '5889',
                // MAX_CAMS       : '8',
                // RECORDINGS_DIR : './recordings',
            },

            watch        : false,
            ignore_watch : ['node_modules', 'logs', 'recordings', 'certs', '*.log'],
        },
    ],
};
