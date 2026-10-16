// The installation icons (assets/blocks) are drawn by blocks.html: 16x16 textures
// on isometric boxes. Re-render them with
//   node_modules/electron/dist/electron.exe scripts/blocks/export.js assets/blocks sheet.png px
// ("px": the 32x36 pixel icons the launcher uses; leave it off for 300x300 renders)
// (every block's PNG into the folder, plus a contact sheet to look at).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const [outDir, sheet, mode] = process.argv.slice(2);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ x: -4000, y: 40, width: 1340, height: 900, show: true, frame: false, useContentSize: true });
  await win.loadURL(`${pathToFileURL(path.join(__dirname, 'blocks.html')).href}${mode === 'px' ? '?px=1' : ''}`);
  for (let i = 0; i < 40; i++) {
    if ((await win.webContents.executeJavaScript('document.title')) === 'done') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const pngs = await win.webContents.executeJavaScript('window.__pngs');
  fs.mkdirSync(outDir, { recursive: true });
  for (const [id, url] of Object.entries(pngs)) fs.writeFileSync(path.join(outDir, `${id}.png`), Buffer.from(url.split(',')[1], 'base64'));
  console.log(Object.keys(pngs).length, 'blocks');
  await new Promise((r) => setTimeout(r, 400));
  win.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 200));
  fs.writeFileSync(sheet, (await win.webContents.capturePage()).toPNG());
  app.quit();
});
