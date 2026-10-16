// mcnative — the launcher's C++ side.
//
// Everything here is something JavaScript either cannot do on Windows or
// can only do by spawning a helper process every time:
//
//   systemInfo()          RAM, CPU brand/cores, GPUs (DXGI) and the OS
//                         build — drives the memory slider's limits and the
//                         "About" card.
//   processStats(pid)     working set / private bytes / CPU time of the game
//                         process, polled while it runs.
//   setPriority(pid, lv)  the "process priority" setting.
//   fileVersion(path)     PE version resource of an exe (java.exe) without
//                         starting a JVM just to ask it.
//   javaRegistryHomes()   every JDK/JRE the common vendors registered.
//   verifyFiles(items)    multi-threaded SHA-1 check of thousands of game
//                         files (BCrypt), used by "Verify files" and after
//                         downloads.
//   sha1File(path)        the same for one file.
//   keysDown(vks)         whether any of these keys / mouse buttons is held
//                         right now, whichever window has focus — push-to-talk
//                         for the party voice chat while the game is in front.
//
// The JS side (src/main/native.js) has a fallback for every export, so a
// missing or broken .node never stops the launcher from working.

#include <windows.h>
#include <psapi.h>
#include <dxgi.h>
#include <bcrypt.h>
#include <intrin.h>
#include <napi.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr double kMB = 1024.0 * 1024.0;

std::wstring Widen(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
  return w;
}

std::string Narrow(const wchar_t* w, int len = -1) {
  if (!w) return {};
  if (len < 0) len = static_cast<int>(wcslen(w));
  if (len == 0) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w, len, nullptr, 0, nullptr, nullptr);
  std::string s(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, len, s.data(), n, nullptr, nullptr);
  return s;
}

std::string Trim(std::string s) {
  auto notSpace = [](unsigned char c) { return c != ' ' && c != '\t' && c != '\0'; };
  s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
  s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
  return s;
}

// ---------------------------------------------------------------- system

std::string CpuBrand() {
  int regs[4] = {0};
  __cpuid(regs, 0x80000000);
  if (static_cast<unsigned>(regs[0]) < 0x80000004u) return {};
  char brand[49] = {0};
  for (int i = 0; i < 3; ++i) {
    __cpuid(regs, 0x80000002 + i);
    std::memcpy(brand + i * 16, regs, 16);
  }
  // Intel pads the brand string with leading spaces and some BIOSes
  // with runs of them in the middle; collapse both.
  std::string out;
  bool space = false;
  for (const char* p = brand; *p; ++p) {
    if (*p == ' ') {
      space = !out.empty();
      continue;
    }
    if (space) out.push_back(' ');
    space = false;
    out.push_back(*p);
  }
  return out;
}

int PhysicalCores() {
  DWORD len = 0;
  GetLogicalProcessorInformationEx(RelationProcessorCore, nullptr, &len);
  if (len == 0) return 0;
  std::vector<BYTE> buf(len);
  auto* first = reinterpret_cast<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX*>(buf.data());
  if (!GetLogicalProcessorInformationEx(RelationProcessorCore, first, &len)) return 0;
  int cores = 0;
  for (DWORD off = 0; off < len;) {
    auto* item = reinterpret_cast<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX*>(buf.data() + off);
    if (item->Relationship == RelationProcessorCore) ++cores;
    off += item->Size;
  }
  return cores;
}

std::string OsVersion() {
  using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) return {};
  auto fn = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"));
  if (!fn) return {};
  RTL_OSVERSIONINFOW v{};
  v.dwOSVersionInfoSize = sizeof(v);
  if (fn(&v) != 0) return {};
  return std::to_string(v.dwMajorVersion) + "." + std::to_string(v.dwMinorVersion) + "." +
         std::to_string(v.dwBuildNumber);
}

