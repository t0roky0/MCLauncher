'use strict';
// Opt-in electron-builder signing hook. Does not install or trust certificates.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
module.exports = async function sign(configuration) {
  const pfx = process.env.MCL_SIGN_PFX, passwordFile = process.env.MCL_SIGN_PASSWORD_FILE;
  if (!pfx || !passwordFile) throw new Error('MCL_SIGN_PFX and MCL_SIGN_PASSWORD_FILE are required for local signing.');
  const password = fs.readFileSync(passwordFile, 'utf8').trim();
  if (process.env.MCL_OSSLSIGNCODE) {
    const output = configuration.path + '.signed';
    const args = ['sign', '-pkcs12', path.resolve(pfx), '-readpass', path.resolve(passwordFile), '-h', 'sha256', '-n', 'MC Launcher', '-in', configuration.path, '-out', output];
    if (process.env.MCL_SIGN_TIMESTAMP_URL) args.push('-ts', process.env.MCL_SIGN_TIMESTAMP_URL);
    const result = spawnSync(process.env.MCL_OSSLSIGNCODE, args, { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Signing failed: ${(result.stderr || result.stdout || result.error?.message || '').split(password).join('<password>')}`);
    // Custom hooks must replace the input themselves in electron-builder 26.
    fs.copyFileSync(output, configuration.path);
    fs.unlinkSync(output);
    console.log(`Signed ${path.basename(configuration.path)} with the local development certificate.`);
    return;
  }
  const signtool = process.env.MCL_SIGNTOOL || path.join(__dirname, '../node_modules/@electron/windows-sign/vendor/signtool.exe');
  const args = ['sign', '/fd', 'SHA256', '/f', path.resolve(pfx), '/p', password, '/d', 'MC Launcher'];
  if (process.env.MCL_SIGN_TIMESTAMP_URL) args.push('/tr', process.env.MCL_SIGN_TIMESTAMP_URL, '/td', 'SHA256');
  args.push(configuration.path);
  // Never print the command: it contains the PFX password.
  const result = spawnSync(signtool, args, { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Signing failed for ${path.basename(configuration.path)}: ${(result.stderr || result.stdout || result.error?.message || '').split(password).join('<password>')}`);
  console.log(`Signed ${path.basename(configuration.path)} with the local development certificate.`);
};
