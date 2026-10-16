#pragma once
#include <windows.h>
#include <string>
#include <cstdint>
namespace comfort {
void init(HMODULE module,uintptr_t gamma,const std::wstring& preferences);
void tick(bool world,bool cursorGrabbed,bool enabled);
void voice(bool muted,unsigned acknowledged);
void resetCommands();
void close();
std::string telemetry();
}
