const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT   = path.join(__dirname, '..');
const IS_DEV = process.env.NODE_ENV === 'development' || process.env.DEV === 'true';

const resolvePath = (envVar, defaultPath) => {
    const val = process.env[envVar];
    if (!val) return defaultPath;
    return path.isAbsolute(val) ? val : path.resolve(ROOT, val);
};

module.exports = {
    IS_DEV,
    ADMIN_KEY: process.env.ADMIN_KEY || '1313',
    STREAM_KEY: process.env.STREAM_KEY || 'stream1234',
    GAME_DURATION: 60,
    MAX_PLAYERS: 200,

    // Server Config
    MAIN_SERVER_WS: process.env.MAIN_SERVER_WS || 'ws://localhost:5889',
    SCHOOL_ID: process.env.SCHOOL_ID || ('school-' + Math.random().toString(36).substr(2, 6)),
    LOCAL_PORT: parseInt(process.env.SCHOOL_PORT) || 5889,
    HTTP_PORT: parseInt(process.env.HTTP_PORT) || 8080,
    VIDEO_PORT: parseInt(process.env.VIDEO_PORT) || 5888,
    MAX_CAMS: parseInt(process.env.MAX_CAMS) || 8,
    HTTPS_PORT: parseInt(process.env.HTTPS_PORT) || 8443,

    // Paths
    RECORDINGS_DIR: resolvePath('RECORDINGS_DIR', path.join(ROOT, 'SchoolServer', 'recordings')),
    CERT_DIR: resolvePath('CERT_DIR', path.join(ROOT, 'SchoolServer', 'certs')),
    FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
    STATIC_ROOT: resolvePath('STATIC_ROOT', path.join(ROOT, 'ClientWeb'))
};