Napi::Array Gpus(Napi::Env env) {
  Napi::Array arr = Napi::Array::New(env);
  IDXGIFactory1* factory = nullptr;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory))) || !factory) {
    return arr;
  }
  uint32_t n = 0;
  IDXGIAdapter1* adapter = nullptr;
  // DXGI can hand back the same physical adapter more than once (one entry
  // per output on some drivers); the LUID is what identifies the device.
  std::set<std::pair<DWORD, LONG>> seen;
  for (UINT i = 0; factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; ++i) {
    DXGI_ADAPTER_DESC1 d{};
    if (SUCCEEDED(adapter->GetDesc1(&d)) && !(d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) &&
        seen.insert({d.AdapterLuid.LowPart, d.AdapterLuid.HighPart}).second) {
      Napi::Object g = Napi::Object::New(env);
      g.Set("name", Narrow(d.Description));
      g.Set("vramMB", static_cast<double>(d.DedicatedVideoMemory) / kMB);
      g.Set("sharedMB", static_cast<double>(d.SharedSystemMemory) / kMB);
      g.Set("vendorId", static_cast<double>(d.VendorId));
      arr.Set(n++, g);
    }
    adapter->Release();
  }
  factory->Release();
  return arr;
}

Napi::Value SystemInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);

  MEMORYSTATUSEX ms{};
  ms.dwLength = sizeof(ms);
  if (GlobalMemoryStatusEx(&ms)) {
    out.Set("totalMemMB", static_cast<double>(ms.ullTotalPhys) / kMB);
    out.Set("freeMemMB", static_cast<double>(ms.ullAvailPhys) / kMB);
    out.Set("memoryLoad", static_cast<double>(ms.dwMemoryLoad));
  }
  out.Set("cpuName", CpuBrand());
  out.Set("cpuCores", PhysicalCores());
  out.Set("cpuThreads", static_cast<double>(GetActiveProcessorCount(ALL_PROCESSOR_GROUPS)));
  out.Set("gpus", Gpus(env));
  out.Set("osVersion", OsVersion());
  return out;
}

// --------------------------------------------------------------- process

const char* PriorityName(DWORD cls) {
  switch (cls) {
    case IDLE_PRIORITY_CLASS: return "idle";
    case BELOW_NORMAL_PRIORITY_CLASS: return "below";
    case ABOVE_NORMAL_PRIORITY_CLASS: return "above";
    case HIGH_PRIORITY_CLASS: return "high";
    case REALTIME_PRIORITY_CLASS: return "realtime";
    default: return "normal";
  }
}

double FileTimeMs(const FILETIME& f) {
  return static_cast<double>((static_cast<ULONGLONG>(f.dwHighDateTime) << 32) | f.dwLowDateTime) / 10000.0;
}

Napi::Value ProcessStats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    throw Napi::TypeError::New(env, "processStats(pid: number)");
  }
  DWORD pid = info[0].As<Napi::Number>().Uint32Value();
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  if (!h) h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return env.Null();

  Napi::Object o = Napi::Object::New(env);
  DWORD code = 0;
  o.Set("alive", GetExitCodeProcess(h, &code) && code == STILL_ACTIVE);

  PROCESS_MEMORY_COUNTERS_EX pmc{};
  pmc.cb = sizeof(pmc);
  if (GetProcessMemoryInfo(h, reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&pmc), sizeof(pmc))) {
    o.Set("workingSetMB", static_cast<double>(pmc.WorkingSetSize) / kMB);
    o.Set("privateMB", static_cast<double>(pmc.PrivateUsage) / kMB);
    o.Set("peakWorkingSetMB", static_cast<double>(pmc.PeakWorkingSetSize) / kMB);
  }
  FILETIME created, exited, kernel, user;
  if (GetProcessTimes(h, &created, &exited, &kernel, &user)) {
    o.Set("cpuMs", FileTimeMs(kernel) + FileTimeMs(user));
  }
  DWORD handles = 0;
  if (GetProcessHandleCount(h, &handles)) o.Set("handles", static_cast<double>(handles));
  o.Set("priority", PriorityName(GetPriorityClass(h)));
  CloseHandle(h);
  return o;
}

