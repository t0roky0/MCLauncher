#pragma once
#include <windows.h>
#include <string>
// Our copies of some of the game's vanilla files (the launcher's cosmetics,
// src/main/bedrock-cosmetics.js): when the game opens one of those, it gets
// ours. List: "<path under data\resource_packs>\t<our file>" per line.
namespace overlay {
// packs: the game's data\resource_packs\ (with the trailing \); list: the launcher's overlay.txt
bool init(const std::wstring& packs,const std::wstring& list);
// the list again if the launcher changed it (cheap: compares the file's time)
void refresh();
// for telemetry: "overlay":{...}
std::string telemetry();
void close();
}
