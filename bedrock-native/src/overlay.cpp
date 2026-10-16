// The launcher's cosmetics as part of the game's own vanilla resources: when
// the game opens one of the files on the launcher's list (overlay.txt, from
// src/main/bedrock-cosmetics.js), it opens our copy instead — at the lowest
// file calls (ntdll), so whichever way the game asks.
//
// The game reads its list of vanilla files (vanilla\contents.json) once, at
// its start, and never looks for a file that isn't on it. So all or nothing:
// once we've handed it our list, it gets all our files for the rest of the
// session ("armed"); a game that read its own list before we got in gets
// nothing from us (its files and ours wouldn't match — "late").
#include "overlay.h"
#include <winternl.h>
#include <atomic>
#include <fstream>
#include <sstream>
#include <unordered_map>
#include <vector>
#include "MinHook.h"

namespace overlay {
namespace {
using CreateFn = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using OpenFn = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, ULONG, ULONG);
using AttributesFn = NTSTATUS(NTAPI*)(POBJECT_ATTRIBUTES, PVOID);

CreateFn realCreate = nullptr;
OpenFn realOpen = nullptr;
AttributesFn realAttributes = nullptr, realFullAttributes = nullptr;
std::vector<void*> targets;

const wchar_t kList[] = L"vanilla\\contents.json";
enum State { Waiting = 0, Armed = 1, Late = -1 };

std::vector<std::wstring> roots;  // the game's data\resource_packs\ (no \??\): as given, and where it really is
std::string hookError;            // why the file calls aren't ours, if they aren't
std::wstring listFile;  // the launcher's overlay.txt
FILETIME listTime{};
SRWLOCK lock = SRWLOCK_INIT;
std::unordered_map<std::wstring, std::wstring> files;  // path under root, lower case → \??\ our file
std::vector<std::wstring> journal;                     // what was handed over (for overlay.log)
std::atomic<int> state{Waiting};
std::atomic<unsigned> served{0}, fallbacks{0};
bool ready = false;

bool notFound(NTSTATUS s) { return s == static_cast<NTSTATUS>(0xC0000034) || s == static_cast<NTSTATUS>(0xC000003A); }

void note(const std::wstring& line) {
  AcquireSRWLockExclusive(&lock);
  if (journal.size() < 400) journal.push_back(line);
  ReleaseSRWLockExclusive(&lock);
}

bool endsWith(const wchar_t* p, size_t n, const wchar_t* tail) {
  const size_t t = wcslen(tail);
  return n >= t && CompareStringOrdinal(p + n - t, static_cast<int>(t), tail, static_cast<int>(t), TRUE) == CSTR_EQUAL;
}

// a handle's folder as a plain path (C:\…), "" if it can't be told
std::wstring folderOf(HANDLE h) {
  wchar_t s[2048];
  DWORD n = GetFinalPathNameByHandleW(h, s, 2048, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!n || n >= 2048) return {};
  std::wstring out(s, n);
  if (out.rfind(L"\\\\?\\", 0) == 0 && out.rfind(L"\\\\?\\UNC\\", 0) != 0) out.erase(0, 4);
  return out;
}

// the first few pack files the game asks for, as it asks (overlay.log): to
// see how it does when nothing is ours
std::atomic<int> seen{0};
void witness(POBJECT_ATTRIBUTES a, const wchar_t* p, size_t n, const std::wstring& full) {
  if (seen.load() >= 60) return;
  std::wstring raw(p, n), low = raw;
  CharLowerBuffW(low.data(), static_cast<DWORD>(low.size()));
  if (low.find(L"resource_packs") == std::wstring::npos && !endsWith(p, n, L".brarchive") && !endsWith(p, n, L"contents.json")) return;
  if (seen.fetch_add(1) >= 60) return;
  note(L"seen " + std::wstring(a->RootDirectory ? L"[in folder] " : L"") + raw + (a->RootDirectory && !full.empty() ? L" -> " + full : L""));
}

// Is this one of ours? out: the attributes to open instead. Every file the
// game opens comes through here — the common case (not under root) is a
// length check and one comparison.
bool ours(POBJECT_ATTRIBUTES attributes, OBJECT_ATTRIBUTES& copy, UNICODE_STRING& name, std::wstring& buffer) {
  if (!ready || !attributes || !attributes->ObjectName || !attributes->ObjectName->Buffer) return false;
  const wchar_t* p = attributes->ObjectName->Buffer;
  size_t n = attributes->ObjectName->Length / sizeof(wchar_t);
  std::wstring full;  // for a name relative to a folder handle: the folder + the name
  if (attributes->RootDirectory) {
    // only pack files are worth asking a handle its folder
    if (endsWith(p, n, L".brarchive") || endsWith(p, n, L".json")) {
      std::wstring folder = folderOf(attributes->RootDirectory);
      if (!folder.empty()) full = folder + L"\\" + std::wstring(p, n);
    }
  } else if (n >= 4 && p[0] == L'\\' && (p[1] == L'?' || p[1] == L'\\') && p[2] == L'?' && p[3] == L'\\') {
    full.assign(p + 4, n - 4);
  }
  witness(attributes, p, n, full);
  if (full.empty()) return false;
  const std::wstring* base = nullptr;
  for (const auto& r : roots) {
    if (full.size() > r.size() && CompareStringOrdinal(full.c_str(), static_cast<int>(r.size()), r.c_str(), static_cast<int>(r.size()), TRUE) == CSTR_EQUAL) {
      base = &r;
      break;
    }
  }
  // a pack of the player's own (outside the game's folder: a resource pack
  // that brings its own player) is listed by its whole path, "*" before it
  if (!base && !endsWith(p, n, L".brarchive") && !endsWith(p, n, L".json")) return false;
  std::wstring rel = base ? full.substr(base->size()) : L"*" + full;
  for (auto& c : rel) if (c == L'/') c = L'\\';
  CharLowerBuffW(rel.data(), static_cast<DWORD>(rel.size()));

  const bool list = rel == kList;
  // a pack's manifest comes before its list (ours adds "pbr"): no sign of
  // being late, and ours while we may still be in time
  static const wchar_t kManifest[] = L"\\manifest.json";
  const size_t m = wcslen(kManifest);
  const bool manifest = rel.size() > m && rel.compare(rel.size() - m, m, kManifest) == 0;
  std::wstring target;
  AcquireSRWLockShared(&lock);
  auto it = files.find(rel);
  if (it != files.end()) target = it->second;
  ReleaseSRWLockShared(&lock);

  int s = state.load();
  if (list) {
    // the moment that decides the session
    if (s == Waiting) {
      s = target.empty() ? Late : Armed;
      state = s;
      note(s == Armed ? L"armed" : L"late (no list from the launcher)");
    }
  } else if (s == Waiting && !target.empty() && !manifest) {
    // the game is already on its archives: it read its list before we came
    state = s = Late;
    note(L"late (the game had read its list before us)");
  }
  if (target.empty() || !(s == Armed || (s == Waiting && manifest))) return false;
  buffer = target;
  name.Buffer = buffer.data();
  name.Length = static_cast<USHORT>(buffer.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  copy = *attributes;
  copy.RootDirectory = nullptr;
  copy.ObjectName = &name;
  served++;
  note(rel);
  return true;
}

NTSTATUS NTAPI hookCreate(PHANDLE handle, ACCESS_MASK access, POBJECT_ATTRIBUTES attributes, PIO_STATUS_BLOCK io, PLARGE_INTEGER size, ULONG fileAttributes, ULONG share, ULONG disposition, ULONG options, PVOID ea, ULONG eaLength) {
  OBJECT_ATTRIBUTES copy;
  UNICODE_STRING name;
  std::wstring buffer;
  if (ours(attributes, copy, name, buffer)) {
    NTSTATUS s = realCreate(handle, access, &copy, io, size, fileAttributes, share, disposition, options, ea, eaLength);
    if (!notFound(s)) return s;
    fallbacks++;  // our file's gone: the game's own, rather than none
  }
  return realCreate(handle, access, attributes, io, size, fileAttributes, share, disposition, options, ea, eaLength);
}

NTSTATUS NTAPI hookOpen(PHANDLE handle, ACCESS_MASK access, POBJECT_ATTRIBUTES attributes, PIO_STATUS_BLOCK io, ULONG share, ULONG options) {
  OBJECT_ATTRIBUTES copy;
  UNICODE_STRING name;
  std::wstring buffer;
  if (ours(attributes, copy, name, buffer)) {
    NTSTATUS s = realOpen(handle, access, &copy, io, share, options);
    if (!notFound(s)) return s;
    fallbacks++;
  }
  return realOpen(handle, access, attributes, io, share, options);
}

NTSTATUS NTAPI hookAttributes(POBJECT_ATTRIBUTES attributes, PVOID info) {
  OBJECT_ATTRIBUTES copy;
  UNICODE_STRING name;
  std::wstring buffer;
  if (ours(attributes, copy, name, buffer)) {
    NTSTATUS s = realAttributes(&copy, info);
    if (!notFound(s)) return s;
  }
  return realAttributes(attributes, info);
}

NTSTATUS NTAPI hookFullAttributes(POBJECT_ATTRIBUTES attributes, PVOID info) {
  OBJECT_ATTRIBUTES copy;
  UNICODE_STRING name;
  std::wstring buffer;
  if (ours(attributes, copy, name, buffer)) {
    NTSTATUS s = realFullAttributes(&copy, info);
    if (!notFound(s)) return s;
  }
  return realFullAttributes(attributes, info);
}

std::wstring wide(const std::string& s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
  return w;
}

std::string utf8(const std::wstring& w) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
  return s;
}

// The launcher's list: "<path under resource_packs>\t<our file>"; files that
// aren't there are left out (the game keeps its own).
bool load() {
  WIN32_FILE_ATTRIBUTE_DATA a{};
  if (listFile.empty() || !GetFileAttributesExW(listFile.c_str(), GetFileExInfoStandard, &a)) return false;
  if (CompareFileTime(&a.ftLastWriteTime, &listTime) == 0) return true;
  std::ifstream in(listFile, std::ios::binary);
  if (!in) return false;
  std::unordered_map<std::wstring, std::wstring> next;
  std::string line;
  while (std::getline(in, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.size() >= 3 && static_cast<unsigned char>(line[0]) == 0xEF) line.erase(0, 3);
    auto tab = line.find('\t');
    if (line.empty() || line[0] == '#' || tab == std::string::npos) continue;
    std::wstring rel = wide(line.substr(0, tab)), file = wide(line.substr(tab + 1));
    for (auto& c : rel) if (c == L'/') c = L'\\';
    for (auto& c : file) if (c == L'/') c = L'\\';  // \??\ paths take no other
    CharLowerBuffW(rel.data(), static_cast<DWORD>(rel.size()));
    if (rel.empty() || rel.find(L"..") != std::wstring::npos || GetFileAttributesW(file.c_str()) == INVALID_FILE_ATTRIBUTES) continue;
    // a whole path (C:\...): a file of a pack outside the game's folder
    if (rel.size() > 3 && rel[1] == L':' && rel[2] == L'\\') rel = L"*" + rel;
    next[rel] = L"\\??\\" + file;
  }
  AcquireSRWLockExclusive(&lock);
  files.swap(next);
  ReleaseSRWLockExclusive(&lock);
  listTime = a.ftLastWriteTime;
  return true;
}

std::wstring logFile;
}  // namespace