Napi::Value SetPriority(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
    throw Napi::TypeError::New(env, "setPriority(pid: number, level: string)");
  }
  DWORD pid = info[0].As<Napi::Number>().Uint32Value();
  std::string level = info[1].As<Napi::String>().Utf8Value();
  DWORD cls = NORMAL_PRIORITY_CLASS;
  if (level == "idle") cls = IDLE_PRIORITY_CLASS;
  else if (level == "below") cls = BELOW_NORMAL_PRIORITY_CLASS;
  else if (level == "above") cls = ABOVE_NORMAL_PRIORITY_CLASS;
  else if (level == "high") cls = HIGH_PRIORITY_CLASS;
  // "realtime" is deliberately not accepted: a game that wins against the
  // mouse and keyboard drivers is not a feature.
  HANDLE h = OpenProcess(PROCESS_SET_INFORMATION, FALSE, pid);
  if (!h) return Napi::Boolean::New(env, false);
  BOOL ok = SetPriorityClass(h, cls);
  CloseHandle(h);
  return Napi::Boolean::New(env, ok != FALSE);
}

// ------------------------------------------------------------- versions

std::wstring QueryString(const std::vector<BYTE>& data, WORD lang, WORD cp, const wchar_t* name) {
  wchar_t key[128];
  swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\%s", lang, cp, name);
  LPVOID value = nullptr;
  UINT len = 0;
  if (VerQueryValueW(data.data(), key, &value, &len) && value && len > 0) {
    return std::wstring(static_cast<const wchar_t*>(value), len - 1);
  }
  return {};
}

Napi::Value FileVersion(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) throw Napi::TypeError::New(env, "fileVersion(path: string)");
  std::wstring path = Widen(info[0].As<Napi::String>().Utf8Value());
  DWORD dummy = 0;
  DWORD size = GetFileVersionInfoSizeW(path.c_str(), &dummy);
  if (size == 0) return env.Null();
  std::vector<BYTE> data(size);
  if (!GetFileVersionInfoW(path.c_str(), 0, size, data.data())) return env.Null();

  Napi::Object o = Napi::Object::New(env);
  VS_FIXEDFILEINFO* ffi = nullptr;
  UINT len = 0;
  if (VerQueryValueW(data.data(), L"\\", reinterpret_cast<LPVOID*>(&ffi), &len) && ffi) {
    char buf[64];
    sprintf_s(buf, "%u.%u.%u.%u", HIWORD(ffi->dwFileVersionMS), LOWORD(ffi->dwFileVersionMS),
              HIWORD(ffi->dwFileVersionLS), LOWORD(ffi->dwFileVersionLS));
    o.Set("fileVersion", buf);
    o.Set("major", static_cast<double>(HIWORD(ffi->dwFileVersionMS)));
  }
  struct Translation { WORD lang; WORD cp; }* tr = nullptr;
  if (VerQueryValueW(data.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<LPVOID*>(&tr), &len) && tr &&
      len >= sizeof(Translation)) {
    o.Set("productName", Narrow(QueryString(data, tr->lang, tr->cp, L"ProductName").c_str()));
    o.Set("productVersion", Narrow(QueryString(data, tr->lang, tr->cp, L"ProductVersion").c_str()));
    o.Set("company", Narrow(QueryString(data, tr->lang, tr->cp, L"CompanyName").c_str()));
  }
  return o;
}

// ------------------------------------------------------- java registry

std::wstring ReadRegString(HKEY key, const wchar_t* sub, const wchar_t* value) {
  wchar_t buf[MAX_PATH * 2];
  DWORD bytes = sizeof(buf);
  if (RegGetValueW(key, sub, value, RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ, nullptr, buf, &bytes) == ERROR_SUCCESS) {
    return std::wstring(buf);
  }
  return {};
}

