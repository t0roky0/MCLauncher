// mcl-crashlog-test <file>: an access violation (caught here) goes into the log with its place and calls.
#include "../src/crashlog.h"
#include <cstdio>
#include <fstream>
#include <sstream>

__declspec(noinline) void crash() { *static_cast<volatile int*>(nullptr) = 1; }
// __try lives apart from anything with a destructor
__declspec(noinline) void caught() { __try { crash(); } __except (EXCEPTION_EXECUTE_HANDLER) {} }

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 100;
  DeleteFileW(argv[1]);
  crashlog::init(argv[1]);
  caught();
  std::ifstream in(argv[1]);
  std::stringstream s;
  s << in.rdbuf();
  const std::string log = s.str();
  bool ok = log.find("exception 0xc0000005 at mcl-crashlog-test.exe+0x") != std::string::npos && log.find("(writing 0x0)") != std::string::npos &&
            log.find("    mcl-crashlog-test.exe+0x") != std::string::npos;
  std::printf("%s\n%s", ok ? "OK" : "FAIL", log.c_str());
  return ok ? 0 : 1;
}
