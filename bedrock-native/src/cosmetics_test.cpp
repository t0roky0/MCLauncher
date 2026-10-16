// A test of drawing in Bedrock (the way to cosmetics on players): hooks the
// frame's Present, and over the game's picture draws a cube placed in the
// world by the camera worked out from the player's eyes and head turn.
// Development only — loaded by tools/bedrock/cosmetics_test.py, never shipped.
//
// Everything it needs comes from cosmetics-test.ini next to the DLL (read
// twice a second), so the numbers are tuned without building it again:
//   actor=0x…          the local player's actor (tools/bedrock/mem.py finds it)
//   view=0x… projection=0x…  the game's own camera (mem.py camera): its turn and
//                            its projection — the real FOV, sprinting and flying included
//   mode=first|back|front   the camera: first person, third person behind / in front
//   fov=70  fovAxis=v|h     the field of view and which way it spans
//   distance=4              the third-person camera's distance
//   anchor=x,y,z            a cube fixed in the world (0 = none)
//   head=1                  a cube over the player's head
//   delay=1                 use the camera as it was this many frames ago (the game
//                           builds the next frame while one is shown)
//   unload=1                take the hooks out and unload
//
// The game draws with Direct3D 12; this draws with Direct3D 11 on 12 onto the
// swap chain's buffer just before it is presented (over the game's UI too).
#include <windows.h>
#include <d3d11.h>
#include <d3d11on12.h>
#include <d3d12.h>
#include <d3dcompiler.h>
#include <dxgi1_4.h>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <mutex>
#include <string>
#include <vector>
#include "MinHook.h"