bool init(const std::wstring& packs, const std::wstring& list) {
  std::wstring root = packs;
  for (auto& c : root) if (c == L'/') c = L'\\';  // as Windows hands paths to ntdll
  roots.push_back(root);
  // the same folder where it really is (a link or another name for the drive on the way)
  HANDLE dir = CreateFileW(root.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (dir != INVALID_HANDLE_VALUE) {
    std::wstring real = folderOf(dir) + L"\\";
    CloseHandle(dir);
    if (real.size() > 1 && CompareStringOrdinal(real.c_str(), -1, root.c_str(), -1, TRUE) != CSTR_EQUAL) roots.push_back(real);
  }
  listFile = list;
  logFile = list.empty() ? L"" : list.substr(0, list.find_last_of(L"\\/") + 1) + L"overlay.log";
  load();
  {
    std::wstring line = L"module in, pid " + std::to_wstring(GetCurrentProcessId()) + L", game files at";
    for (auto& r : roots) line += L" " + r;
    note(line);
  }
  ready = true;
  MH_STATUS st = MH_Initialize();
  if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) {
    hookError = std::string("init ") + MH_StatusToString(st);
    note(L"no hooks: MH_Initialize");
    return false;
  }
  struct Hook { const char* name; void* detour; void** real; } hooks[] = {
      {"NtCreateFile", reinterpret_cast<void*>(hookCreate), reinterpret_cast<void**>(&realCreate)},
      {"NtOpenFile", reinterpret_cast<void*>(hookOpen), reinterpret_cast<void**>(&realOpen)},
      {"NtQueryAttributesFile", reinterpret_cast<void*>(hookAttributes), reinterpret_cast<void**>(&realAttributes)},
      {"NtQueryFullAttributesFile", reinterpret_cast<void*>(hookFullAttributes), reinterpret_cast<void**>(&realFullAttributes)},
  };
  for (auto& h : hooks) {
    void* target = nullptr;
    st = MH_CreateHookApiEx(L"ntdll", h.name, h.detour, h.real, &target);
    if (st != MH_OK) {
      hookError = std::string(h.name) + " " + MH_StatusToString(st);
      note(L"no hooks: " + wide(hookError));
      return false;
    }
    targets.push_back(target);
  }
  // each by itself: MH_ALL_HOOKS would also switch on the fullbright hook
  for (void* t : targets) {
    st = MH_EnableHook(t);
    if (st != MH_OK) {
      hookError = std::string("enable ") + MH_StatusToString(st);
      note(L"no hooks: " + wide(hookError));
      return false;
    }
  }
  note(L"hooks on");
  return true;
}

