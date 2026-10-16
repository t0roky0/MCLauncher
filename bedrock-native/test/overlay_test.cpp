// Development only: the overlay's file redirection, outside the game
// (scripts/tests/bedrock-overlay.test.cjs runs it). A fake game folder with
// a vanilla pack, a launcher list, then the game's ways of opening files.
//   mcl-overlay-test <scratch dir> armed|late|nolist
// Prints one line per check ("ok …" / "FAIL …"); exit code = failures.
#include <windows.h>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include "../src/overlay.h"

namespace fs = std::filesystem;
int failures = 0;

void check(bool ok, const char* what) {
  printf("%s %s\n", ok ? "ok" : "FAIL", what);
  if (!ok) failures++;
}

void put(const fs::path& p, const std::string& text) {
  fs::create_directories(p.parent_path());
  std::ofstream(p, std::ios::binary) << text;
}

// what the game would get: read through CreateFileW (→ NtCreateFile)
std::string read(const fs::path& p) {
  HANDLE f = CreateFileW(p.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return "<none>";
  char buf[256]{};
  DWORD n = 0;
  ReadFile(f, buf, sizeof buf - 1, &n, nullptr);
  CloseHandle(f);
  return std::string(buf, n);
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 3) return 100;
  fs::path dir = argv[1];
  std::wstring mode = argv[2];
  fs::remove_all(dir);
  fs::path packs = dir / L"Game Content" / L"data" / L"resource_packs";
  fs::path vanilla = packs / L"vanilla";
  put(vanilla / L"contents.json", "game list");
  put(vanilla / L"manifest.json", "game manifest");
  put(vanilla / L"__brarchive" / L"entity.brarchive", "game entity");
  put(vanilla / L"__brarchive" / L"models" / L"entity.brarchive", "game models");
  put(vanilla / L"__brarchive" / L"other.brarchive", "game other");
  fs::path ours = dir / L"Лаунчер" / L"set";  // the user's folder may well be in Cyrillic
  put(ours / L"contents.json", "our list");
  put(ours / L"manifest.json", "our manifest");
  put(ours / L"entity.brarchive", "our entity");
  put(ours / L"models.brarchive", "our models");
  put(ours / L"mcl.brarchive", "our textures");
  // a resource pack of the player's own, outside the game's folder, with its own player
  fs::path pack = dir / L"com.mojang" / L"resource_packs" / L"Actions" / L"subpacks" / L"SP0" / L"__brarchive" / L"entity.brarchive";
  put(pack, "pack entity");
  put(ours / L"pack-entity.brarchive", "our pack entity");
  std::string list = "# test\r\n";
  auto line = [&](const char* rel, const fs::path& file) { list += std::string(rel) + "\t" + file.u8string() + "\r\n"; };
  if (mode != L"nolist") line("vanilla\\contents.json", ours / L"contents.json");
  line("vanilla\\manifest.json", ours / L"manifest.json");
  line("vanilla\\__brarchive\\entity.brarchive", ours / L"entity.brarchive");
  line("vanilla/__brarchive/models/entity.brarchive", ours / L"models.brarchive");
  line("vanilla\\__brarchive\\textures\\mcl.brarchive", ours / L"mcl.brarchive");
  line("vanilla\\__brarchive\\gone.brarchive", ours / L"gone.brarchive");  // not there: left out
  list += pack.u8string() + "\t" + (ours / L"pack-entity.brarchive").u8string() + "\r\n";
  put(dir / L"overlay.txt", list);

  check(overlay::init(packs.wstring() + L"\\", (dir / L"overlay.txt").wstring()), "hooks installed");
  check(read(vanilla / L"__brarchive" / L"other.brarchive") == "game other", "a file not on the list: the game's");

  if (mode == L"armed") {
    check(overlay::telemetry().find("\"state\":\"waiting\"") != std::string::npos, "waiting before the list is read");
    // the game reads a pack's manifest first: ours, and still in time
    check(read(vanilla / L"manifest.json") == "our manifest", "the manifest before the list: ours");
    check(overlay::telemetry().find("\"state\":\"waiting\"") != std::string::npos, "the manifest first: still waiting (not late)");
    check(read(vanilla / L"contents.json") == "our list", "the list: ours (armed)");
    check(read(vanilla / L"__brarchive" / L"entity.brarchive") == "our entity", "entity: ours");
    check(read(packs / L"VANILLA" / L"__brarchive" / L"Models" / L"entity.brarchive") == "our models", "other case: ours");
    std::wstring slashes = packs.wstring() + L"/vanilla/__brarchive/models/entity.brarchive";
    check(read(slashes) == "our models", "forward slashes: ours");
    fs::path virt = vanilla / L"__brarchive" / L"textures" / L"mcl.brarchive";
    check(GetFileAttributesW(virt.c_str()) != INVALID_FILE_ATTRIBUTES, "our new archive exists for the game");
    WIN32_FILE_ATTRIBUTE_DATA a{};
    check(GetFileAttributesExW(virt.c_str(), GetFileExInfoStandard, &a) && a.nFileSizeLow == 12, "its size (full attributes)");
    check(read(virt) == "our textures", "our new archive: ours");
    check(read(vanilla / L"__brarchive" / L"gone.brarchive") == "<none>", "a listed file that isn't there: not found, as before");
    check(read(pack) == "our pack entity", "a player's pack outside the game: ours");
    std::wstring upper = pack.wstring();
    CharUpperBuffW(upper.data(), static_cast<DWORD>(upper.size()));
    check(read(upper) == "our pack entity", "a player's pack, other case: ours");
    // the launcher deletes a file after the list was read: the game's own
    fs::remove(ours / L"entity.brarchive");
    check(read(vanilla / L"__brarchive" / L"entity.brarchive") == "game entity", "our file gone: the game's");
    // a new list from the launcher
    Sleep(20);
    put(ours / L"entity2.brarchive", "our entity 2");
    std::string list2 = list;
    list2.replace(list2.find("entity.brarchive\r"), 16, "entity2.brarchive");
    put(dir / L"overlay.txt", list2);
    HANDLE f = CreateFileW((dir / L"overlay.txt").c_str(), FILE_WRITE_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    FILETIME later;
    GetSystemTimeAsFileTime(&later);
    SetFileTime(f, nullptr, nullptr, &later);
    CloseHandle(f);
    overlay::refresh();
    check(read(vanilla / L"__brarchive" / L"entity.brarchive") == "our entity 2", "a new list: picked up");
    auto t = overlay::telemetry();
    printf("%s\n", t.c_str());
    check(t.find("\"state\":\"armed\"") != std::string::npos, "telemetry: armed");
  } else if (mode == L"late") {
    // the game on its archives before we saw it read the list
    check(read(vanilla / L"__brarchive" / L"entity.brarchive") == "game entity", "late: the game's entity");
    check(read(pack) == "pack entity", "late: the player's pack as it is");
    check(read(vanilla / L"contents.json") == "game list", "late: the game's list");
    check(read(vanilla / L"manifest.json") == "game manifest", "late: the game's manifest");
    check(GetFileAttributesW((vanilla / L"__brarchive" / L"textures" / L"mcl.brarchive").c_str()) == INVALID_FILE_ATTRIBUTES, "late: no new archive");
    check(overlay::telemetry().find("\"state\":\"late\"") != std::string::npos, "telemetry: late");
  } else if (mode == L"nolist") {
    // the launcher gave no list for the game's own: nothing at all
    check(read(vanilla / L"contents.json") == "game list", "no list: the game's");
    check(read(vanilla / L"__brarchive" / L"entity.brarchive") == "game entity", "no list: the game's entity");
    check(overlay::telemetry().find("\"state\":\"late\"") != std::string::npos, "telemetry: late");
  }
  overlay::refresh();
  std::ifstream log(dir / L"overlay.log");
  std::string first;
  std::getline(log, first);
  check(!first.empty(), "overlay.log written");
  overlay::close();
  return failures;
}