void CollectVendor(HKEY root, REGSAM view, const wchar_t* base, const wchar_t* suffix, const wchar_t* valueName,
                   std::set<std::wstring>& out) {
  HKEY key = nullptr;
  if (RegOpenKeyExW(root, base, 0, KEY_READ | view, &key) != ERROR_SUCCESS) return;
  wchar_t name[256];
  for (DWORD i = 0;; ++i) {
    DWORD nameLen = 256;
    if (RegEnumKeyExW(key, i, name, &nameLen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
    std::wstring sub = name;
    if (suffix && *suffix) sub += std::wstring(L"\\") + suffix;
    HKEY child = nullptr;
    if (RegOpenKeyExW(key, sub.c_str(), 0, KEY_READ | view, &child) == ERROR_SUCCESS) {
      std::wstring home = ReadRegString(child, nullptr, valueName);
      if (!home.empty()) {
        while (!home.empty() && (home.back() == L'\\' || home.back() == L'/')) home.pop_back();
        out.insert(home);
      }
      RegCloseKey(child);
    }
  }
  RegCloseKey(key);
}

Napi::Value JavaRegistryHomes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  struct Vendor { const wchar_t* base; const wchar_t* suffix; const wchar_t* value; };
  const Vendor vendors[] = {
      {L"SOFTWARE\\JavaSoft\\JDK", nullptr, L"JavaHome"},
      {L"SOFTWARE\\JavaSoft\\JRE", nullptr, L"JavaHome"},
      {L"SOFTWARE\\JavaSoft\\Java Runtime Environment", nullptr, L"JavaHome"},
      {L"SOFTWARE\\JavaSoft\\Java Development Kit", nullptr, L"JavaHome"},
      {L"SOFTWARE\\Eclipse Adoptium\\JDK", L"hotspot\\MSI", L"Path"},
      {L"SOFTWARE\\Eclipse Adoptium\\JRE", L"hotspot\\MSI", L"Path"},
      {L"SOFTWARE\\Eclipse Foundation\\JDK", L"hotspot\\MSI", L"Path"},
      {L"SOFTWARE\\AdoptOpenJDK\\JDK", L"hotspot\\MSI", L"Path"},
      {L"SOFTWARE\\AdoptOpenJDK\\JRE", L"hotspot\\MSI", L"Path"},
      {L"SOFTWARE\\Microsoft\\JDK", L"hotspot\\MSI", L"Path"},
      {L"SOFTWARE\\Azul Systems\\Zulu", nullptr, L"InstallationPath"},
      {L"SOFTWARE\\BellSoft\\Liberica", nullptr, L"InstallationPath"},
  };
  std::set<std::wstring> homes;
  for (HKEY root : {HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER}) {
    for (REGSAM view : {static_cast<REGSAM>(KEY_WOW64_64KEY), static_cast<REGSAM>(KEY_WOW64_32KEY)}) {
      for (const Vendor& v : vendors) CollectVendor(root, view, v.base, v.suffix, v.value, homes);
    }
  }
  Napi::Array arr = Napi::Array::New(env);
  uint32_t i = 0;
  for (const auto& h : homes) arr.Set(i++, Narrow(h.c_str()));
  return arr;
}

// ------------------------------------------------------------------ sha1

class Sha1 {
 public:
  Sha1() {
    if (BCryptOpenAlgorithmProvider(&alg_, BCRYPT_SHA1_ALGORITHM, nullptr, BCRYPT_HASH_REUSABLE_FLAG) != 0) {
      alg_ = nullptr;
      return;
    }
    DWORD objLen = 0, got = 0;
    BCryptGetProperty(alg_, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objLen), sizeof(objLen), &got, 0);
    obj_.resize(objLen);
    if (BCryptCreateHash(alg_, &hash_, obj_.data(), objLen, nullptr, 0, BCRYPT_HASH_REUSABLE_FLAG) != 0) {
      hash_ = nullptr;
    }
  }
  ~Sha1() {
    if (hash_) BCryptDestroyHash(hash_);
    if (alg_) BCryptCloseAlgorithmProvider(alg_, 0);
  }
  Sha1(const Sha1&) = delete;
  Sha1& operator=(const Sha1&) = delete;

  bool ok() const { return hash_ != nullptr; }
  void Update(const void* p, ULONG n) { BCryptHashData(hash_, static_cast<PUCHAR>(const_cast<void*>(p)), n, 0); }
  // A reusable hash object resets itself on finish, so one instance per
  // thread serves every file that thread checks.
  std::string FinishHex() {
    UCHAR digest[20];
    BCryptFinishHash(hash_, digest, sizeof(digest), 0);
    static const char* hex = "0123456789abcdef";
    std::string s(40, '0');
    for (int i = 0; i < 20; ++i) {
      s[i * 2] = hex[digest[i] >> 4];
      s[i * 2 + 1] = hex[digest[i] & 15];
    }
    return s;
  }

 private:
  BCRYPT_ALG_HANDLE alg_ = nullptr;
  BCRYPT_HASH_HANDLE hash_ = nullptr;
  std::vector<UCHAR> obj_;
};

