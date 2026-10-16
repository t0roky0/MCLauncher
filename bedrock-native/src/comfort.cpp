#include "comfort.h"
#include "crashlog.h"
#include "MinHook.h"
#include <d3d12.h>
#include <dxgi1_5.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <sstream>
#include <vector>
// The game's comfort settings: sprinting by itself, full brightness, a zoom
// (a key held, the wheel while it's held) and VSync. The launcher's overlay
// (F7, "Game") writes them into comfort.ini; read again every half second, so
// a change in the overlay is a change in the game at once. (The F8 panel of
// its own that was here is gone: it flickered, and the overlay has it all.)
namespace comfort {
namespace {
std::wstring prefs;HMODULE self=nullptr;
bool sprint=false,sprintHeld=false,micOff=false,gammaReady=false,gammaInstalled=false;
unsigned micSequence=0;ULONGLONG readAt=0,pressedAt=0;
std::atomic<bool> bright{false},inWorld{false};
using Gamma=float(__fastcall*)(void*,void*);
Gamma originalGamma=nullptr;uintptr_t gammaTarget=0;
// the options the game reads its gamma from: the same object gives the field of view
std::atomic<void*> lastOptions{nullptr},lastContext{nullptr};
float __fastcall gammaHook(void* options,void* context){
 lastOptions.store(options,std::memory_order_relaxed);lastContext.store(context,std::memory_order_relaxed);
 const float normal=originalGamma(options,context);return bright.load(std::memory_order_relaxed)&&inWorld.load(std::memory_order_relaxed)?16.0f:normal;
}
void control(bool down){INPUT key{};key.type=INPUT_KEYBOARD;key.ki.wVk=VK_LCONTROL;key.ki.dwFlags=down?0:KEYEVENTF_KEYUP;if(SendInput(1,&key,sizeof(key))==1)sprintHeld=down;}
bool gammaOn(){if(!gammaInstalled&&gammaReady){gammaInstalled=MH_EnableHook(reinterpret_cast<void*>(gammaTarget))==MH_OK;if(!gammaInstalled)gammaReady=false;}return gammaInstalled;}

// ---- zoom: the field of view, handed out smaller while the key is held ----
// The game reads every option through its options object's vtable[1]
// (number → option; the value at +0x18; an option may be overridden by
// another: +8 → +0x238, the last one counts). The field of view (option 47
// on 26.52) has no getter of its own like the gamma's — it's read in place —
// so that one function is hooked: asked for the field of view while zooming,
// it hands out a copy of the option holding the value divided; asked for the
// mouse's sensitivity, a copy holding it lower (OptiFine's zoom: the closer,
// the slower). The game's own options are never written (nothing to be saved
// by mistake). How close it is now is worked out as the game reads its field
// of view — every frame, by the clock — so the zoom moves as smoothly as the
// picture does (the tick here runs at 60 a second; the screen may be faster).
using GetOption=void**(__fastcall*)(void*,void**,int);
GetOption realGetOption=nullptr;uintptr_t getOptionAt=0;
std::atomic<int> fovId{-1},sensId{-1};
alignas(16) unsigned char fovCopy[0x200],sensCopy[0x200];
std::atomic<uintptr_t> fovCopyOf{0},sensCopyOf{0};
std::atomic<bool> zoomOn{false},zoomSmooth{true},zoomHeldNow{false};
int zoomKey='C';float zoomLevel=4,fovHint=0,sensHint=0;int sensGuess=0;
std::atomic<float> zoomTarget{4.0f},zoomGoal{1.0f},zoomNow{1.0f};
std::atomic<long long> zoomAt{0};long long qpf=0;
bool zoomHeld=false,fovSearched=false;std::string fovState="off",sensState="off";
template<class T> bool peek(uintptr_t at,T& v){SIZE_T got=0;return at>0x10000&&ReadProcessMemory(GetCurrentProcess(),reinterpret_cast<void*>(at),&v,sizeof v,&got)&&got==sizeof v;}
// the option that counts: the last of its overrides
uintptr_t lastOf(uintptr_t o){
 for(int hops=0;o&&hops<8;hops++){uintptr_t owner=0,next=0;if(!peek(o+8,owner)||!peek(owner+0x238,next)||!next)break;o=next;}
 return o;
}
// how close now: towards the goal by the clock (at once with the animation off)
float zoomStep(){
 LARGE_INTEGER t;QueryPerformanceCounter(&t);
 const long long last=zoomAt.exchange(t.QuadPart);
 const float goal=zoomGoal.load(std::memory_order_relaxed);float cur=zoomNow.load(std::memory_order_relaxed);
 if(!zoomSmooth.load(std::memory_order_relaxed)||!last||!qpf)cur=goal;
 else{
  const double dt=(std::min)(0.1,static_cast<double>(t.QuadPart-last)/static_cast<double>(qpf));
  cur=goal+(cur-goal)*static_cast<float>(std::exp(-dt*13.0));
  if(std::fabs(cur-goal)<0.002f)cur=goal;
 }
 zoomNow.store(cur,std::memory_order_relaxed);return cur;
}
// the mouse while zoomed: slower the closer (as the Java zoom does)
float slower(float z){return (std::max)(0.2f,(std::min)(1.0f,1.15f/std::sqrt(z)));}
void** __fastcall getOptionHook(void* options,void** out,int id){
 void** r=realGetOption(options,out,id);
 if(!out||!*out)return r;
 if(id==fovId.load(std::memory_order_relaxed)){
  const float z=zoomStep();
  const uintptr_t of=fovCopyOf.load(std::memory_order_relaxed);
  if(z>1.001f&&of&&lastOf(reinterpret_cast<uintptr_t>(*out))==of){
   float base=0;memcpy(&base,reinterpret_cast<void*>(of+0x18),sizeof base);
   const float v=base/z;memcpy(fovCopy+0x18,&v,sizeof v);*out=fovCopy;
  }
 }else if(id==sensId.load(std::memory_order_relaxed)){
  const float z=zoomNow.load(std::memory_order_relaxed);
  const uintptr_t of=sensCopyOf.load(std::memory_order_relaxed);
  if(z>1.001f&&of&&lastOf(reinterpret_cast<uintptr_t>(*out))==of){
   float base=0;memcpy(&base,reinterpret_cast<void*>(of+0x18),sizeof base);
   const float v=base*slower(z);memcpy(sensCopy+0x18,&v,sizeof v);*out=sensCopy;
  }
 }
 return r;
}
// one option by its number (a wrong guess caught, not a crash)
uintptr_t askOption(GetOption fn,void* options,int id){
 __try{void* out[4]={};fn(options,out,id);return reinterpret_cast<uintptr_t>(out[0]);}
 __except(EXCEPTION_EXECUTE_HANDLER){return 0;}
}
// The field of view among the options: a decimal option (the gamma's kind:
// the same vtable) between 30 and 110 — the one with the value options.txt
// gives it, or the only one so, or (26.52) the one three before the gamma.
// The mouse's sensitivity: the decimal option with its value from options.txt
// (ctrl_sensitivity2_mouse) — the only one, or the one at its place in the file.
void findFov(){
 void* options=lastOptions.load();
 if(fovSearched||!options)return;
 fovSearched=true;
 auto fn=reinterpret_cast<GetOption>((*reinterpret_cast<void***>(options))[1]);
 crashlog::quiet(true);
 uintptr_t decimal=0;peek(askOption(fn,options,0x32),decimal);
 std::vector<int> fit,same,touch;
 for(int id=0,misses=0;id<1000&&misses<60&&decimal;id++){
  const uintptr_t o=askOption(fn,options,id);if(!o){misses++;continue;}misses=0;
  uintptr_t vt=0;float v=0;if(!peek(o,vt)||vt!=decimal||!peek(lastOf(o)+0x18,v))continue;
  if(sensHint>0&&std::fabs(v-sensHint)<0.0005f)touch.push_back(id);
  if(v<30.0f||v>110.0f)continue;
  fit.push_back(id);if(fovHint>0&&std::fabs(v-fovHint)<0.01f)same.push_back(id);
 }
 crashlog::quiet(false);
 int id=same.size()==1?same[0]:fit.size()==1?fit[0]:-1;
 if(id<0)for(int f:fit)if(f==0x32-3)id=f;
 int sid=touch.size()==1?touch[0]:-1;
 if(sid<0)for(int t:touch)if(t==sensGuess)sid=t;
 sensState=sid<0?(touch.empty()?"not_found":"ambiguous"):"on";
 if(id<0){fovState=fit.empty()?"not_found":"ambiguous";return;}
 if(MH_CreateHook(reinterpret_cast<void*>(fn),reinterpret_cast<void*>(getOptionHook),reinterpret_cast<void**>(&realGetOption))==MH_OK&&MH_EnableHook(reinterpret_cast<void*>(fn))==MH_OK){getOptionAt=reinterpret_cast<uintptr_t>(fn);sensId=sid;fovId=id;fovState="on";}
 else fovState="hook_failed";
}
// a copy of an option as it is now (made here, read in the hook): as much of it as there is to read
void keepCopy(int id,unsigned char* copy,std::atomic<uintptr_t>& of){
 void* options=lastOptions.load();
 if(id<0||!realGetOption||!options)return;
 const uintptr_t o=lastOf(askOption(realGetOption,options,id));
 if(!o||o==of.load())return;
 of=0;
 SIZE_T got=0;size_t n=0x200;
 while(n>=0x40&&!(ReadProcessMemory(GetCurrentProcess(),reinterpret_cast<void*>(o),copy,n,&got)&&got==n))n/=2;
 if(n>=0x40)of=o;
}

// the wheel while the zoom key is held: closer or farther, not the hotbar —
// from the mouse itself (a low-level hook on a thread of its own): the game
// reads the mouse by itself, not from its window's messages
DWORD wheelThread=0;HANDLE wheelHandle=nullptr;
LRESULT CALLBACK lowMouse(int code,WPARAM wp,LPARAM lp){
 if(code==HC_ACTION&&wp==WM_MOUSEWHEEL&&zoomHeldNow.load(std::memory_order_relaxed)){
  const short d=GET_WHEEL_DELTA_WPARAM(reinterpret_cast<MSLLHOOKSTRUCT*>(lp)->mouseData);
  zoomTarget=(std::max)(1.5f,(std::min)(40.0f,zoomTarget.load()*(d>0?1.25f:0.8f)));
  return 1;
 }
 return CallNextHookEx(nullptr,code,wp,lp);
}
DWORD WINAPI wheelLoop(void*){
 HHOOK h=SetWindowsHookExW(WH_MOUSE_LL,lowMouse,self,0);
 MSG m;while(GetMessageW(&m,nullptr,0,0)>0){}
 if(h)UnhookWindowsHookEx(h);return 0;
}
void watchWheel(){if(!wheelHandle)wheelHandle=CreateThread(nullptr,0,wheelLoop,nullptr,0,&wheelThread);}

// ---- VSync: the frame's Present, its sync interval as the player wants (0: as the game has it) ----
std::atomic<int> vsyncMode{0};bool presentTried=false;std::string vsyncState="off";
using PresentFn=HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain*,UINT,UINT);
using Present1Fn=HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain1*,UINT,UINT,const DXGI_PRESENT_PARAMETERS*);
PresentFn realPresent=nullptr;Present1Fn realPresent1=nullptr;
std::atomic<void*> tearingChain{nullptr};std::atomic<int> tearing{-1};
void sync(IDXGISwapChain* chain,UINT& interval,UINT& flags){
 const int mode=vsyncMode.load(std::memory_order_relaxed);
 if(mode==1){if(!interval)interval=1;flags&=~DXGI_PRESENT_ALLOW_TEARING;}
 else if(mode==2){
  interval=0;
  // tearing allowed only where the swap chain was made for it (windowed flip model)
  if(tearingChain.load()!=chain){
   tearingChain=chain;DXGI_SWAP_CHAIN_DESC d{};tearing=SUCCEEDED(chain->GetDesc(&d))&&(d.Flags&DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING)?1:0;
  }
  BOOL full=FALSE;
  if(tearing.load()==1&&!(flags&DXGI_PRESENT_TEST)&&SUCCEEDED(chain->GetFullscreenState(&full,nullptr))&&!full)flags|=DXGI_PRESENT_ALLOW_TEARING;
 }
}
HRESULT STDMETHODCALLTYPE onPresent(IDXGISwapChain* chain,UINT interval,UINT flags){sync(chain,interval,flags);return realPresent(chain,interval,flags);}
HRESULT STDMETHODCALLTYPE onPresent1(IDXGISwapChain1* chain,UINT interval,UINT flags,const DXGI_PRESENT_PARAMETERS* p){sync(chain,interval,flags);return realPresent1(chain,interval,flags,p);}
template<class T> void drop(T*& p){if(p){p->Release();p=nullptr;}}
// the functions, from a throwaway device and swap chain of our own (the game's are made the same way)
void hookPresent(){
 if(presentTried)return;presentTried=true;
 using DeviceFn=HRESULT(WINAPI*)(IUnknown*,D3D_FEATURE_LEVEL,REFIID,void**);
 using FactoryFn=HRESULT(WINAPI*)(REFIID,void**);
 HMODULE d3d=LoadLibraryW(L"d3d12.dll"),dxgi=LoadLibraryW(L"dxgi.dll");
 auto createDevice=d3d?reinterpret_cast<DeviceFn>(GetProcAddress(d3d,"D3D12CreateDevice")):nullptr;
 auto createFactory=dxgi?reinterpret_cast<FactoryFn>(GetProcAddress(dxgi,"CreateDXGIFactory1")):nullptr;
 if(!createDevice||!createFactory){vsyncState="no_d3d12";return;}
 WNDCLASSEXW wc{sizeof(wc)};wc.lpfnWndProc=DefWindowProcW;wc.hInstance=self;wc.lpszClassName=L"MCLauncher.Bedrock.Sync";RegisterClassExW(&wc);
 HWND hwnd=CreateWindowExW(0,wc.lpszClassName,L"",WS_OVERLAPPEDWINDOW,0,0,64,64,nullptr,nullptr,self,nullptr);
 ID3D12Device* d=nullptr;ID3D12CommandQueue* q=nullptr;IDXGIFactory2* fac=nullptr;IDXGISwapChain1* sc=nullptr;
 if(SUCCEEDED(createDevice(nullptr,D3D_FEATURE_LEVEL_11_0,__uuidof(ID3D12Device),reinterpret_cast<void**>(&d)))){
  D3D12_COMMAND_QUEUE_DESC qd{};qd.Type=D3D12_COMMAND_LIST_TYPE_DIRECT;
  if(SUCCEEDED(d->CreateCommandQueue(&qd,__uuidof(ID3D12CommandQueue),reinterpret_cast<void**>(&q)))&&SUCCEEDED(createFactory(__uuidof(IDXGIFactory2),reinterpret_cast<void**>(&fac)))){
   DXGI_SWAP_CHAIN_DESC1 sd{};sd.Width=64;sd.Height=64;sd.Format=DXGI_FORMAT_R8G8B8A8_UNORM;sd.SampleDesc.Count=1;
   sd.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;sd.BufferCount=2;sd.SwapEffect=DXGI_SWAP_EFFECT_FLIP_DISCARD;
   if(SUCCEEDED(fac->CreateSwapChainForHwnd(q,hwnd,&sd,nullptr,nullptr,&sc))){
    void** vt=*reinterpret_cast<void***>(sc);
    const MH_STATUS init=MH_Initialize();
    if((init==MH_OK||init==MH_ERROR_ALREADY_INITIALIZED)&&
       MH_CreateHook(vt[8],reinterpret_cast<void*>(&onPresent),reinterpret_cast<void**>(&realPresent))==MH_OK&&
       MH_CreateHook(vt[22],reinterpret_cast<void*>(&onPresent1),reinterpret_cast<void**>(&realPresent1))==MH_OK&&
       MH_EnableHook(vt[8])==MH_OK&&MH_EnableHook(vt[22])==MH_OK)vsyncState="on";
    else vsyncState="hook_failed";
   }else vsyncState="no_swapchain";
  }else vsyncState="no_queue";
 }else vsyncState="no_device";
 drop(sc);drop(fac);drop(q);drop(d);
 DestroyWindow(hwnd);UnregisterClassW(wc.lpszClassName,self);
}

