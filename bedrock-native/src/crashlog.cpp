// What brought the game down, when something does: the exception, the module
// and offset it happened in, and the calls that led there — one block per
// fatal-looking exception in logs\bedrock-crash.log next to the launcher's
// own log. Written with no heap at all (a heap that's broken is one of the
// ways the game goes down) through a file opened at the start.
#include "crashlog.h"
#include <atomic>
#include <cstdio>

namespace crashlog {
namespace {
HANDLE file = INVALID_HANDLE_VALUE;
std::atomic<int> written{0};
const int kMax = 12;  // blocks a session: a game that keeps catching its own isn't worth more
thread_local bool probing = false;  // our own calls that may fail on purpose (comfort.cpp), caught where they're made

bool fatal(DWORD code) {
  return code == EXCEPTION_ACCESS_VIOLATION || code == 0xC0000374 /* heap corruption */ || code == 0xC0000409 /* stack buffer overrun */ ||
         code == EXCEPTION_STACK_OVERFLOW || code == EXCEPTION_ILLEGAL_INSTRUCTION || code == EXCEPTION_IN_PAGE_ERROR ||
         code == EXCEPTION_INT_DIVIDE_BY_ZERO || code == 0xC0000420 /* assertion */;
}

// "module+0x1234" for an address, into out
void where(const void* address, char* out, size_t size) {
  HMODULE m = nullptr;
  wchar_t path[MAX_PATH]{};
  if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, static_cast<LPCWSTR>(address), &m) && m &&
      GetModuleFileNameW(m, path, MAX_PATH)) {
    const wchar_t* name = path;
    for (const wchar_t* p = path; *p; p++) if (*p == L'\\' || *p == L'/') name = p + 1;
    char narrow[MAX_PATH]{};
    WideCharToMultiByte(CP_UTF8, 0, name, -1, narrow, MAX_PATH, nullptr, nullptr);
    _snprintf_s(out, size, _TRUNCATE, "%s+0x%llx", narrow, static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(address) - reinterpret_cast<uintptr_t>(m)));
  } else {
    _snprintf_s(out, size, _TRUNCATE, "0x%llx", static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(address)));
  }
}

void put(const char* s) {
  DWORD n = 0;
  WriteFile(file, s, static_cast<DWORD>(strlen(s)), &n, nullptr);
}

LONG CALLBACK handler(EXCEPTION_POINTERS* e) {
  if (!e || !e->ExceptionRecord || file == INVALID_HANDLE_VALUE) return EXCEPTION_CONTINUE_SEARCH;
  const DWORD code = e->ExceptionRecord->ExceptionCode;
  if (probing || !fatal(code) || written.fetch_add(1) >= kMax) return EXCEPTION_CONTINUE_SEARCH;
  char line[512], at[300];
  SYSTEMTIME t;
  GetLocalTime(&t);
  where(e->ExceptionRecord->ExceptionAddress, at, sizeof(at));
  _snprintf_s(line, sizeof(line), _TRUNCATE, "\r\n%04u-%02u-%02u %02u:%02u:%02u  exception 0x%08lx at %s  thread %lu", t.wYear, t.wMonth, t.wDay, t.wHour,
              t.wMinute, t.wSecond, code, at, GetCurrentThreadId());
  put(line);
  if (code == EXCEPTION_ACCESS_VIOLATION && e->ExceptionRecord->NumberParameters >= 2) {
    _snprintf_s(line, sizeof(line), _TRUNCATE, "  (%s 0x%llx)", e->ExceptionRecord->ExceptionInformation[0] == 1 ? "writing" : e->ExceptionRecord->ExceptionInformation[0] == 8 ? "executing" : "reading",
                static_cast<unsigned long long>(e->ExceptionRecord->ExceptionInformation[1]));
    put(line);
  }
  put("\r\n");
  void* frames[40]{};
  const USHORT n = CaptureStackBackTrace(0, 40, frames, nullptr);
  for (USHORT i = 0; i < n; i++) {
    where(frames[i], at, sizeof(at));
    _snprintf_s(line, sizeof(line), _TRUNCATE, "    %s\r\n", at);
    put(line);
  }
  FlushFileBuffers(file);
  return EXCEPTION_CONTINUE_SEARCH;  // the game's own handling goes on as it would
}
}  // namespace

void quiet(bool on) { probing = on; }

void init(const std::wstring& path) {
  file = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return;
  AddVectoredExceptionHandler(1, handler);
}
}  // namespace crashlog
