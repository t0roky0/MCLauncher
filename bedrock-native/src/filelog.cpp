// Development only (tools/bedrock/filelog.py): how Bedrock reads resource
// packs — which file calls it makes for the pack folder and our pack's files,
// in which order, how it reads them (whole, in pieces, mapped), and from where
// in the game (a short stack as module+offset). For serving our pack from the
// launcher's module instead of from files anyone can copy.
//
// Hooks the lowest file calls (ntdll), logs to filelog.txt next to the DLL
// only what concerns "resource_packs" and our pack.
#include <windows.h>
#include <winternl.h>
#include <cstdio>
#include <cwchar>
#include <mutex>
#include <string>
#include <unordered_map>
#include "MinHook.h"

namespace {
HMODULE self = nullptr;
std::wstring logPath;
std::mutex lock;
std::unordered_map<HANDLE, std::wstring> watched;  // handles of ours / of the pack folders → their path
thread_local bool inside = false;                    // our own file calls don't log themselves