// ---- the launcher's settings ----
int number(const wchar_t* key,int fallback){return static_cast<int>(GetPrivateProfileIntW(L"comfort",key,fallback,prefs.c_str()));}
float decimal(const wchar_t* key,float fallback){wchar_t v[32]{};GetPrivateProfileStringW(L"comfort",key,L"",v,32,prefs.c_str());return v[0]?static_cast<float>(_wtof(v)):fallback;}
void reload(){
 sprint=number(L"autoSprint",0)!=0;
 const bool want=number(L"fullbright",0)!=0;
 if(want&&gammaOn())bright=true;else if(!want)bright=false;
 zoomOn=number(L"zoom",0)!=0;zoomKey=number(L"zoomKey",'C');zoomLevel=decimal(L"zoomLevel",4);fovHint=decimal(L"fovHint",0);
 zoomSmooth=number(L"zoomSmooth",1)!=0;sensHint=decimal(L"sensHint",0);sensGuess=number(L"sensGuess",0);
 if(!zoomHeld)zoomTarget=zoomLevel;
 // the field of view is found through the gamma's options: its getter hooked (it passes on what the game has)
 if(zoomOn&&gammaReady)gammaOn();
 vsyncMode=number(L"vsync",0);
 if(vsyncMode!=0)hookPresent();
}
}
void init(HMODULE module,uintptr_t gamma,const std::wstring& preferences){
 self=module;prefs=preferences;
 gammaTarget=gamma;
 {LARGE_INTEGER f;if(QueryPerformanceFrequency(&f))qpf=f.QuadPart;}
 const MH_STATUS hooks=gamma?MH_Initialize():MH_UNKNOWN;
 if(gamma&&(hooks==MH_OK||hooks==MH_ERROR_ALREADY_INITIALIZED)&&MH_CreateHook(reinterpret_cast<void*>(gamma),reinterpret_cast<void*>(gammaHook),reinterpret_cast<void**>(&originalGamma))==MH_OK)gammaReady=true;
 reload();readAt=GetTickCount64();
}
void tick(bool world,bool grabbed,bool enabled){
 inWorld=world&&enabled;
 if(GetTickCount64()-readAt>=500){readAt=GetTickCount64();reload();}
 HWND foreground=GetForegroundWindow();DWORD process=0;GetWindowThreadProcessId(foreground,&process);
 const bool focused=process==GetCurrentProcessId();
 // in the game, not a menu: the mouse is the game's (its flag), or the cursor is hidden over our window
 CURSORINFO cursor{sizeof cursor};
 const bool playing=focused&&(grabbed||(GetCursorInfo(&cursor)&&!(cursor.flags&CURSOR_SHOWING)));
 // sprinting by itself: W held in the game — Ctrl pressed for a moment (the
 // game starts running at the press; held down, Ctrl+Q would throw the whole
 // stack), and again every half second while still going forward, so a run
 // cut short (a hit, a wall, a jump into water) starts again
 const bool run=enabled&&world&&playing&&sprint&&(GetAsyncKeyState('W')&0x8000)&&!(GetAsyncKeyState('S')&0x8000)&&!(GetAsyncKeyState(VK_SHIFT)&0x8000)&&!(GetAsyncKeyState(VK_MENU)&0x8000);
 const ULONGLONG now=GetTickCount64();
 if(sprintHeld&&now-pressedAt>=60)control(false);
 else if(run&&!sprintHeld&&now-pressedAt>=500&&!(GetAsyncKeyState(VK_CONTROL)&0x8000)){control(true);pressedAt=now;}
 // zoom: the key held in the game (not in a menu); the goal here, the way
 // there in the hook (every frame, by the clock); the copies it hands out kept fresh
 if(zoomOn&&world&&enabled&&focused){if(!fovSearched)findFov();watchWheel();}
 zoomHeld=zoomOn&&fovId>=0&&world&&enabled&&playing&&(GetAsyncKeyState(zoomKey)&0x8000);
 zoomHeldNow=zoomHeld;
 zoomGoal=zoomHeld?zoomTarget.load():1.0f;
 if(!zoomHeld&&zoomNow.load()<=1.001f)zoomTarget=zoomLevel;
 if(fovId>=0){keepCopy(fovId,fovCopy,fovCopyOf);keepCopy(sensId,sensCopy,sensCopyOf);}
}
void voice(bool muted,unsigned acknowledged){if(acknowledged>=micSequence)micOff=muted;}
void resetCommands(){micSequence=0;}
std::string telemetry(){std::ostringstream s;s<<"\"controls\":{\"autoSprint\":"<<(sprint?"true":"false")<<",\"fullbright\":"<<(bright?"true":"false")<<",\"fullbrightAvailable\":"<<(gammaReady?"true":"false")<<",\"micOff\":"<<(micOff?"true":"false")<<",\"micSequence\":"<<micSequence<<",\"zoom\":\""<<fovState<<"\",\"zoomMouse\":\""<<sensState<<"\",\"vsync\":\""<<vsyncState<<"\"}";return s.str();}
void close(){
 inWorld=false;zoomNow=1.0f;zoomGoal=1.0f;if(sprintHeld)control(false);
 if(gammaReady)MH_DisableHook(reinterpret_cast<void*>(gammaTarget));
 zoomGoal=1.0f;zoomHeldNow=false;if(getOptionAt)MH_DisableHook(reinterpret_cast<void*>(getOptionAt));
 vsyncMode=0;
 if(wheelThread)PostThreadMessageW(wheelThread,WM_QUIT,0,0);
}
}
