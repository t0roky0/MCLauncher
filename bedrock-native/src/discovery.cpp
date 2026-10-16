// See discovery.h. Read-only: every read goes through ReadProcessMemory on
// our own process, so a wrong guess can't fault the game.
#include "discovery.h"
#include <windows.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <map>
#include <set>
#include <sstream>
#include <vector>

namespace discovery {
namespace {
uintptr_t base = 0, end = 0;

template <class T> bool read(uintptr_t at, T& v) {
  SIZE_T got = 0;
  if (at < 0x10000 || at > 0x00007fffffffffffULL - sizeof(T)) return false;
  return ReadProcessMemory(GetCurrentProcess(), reinterpret_cast<void*>(at), &v, sizeof(T), &got) && got == sizeof(T);
}
uintptr_t ptr(uintptr_t at) { uintptr_t v = 0; read(at, v); return v; }

std::string esc(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += static_cast<char>(c); }
    else if (c < 32 || c > 126) { char b[8]; sprintf_s(b, "\\u%04x", c); o += b; }
    else o += static_cast<char>(c);
  }
  return o + "\"";
}

struct Section { uintptr_t start; size_t size; bool exec; };
std::vector<Section> sections() {
  std::vector<Section> out;
  auto dos = reinterpret_cast<IMAGE_DOS_HEADER*>(base);
  auto nt = reinterpret_cast<IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
  auto s = IMAGE_FIRST_SECTION(nt);
  for (unsigned n = 0; n < nt->FileHeader.NumberOfSections; n++) {
    if (!(s[n].Characteristics & IMAGE_SCN_MEM_READ)) continue;
    out.push_back({base + s[n].VirtualAddress, s[n].Misc.VirtualSize, (s[n].Characteristics & IMAGE_SCN_MEM_EXECUTE) != 0});
  }
  return out;
}

// Walks a section in chunks (with an overlap for patterns across the seam).
template <class F> void chunks(const Section& sec, size_t overlap, F each) {
  const size_t step = 4 << 20;
  std::vector<unsigned char> buf(step + overlap);
  for (size_t off = 0; off < sec.size; off += step) {
    size_t want = std::min(step + overlap, sec.size - off);
    SIZE_T got = 0;
    if (!ReadProcessMemory(GetCurrentProcess(), reinterpret_cast<void*>(sec.start + off), buf.data(), want, &got) || got < 8) continue;
    each(sec.start + off, buf.data(), static_cast<size_t>(got));
  }
}

// ".?AVLevel@@" → "Level"; ".?AVFoo@bar@@" → "bar::Foo"
std::string pretty(const std::string& raw) {
  std::string s = raw;
  if (s.rfind(".?AV", 0) == 0 || s.rfind(".?AU", 0) == 0) s = s.substr(4);
  if (s.size() >= 2 && s.compare(s.size() - 2, 2, "@@") == 0) s.resize(s.size() - 2);
  std::vector<std::string> parts;
  std::stringstream ss(s);
  std::string p;
  while (std::getline(ss, p, '@')) if (!p.empty()) parts.push_back(p);
  std::string out;
  for (auto it = parts.rbegin(); it != parts.rend(); ++it) out += (out.empty() ? "" : "::") + *it;
  return out;
}

// The class of an object: its vtable's slot −1 holds the locator; the
// locator (signature 1, pSelf = its own RVA) names the type descriptor.
std::string classOf(uintptr_t obj) {
  uintptr_t vt = ptr(obj);
  if (vt < base || vt >= end) return {};
  uintptr_t col = ptr(vt - 8);
  if (col < base || col >= end) return {};
  struct { uint32_t sig, offset, cd; int32_t td, cls, self; } c{};
  if (!read(col, c) || c.sig != 1 || static_cast<uintptr_t>(c.self) != col - base) return {};
  char name[160]{};
  SIZE_T got = 0;
  if (!ReadProcessMemory(GetCurrentProcess(), reinterpret_cast<void*>(base + c.td + 16), name, sizeof(name) - 1, &got)) return {};
  return pretty(name);
}

