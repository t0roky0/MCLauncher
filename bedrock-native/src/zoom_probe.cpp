// How Bedrock gets its field of view (the zoom). Development only — loaded
// into a running game by tools/bedrock/zoom_probe.py, never shipped.
//
// The game's option getters all look alike (the gamma's is one): they ask
// the options object for an option by its number, then read its value. This
// lists them all with their numbers and what they give now, and can stand in
// for one of them (divide what it gives) to see whether the picture follows.
//
// zoom-probe.ini next to the DLL ([probe], read twice a second):
//   hook=<rva hex>   a getter to divide (0: none)     factor=<n>   by how much
//   shadow=<id>      the option of that number handed out as a copy divided by factor
//   unload=1         hooks out, module out
// zoom-probe.log: what it found.
#include <windows.h>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>
#include "MinHook.h"

namespace {
HMODULE self = nullptr;
std::wstring dir, iniPath, logPath;
uintptr_t base = 0, end = 0;
using Getter = float(__fastcall*)(void*, void*);
std::atomic<void*> options{nullptr}, context{nullptr};
Getter realGamma = nullptr;
uintptr_t gammaAt = 0;

void log(const char* fmt, ...) {
  FILE* f = _wfopen(logPath.c_str(), L"a");
  if (!f) return;
  SYSTEMTIME t;
  GetLocalTime(&t);
  fprintf(f, "%02d:%02d:%02d.%03d ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
  va_list a;
  va_start(a, fmt);
  vfprintf(f, fmt, a);
  va_end(a);
  fputc('\n', f);
  fclose(f);
}

float __fastcall gammaHook(void* o, void* c) {
  options.store(o);
  context.store(c);
  return realGamma(o, c);
}

struct Found { uintptr_t at; unsigned id; bool floats; };
std::vector<Found> getters;

void scan() {
  const int pattern[] = {0x48, 0x83, 0xec, 0x38, 0x48, 0x8b, 0x05, -1, -1, -1, -1, 0x48, 0x31, 0xe0, 0x48, 0x89, 0x44, 0x24, -1, 0x48, 0x8b, 0x01, 0x48, 0x8b, 0x40, 0x08, 0x48, 0x8d, 0x54, 0x24, -1, 0x41, 0xb8};
  const size_t n = sizeof(pattern) / sizeof(int);
  auto dos = reinterpret_cast<IMAGE_DOS_HEADER*>(base);
  auto nt = reinterpret_cast<IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
  end = base + nt->OptionalHeader.SizeOfImage;
  auto sec = IMAGE_FIRST_SECTION(nt);
  for (unsigned s = 0; s < nt->FileHeader.NumberOfSections; s++) {
    if (!(sec[s].Characteristics & IMAGE_SCN_MEM_EXECUTE)) continue;
    auto start = base + sec[s].VirtualAddress;
    size_t size = sec[s].Misc.VirtualSize;
    std::vector<unsigned char> bytes(size);
    SIZE_T got = 0;
    if (!ReadProcessMemory(GetCurrentProcess(), reinterpret_cast<void*>(start), bytes.data(), size, &got) || got != size) continue;
    for (size_t i = 0; i + n + 4 + 96 <= size; i++) {
      // (a getter already hooked — the launcher's own module: a jump over its first 5 bytes)
      const bool jumped = bytes[i] == 0xe9;
      bool match = true;
      for (size_t j = jumped ? 5 : 0; j < n; j++) if (pattern[j] >= 0 && bytes[i + j] != pattern[j]) { match = false; break; }
      if (!match) continue;
      unsigned id = 0;
      memcpy(&id, &bytes[i + n], 4);
      bool floats = false;
      for (size_t k = i + n + 4; k < i + n + 4 + 64; k++) if (bytes[k] == 0xf3 && bytes[k + 1] == 0x0f && bytes[k + 2] == 0x10) { floats = true; break; }
      getters.push_back({start + i, id, floats});
      std::string hex;
      char b[4];
      for (size_t k = 0; k < 96; k++) { snprintf(b, sizeof b, "%02x", bytes[i + k]); hex += b; }
      log("getter rva=%llx id=%u (0x%x) %s%s bytes=%s", static_cast<unsigned long long>(start + i - base), id, id, floats ? "float" : "other", jumped ? " hooked" : "", hex.c_str());
    }
  }
  for (auto& g : getters) if (g.id == 0x32) gammaAt = g.at;
}

float call(Getter fn, void* o, void* c, bool* ok) {
  __try { const float v = fn(o, c); *ok = true; return v; }
  __except (EXCEPTION_EXECUTE_HANDLER) { *ok = false; return 0; }
}

// a getter divided by a factor
std::atomic<float> factor{1.0f};
Getter realHooked = nullptr;
uintptr_t hookedAt = 0;
float __fastcall dividedHook(void* o, void* c) {
  const float v = realHooked(o, c);
  const float f = factor.load();
  return f > 1.001f ? v / f : v;
}

// ---- the options by number: vtable[1] of the options object hands out an
// option (out param), whose value sits at +0x18 (float, int) / +0x10 (bool);
// an option may be overridden by another (+8 → +0x238), the last one counts
using GetOption = void**(__fastcall*)(void*, void**, int);
GetOption realGetOption = nullptr;
uintptr_t getOptionAt = 0;
std::atomic<int> shadowId{-1};
alignas(16) unsigned char shadow[0x400];
void* shadowOf = nullptr;
template<class T> bool peek(uintptr_t at, T& v) {
  SIZE_T got = 0;
  return at > 0x10000 && ReadProcessMemory(GetCurrentProcess(), reinterpret_cast<void*>(at), &v, sizeof v, &got) && got == sizeof v;
}
uintptr_t last(uintptr_t o) {
  for (int hops = 0; o && hops < 8; hops++) {
    uintptr_t owner = 0, next = 0;
    if (!peek(o + 8, owner) || !peek(owner + 0x238, next) || !next) break;
    o = next;
  }
  return o;
}
std::string textAt(uintptr_t at) {
  struct Str { char bytes[16]; size_t size, cap; } s{};
  if (!peek(at, s) || s.size == 0 || s.size > 64 || s.cap < s.size || s.cap > 4096) return {};
  char buf[65]{};
  uintptr_t data = at;
  if (s.cap >= 16) memcpy(&data, s.bytes, 8);
  SIZE_T got = 0;
  if (!ReadProcessMemory(GetCurrentProcess(), reinterpret_cast<void*>(data), buf, s.size, &got) || got != s.size) return {};
  for (size_t i = 0; i < s.size; i++) if (buf[i] < 32 || buf[i] > 126) return {};
  return std::string(buf, s.size);
}
void** __fastcall getOptionHook(void* options, void** out, int id) {
  void** r = realGetOption(options, out, id);
  const float f = factor.load();
  if (id == shadowId.load() && f > 1.001f && out && *out) {
    const uintptr_t real = last(reinterpret_cast<uintptr_t>(*out));
    if (shadowOf != reinterpret_cast<void*>(real)) { memcpy(shadow, reinterpret_cast<void*>(real), sizeof shadow); shadowOf = reinterpret_cast<void*>(real); }
    float v = 0;
    memcpy(&v, reinterpret_cast<void*>(real + 0x18), 4);
    v /= f;
    memcpy(shadow + 0x18, &v, 4);
    *out = shadow;
  }
  return r;
}
void* callGetOption(GetOption fn, void* o, int id, bool* ok) {
  __try { void* out[4] = {}; fn(o, out, id); *ok = true; return out[0]; }
  __except (EXCEPTION_EXECUTE_HANDLER) { *ok = false; return nullptr; }
}
void mapOptions(void* o) {
  auto fn = reinterpret_cast<GetOption>((*reinterpret_cast<void***>(o))[1]);
  getOptionAt = reinterpret_cast<uintptr_t>(fn);
  log("getOption at rva %llx", static_cast<unsigned long long>(getOptionAt - base));
  int fails = 0;
  for (int id = 0; id < 700 && fails < 60; id++) {
    bool ok = false;
    void* opt = callGetOption(fn, o, id, &ok);
    if (!ok || !opt) { fails++; continue; }
    fails = 0;
    const uintptr_t a = reinterpret_cast<uintptr_t>(opt), e = last(a);
    float fv = 0; int iv = 0; unsigned char bv = 0; uintptr_t vt = 0;
    peek(e + 0x18, fv); peek(e + 0x18, iv); peek(e + 0x10, bv); peek(a, vt);
    std::string names;
    for (uintptr_t k = 0; k < 0x100; k += 8) { auto t = textAt(a + k); if (!t.empty()) names += " +" + std::to_string(k) + "=" + t; }
    log("option id=%d at %llx%s vt=%llx f=%.4f i=%d b=%u%s", id, static_cast<unsigned long long>(a), e != a ? " (overridden)" : "",
        static_cast<unsigned long long>(vt >= base && vt < end ? vt - base : 0), fv, iv, bv, names.c_str());
  }
  if (MH_CreateHook(reinterpret_cast<void*>(getOptionAt), reinterpret_cast<void*>(getOptionHook), reinterpret_cast<void**>(&realGetOption)) == MH_OK &&
      MH_EnableHook(reinterpret_cast<void*>(getOptionAt)) == MH_OK) log("getOption hooked");
  else log("getOption hook failed");
}

std::wstring get(const wchar_t* key) {
  wchar_t buf[128]{};
  GetPrivateProfileStringW(L"probe", key, L"", buf, 128, iniPath.c_str());
  return buf;
}

DWORD WINAPI worker(void*) {
  log("in, image %llx", static_cast<unsigned long long>(base));
  scan();
  log("%zu getters, gamma at rva %llx", getters.size(), static_cast<unsigned long long>(gammaAt ? gammaAt - base : 0));
  if (MH_Initialize() != MH_OK) { log("MH_Initialize failed"); }
  if (gammaAt && MH_CreateHook(reinterpret_cast<void*>(gammaAt), reinterpret_cast<void*>(gammaHook), reinterpret_cast<void**>(&realGamma)) == MH_OK &&
      MH_EnableHook(reinterpret_cast<void*>(gammaAt)) == MH_OK) log("gamma hooked");
  else log("gamma hook failed");
  bool listed = false;
  for (;;) {
    Sleep(500);
    if (get(L"unload") == L"1") break;
    void* o = options.load();
    if (o && !listed) {
      listed = true;
      log("options %p context %p", o, context.load());
      for (auto& g : getters) {
        if (!g.floats) continue;
        bool ok = false;
        const float v = call(reinterpret_cast<Getter>(g.at), o, context.load(), &ok);
        log("value rva=%llx id=%u %s %.4f", static_cast<unsigned long long>(g.at - base), g.id, ok ? "ok" : "FAULT", v);
      }
      log("listed");
      mapOptions(o);
      log("mapped");
    }
    const auto sid = get(L"shadow");
    shadowId = sid.empty() ? -1 : _wtoi(sid.c_str());
    // stand in for one getter
    const auto h = get(L"hook");
    const uintptr_t want = h.empty() ? 0 : base + wcstoull(h.c_str(), nullptr, 16);
    if (want != hookedAt) {
      if (hookedAt) { MH_DisableHook(reinterpret_cast<void*>(hookedAt)); MH_RemoveHook(reinterpret_cast<void*>(hookedAt)); log("unhooked %llx", static_cast<unsigned long long>(hookedAt - base)); }
      hookedAt = 0;
      if (want > base && want < end && MH_CreateHook(reinterpret_cast<void*>(want), reinterpret_cast<void*>(dividedHook), reinterpret_cast<void**>(&realHooked)) == MH_OK &&
          MH_EnableHook(reinterpret_cast<void*>(want)) == MH_OK) { hookedAt = want; log("hooked %llx", static_cast<unsigned long long>(want - base)); }
    }
    const auto f = get(L"factor");
    factor = f.empty() ? 1.0f : static_cast<float>(_wtof(f.c_str()));
  }
  MH_DisableHook(MH_ALL_HOOKS);
  Sleep(200);
  MH_Uninitialize();
  log("unloaded");
  FreeLibraryAndExitThread(self, 0);
}
}  // namespace

BOOL WINAPI DllMain(HINSTANCE mod, DWORD why, LPVOID) {
  if (why == DLL_PROCESS_ATTACH) {
    self = mod;
    DisableThreadLibraryCalls(mod);
    wchar_t path[MAX_PATH]{};
    GetModuleFileNameW(mod, path, MAX_PATH);
    dir = path;
    dir = dir.substr(0, dir.find_last_of(L"\\/"));
    iniPath = dir + L"\\zoom-probe.ini";
    logPath = dir + L"\\zoom-probe.log";
    base = reinterpret_cast<uintptr_t>(GetModuleHandleW(nullptr));
    HANDLE t = CreateThread(nullptr, 0, worker, nullptr, 0, nullptr);
    if (t) CloseHandle(t);
  }
  return TRUE;
}