namespace {
HMODULE self = nullptr;
std::wstring iniPath;
std::atomic<bool> leaving{false};
std::mutex lock;

// ---- settings --------------------------------------------------------------------------------------
struct Settings {
  uintptr_t actor = 0, view = 0, projection = 0;
  int delay = 1;
  int mode = 0;  // 0 first, 1 back, 2 front
  float fov = 70, distance = 4;
  bool fovHorizontal = false, head = true, unload = false;
  float anchor[3]{}; bool hasAnchor = false;
} cfg;
ULONGLONG cfgAt = 0;

std::wstring get(const wchar_t* key, const wchar_t* def) {
  wchar_t buf[256]{};
  GetPrivateProfileStringW(L"test", key, def, buf, 256, iniPath.c_str());
  return buf;
}
void readSettings() {
  if (GetTickCount64() - cfgAt < 500) return;
  cfgAt = GetTickCount64();
  Settings s;
  s.actor = wcstoull(get(L"actor", L"0").c_str(), nullptr, 0);
  s.view = wcstoull(get(L"view", L"0").c_str(), nullptr, 0);
  s.projection = wcstoull(get(L"projection", L"0").c_str(), nullptr, 0);
  s.delay = _wtoi(get(L"delay", L"1").c_str());
  if (s.delay < 0) s.delay = 0;
  if (s.delay > 7) s.delay = 7;
  auto mode = get(L"mode", L"back");
  s.mode = mode == L"first" ? 0 : mode == L"front" ? 2 : 1;
  s.fov = static_cast<float>(_wtof(get(L"fov", L"70").c_str()));
  s.fovHorizontal = get(L"fovAxis", L"v") == L"h";
  s.distance = static_cast<float>(_wtof(get(L"distance", L"4").c_str()));
  s.head = get(L"head", L"1") != L"0";
  s.unload = get(L"unload", L"0") == L"1";
  auto a = get(L"anchor", L"0");
  s.hasAnchor = swscanf_s(a.c_str(), L"%f,%f,%f", &s.anchor[0], &s.anchor[1], &s.anchor[2]) == 3;
  cfg = s;
}

// ---- reading the game --------------------------------------------------------------------------------
template <class T> bool read(uintptr_t at, T& out) {
  SIZE_T got = 0;
  return at > 0x10000 && ReadProcessMemory(GetCurrentProcess(), reinterpret_cast<void*>(at), &out, sizeof(T), &got) && got == sizeof(T);
}
uintptr_t ptr(uintptr_t at) { uintptr_t v = 0; return read(at, v) ? v : 0; }
struct Vec3 { float x, y, z; };
// eyes (state vector, actor+0x218 →) and head turn (actor+0x228 → pitch, yaw), 26.52
bool look(uintptr_t actor, Vec3& eyes, float& pitch, float& yaw) {
  float r[2]{};
  if (!read(ptr(actor + 0x218), eyes) || !read(ptr(actor + 0x228), r)) return false;
  pitch = r[0]; yaw = r[1];
  return std::isfinite(eyes.x) && std::isfinite(eyes.y) && std::isfinite(eyes.z) && std::isfinite(pitch) && std::isfinite(yaw);
}

// ---- the camera ----------------------------------------------------------------------------------------
// Minecraft: x east, y up, z south; yaw 0 faces south, 90 west; pitch > 0 looks down.
struct Camera { Vec3 at, fwd, right, up; float sx, sy; };
Vec3 sub(Vec3 a, Vec3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
float dot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
Vec3 cross(Vec3 a, Vec3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
Vec3 scale(Vec3 a, float k) { return {a.x * k, a.y * k, a.z * k}; }
Vec3 add(Vec3 a, Vec3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
Vec3 norm(Vec3 a) { float l = std::sqrt(dot(a, a)); return l > 0 ? scale(a, 1 / l) : a; }

Camera camera(Vec3 eyes, float pitch, float yaw, float width, float height) {
  const float d = 3.14159265f / 180;
  Vec3 fwd{-std::sin(yaw * d) * std::cos(pitch * d), -std::sin(pitch * d), std::cos(yaw * d) * std::cos(pitch * d)};
  Camera c{};
  float aspect = width / height;
  if (cfg.mode == 1) c.at = sub(eyes, scale(fwd, cfg.distance));
  else if (cfg.mode == 2) { c.at = add(eyes, scale(fwd, cfg.distance)); fwd = scale(fwd, -1); }
  else c.at = eyes;
  c.fwd = fwd;
  c.right = norm(cross(fwd, Vec3{0, 1, 0}));
  c.up = cross(c.right, fwd);
  float half = cfg.fov * d / 2;
  // focal length for the vertical span (from the horizontal one if the setting is that)
  float f = cfg.fovHorizontal ? aspect / std::tan(half) : 1 / std::tan(half);
  c.sx = f / aspect; c.sy = f;
  // the game's own camera, when we know where it keeps it: its turn (the
  // columns: right, up, back) and its projection's scales
  float m[16]{};
  if (cfg.view && read(cfg.view, m) && m[15] == 1 && std::fabs(m[0] * m[0] + m[4] * m[4] + m[8] * m[8] - 1) < 0.02f && cfg.mode == 0) {
    c.right = {m[0], m[4], m[8]}; c.up = {m[1], m[5], m[9]}; c.fwd = {-m[2], -m[6], -m[10]};
  }
  if (cfg.projection && read(cfg.projection, m) && m[0] > 0.05f && m[5] > 0.05f && m[0] < 20 && m[5] < 20) { c.sx = m[0]; c.sy = m[5]; }
  return c;
}
// a world point → clip space (x, y, z, w), depth 0…1 between 0.05 and 1000
void project(const Camera& c, Vec3 p, float out[4]) {
  Vec3 v = sub(p, c.at);
  float x = dot(v, c.right), y = dot(v, c.up), z = dot(v, c.fwd);
  const float zn = 0.05f, zf = 1000;
  out[0] = x * c.sx;
  out[1] = y * c.sy;
  out[2] = (z - zn) * zf / (zf - zn);
  out[3] = z;
}

// ---- drawing ---------------------------------------------------------------------------------------------
struct Vertex { float pos[4]; float color[4]; };
ID3D12CommandQueue* queue = nullptr;
ID3D11Device* dev11 = nullptr;
ID3D11DeviceContext* ctx11 = nullptr;
ID3D11On12Device* on12 = nullptr;
std::vector<ID3D11Resource*> wrapped;
std::vector<ID3D11RenderTargetView*> targets;
ID3D11Buffer* vbuf = nullptr;
ID3D11VertexShader* vs = nullptr;
ID3D11PixelShader* ps = nullptr;
ID3D11InputLayout* layout = nullptr;
ID3D11RasterizerState* raster = nullptr;
ID3D11BlendState* blend = nullptr;
ID3D11DepthStencilState* nodepth = nullptr;
UINT width = 0, height = 0;
const UINT MAX_VERTS = 36 * 4;

const char* SHADER = R"(
struct V { float4 pos : POSITION; float4 color : COLOR; };
struct P { float4 pos : SV_Position; float4 color : COLOR; };
P vs(V v) { P p; p.pos = v.pos; p.color = v.color; return p; }
float4 ps(P p) : SV_Target { return p.color; }
)";

template <class T> void drop(T*& p) { if (p) { p->Release(); p = nullptr; } }
void dropTargets() {
  for (auto* t : targets) if (t) t->Release();
  for (auto* r : wrapped) if (r) r->Release();
  targets.clear(); wrapped.clear();
  if (ctx11) ctx11->Flush();
}
void dropAll() {
  dropTargets();
  drop(vbuf); drop(vs); drop(ps); drop(layout); drop(raster); drop(blend); drop(nodepth);
  drop(on12); drop(ctx11); drop(dev11);
}

bool setup(IDXGISwapChain3* chain) {
  if (dev11) return true;
  if (!queue) return false;
  ID3D12Device* d12 = nullptr;
  if (FAILED(chain->GetDevice(IID_PPV_ARGS(&d12)))) return false;
  IUnknown* queues[] = {queue};
  HRESULT hr = D3D11On12CreateDevice(d12, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, queues, 1, 0, &dev11, &ctx11, nullptr);
  d12->Release();
  if (FAILED(hr) || FAILED(dev11->QueryInterface(IID_PPV_ARGS(&on12)))) { dropAll(); return false; }
  ID3DBlob *vsb = nullptr, *psb = nullptr;
  if (FAILED(D3DCompile(SHADER, strlen(SHADER), nullptr, nullptr, nullptr, "vs", "vs_4_0", 0, 0, &vsb, nullptr)) ||
      FAILED(D3DCompile(SHADER, strlen(SHADER), nullptr, nullptr, nullptr, "ps", "ps_4_0", 0, 0, &psb, nullptr))) { drop(vsb); drop(psb); dropAll(); return false; }
  dev11->CreateVertexShader(vsb->GetBufferPointer(), vsb->GetBufferSize(), nullptr, &vs);
  dev11->CreatePixelShader(psb->GetBufferPointer(), psb->GetBufferSize(), nullptr, &ps);
  D3D11_INPUT_ELEMENT_DESC el[] = {{"POSITION", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 0, D3D11_INPUT_PER_VERTEX_DATA, 0},
                                   {"COLOR", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 16, D3D11_INPUT_PER_VERTEX_DATA, 0}};
  dev11->CreateInputLayout(el, 2, vsb->GetBufferPointer(), vsb->GetBufferSize(), &layout);
  vsb->Release(); psb->Release();
  D3D11_BUFFER_DESC bd{sizeof(Vertex) * MAX_VERTS, D3D11_USAGE_DYNAMIC, D3D11_BIND_VERTEX_BUFFER, D3D11_CPU_ACCESS_WRITE, 0, 0};
  dev11->CreateBuffer(&bd, nullptr, &vbuf);
  D3D11_RASTERIZER_DESC rd{}; rd.FillMode = D3D11_FILL_SOLID; rd.CullMode = D3D11_CULL_NONE; rd.DepthClipEnable = TRUE;
  dev11->CreateRasterizerState(&rd, &raster);
  D3D11_BLEND_DESC bl{}; bl.RenderTarget[0].BlendEnable = TRUE;
  bl.RenderTarget[0].SrcBlend = D3D11_BLEND_SRC_ALPHA; bl.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA; bl.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
  bl.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE; bl.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_ZERO; bl.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
  bl.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
  dev11->CreateBlendState(&bl, &blend);
  D3D11_DEPTH_STENCIL_DESC ds{}; ds.DepthEnable = FALSE;
  dev11->CreateDepthStencilState(&ds, &nodepth);
  return vs && ps && layout && vbuf;
}

bool buffers(IDXGISwapChain3* chain) {
  DXGI_SWAP_CHAIN_DESC desc{};
  chain->GetDesc(&desc);
  if (!targets.empty() && desc.BufferDesc.Width == width && desc.BufferDesc.Height == height && targets.size() == desc.BufferCount) return true;
  dropTargets();
  width = desc.BufferDesc.Width; height = desc.BufferDesc.Height;
  for (UINT i = 0; i < desc.BufferCount; i++) {
    ID3D12Resource* res = nullptr;
    if (FAILED(chain->GetBuffer(i, IID_PPV_ARGS(&res)))) return false;
    D3D11_RESOURCE_FLAGS f{D3D11_BIND_RENDER_TARGET};
    ID3D11Resource* r11 = nullptr;
    HRESULT hr = on12->CreateWrappedResource(res, &f, D3D12_RESOURCE_STATE_PRESENT, D3D12_RESOURCE_STATE_PRESENT, IID_PPV_ARGS(&r11));
    res->Release();
    if (FAILED(hr)) return false;
    ID3D11RenderTargetView* rtv = nullptr;
    // the buffer is 8-bit RGBA or BGRA; draw in its own format
    if (FAILED(dev11->CreateRenderTargetView(r11, nullptr, &rtv))) { r11->Release(); return false; }
    wrapped.push_back(r11); targets.push_back(rtv);
  }
  return true;
}

// a box's 36 corners (12 triangles), each face its own shade of the colour
void box(std::vector<Vertex>& out, const Camera& cam, Vec3 lo, Vec3 hi, const float rgb[3]) {
  Vec3 c[8] = {{lo.x, lo.y, lo.z}, {hi.x, lo.y, lo.z}, {hi.x, hi.y, lo.z}, {lo.x, hi.y, lo.z},
               {lo.x, lo.y, hi.z}, {hi.x, lo.y, hi.z}, {hi.x, hi.y, hi.z}, {lo.x, hi.y, hi.z}};
  const int faces[6][4] = {{0, 1, 2, 3}, {5, 4, 7, 6}, {4, 0, 3, 7}, {1, 5, 6, 2}, {3, 2, 6, 7}, {4, 5, 1, 0}};
  const float shade[6] = {0.8f, 0.8f, 0.65f, 0.65f, 1.0f, 0.5f};
  for (int f = 0; f < 6; f++) {
    const int tri[6] = {0, 1, 2, 0, 2, 3};
    for (int k : tri) {
      Vertex v{};
      project(cam, c[faces[f][k]], v.pos);
      for (int i = 0; i < 3; i++) v.color[i] = rgb[i] * shade[f];
      v.color[3] = 0.85f;
      out.push_back(v);
    }
  }
}

void draw(IDXGISwapChain3* chain) {
  readSettings();
  if (cfg.unload) { leaving = true; return; }
  if (!cfg.actor || !setup(chain) || !buffers(chain)) return;
  Vec3 eyes{}; float pitch = 0, yaw = 0;
  if (!look(cfg.actor, eyes, pitch, yaw)) return;
  // the camera of a few frames ago: the frame shown now was built then
  static Camera past[8]; static unsigned frames = 0;
  past[frames % 8] = camera(eyes, pitch, yaw, static_cast<float>(width), static_cast<float>(height));
  frames++;
  unsigned back = static_cast<unsigned>(cfg.delay) < frames ? static_cast<unsigned>(cfg.delay) : frames - 1;
  Camera cam = past[(frames - 1 - back) % 8];
  std::vector<Vertex> verts;
  const float gold[3] = {1.0f, 0.78f, 0.25f}, purple[3] = {0.64f, 0.36f, 1.0f};
  if (cfg.hasAnchor) box(verts, cam, {cfg.anchor[0] - 0.5f, cfg.anchor[1] - 0.5f, cfg.anchor[2] - 0.5f}, {cfg.anchor[0] + 0.5f, cfg.anchor[1] + 0.5f, cfg.anchor[2] + 0.5f}, gold);
  // over the head: the eyes are 1.62 up, the head's top about 0.28 above them
  if (cfg.head && cfg.mode != 0) box(verts, cam, {eyes.x - 0.25f, eyes.y + 0.35f, eyes.z - 0.25f}, {eyes.x + 0.25f, eyes.y + 0.85f, eyes.z + 0.25f}, purple);
  if (verts.empty() || verts.size() > MAX_VERTS) return;
  UINT index = chain->GetCurrentBackBufferIndex();
  if (index >= targets.size()) return;
  D3D11_MAPPED_SUBRESOURCE m{};
  if (FAILED(ctx11->Map(vbuf, 0, D3D11_MAP_WRITE_DISCARD, 0, &m))) return;
  memcpy(m.pData, verts.data(), verts.size() * sizeof(Vertex));
  ctx11->Unmap(vbuf, 0);
  on12->AcquireWrappedResources(&wrapped[index], 1);
  D3D11_VIEWPORT vp{0, 0, static_cast<float>(width), static_cast<float>(height), 0, 1};
  ctx11->RSSetViewports(1, &vp);
  ctx11->RSSetState(raster);
  float bf[4]{};
  ctx11->OMSetBlendState(blend, bf, 0xffffffff);
  ctx11->OMSetDepthStencilState(nodepth, 0);
  ctx11->OMSetRenderTargets(1, &targets[index], nullptr);
  UINT stride = sizeof(Vertex), offset = 0;
  ctx11->IASetVertexBuffers(0, 1, &vbuf, &stride, &offset);
  ctx11->IASetInputLayout(layout);
  ctx11->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  ctx11->VSSetShader(vs, nullptr, 0);
  ctx11->PSSetShader(ps, nullptr, 0);
  ctx11->Draw(static_cast<UINT>(verts.size()), 0);
  ctx11->OMSetRenderTargets(0, nullptr, nullptr);
  on12->ReleaseWrappedResources(&wrapped[index], 1);
  ctx11->Flush();
}

// ---- hooks -------------------------------------------------------------------------------------------------
using PresentFn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain3*, UINT, UINT);
using Present1Fn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain3*, UINT, UINT, const DXGI_PRESENT_PARAMETERS*);
using ResizeFn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain3*, UINT, UINT, UINT, DXGI_FORMAT, UINT);
using ExecuteFn = void(STDMETHODCALLTYPE*)(ID3D12CommandQueue*, UINT, ID3D12CommandList* const*);
PresentFn realPresent = nullptr; Present1Fn realPresent1 = nullptr; ResizeFn realResize = nullptr; ExecuteFn realExecute = nullptr;
void* targetsHooked[4]{};