enum CheckResult : uint8_t { kOk = 0, kMissing = 1, kSize = 2, kHash = 3, kReadError = 4 };

const char* ReasonName(uint8_t r) {
  switch (r) {
    case kMissing: return "missing";
    case kSize: return "size";
    case kHash: return "hash";
    case kReadError: return "read";
    default: return "ok";
  }
}

// Hashes `path`; returns kOk and fills `hexOut`, or an error code.
uint8_t HashFile(const std::wstring& path, int64_t expectSize, Sha1& hasher, std::vector<char>& buf,
                 std::string& hexOut) {
  HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                         FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (f == INVALID_HANDLE_VALUE) return kMissing;
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(f, &size)) {
    CloseHandle(f);
    return kReadError;
  }
  if (expectSize >= 0 && size.QuadPart != expectSize) {
    CloseHandle(f);
    return kSize;
  }
  for (;;) {
    DWORD got = 0;
    if (!ReadFile(f, buf.data(), static_cast<DWORD>(buf.size()), &got, nullptr)) {
      CloseHandle(f);
      hasher.FinishHex();  // reset the reusable object for the next file
      return kReadError;
    }
    if (got == 0) break;
    hasher.Update(buf.data(), got);
  }
  CloseHandle(f);
  hexOut = hasher.FinishHex();
  return kOk;
}

struct VerifyItem {
  std::wstring path;
  std::string sha1;  // lower-case hex, or empty for "existence + size only"
  int64_t size = -1;
};

class VerifyWorker : public Napi::AsyncWorker {
 public:
  VerifyWorker(Napi::Env env, std::vector<VerifyItem> items, Napi::Function progress)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), items_(std::move(items)) {
    if (!progress.IsEmpty() && progress.IsFunction()) {
      tsfn_ = Napi::ThreadSafeFunction::New(env, progress, "mcnative.verifyFiles", 0, 1);
      hasProgress_ = true;
    }
  }

  Napi::Promise Promise() { return deferred_.Promise(); }

 protected:
  void Execute() override {
    results_.assign(items_.size(), kOk);
    if (items_.empty()) return;
    std::atomic<size_t> next{0};
    std::atomic<size_t> done{0};
    unsigned hw = std::thread::hardware_concurrency();
    unsigned n = std::clamp(hw == 0 ? 4u : hw, 2u, 8u);
    n = static_cast<unsigned>(std::min<size_t>(n, items_.size()));
    std::vector<std::thread> threads;
    threads.reserve(n);
    for (unsigned t = 0; t < n; ++t) {
      threads.emplace_back([&] {
        Sha1 hasher;
        std::vector<char> buf(1 << 20);
        for (;;) {
          size_t i = next.fetch_add(1);
          if (i >= items_.size()) break;
          const VerifyItem& item = items_[i];
          uint8_t r;
          if (item.sha1.empty() || !hasher.ok()) {
            WIN32_FILE_ATTRIBUTE_DATA fad{};
            if (!GetFileAttributesExW(item.path.c_str(), GetFileExInfoStandard, &fad)) {
              r = kMissing;
            } else {
              int64_t sz = (static_cast<int64_t>(fad.nFileSizeHigh) << 32) | fad.nFileSizeLow;
              r = (item.size >= 0 && sz != item.size) ? kSize : kOk;
            }
          } else {
            std::string hex;
            r = HashFile(item.path, item.size, hasher, buf, hex);
            if (r == kOk && _stricmp(hex.c_str(), item.sha1.c_str()) != 0) r = kHash;
          }
          results_[i] = r;
          size_t d = done.fetch_add(1) + 1;
          if (hasProgress_ && (d % 96 == 0 || d == items_.size())) {
            auto* payload = new size_t(d);
            napi_status st = tsfn_.NonBlockingCall(payload, [](Napi::Env env, Napi::Function fn, size_t* v) {
              fn.Call({Napi::Number::New(env, static_cast<double>(*v))});
              delete v;
            });
            if (st != napi_ok) delete payload;
          }
        }
      });
    }
    for (auto& th : threads) th.join();
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array out = Napi::Array::New(env);
    uint32_t k = 0;
    for (size_t i = 0; i < results_.size(); ++i) {
      if (results_[i] == kOk) continue;
      Napi::Object o = Napi::Object::New(env);
      o.Set("index", static_cast<double>(i));
      o.Set("reason", ReasonName(results_[i]));
      out.Set(k++, o);
    }
    if (hasProgress_) tsfn_.Release();
    deferred_.Resolve(out);
  }

  void OnError(const Napi::Error& e) override {
    if (hasProgress_) tsfn_.Release();
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::vector<VerifyItem> items_;
  std::vector<uint8_t> results_;
  Napi::ThreadSafeFunction tsfn_;
  bool hasProgress_ = false;
};

