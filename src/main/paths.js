'use strict';
// Where everything lives on disk.
//
// The launcher's own data stays in %APPDATA%\MCLauncher, the same folder the
// Python version used, so config.json, the skin library and the cached key
// art carry straight over. Chromium's caches go into a subfolder of it rather
// than next to config.json (see index.js: app.setPath('userData')).
//
// Game files (versions/libraries/assets/runtime/instances) live under the
// configured game directory — %APPDATA%\.minecraft by default, shared with
// the official launcher so nothing already downloaded is fetched twice.

const path = require('path');
const os = require('os');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

// MCL_DATA_DIR points a test run at a scratch copy of the data folder.
const appDir = process.env.MCL_DATA_DIR || path.join(APPDATA, 'MCLauncher');
const appRoot = path.join(__dirname, '..', '..');

module.exports = {
  APPDATA,
  LOCALAPPDATA,
  appRoot,
  appDir,
  configPath: path.join(appDir, 'config.json'),
  skinsDir: path.join(appDir, 'skins'),
  capesDir: path.join(appDir, 'capes'),
  wallpaperDir: path.join(appDir, 'wallpaper_cache'),
  imageCacheDir: path.join(appDir, 'image_cache'),
  logsDir: path.join(appDir, 'logs'),
  chromiumDir: path.join(appDir, 'chromium'),
  defaultGameDir: path.join(APPDATA, '.minecraft'),
  // Read-only resources shipped with the app.
  asset: (...parts) => path.join(appRoot, 'assets', ...parts),
  dist: (...parts) => path.join(appRoot, 'dist', ...parts),
  nativeModule: path.join(appRoot, 'native', 'build', 'Release', 'mcnative.node'),
};