// a fault in our drawing takes us out, not the game
void guarded(IDXGISwapChain3* chain) {
  __try { draw(chain); } __except (EXCEPTION_EXECUTE_HANDLER) { leaving = true; }
}
void frame(IDXGISwapChain3* chain) {
  if (leaving) return;
  std::lock_guard<std::mutex> g(lock);
  guarded(chain);
}
HRESULT STDMETHODCALLTYPE onPresent(IDXGISwapChain3* chain, UINT sync, UINT flags) { frame(chain); return realPresent(chain, sync, flags); }
HRESULT STDMETHODCALLTYPE onPresent1(IDXGISwapChain3* chain, UINT sync, UINT flags, const DXGI_PRESENT_PARAMETERS* p) { frame(chain); return realPresent1(chain, sync, flags, p); }
HRESULT STDMETHODCALLTYPE onResize(IDXGISwapChain3* chain, UINT n, UINT w, UINT h, DXGI_FORMAT f, UINT fl) {
  { std::lock_guard<std::mutex> g(lock); dropTargets(); width = height = 0; }
  return realResize(chain, n, w, h, f, fl);
}
void STDMETHODCALLTYPE onExecute(ID3D12CommandQueue* q, UINT n, ID3D12CommandList* const* lists) {
  if (!queue && q->GetDesc().Type == D3D12_COMMAND_LIST_TYPE_DIRECT) { q->AddRef(); queue = q; }
  realExecute(q, n, lists);
}