Napi::Value VerifyFiles(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsArray()) {
    throw Napi::TypeError::New(env, "verifyFiles(items: {path, sha1?, size?}[], onProgress?)");
  }
  Napi::Array arr = info[0].As<Napi::Array>();
  std::vector<VerifyItem> items;
  items.reserve(arr.Length());
  for (uint32_t i = 0; i < arr.Length(); ++i) {
    Napi::Value v = arr.Get(i);
    if (!v.IsObject()) throw Napi::TypeError::New(env, "verifyFiles: every item must be an object");
    Napi::Object o = v.As<Napi::Object>();
    VerifyItem item;
    item.path = Widen(o.Get("path").As<Napi::String>().Utf8Value());
    Napi::Value sha = o.Get("sha1");
    if (sha.IsString()) item.sha1 = sha.As<Napi::String>().Utf8Value();
    Napi::Value size = o.Get("size");
    if (size.IsNumber()) {
      double s = size.As<Napi::Number>().DoubleValue();
      item.size = s > 0 ? static_cast<int64_t>(s) : -1;
    }
    items.push_back(std::move(item));
  }
  Napi::Function progress;
  if (info.Length() > 1 && info[1].IsFunction()) progress = info[1].As<Napi::Function>();
  auto* worker = new VerifyWorker(env, std::move(items), progress);
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

class HashWorker : public Napi::AsyncWorker {
 public:
  HashWorker(Napi::Env env, std::wstring path)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), path_(std::move(path)) {}
  Napi::Promise Promise() { return deferred_.Promise(); }

 protected:
  void Execute() override {
    Sha1 hasher;
    if (!hasher.ok()) {
      SetError("BCrypt SHA-1 provider unavailable");
      return;
    }
    std::vector<char> buf(1 << 20);
    uint8_t r = HashFile(path_, -1, hasher, buf, hex_);
    if (r != kOk) SetError(std::string("cannot read file: ") + ReasonName(r));
  }
  void OnOK() override { deferred_.Resolve(Napi::String::New(Env(), hex_)); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  std::wstring path_;
  std::string hex_;
};

Napi::Value Sha1File(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) throw Napi::TypeError::New(env, "sha1File(path: string)");
  auto* worker = new HashWorker(env, Widen(info[0].As<Napi::String>().Utf8Value()));
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

// GetAsyncKeyState sees the physical state of a key without taking it from
// the window that has focus, so the game still gets it.
Napi::Value KeysDown(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsArray()) {
    throw Napi::TypeError::New(env, "keysDown(vks: number[])");
  }
  Napi::Array list = info[0].As<Napi::Array>();
  bool down = false;
  for (uint32_t i = 0; i < list.Length() && i < 8; i++) {
    Napi::Value v = list.Get(i);
    if (!v.IsNumber()) continue;
    int vk = v.As<Napi::Number>().Int32Value();
    if (vk > 0 && vk < 256 && (GetAsyncKeyState(vk) & 0x8000)) down = true;
  }
  return Napi::Boolean::New(env, down);
}

Napi::Value ForegroundWindow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND window = GetForegroundWindow();
  if (!window || IsIconic(window)) return env.Null();
  DWORD pid = 0; GetWindowThreadProcessId(window, &pid);
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return env.Null();
  wchar_t file[32768]; DWORD length = 32768;
  BOOL ok = QueryFullProcessImageNameW(process, 0, file, &length);
  CloseHandle(process);
  if (!ok) return env.Null();
  RECT rect; POINT origin = {0, 0};
  if (!GetClientRect(window, &rect) || !ClientToScreen(window, &origin)) return env.Null();
  std::wstring full(file, length); size_t slash = full.find_last_of(L"\\/");
  std::wstring name = slash == std::wstring::npos ? full : full.substr(slash + 1);
  Napi::Object out = Napi::Object::New(env);
  out.Set("pid", pid);
  out.Set("exe", Napi::String::New(env, reinterpret_cast<const char16_t*>(name.c_str()), name.size()));
  out.Set("x", origin.x); out.Set("y", origin.y);
  out.Set("width", rect.right); out.Set("height", rect.bottom);
  return out;
}

