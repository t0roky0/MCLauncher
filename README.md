<div align="center">

# 🟩 MC Launcher

**One launcher for Minecraft: Java Edition and Bedrock Edition — with a lobby, parties, voice chat and an in‑game overlay.**

`Windows 10/11` · `Electron` · `C++` · `Java agent` · `three.js`

</div>

---

## ✨ What it does

| | |
|---|---|
| 🎮 **Java & Bedrock** | Java installations (Vanilla, Fabric, Quilt, Forge, NeoForge) with their own Java runtimes from Mojang's manifests; Bedrock (GDK) started from the same window, with its servers and skins. |
| 🔐 **Microsoft / Xbox sign‑in** | Official OAuth flow, tokens kept encrypted with Windows DPAPI. Xbox friends and presence. |
| 🏠 **Lobby** | Your skin in 3D on an animated stage: emotes, particles, accent colours, friends standing next to you. |
| 👥 **Parties** | Invite friends by code or link, launch together into the same world or server. Party traffic goes through public MQTT relays and is end‑to‑end encrypted (AES‑GCM, key derived from the party code). |
| 🎙️ **Voice chat** | WebRTC with an Opus fallback through the relay, RNNoise noise suppression, proximity voice in game (3D positional in Java). |
| 🖥️ **In‑game overlay (F7)** | Voice panel, lobby chat, screenshots, video recording and instant replay (DXGI capture + hardware H.264 via Media Foundation), game settings. |
| 🔧 **Game settings** | Fullbright, smooth zoom (mouse slows down while zoomed), VSync, auto‑sprint, low fire — for both editions. |
| 🐞 **Fixer** | Reads the last crash: points at the mod that broke the game (Fabric's suspects, failed mixins, missing dependencies, wrong version or loader, duplicates), out of memory, broken files; for Bedrock — a stuck game, crash logs, Gaming Services. One click to fix where possible. |
| ✨ **Cosmetics** | Hats, wings, pets — drawn by a Java agent in Java Edition and by the launcher's module in Bedrock. *(The models themselves are not part of this repository.)* |
| 🔄 **Updates** | Background updates, every package checked against an Ed25519 signature before it is installed. |

## 🧱 How it's built

```
src/main         Electron main process — accounts, installs, game launch, parties, voice signalling, overlay, updates
src/renderer     the UI (plain ES modules, bundled with esbuild), 3D with three.js / skinview3d
src/preload      the bridge between the two (an allow‑list of channels)
native           Node‑API addon in C++ (window and process helpers, focus, hotkeys)
recorder-native  the screen recorder (DXGI duplication, D3D11 video processor, Media Foundation H.264, WASAPI)
bedrock-native   the Bedrock module (C++, MinHook): comfort settings, telemetry for proximity voice, cosmetics
agent            Java agent (no bytecode library): skins, cosmetics layer, comfort settings, party bridge
scripts          build scripts and tests (node --test)
```

## 🛠️ Building

Requirements: **Node.js 22+**, **Visual Studio 2022** (C++ desktop workload), **CMake 3.20+**, **JDK 17+**.

```bash
npm install
npm run build        # native addon, Bedrock module, recorder, UI
npm start            # run from source
npm run dist         # Windows installer (electron-builder)
npm test
```

### 🔑 Your own keys and servers

This repository contains **no keys, addresses or credentials**. To run your own build, provide them through environment variables:

| Variable | What it is |
|---|---|
| `MCL_MS_CLIENT_ID` | Client ID of your Azure app, approved for Minecraft services |
| `MCL_RELAY_HOST` | Your relay host (Mosquitto + coturn) |
| `MCL_RELAY_CERT` | The relay's TLS certificate (PEM) |
| `MCL_TURN_SECRET` | coturn `static-auth-secret` |
| `MCL_DISCORD_ID` | Discord application ID for Rich Presence (optional) |

### 📦 Not included

- 🎨 cosmetic models and textures, stickers;
- 🧩 anything owned by Mojang / Microsoft: logos, fonts, default skins, game textures;
- 🌐 server code and configuration;
- ⚙️ built binaries (the Bedrock module, the recorder, the agent jar, installers).

The launcher builds and runs without them; the places that use them stay empty.

## ⚖️ Legal

**Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.**
Minecraft is a trademark of Mojang Synergies AB. This launcher does not include or distribute any game files — the game is downloaded from Mojang's official servers or installed from the Microsoft Store, and you need your own copy of Minecraft.

© 2026 MC Launcher. **All rights reserved.** The source code is published for reference; no licence to copy, modify or redistribute it is granted.