// The functions to hook, from a throwaway device and swap chain of our own.
bool hook() {
  WNDCLASSEXW wc{sizeof(wc)}; wc.lpfnWndProc = DefWindowProcW; wc.hInstance = self; wc.lpszClassName = L"mcl-cosmetics-test";
  RegisterClassExW(&wc);
  HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"", WS_OVERLAPPEDWINDOW, 0, 0, 64, 64, nullptr, nullptr, self, nullptr);
  ID3D12Device* d = nullptr; ID3D12CommandQueue* q = nullptr; IDXGIFactory2* fac = nullptr; IDXGISwapChain1* sc = nullptr;
  bool ok = false;
  if (SUCCEEDED(D3D12CreateDevice(nullptr, D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&d)))) {
    D3D12_COMMAND_QUEUE_DESC qd{}; qd.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    if (SUCCEEDED(d->CreateCommandQueue(&qd, IID_PPV_ARGS(&q))) && SUCCEEDED(CreateDXGIFactory1(IID_PPV_ARGS(&fac)))) {
      DXGI_SWAP_CHAIN_DESC1 sd{}; sd.Width = 64; sd.Height = 64; sd.Format = DXGI_FORMAT_R8G8B8A8_UNORM; sd.SampleDesc.Count = 1;
      sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT; sd.BufferCount = 2; sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
      if (SUCCEEDED(fac->CreateSwapChainForHwnd(q, hwnd, &sd, nullptr, nullptr, &sc))) {
        void** chainVt = *reinterpret_cast<void***>(sc);
        void** queueVt = *reinterpret_cast<void***>(q);
        targetsHooked[0] = chainVt[8]; targetsHooked[1] = chainVt[22]; targetsHooked[2] = chainVt[13]; targetsHooked[3] = queueVt[10];
        ok = MH_Initialize() == MH_OK &&
             MH_CreateHook(targetsHooked[0], reinterpret_cast<void*>(&onPresent), reinterpret_cast<void**>(&realPresent)) == MH_OK &&
             MH_CreateHook(targetsHooked[1], reinterpret_cast<void*>(&onPresent1), reinterpret_cast<void**>(&realPresent1)) == MH_OK &&
             MH_CreateHook(targetsHooked[2], reinterpret_cast<void*>(&onResize), reinterpret_cast<void**>(&realResize)) == MH_OK &&
             MH_CreateHook(targetsHooked[3], reinterpret_cast<void*>(&onExecute), reinterpret_cast<void**>(&realExecute)) == MH_OK &&
             MH_EnableHook(MH_ALL_HOOKS) == MH_OK;
      }
    }
  }
  drop(sc); drop(fac); drop(q); drop(d);
  DestroyWindow(hwnd); UnregisterClassW(wc.lpszClassName, self);
  return ok;
}