// The overlay's menu closed: the keyboard and mouse go back to the game —
// its biggest visible top-level window. Allowed while the overlay (our
// process) is the foreground window.
struct MainWindow { DWORD pid; HWND best; LONGLONG area; };
BOOL CALLBACK FindMainWindow(HWND window, LPARAM param) {
  auto* m = reinterpret_cast<MainWindow*>(param);
  DWORD pid = 0; GetWindowThreadProcessId(window, &pid);
  if (pid != m->pid || !IsWindowVisible(window) || GetWindow(window, GW_OWNER)) return TRUE;
  RECT r; if (!GetWindowRect(window, &r)) return TRUE;
  LONGLONG area = static_cast<LONGLONG>(r.right - r.left) * (r.bottom - r.top);
  if (area > m->area) { m->area = area; m->best = window; }
  return TRUE;
}

HWND MainWindowOf(DWORD pid) {
  MainWindow m{ pid, nullptr, 0 };
  if (pid) EnumWindows(FindMainWindow, reinterpret_cast<LPARAM>(&m));
  return m.best;
}

// Windows lets only the foreground thread hand the foreground over: for the
// switch we share the current foreground window's input queue. Failing that,
// a released Alt (no key goes down) unlocks SetForegroundWindow.
bool BringToFront(HWND target) {
  if (!target || !IsWindow(target)) return false;
  if (IsIconic(target)) ShowWindow(target, SW_RESTORE);
  HWND fg = GetForegroundWindow();
  if (fg == target) return true;
  DWORD me = GetCurrentThreadId();
  DWORD other = fg ? GetWindowThreadProcessId(fg, nullptr) : 0;
  bool attached = other && other != me && AttachThreadInput(me, other, TRUE);
  BringWindowToTop(target);
  SetForegroundWindow(target);
  SetActiveWindow(target);
  SetFocus(target);
  if (attached) AttachThreadInput(me, other, FALSE);
  if (GetForegroundWindow() != target) {
    INPUT up{};
    up.type = INPUT_KEYBOARD;
    up.ki.wVk = VK_MENU;
    up.ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(1, &up, sizeof(INPUT));
    SetForegroundWindow(target);
  }
  return GetForegroundWindow() == target;
}

HWND HandleOf(const Napi::Value& v) {
  if (!v.IsBuffer()) return nullptr;
  auto b = v.As<Napi::Buffer<uint8_t>>();
  if (b.Length() < sizeof(HWND)) return nullptr;
  HWND h = nullptr;
  memcpy(&h, b.Data(), sizeof(HWND));
  return h;
}

// The game's window back in front (the overlay menu closed).
Napi::Value FocusProcess(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) throw Napi::TypeError::New(env, "focusProcess(pid: number)");
  return Napi::Boolean::New(env, BringToFront(MainWindowOf(info[0].As<Napi::Number>().Uint32Value())));
}

// One of ours in front (the overlay menu opened): getNativeWindowHandle().
Napi::Value FocusWindow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1) throw Napi::TypeError::New(env, "focusWindow(handle: Buffer)");
  return Napi::Boolean::New(env, BringToFront(HandleOf(info[0])));
}

// The overlay rides on the game's window: every move or resize of the game
// (a WinEvent on this thread's message loop) puts the overlay on its client
// area in the same moment — no polling, no lag behind a dragged window.
HWINEVENTHOOK followHook = nullptr;
HWINEVENTHOOK foregroundHook = nullptr;
HWND followGame = nullptr;
HWND followOverlay = nullptr;
bool hiddenForOther = false; // we hid the overlay: another app came in front