// An MSVC std::string at `at` (SSO up to 15 bytes, else a heap pointer).
bool stringAt(uintptr_t at, std::string& out) {
  struct { char bytes[16]; size_t len, cap; } s{};
  if (!read(at, s) || s.len == 0 || s.len > 64 || s.cap < s.len || s.cap > 4096) return false;
  uintptr_t data = at;
  if (s.cap >= 16) memcpy(&data, s.bytes, sizeof(data));
  out.assign(s.len, '\0');
  SIZE_T got = 0;
  return ReadProcessMemory(GetCurrentProcess(), reinterpret_cast<void*>(data), out.data(), s.len, &got) && got == s.len;
}

const char* WANTED[] = {"ClientInstance", "MinecraftGame", "LocalPlayer", "Player", "Mob", "Actor", "MultiPlayerLevel", "Level", "Dimension",
                        "GameMode", "ActorRenderDispatcher", "LevelRenderer", "LevelRendererPlayer", "MobRenderer", "PlayerRenderer",
                        "ActorRenderer", "HumanoidMobRenderer", "BaseActorRenderer", "ActorEventPacket", "ClientNetworkHandler", "SerializedSkin"};
}  // namespace

std::string classes(uintptr_t imageBegin, uintptr_t imageEnd) {
  base = imageBegin;
  end = imageEnd;
  auto secs = sections();
  // every type descriptor name in the image; the wanted ones by address
  size_t names = 0, renderers = 0;
  std::map<std::string, uintptr_t> wanted;  // pretty name → type descriptor
  std::vector<std::string> renderNames;
  for (auto& sec : secs) {
    if (sec.exec) continue;
    chunks(sec, 256, [&](uintptr_t at, const unsigned char* b, size_t n) {
      for (size_t i = 0; i + 8 < n && i < (4u << 20); i++) {
        if (b[i] != '.' || b[i + 1] != '?' || b[i + 2] != 'A' || (b[i + 3] != 'V' && b[i + 3] != 'U')) continue;
        size_t e = i;
        while (e < n && e - i < 200 && b[e]) e++;
        if (e >= n || e - i < 6) continue;
        std::string raw(reinterpret_cast<const char*>(b + i), e - i);
        if (raw.size() < 2 || raw.compare(raw.size() - 2, 2, "@@") != 0) continue;
        names++;
        auto p = pretty(raw);
        for (auto w : WANTED) if (p == w) wanted[p] = at + i - 16;
        if (p.find("Renderer") != std::string::npos && p.find("::") == std::string::npos) { renderers++; if (renderNames.size() < 60) renderNames.push_back(p); }
        i = e;
      }
    });
  }
  // their locators (offset 0 — the primary vtable) and vtables
  std::map<uintptr_t, std::string> byTd;
  for (auto& [n, td] : wanted) byTd[td - base] = n;
  std::map<std::string, std::vector<uintptr_t>> cols;
  for (auto& sec : secs) {
    if (sec.exec) continue;
    chunks(sec, 32, [&](uintptr_t at, const unsigned char* b, size_t n) {
      for (size_t i = 0; i + 24 <= n && i < (4u << 20); i += 4) {
        uint32_t sig, off; int32_t td, self;
        memcpy(&sig, b + i, 4);
        if (sig != 1) continue;
        memcpy(&off, b + i + 4, 4);
        memcpy(&td, b + i + 12, 4);
        memcpy(&self, b + i + 20, 4);
        if (off != 0 || static_cast<uintptr_t>(self) != at + i - base) continue;
        auto it = byTd.find(static_cast<uintptr_t>(td));
        if (it != byTd.end()) cols[it->second].push_back(at + i);
      }
    });
  }
  std::map<uintptr_t, std::string> byCol;
  for (auto& [n, list] : cols) for (auto c : list) byCol[c] = n;
  std::map<std::string, std::vector<uintptr_t>> vtables;
  for (auto& sec : secs) {
    if (sec.exec) continue;
    chunks(sec, 16, [&](uintptr_t at, const unsigned char* b, size_t n) {
      for (size_t i = 0; i + 8 <= n && i < (4u << 20); i += 8) {
        uintptr_t v;
        memcpy(&v, b + i, 8);
        auto it = byCol.find(v);
        if (it != byCol.end()) vtables[it->second].push_back(at + i + 8);
      }
    });
  }
  std::ostringstream o;
  o << "\"rtti\":{\"names\":" << names << ",\"renderers\":" << renderers << ",\"classes\":{";
  bool first = true;
  for (auto w : WANTED) {
    auto it = wanted.find(w);
    if (it == wanted.end()) continue;
    if (!first) o << ',';
    first = false;
    o << esc(w) << ":{\"td\":" << (it->second - base) << ",\"vtables\":[";
    auto& vts = vtables[w];
    for (size_t k = 0; k < vts.size() && k < 4; k++) {
      // how many slots: until the next pointer that isn't into code
      unsigned slots = 0;
      while (slots < 600) { uintptr_t f = ptr(vts[k] + slots * 8); if (f < base || f >= end) break; slots++; }
      o << (k ? "," : "") << "{\"rva\":" << (vts[k] - base) << ",\"slots\":" << slots << "}";
    }
    o << "]}";
  }
  o << "},\"renderNames\":[";
  for (size_t k = 0; k < renderNames.size(); k++) o << (k ? "," : "") << esc(renderNames[k]);
  o << "]}";
  return o.str();
}