void refresh() {
  load();
  std::vector<std::wstring> lines;
  AcquireSRWLockExclusive(&lock);
  lines.swap(journal);
  ReleaseSRWLockExclusive(&lock);
  if (lines.empty() || logFile.empty()) return;
  std::ofstream out(logFile, std::ios::binary | std::ios::app);
  SYSTEMTIME t;
  GetLocalTime(&t);
  char stamp[32];
  snprintf(stamp, sizeof stamp, "%02d:%02d:%02d.%03d ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
  for (auto& l : lines) out << stamp << GetCurrentProcessId() << ' ' << utf8(l) << "\r\n";
}

std::string telemetry() {
  size_t count;
  AcquireSRWLockShared(&lock);
  count = files.size();
  ReleaseSRWLockShared(&lock);
  const int s = state.load();
  std::ostringstream o;
  o << "\"overlay\":{\"state\":\"" << (s == Armed ? "armed" : s == Late ? "late" : "waiting") << "\",\"files\":" << count << ",\"served\":" << served.load() << ",\"fallbacks\":" << fallbacks.load() << ",\"hooks\":\"" << (hookError.empty() ? (targets.size() == 4 ? "on" : "off") : hookError.c_str()) << "\"}";
  return o.str();
}

void close() {
  for (void* t : targets) MH_DisableHook(t);
}
}  // namespace overlay
