# MC Launcher Bedrock voice adapter

This is an independent MC Launcher DLL and loader. No Latite or OderSo client, SDK,
hooking library, or scripting runtime is included. The module only reads game
state. Audio capture, device selection, noise suppression and encrypted WebRTC
audio remain in the launcher's existing voice implementation.

## Current verification status

The adapter targets the exact x64 package `Microsoft.MinecraftUWP 1.26.5203.0`.
It compiles with MSVC 2022. Automated tests cover telemetry validation, mutual
player discovery, distance, dimensions, stale samples and independent party voice.
Live game reading has NOT yet been verified: the Codex process received Windows
error 5 when opening the running game. Do not describe this build as verified
in-game until a user-session test produces valid world samples and a two-player
voice test succeeds.

## Data path

1. The launcher finds Minecraft.Windows.exe and checks its adjacent package identity.
2. It verifies its bundled module files against their SHA-256 manifest, stages them
   under a content-versioned directory, and loads its own DLL into that process.
3. The DLL independently checks the current Windows package identity, requires a
   unique code signature, then reads a bounded pointer chain with ReadProcessMemory.
   It decodes a plain pointer getter instead of calling game functions on its worker.
4. Every 250 ms it atomically replaces a JSON sample containing a per-session nonce,
   process ID, world status, self position, dimension and player names.
5. The launcher rejects wrong processes/nonces, oversized files and samples older
   than 1.5 seconds. It discovers launchers for names present in the local game,
   exchanges their positions and requires mutual membership and the same dimension.
6. Nearby voice starts automatically. Volume falls with distance. Menu, loss of
   telemetry or absent/stale peers remove the voice route. Party voice remains manual.

Position discovery currently uses public MQTT brokers and is not an authenticated
proof of Xbox identity. Audio uses the existing encrypted direct WebRTC connection;
there is currently no nearby-audio relay for pairs that cannot establish direct ICE.
The adapter does not expose coordinates of entities outside the player roster.

## Build and updates

Run `npm run build:bedrock` with Visual Studio 2022 C++ and CMake available.
The build produces `assets/bedrock/manifest.json`, `mcl-bedrock.dll` and
`mcl-bedrock-loader.exe`. Normal `npm run build` and `npm run dist` include it.
The launcher automatically stages the module shipped with its installed version.
The manifest hash isolates each module revision, and an already loaded older DLL
requires restarting Minecraft. No loaded file is overwritten or blindly unloaded.

A new Bedrock patch needs a reviewed adapter and an exact package allowlist update.
This is not an automatic address finder: old offsets are never applied to an unknown
package. Independent remote DLL distribution is not configured; a real owner-controlled
release endpoint and signature-verification key are required before enabling it.
Manifest hashes provide bundled-file consistency, not a remote publisher signature.

## Research references

Memory-layout observations were checked against the public Latite repository,
commit `9f7463515dd298a496da918285936d78c7416aad`, in its Minecraft layout declarations:
https://github.com/LatiteClient/Latite/tree/9f7463515dd298a496da918285936d78c7416aad/src/mc
Only observed layout facts were used; no client implementation is linked or bundled.
All game pointer layouts still require verification against the exact running package.

Auto-sprint, fullbright and an in-game GUI are not implemented by this read-only
voice adapter. They remain separate follow-up work after voice has been verified.
