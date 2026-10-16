#pragma once
#include <windows.h>
#include <string>

// What brought the game down (crashlog.cpp): exceptions that look fatal, to a
// file opened now, with no heap needed when one comes.
namespace crashlog {
void init(const std::wstring& path);
// on this thread: exceptions that are caught on purpose (a probe), not written down
void quiet(bool on);
}
