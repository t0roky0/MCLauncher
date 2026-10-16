#include <windows.h>
#include <tlhelp32.h>
#include <filesystem>
#include <set>
#include <vector>
#include <iostream>
#include <string>
#include <cwchar>
namespace fs=std::filesystem;
struct Handle{HANDLE h;~Handle(){if(h&&h!=INVALID_HANDLE_VALUE)CloseHandle(h);}operator HANDLE()const{return h;}};
std::string utf8(const std::wstring& s){int n=WideCharToMultiByte(CP_UTF8,0,s.data(),static_cast<int>(s.size()),nullptr,0,nullptr,nullptr);std::string r(n,0);WideCharToMultiByte(CP_UTF8,0,s.data(),static_cast<int>(s.size()),r.data(),n,nullptr,nullptr);return r;}
std::string json(const std::wstring& s){std::string r="\"";for(char c:utf8(s)){if(c=='\\'||c=='"')r+='\\';if(static_cast<unsigned char>(c)>=32)r+=c;}return r+'"';}
std::wstring image(HANDLE p){wchar_t s[32768]{};DWORD n=32768;return QueryFullProcessImageNameW(p,0,s,&n)?std::wstring(s,n):L"";}
uintptr_t module(DWORD pid,const std::wstring& name,bool full=false){
 Handle snap{CreateToolhelp32Snapshot(TH32CS_SNAPMODULE|TH32CS_SNAPMODULE32,pid)};MODULEENTRY32W m{};m.dwSize=sizeof(m);
 if(Module32FirstW(snap,&m))do{if(!_wcsicmp(full?m.szExePath:m.szModule,name.c_str()))return reinterpret_cast<uintptr_t>(m.modBaseAddr);}while(Module32NextW(snap,&m));return 0;
}
int fail(const char* reason){std::cerr<<reason<<" ("<<GetLastError()<<")\n";return 1;}
std::string why(const char* reason){return std::string(reason)+" ("+std::to_string(GetLastError())+")";}
// The module into the game: "" when it's in (already: it was), else why not.
std::string inject(DWORD pid,const fs::path& dll,bool& already){
 already=false;
 Handle process{OpenProcess(PROCESS_QUERY_INFORMATION|PROCESS_CREATE_THREAD|PROCESS_VM_OPERATION|PROCESS_VM_WRITE|PROCESS_VM_READ,FALSE,pid)};
 if(!process)return why("open_process");if(_wcsicmp(fs::path(image(process)).filename().c_str(),L"Minecraft.Windows.exe"))return why("wrong_process");
 USHORT proc=0,native=0;if(!IsWow64Process2(process,&proc,&native)||proc!=IMAGE_FILE_MACHINE_UNKNOWN||native!=IMAGE_FILE_MACHINE_AMD64)return why("not_x64");
 if(module(pid,dll.wstring(),true)){already=true;return "";}
 if(module(pid,L"mcl-bedrock.dll"))return why("restart_game_for_module_update");
 auto load=GetProcAddress(GetModuleHandleW(L"kernel32.dll"),"LoadLibraryW");HMODULE owner=nullptr;
 if(!load||!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,reinterpret_cast<LPCWSTR>(load),&owner))return why("load_library");
 // a game that has only just started: its module list isn't readable for a moment
 wchar_t ownerPath[32768]{};GetModuleFileNameW(owner,ownerPath,32768);uintptr_t remote=0;
 for(int tries=0;tries<300&&!(remote=module(pid,fs::path(ownerPath).filename().wstring()));tries++)Sleep(10);
 if(!remote)return why("remote_system_module");
 auto entry=remote+(reinterpret_cast<uintptr_t>(load)-reinterpret_cast<uintptr_t>(owner));
 auto path=dll.wstring();SIZE_T bytes=(path.size()+1)*sizeof(wchar_t),written=0;void* mem=VirtualAllocEx(process,nullptr,bytes,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);if(!mem)return why("allocate");
 if(!WriteProcessMemory(process,mem,path.c_str(),bytes,&written)||written!=bytes){VirtualFreeEx(process,mem,0,MEM_RELEASE);return why("write_path");}
 Handle thread{CreateRemoteThread(process,nullptr,0,reinterpret_cast<LPTHREAD_START_ROUTINE>(entry),mem,0,nullptr)};
 if(!thread){VirtualFreeEx(process,mem,0,MEM_RELEASE);return why("load_thread");}
 if(WaitForSingleObject(thread,15000)!=WAIT_OBJECT_0)return why("load_timeout");
 VirtualFreeEx(process,mem,0,MEM_RELEASE);
 if(!module(pid,dll.wstring(),true))return why("module_not_loaded");
 return "";
}
// the games running now: their pids, and how long ago each started (ms)
std::vector<std::pair<DWORD,ULONGLONG>> games(){
 std::vector<std::pair<DWORD,ULONGLONG>> out;FILETIME now{};GetSystemTimeAsFileTime(&now);
 auto ticks=[](const FILETIME& f){return (static_cast<ULONGLONG>(f.dwHighDateTime)<<32)|f.dwLowDateTime;};
 Handle snap{CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0)};PROCESSENTRY32W p{};p.dwSize=sizeof(p);
 if(Process32FirstW(snap,&p))do{
  if(_wcsicmp(p.szExeFile,L"Minecraft.Windows.exe"))continue;
  ULONGLONG age=~0ull;Handle h{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,p.th32ProcessID)};FILETIME c{},e{},k{},u{};
  if(h&&GetProcessTimes(h,&c,&e,&k,&u)&&ticks(now)>=ticks(c))age=(ticks(now)-ticks(c))/10000;
  out.push_back({p.th32ProcessID,age});
 }while(Process32NextW(snap,&p));
 return out;
}
int wmain(int argc,wchar_t** argv){
 if(argc==2&&!wcscmp(argv[1],L"--probe")){
  Handle snap{CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0)};PROCESSENTRY32W p{};p.dwSize=sizeof(p);bool first=true;std::cout<<'[';
  if(Process32FirstW(snap,&p))do{if(_wcsicmp(p.szExeFile,L"Minecraft.Windows.exe"))continue;Handle h{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,p.th32ProcessID)};auto file=image(h);if(!first)std::cout<<',';first=false;std::cout<<"{\"pid\":"<<p.th32ProcessID<<",\"path\":"<<json(file)<<'}';}while(Process32NextW(snap,&p));
  std::cout<<"]\n";return 0;
 }
 // The game is being started: waits for it (up to ms) and puts the module in
 // the moment it's there, before it reads its vanilla files (the cosmetics) —
 // however long the Xbox app takes to start it. One line of JSON:
 // {"pid":N,"path":"…","result":"loaded"|"already_loaded"}, {"pid":N,"path":"…","error":"…"},
 // or {"pid":0,"error":"timeout"} when none came (or the launcher, pid, is gone).
 if(argc>=3&&!wcscmp(argv[1],L"--watch")){
  fs::path dll(argv[2]);if(!dll.is_absolute()||dll.filename()!=L"mcl-bedrock.dll"||!fs::is_regular_file(dll))return fail("invalid_module");
  unsigned long limit=argc>3?wcstoul(argv[3],nullptr,10):300000;
  // the launcher's pid: gone, and so are we
  Handle parent{argc>4?OpenProcess(SYNCHRONIZE,FALSE,wcstoul(argv[4],nullptr,10)):nullptr};
  // a game that was already running (not one that has only just started) isn't the one
  std::set<DWORD> old;for(auto& g:games())if(g.second>10000)old.insert(g.first);
  for(ULONGLONG t0=GetTickCount64();GetTickCount64()-t0<limit;){
   for(auto& g:games()){
    if(old.count(g.first))continue;
    bool already=false;auto error=inject(g.first,dll,already);
    std::wstring file;{Handle h{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,g.first)};if(h)file=image(h);}
    std::cout<<"{\"pid\":"<<g.first<<",\"path\":"<<json(file);
    if(error.empty())std::cout<<",\"result\":\""<<(already?"already_loaded":"loaded")<<"\"}\n";
    else std::cout<<",\"error\":"<<json(std::wstring(error.begin(),error.end()))<<"}\n";
    return 0;
   }
   if(parent&&WaitForSingleObject(parent,0)==WAIT_OBJECT_0)break;
   // often while it's likely to come, then now and then
   Sleep(GetTickCount64()-t0<60000?15:100);
  }
  std::cout<<"{\"pid\":0,\"error\":\"timeout\"}\n";return 0;
 }
 if(argc!=3)return fail("usage: loader PID absolute-DLL-path | --probe | --watch absolute-DLL-path [ms [launcher-pid]]");
 wchar_t* end=nullptr;unsigned long pid=wcstoul(argv[1],&end,10);if(!pid||!end||*end)return fail("invalid_pid");
 fs::path dll(argv[2]);if(!dll.is_absolute()||dll.filename()!=L"mcl-bedrock.dll"||!fs::is_regular_file(dll))return fail("invalid_module");
 bool already=false;auto error=inject(pid,dll,already);
 if(!error.empty()){std::cerr<<error<<"\n";return 1;}
 std::cout<<(already?"already_loaded\n":"loaded\n");return 0;
}