std::string world(uintptr_t client, uintptr_t actor, uintptr_t level, const std::string& name, float x, float y, float z) {
  std::ostringstream o;
  o << "\"objects\":{\"client\":" << esc(classOf(client)) << ",\"actor\":" << esc(classOf(actor)) << ",\"level\":" << esc(classOf(level))
    << ",\"minecraft\":" << esc(classOf(ptr(client + 0x1b0))) << "}";
  // the name: every std::string in the actor equal to it
  o << ",\"fields\":{\"name\":[";
  bool first = true;
  for (uintptr_t off = 0; off < 0x3000; off += 8) {
    std::string s;
    if (stringAt(actor + off, s) && s == name) { o << (first ? "" : ",") << off; first = false; }
  }
  // the position: pointers from the actor to three floats where the player is
  o << "],\"position\":[";
  first = true;
  for (uintptr_t off = 0; off < 0x3000; off += 8) {
    uintptr_t p = ptr(actor + off);
    if (p < 0x10000) continue;
    for (uintptr_t k = 0; k < 0x40; k += 4) {
      float v[3]{};
      if (!read(p + k, v)) break;
      if (std::fabs(v[0] - x) < 0.01f && std::fabs(v[1] - y) < 0.01f && std::fabs(v[2] - z) < 0.01f) {
        o << (first ? "" : ",") << "[" << off << "," << k << "]";
        first = false;
        break;
      }
    }
  }
  // the dimension: pointers from the actor to an object whose class is a Dimension
  o << "],\"dimension\":[";
  first = true;
  for (uintptr_t off = 0; off < 0x3000; off += 8) {
    auto c = classOf(ptr(actor + off));
    if (c.find("Dimension") != std::string::npos) { o << (first ? "" : ",") << "[" << off << "," << esc(c) << "]"; first = false; }
  }
  // the local player from the client: pointers to an object of a Player class
  o << "],\"clientPlayer\":[";
  first = true;
  for (uintptr_t off = 0; off < 0x2000; off += 8) {
    uintptr_t p = ptr(client + off);
    if (p == actor) { o << (first ? "" : ",") << "[" << off << ",\"same\"]"; first = false; }
  }
  o << "]}";
  return o.str();
}
}  // namespace discovery