void status(const char* text) {
  auto path = iniPath.substr(0, iniPath.size() - 3) + L"log";
  FILE* f = nullptr;
  if (!_wfopen_s(&f, path.c_str(), L"a") && f) { fprintf(f, "%s\n", text); fclose(f); }
}

DWORD WINAPI run(void*) {
  status(hook() ? "hooked" : "hook failed");
  while (!leaving) Sleep(200);
  // out: the hooks first (no frame is inside ours after the lock), then what we made
  MH_DisableHook(MH_ALL_HOOKS);
  Sleep(300);
  { std::lock_guard<std::mutex> g(lock); dropAll(); if (queue) { queue->Release(); queue = nullptr; } }
  MH_Uninitialize();
  status("unloaded");
  FreeLibraryAndExitThread(self, 0);
}
}  // namespace

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, void*) {
  if (reason == DLL_PROCESS_ATTACH) {
    self = module;
    DisableThreadLibraryCalls(module);
    wchar_t path[MAX_PATH]{};
    GetModuleFileNameW(module, path, MAX_PATH);
    std::wstring p(path);
    iniPath = p.substr(0, p.find_last_of(L"\\/") + 1) + L"cosmetics-test.ini";
    HANDLE t = CreateThread(nullptr, 0, run, nullptr, 0, nullptr);
    if (t) CloseHandle(t);
  }
  return TRUE;
}