void FollowNow() {
  if (!followGame || !followOverlay || !IsWindow(followGame) || !IsWindow(followOverlay) || IsIconic(followGame)) return;
  RECT r; POINT o = {0, 0};
  if (!GetClientRect(followGame, &r) || !ClientToScreen(followGame, &o) || r.right < 1 || r.bottom < 1) return;
  RECT now;
  if (GetWindowRect(followOverlay, &now) && now.left == o.x && now.top == o.y && now.right - now.left == r.right && now.bottom - now.top == r.bottom) return;
  SetWindowPos(followOverlay, nullptr, o.x, o.y, r.right, r.bottom, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
}

void CALLBACK OnGameMoved(HWINEVENTHOOK, DWORD, HWND window, LONG object, LONG child, DWORD, DWORD) {
  if (window == followGame && object == OBJID_WINDOW && child == CHILDID_SELF) FollowNow();
}

// Only over the game: the moment any other window comes to the front (another
// app, the desktop, the launcher), the overlay goes; back with the game.
void CALLBACK OnForeground(HWINEVENTHOOK, DWORD, HWND window, LONG, LONG, DWORD, DWORD) {
  if (!followOverlay || !IsWindow(followOverlay) || window == followOverlay) return;
  if (window == followGame) {
    if (hiddenForOther) {
      hiddenForOther = false;
      FollowNow();
      ShowWindow(followOverlay, SW_SHOWNOACTIVATE);
    }
    return;
  }
  if (IsWindowVisible(followOverlay)) {
    ShowWindow(followOverlay, SW_HIDE);
    hiddenForOther = true;
  }
}

void StopFollowing() {
  if (followHook) UnhookWinEvent(followHook);
  if (foregroundHook) UnhookWinEvent(foregroundHook);
  followHook = foregroundHook = nullptr;
  followGame = followOverlay = nullptr;
  hiddenForOther = false;
}

Napi::Value FollowWindow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[1].IsNumber()) {
    StopFollowing();
    return Napi::Boolean::New(env, false);
  }
  HWND overlay = HandleOf(info[0]);
  DWORD pid = info[1].As<Napi::Number>().Uint32Value();
  HWND game = MainWindowOf(pid);
  if (!overlay || !game) {
    StopFollowing();
    return Napi::Boolean::New(env, false);
  }
  if (followHook && followGame == game && followOverlay == overlay) {
    FollowNow();
    return Napi::Boolean::New(env, true);
  }
  StopFollowing();
  followHook = SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, nullptr, OnGameMoved, pid, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  if (!followHook) return Napi::Boolean::New(env, false);
  foregroundHook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr, OnForeground, 0, 0, WINEVENT_OUTOFCONTEXT);
  followGame = game;
  followOverlay = overlay;
  FollowNow();
  return Napi::Boolean::New(env, true);
}

Napi::Value ModuleInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object o = Napi::Object::New(env);
  o.Set("version", "1.2.0");
  o.Set("napi", NAPI_VERSION);
#ifdef _MSC_FULL_VER
  o.Set("compiler", std::string("MSVC ") + std::to_string(_MSC_FULL_VER));
#endif
  o.Set("built", __DATE__ " " __TIME__);
  return o;
}

}  // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("systemInfo", Napi::Function::New(env, SystemInfo));
  exports.Set("processStats", Napi::Function::New(env, ProcessStats));
  exports.Set("setPriority", Napi::Function::New(env, SetPriority));
  exports.Set("fileVersion", Napi::Function::New(env, FileVersion));
  exports.Set("javaRegistryHomes", Napi::Function::New(env, JavaRegistryHomes));
  exports.Set("verifyFiles", Napi::Function::New(env, VerifyFiles));
  exports.Set("sha1File", Napi::Function::New(env, Sha1File));
  exports.Set("keysDown", Napi::Function::New(env, KeysDown));
  exports.Set("foregroundWindow", Napi::Function::New(env, ForegroundWindow));
  exports.Set("focusProcess", Napi::Function::New(env, FocusProcess));
  exports.Set("focusWindow", Napi::Function::New(env, FocusWindow));
  exports.Set("followWindow", Napi::Function::New(env, FollowWindow));
  exports.Set("moduleInfo", Napi::Function::New(env, ModuleInfo));
  return exports;
}

NODE_API_MODULE(mcnative, Init)
