// Independent MC Launcher telemetry adapter and optional comfort controls.
#include "comfort.h"
#include "crashlog.h"
#include "discovery.h"
#include "overlay.h"
#include <windows.h>
#include <appmodel.h>
#include <cstdint>
#include <string>
#include <vector>
#include <cmath>
#include <fstream>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <filesystem>
#include <ctime>
namespace {
HMODULE selfModule;
uintptr_t imageBegin=0,imageEnd=0;
HANDLE stopEvent=nullptr;
std::wstring baseDir,iniFile;
const char* phase="client";
std::string accessorCode;
// what the last good snapshot read (for discovery's report)
uintptr_t lastClient=0,lastActor=0,lastLevel=0;std::string lastName;float lastPos[3]{};
template<class T> bool read(uintptr_t at,T& value) {
 SIZE_T got=0;
 if(at<0x10000||at>0x00007fffffffffffULL-sizeof(T))return false;
 return ReadProcessMemory(GetCurrentProcess(),reinterpret_cast<void*>(at),&value,sizeof(T),&got)&&got==sizeof(T);
}
uintptr_t ptr(uintptr_t at){uintptr_t n=0;read(at,n);return n;}
bool executable(uintptr_t at){
 MEMORY_BASIC_INFORMATION m{};
 return at>=imageBegin&&at<imageEnd&&VirtualQuery(reinterpret_cast<void*>(at),&m,sizeof(m))&&m.State==MEM_COMMIT&&
 !(m.Protect&(PAGE_GUARD|PAGE_NOACCESS))&&(m.Protect&(PAGE_EXECUTE|PAGE_EXECUTE_READ|PAGE_EXECUTE_READWRITE|PAGE_EXECUTE_WRITECOPY));
}
std::string text(uintptr_t at){
 struct Str{char bytes[16];size_t length,capacity;}s{};
 if(!read(at,s)||s.length>128||s.capacity<s.length||s.capacity>65536)return {};
 std::string out(s.length,'\0');SIZE_T got=0;uintptr_t data=at;
 if(s.capacity>=16)memcpy(&data,s.bytes,sizeof(data));
 if(!out.empty()&&(!ReadProcessMemory(GetCurrentProcess(),reinterpret_cast<void*>(data),out.data(),out.size(),&got)||got!=out.size()))return {};
 if(out.find('\0')!=std::string::npos)return {};
 return out;
}
std::string escaped(const std::string& s){
 std::ostringstream o;o<<'"';
 for(unsigned char c:s){if(c=='"'||c=='\\')o<<'\\'<<c;else if(c<32)o<<"\\u"<<std::hex<<std::setw(4)<<std::setfill('0')<<(unsigned)c;else o<<c;}
 o<<'"';return o.str();
}
std::wstring option(const wchar_t* key){wchar_t s[256]{};GetPrivateProfileStringW(L"bridge",key,L"",s,256,iniFile.c_str());return s;}
std::string ascii(const std::wstring& s){std::string r;for(wchar_t c:s){if(c>127)return {};r+=static_cast<char>(c);}return r;}
void writeFile(const std::wstring& name,const std::string& bytes){
 auto tmp=baseDir+L"\\"+name+L".tmp",dest=baseDir+L"\\"+name;
 HANDLE f=CreateFileW(tmp.c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
 if(f==INVALID_HANDLE_VALUE)return;
 DWORD n=0;bool ok=WriteFile(f,bytes.data(),static_cast<DWORD>(bytes.size()),&n,nullptr)&&n==bytes.size();CloseHandle(f);
 if(ok)MoveFileExW(tmp.c_str(),dest.c_str(),MOVEFILE_REPLACE_EXISTING);
}
std::string packageVersion(){
 UINT32 size=0;if(GetCurrentPackageId(&size,nullptr)!=ERROR_INSUFFICIENT_BUFFER||size>65536)return {};
 std::vector<BYTE> bytes(size);if(GetCurrentPackageId(&size,bytes.data())!=ERROR_SUCCESS)return {};
 auto v=reinterpret_cast<PACKAGE_ID*>(bytes.data())->version;
 return std::to_string(v.Major)+"."+std::to_string(v.Minor)+"."+std::to_string(v.Build)+"."+std::to_string(v.Revision);
}
void output(const std::string& token,const std::string& body){
 std::string bytes="{\"protocol\":1,\"pid\":"+std::to_string(GetCurrentProcessId())+",\"token\":"+escaped(token)+","+body+"}\n";
 auto tmp=baseDir+L"\\telemetry.tmp",dest=baseDir+L"\\telemetry.json";
 HANDLE f=CreateFileW(tmp.c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
 if(f==INVALID_HANDLE_VALUE)return;
 DWORD n=0;bool ok=WriteFile(f,bytes.data(),static_cast<DWORD>(bytes.size()),&n,nullptr)&&n==bytes.size();CloseHandle(f);
 if(ok)MoveFileExW(tmp.c_str(),dest.c_str(),MOVEFILE_REPLACE_EXISTING);
}
// The 26.52 accessor resolves the game's player handle; it is not a raw pointer load.
// Keep SEH in a leaf without C++ destructors and only call a verified game address.
uintptr_t resolvedPlayer(uintptr_t client,uintptr_t fn){
 __try{return reinterpret_cast<uintptr_t(__fastcall*)(uintptr_t)>(fn)(client);}
 __except(EXCEPTION_EXECUTE_HANDLER){return 0;}
}
uintptr_t localPlayer(uintptr_t client){
 uintptr_t fn=ptr(ptr(client)+31*sizeof(uintptr_t));if(!executable(fn))return 0;
 unsigned char code[16]{};
 for(int hops=0;hops<3;hops++){
  if(!executable(fn)||!read(fn,code))return 0;
  std::ostringstream bytes;for(unsigned char c:code)bytes<<std::hex<<std::setw(2)<<std::setfill('0')<<static_cast<unsigned>(c);accessorCode=bytes.str();
  if(code[0]==0xe9){int32_t delta=0;memcpy(&delta,code+1,4);fn=fn+5+delta;continue;}
  if(code[0]==0x48&&code[1]==0x8b&&code[2]==0x81&&code[7]==0xc3){int32_t offset=0;memcpy(&offset,code+3,4);return offset>=0&&offset<0x10000?ptr(client+offset):0;}
  if(code[0]==0x48&&code[1]==0x8b&&code[2]==0x41&&code[4]==0xc3)return code[3]<0x80?ptr(client+code[3]):0;
  if(code[0]==0x48&&code[1]==0x83&&code[2]==0xec&&code[3]==0x48&&code[4]==0x48&&code[5]==0x8b&&code[6]==0x05&&code[11]==0x48&&code[12]==0x31&&code[13]==0xe0){
   auto actor=resolvedPlayer(client,fn);return executable(ptr(ptr(actor)))?actor:0;
  }
  return 0;
 }return 0;
}
bool supportedPackage(){
 UINT32 size=0;if(GetCurrentPackageId(&size,nullptr)!=ERROR_INSUFFICIENT_BUFFER||size>65536)return false;
 std::vector<BYTE> bytes(size);if(GetCurrentPackageId(&size,bytes.data())!=ERROR_SUCCESS)return false;
 auto p=reinterpret_cast<PACKAGE_ID*>(bytes.data());
 return p->name&&!wcscmp(p->name,L"Microsoft.MinecraftUWP")&&p->version.Major==1&&p->version.Minor==26&&p->version.Build==5203&&p->version.Revision==0;
}
uintptr_t platformGlobal(){
 auto dos=reinterpret_cast<IMAGE_DOS_HEADER*>(imageBegin);
 auto nt=reinterpret_cast<IMAGE_NT_HEADERS64*>(imageBegin+dos->e_lfanew);
 imageEnd=imageBegin+nt->OptionalHeader.SizeOfImage;
 auto section=IMAGE_FIRST_SECTION(nt);uintptr_t found=0;unsigned matches=0;
 for(unsigned n=0;n<nt->FileHeader.NumberOfSections;n++){
  if(!(section[n].Characteristics&IMAGE_SCN_MEM_EXECUTE))continue;
  auto start=imageBegin+section[n].VirtualAddress;size_t size=section[n].Misc.VirtualSize;
  std::vector<unsigned char> bytes(size);SIZE_T got=0;
  if(!ReadProcessMemory(GetCurrentProcess(),reinterpret_cast<void*>(start),bytes.data(),size,&got)||got!=size)continue;
  for(size_t i=0;i+10<=size;i++){
   if(bytes[i]!=0x4c||bytes[i+1]!=0x89||bytes[i+2]!=0x3d||bytes[i+7]!=0x4d||bytes[i+8]!=0x85||bytes[i+9]!=0xff)continue;
   int32_t displacement;memcpy(&displacement,bytes.data()+i+3,4);
   uintptr_t target=start+i+7+displacement;
   if(target<imageBegin||target+8>imageEnd)continue;
   found=target;matches++;
  }
 }
 return matches==1?found:0;
}
uintptr_t gammaFunction(){
 const int pattern[]={0x48,0x83,0xec,0x38,0x48,0x8b,0x05,-1,-1,-1,-1,0x48,0x31,0xe0,0x48,0x89,0x44,0x24,-1,0x48,0x8b,0x01,0x48,0x8b,0x40,0x08,0x48,0x8d,0x54,0x24,-1,0x41,0xb8,0x32,0,0,0};
 auto dos=reinterpret_cast<IMAGE_DOS_HEADER*>(imageBegin);auto nt=reinterpret_cast<IMAGE_NT_HEADERS64*>(imageBegin+dos->e_lfanew);auto sections=IMAGE_FIRST_SECTION(nt);
 uintptr_t result=0;unsigned matches=0;
 for(unsigned n=0;n<nt->FileHeader.NumberOfSections;n++){
  if(!(sections[n].Characteristics&IMAGE_SCN_MEM_EXECUTE))continue;
  auto start=imageBegin+sections[n].VirtualAddress;size_t size=sections[n].Misc.VirtualSize;std::vector<unsigned char> bytes(size);SIZE_T got=0;
  if(!ReadProcessMemory(GetCurrentProcess(),reinterpret_cast<void*>(start),bytes.data(),size,&got)||got!=size)continue;
  for(size_t i=0;i+sizeof(pattern)/sizeof(int)<=size;i++){
   bool match=true;for(size_t j=0;j<sizeof(pattern)/sizeof(int);j++)if(pattern[j]>=0&&bytes[i+j]!=pattern[j]){match=false;break;}
   if(match){result=start+i;matches++;}
  }
 }return matches==1?result:0;
}
uintptr_t clientInstance(uintptr_t global){
 auto owner=ptr(global),platform=ptr(owner+8),holder=ptr(platform+0x118),game=ptr(holder+0x48);
 if(!game)return 0;
 // MSVC release std::map: sentinel, leftmost node, uint8 key and client value.
 auto head=ptr(game+0x970),node=ptr(head);uint8_t key=255,nil=1;
 if(!node||node==head||!read(node+25,nil)||nil||!read(node+32,key)||key!=0)return 0;
 return ptr(node+48);
}
struct Vec3{float x,y,z;};
// Where the actor's fields are: known for 26.52; on other versions learned
// from what they hold (and remembered per version in learned.ini).
struct Fields{uintptr_t name=0xbc0,state=0x218,dimension=0x1c8,dimensionName=0x20;};
bool operator==(const Fields& a,const Fields& b){return a.name==b.name&&a.state==b.state&&a.dimension==b.dimension&&a.dimensionName==b.dimensionName;}
Fields fields;bool knownPackage=false,adapted=false;ULONGLONG adaptAt=0;std::wstring learnedFile;std::string version;
bool plausible(const float* v){return std::isfinite(v[0])&&std::isfinite(v[1])&&std::isfinite(v[2])&&std::abs(v[0])<=30000000&&std::abs(v[2])<=30000000&&v[1]>-200&&v[1]<2000;}
bool dimensionName(const std::string& s){return s=="Overworld"||s=="Nether"||s=="TheEnd";}
// Finds the fields by their contents: the name (an std::string equal to the
// player's), the position (ECS state vector: position, previous position,
// movement — three plausible triples that agree), the dimension (an object
// holding "Overworld", "Nether" or "TheEnd").
bool learn(uintptr_t actor,const std::string& expected,Fields& out){
 bool okName=false,okPos=false,okDim=false;
 if(!expected.empty())for(uintptr_t o=0;o<0x3000&&!okName;o+=8)if(text(actor+o)==expected){out.name=o;okName=true;}
 // the position (where the eyes are): next to it the game keeps the collision
 // box, whose corner is half the player's width (0.3) off in x and z and the
 // eye height (1–2 blocks) below — one pair of pointers in the actor fits that
 struct Triple{uintptr_t off;float v[3];};std::vector<Triple> cand;
 for(uintptr_t o=0;o<0x3000&&cand.size()<64;o+=8){
  Triple t{o,{}};auto at=ptr(actor+o);
  if(at<0x10000||!read(at,t.v)||!plausible(t.v)||std::abs(t.v[0])+std::abs(t.v[2])<0.5f)continue;
  cand.push_back(t);
 }
 for(auto& p:cand){
  for(auto& a:cand){
   if(p.off==a.off)continue;
   float dx=p.v[0]-a.v[0],dy=p.v[1]-a.v[1],dz=p.v[2]-a.v[2];
   if(std::abs(dx-0.3f)<0.02f&&std::abs(dz-0.3f)<0.02f&&dy>0.2f&&dy<2.0f){out.state=p.off;okPos=true;break;}
  }
  if(okPos)break;
 }
 for(uintptr_t o=0;o<0x3000&&!okDim;o+=8){
  auto d=ptr(actor+o);if(d<0x10000)continue;
  for(uintptr_t k=0;k<0x200;k+=8)if(dimensionName(text(d+k))){out.dimension=o;out.dimensionName=k;okDim=true;break;}
 }
 return okName&&okPos&&okDim;
}
void remember(){
 if(learnedFile.empty()||version.empty())return;
 std::wstring sec(version.begin(),version.end());
 auto put=[&](const wchar_t* k,uintptr_t v){WritePrivateProfileStringW(sec.c_str(),k,std::to_wstring(v).c_str(),learnedFile.c_str());};
 put(L"name",fields.name);put(L"state",fields.state);put(L"dimension",fields.dimension);put(L"dimensionName",fields.dimensionName);
}
bool recall(){
 if(learnedFile.empty()||version.empty())return false;
 std::wstring sec(version.begin(),version.end());
 auto get=[&](const wchar_t* k){return static_cast<uintptr_t>(GetPrivateProfileIntW(sec.c_str(),k,0,learnedFile.c_str()));};
 Fields f;f.name=get(L"name");f.state=get(L"state");f.dimension=get(L"dimension");f.dimensionName=get(L"dimensionName");
 if(!f.name||!f.state||!f.dimension)return false;
 fields=f;return true;
}
bool position(uintptr_t actor,Vec3& p){
 auto state=ptr(actor+fields.state);
 return state&&read(state,p)&&std::isfinite(p.x)&&std::isfinite(p.y)&&std::isfinite(p.z)&&std::abs(p.x)<=30000000&&std::abs(p.z)<=30000000&&std::abs(p.y)<=1000000;
}
std::vector<std::string> playerNames(uintptr_t level){
 std::vector<std::string> result;auto map=ptr(level+0x4e0),head=ptr(map+8),node=ptr(head);size_t count=0;
 if(!map||!head||!read(map+16,count)||count>1000)return result;
 for(size_t i=0;i<count&&node&&node!=head;i++){auto name=text(node+56);if(!name.empty())result.push_back(name);auto next=ptr(node);if(next==node)break;node=next;}
 return result;
}
bool snapshot(uintptr_t global,std::string& json){
 phase="client";
 auto client=clientInstance(global);if(!client)return false;
 phase="session";
 auto minecraft=ptr(client+0x1b0),session=ptr(minecraft+0xc8);uint8_t valid=0,live=0;
 if(!session||!read(session+0x28,valid)||valid!=1||!read(ptr(session+0x30),live)||live!=1)return false;
 phase="local_player";
 auto level=ptr(session+0x40),actor=localPlayer(client);if(!level||!actor)return false;
 phase="position";
 Vec3 p{};bool ok=position(actor,p);
 auto name=ok?text(actor+fields.name):std::string(),dimension=ok?text(ptr(actor+fields.dimension)+fields.dimensionName):std::string();
 if(!ok||name.empty()||!dimensionName(dimension)){
  // not where we thought (a new version): learn the fields again, at most every 10 s
  phase="adapting";
  if(GetTickCount64()-adaptAt<10000)return false;
  adaptAt=GetTickCount64();Fields f=fields;
  if(!learn(actor,ascii(option(L"player")),f))return false;
  fields=f;adapted=true;remember();
  if(!position(actor,p))return false;
  name=text(actor+fields.name);dimension=text(ptr(actor+fields.dimension)+fields.dimensionName);
  if(name.empty()||!dimensionName(dimension))return false;
 }
 phase="identity";
 auto names=playerNames(level);if(std::find(names.begin(),names.end(),name)==names.end())names.push_back(name);
 std::ostringstream o;o<<std::setprecision(9)<<"\"status\":\"world\",\"name\":"<<escaped(name)<<",\"dimension\":"<<escaped(dimension)<<",\"position\":["<<p.x<<","<<p.y<<","<<p.z<<"],\"players\":[";
 bool first=true;for(auto& n:names){if(!first)o<<',';first=false;o<<escaped(n);}o<<']';json=o.str();
 lastClient=client;lastActor=actor;lastLevel=level;lastName=name;lastPos[0]=p.x;lastPos[1]=p.y;lastPos[2]=p.z;return true;
}
DWORD WINAPI worker(void*){
 wchar_t modulePath[32768]{};GetModuleFileNameW(selfModule,modulePath,32768);
 baseDir=std::filesystem::path(modulePath).parent_path().wstring();iniFile=baseDir+L"\\bridge.ini";
 // what brings the game down, if something does: next to the launcher's own log (MCLauncher\logs)
 crashlog::init((std::filesystem::path(modulePath).parent_path().parent_path().parent_path()/L"logs"/L"bedrock-crash.log").wstring());
 // (the cosmetics are in already: armed in DllMain, see there)
 imageBegin=reinterpret_cast<uintptr_t>(GetModuleHandleW(nullptr));
 {auto dos=reinterpret_cast<IMAGE_DOS_HEADER*>(imageBegin);auto nt=reinterpret_cast<IMAGE_NT_HEADERS64*>(imageBegin+dos->e_lfanew);imageEnd=imageBegin+nt->OptionalHeader.SizeOfImage;}
 // learning the game from itself: its classes, on any version (read only)
 std::string classes;
 {ULONGLONG t0=GetTickCount64();classes=discovery::classes(imageBegin,imageEnd);
  writeFile(L"discovery.json","{\"package\":"+escaped(packageVersion())+",\"ms\":"+std::to_string(GetTickCount64()-t0)+","+classes+"}\n");}
 version=packageVersion();knownPackage=supportedPackage();
 auto global=platformGlobal();
 if(!global){output(ascii(option(L"token")),"\"status\":\"unsupported\",\"reason\":\"signature_not_unique\"");return 0;}
 auto preferences=option(L"preferences");if(preferences.empty())preferences=baseDir+L"\\comfort.ini";
 learnedFile=std::filesystem::path(preferences).parent_path().wstring()+L"\\learned.ini";
 if(!knownPackage)adapted=recall();
 // a version we don't know: reading only (no fullbright hook) until it's been seen
 comfort::init(selfModule,knownPackage?gammaFunction():0,preferences);
 ULONGLONG sampled=0;bool world=false,enabled=true,worldLearned=false;std::string token;
 while(WaitForSingleObject(stopEvent,16)==WAIT_TIMEOUT){
  if(GetTickCount64()-sampled>=250){
   sampled=GetTickCount64();overlay::refresh();auto current=ascii(option(L"token"));if(current!=token){token=current;comfort::resetCommands();}
   auto heartbeat=option(L"heartbeat");auto lease=heartbeat.empty()?0:_wcstoui64(heartbeat.c_str(),nullptr,10);
   enabled=option(L"enabled")!=L"0"&&(!lease||std::abs(static_cast<long long>(std::time(nullptr))-static_cast<long long>(lease))<=10);
   comfort::voice(option(L"micOff")==L"1",static_cast<unsigned>(_wtoi(option(L"micSequence").c_str())));
   std::string frame;world=enabled&&snapshot(global,frame);
   if(world&&!worldLearned){worldLearned=true;
    auto found=discovery::world(lastClient,lastActor,lastLevel,lastName,lastPos[0],lastPos[1],lastPos[2]);
    // the self-test: would learning from scratch land where the fields are?
    Fields f;f.name=f.state=f.dimension=f.dimensionName=0;bool learned=learn(lastActor,lastName,f);
    std::ostringstream t;t<<",\"selfTest\":{\"learned\":"<<(learned?"true":"false")<<",\"same\":"<<(learned&&f==fields?"true":"false")
     <<",\"name\":"<<f.name<<",\"state\":"<<f.state<<",\"dimension\":"<<f.dimension<<",\"dimensionName\":"<<f.dimensionName
     <<",\"player\":"<<escaped(ascii(option(L"player")));
    // what the position's struct holds, and every pointer to plausible coordinates
    {float v[16]{};read(ptr(lastActor+fields.state),v);t<<",\"stateDump\":[";for(int i=0;i<16;i++)t<<(i?",":"")<<v[i];t<<"]";
     t<<",\"posCandidates\":[";bool first=true;int n=0;
     for(uintptr_t o=0;o<0x3000&&n<40;o+=8){auto at=ptr(lastActor+o);float c[3]{};if(at<0x10000||!read(at,c)||!plausible(c)||std::abs(c[0])+std::abs(c[2])<0.5f)continue;
      t<<(first?"":",")<<"["<<o<<","<<c[0]<<","<<c[1]<<","<<c[2]<<"]";first=false;n++;}
     t<<"]}";}
    writeFile(L"discovery.json","{\"package\":"+escaped(version)+","+classes+","+found+t.str()+",\"known\":{\"name\":3008,\"position\":[536,0],\"dimension\":456},\"adapted\":"+(adapted?"true":"false")+"}\n");}
   if(!world)frame="\"status\":\"menu\",\"reason\":"+escaped(enabled?phase:"launcher_disconnected")+",\"accessor\":"+escaped(accessorCode);
   if(token.size()==64)output(token,frame+",\"adaptive\":{\"known\":"+(knownPackage?"true":"false")+",\"learned\":"+(adapted?"true":"false")+"},"+comfort::telemetry()+","+overlay::telemetry());
  }
  auto client=world?clientInstance(global):0;uint8_t grabbed=0;if(client)read(ptr(client+0x1a8)+0x1e8,grabbed);
  comfort::tick(world,grabbed==1,enabled);
 }comfort::close();return 0;
}
}
extern "C" __declspec(dllexport) DWORD WINAPI MCLauncherStop(void*){if(stopEvent)SetEvent(stopEvent);return 0;}
// The cosmetics need to be in before the game reads its vanilla files
// (overlay.cpp) — armed here, while the module loads: a thread of our own
// can't even start while the game, at its start, loads its DLLs (the graphics
// driver's: seconds of holding the loader lock), and by then it has read its
// list. Here that lock is ours already. MinHook freezes the other threads
// with a heap of its own, so nothing here waits on them.
void armOverlay(HMODULE mod){
 wchar_t modulePath[32768]{},exe[32768]{},list[4096]{};
 GetModuleFileNameW(mod,modulePath,32768);GetModuleFileNameW(nullptr,exe,32768);
 const std::wstring ini=std::filesystem::path(modulePath).parent_path().wstring()+L"\\bridge.ini";
 GetPrivateProfileStringW(L"bridge",L"overlay",L"",list,4096,ini.c_str());
 overlay::init(std::filesystem::path(exe).parent_path().wstring()+L"\\data\\resource_packs\\",list);
}
BOOL WINAPI DllMain(HINSTANCE mod,DWORD why,LPVOID){
 if(why==DLL_PROCESS_ATTACH){selfModule=mod;DisableThreadLibraryCalls(mod);armOverlay(mod);stopEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);HANDLE t=CreateThread(nullptr,0,worker,nullptr,0,nullptr);if(t)CloseHandle(t);}
 if(why==DLL_PROCESS_DETACH&&stopEvent)SetEvent(stopEvent);return TRUE;
}
