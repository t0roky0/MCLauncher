# MC Launcher — website 🌐

The website of **MC Launcher**, a free Minecraft launcher for Windows: Java and
Bedrock in one window, parties with voice chat, Xbox friends, an in-game overlay
and cosmetics. 🎮

**Live:** https://t0roky0.github.io/MCLauncher/ · **Source code of the launcher:**
the [`main`](https://github.com/t0roky0/MCLauncher/tree/main) branch.

A plain static page — no build step, no trackers, no cookies:

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | the page (Russian, with an English switch) |
| `theme.js` | a random accent colour from the launcher's palette on every visit 🎨 |
| `app.js` | pixel icons, the tilting 3D screenshot, the code-activation form 🔑 |
| `i18n.js` | the English translation |
| `assets/js/sky.js` | the launcher's own pixel particles in the header ✨ |

The activation form never sends anything anywhere: it hands the code to the
installed launcher through its `mclauncher://redeem/<code>` link.

## Credits

- Fonts: *Minecraft Rus* © BOGDAN Software; *8bitoperator JVE* © nipcen,
  [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/).
- Cosmetics art and the launcher's screenshots — MC Launcher.

MC Launcher is an unofficial launcher. It is not a Minecraft product and is not
affiliated with Mojang Studios or Microsoft. Minecraft is a trademark of Mojang
Synergies AB.
