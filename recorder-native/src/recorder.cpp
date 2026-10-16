// mcl-recorder: the game's part of the screen to an MP4, all on the GPU —
// DXGI desktop duplication (the overlay excludes itself from capture), the
// H.264 hardware encoder through a Media Foundation sink writer, and the
// computer's sound (WASAPI loopback) as AAC. A constant frame rate: a frame
// goes out every 1/fps second, repeated when the screen didn't change.
//
// Two modes. "record": straight into the MP4. "replay": fragmented MP4
// segments on disk, rotated; "save" cuts the last N seconds out of them
// into a normal MP4 (no re-encoding: the compressed samples are copied).
//
// Sound: the computer's (the game, friends' voices) and, when asked, our
// microphone — mixed in only while the launcher says it's open (talking in
// voice chat, not muted), so the video hears us as the others did.
//
// Driven over stdin/stdout, one JSON object per line:
//   {"cmd":"start","mode":"record","file":"…mp4","pid":123,"fps":60,"bitrate":16000000,"audio":true,"mic":true}
//   {"cmd":"start","mode":"replay","dir":"…","pid":123,"fps":60,"bitrate":16000000,"audio":true,"mic":false,"seconds":60}
//   {"cmd":"mic","open":true}                      (our voice goes in now / not)
//   {"cmd":"save","file":"…mp4","seconds":60}     (replay)
//   {"cmd":"stop"}                                 (also: stdin closes)
// Events: {"ev":"started","width":…,"height":…}, {"ev":"saved","seconds":…},
//         {"ev":"stopped","seconds":…}, {"ev":"error","msg":"…"}.

#include <windows.h>
#include <timeapi.h>
#include <d3d11.h>
#include <d3d10.h>
#include <dxgi1_2.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <codecapi.h>
#include <strmif.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <wrl/client.h>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;
namespace fs = std::filesystem;

namespace {

// ---- output -------------------------------------------------------------------------------------

std::mutex outLock;
void emit(const std::string& json) {
  std::lock_guard<std::mutex> g(outLock);
  fwrite(json.data(), 1, json.size(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
}
std::string esc(const std::string& s) {
  std::string o;
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += static_cast<char>(c); }
    else if (c < 32) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += static_cast<char>(c);
  }
  return o;
}
void fail(const std::string& msg) { emit("{\"ev\":\"error\",\"msg\":\"" + esc(msg) + "\"}"); }
std::string hex(HRESULT hr) { char b[16]; snprintf(b, sizeof b, "0x%08lX", static_cast<unsigned long>(hr)); return b; }
#define CHECK(expr, what) do { HRESULT hr_ = (expr); if (FAILED(hr_)) { fail(std::string(what) + " " + hex(hr_)); return false; } } while (0)

// ---- a flat JSON object (strings, numbers, booleans) ------------------------------------------------

struct Command {
  std::string cmd, mode;
  std::wstring file, dir;
  DWORD pid = 0;
  int fps = 60;
  UINT32 bitrate = 16000000;
  bool audio = true;
  bool mic = false;
  bool open = false;
  double seconds = 60;
};

std::wstring wide(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
  return w;
}

bool parse(const std::string& line, Command& c) {
  size_t i = 0;
  auto ws = [&] { while (i < line.size() && isspace(static_cast<unsigned char>(line[i]))) i++; };
  auto str = [&](std::string& out) -> bool {
    if (line[i] != '"') return false;
    i++;
    while (i < line.size() && line[i] != '"') {
      char ch = line[i++];
      if (ch == '\\' && i < line.size()) {
        char e = line[i++];
        if (e == 'n') out += '\n'; else if (e == 't') out += '\t'; else if (e == 'u' && i + 4 <= line.size()) {
          unsigned v = std::stoul(line.substr(i, 4), nullptr, 16); i += 4;
          if (v < 0x80) out += static_cast<char>(v);
          else if (v < 0x800) { out += static_cast<char>(0xC0 | (v >> 6)); out += static_cast<char>(0x80 | (v & 0x3F)); }
          else { out += static_cast<char>(0xE0 | (v >> 12)); out += static_cast<char>(0x80 | ((v >> 6) & 0x3F)); out += static_cast<char>(0x80 | (v & 0x3F)); }
        } else out += e;
      } else out += ch;
    }
    i++;
    return true;
  };
  ws();
  if (i >= line.size() || line[i] != '{') return false;
  i++;
  for (;;) {
    ws();
    if (i < line.size() && line[i] == '}') return true;
    std::string key;
    if (i >= line.size() || !str(key)) return false;
    ws();
    if (i >= line.size() || line[i] != ':') return false;
    i++;
    ws();
    std::string sv;
    double nv = 0;
    bool bv = false, isStr = false, isNum = false, isBool = false;
    if (line[i] == '"') { str(sv); isStr = true; }
    else if (line.compare(i, 4, "true") == 0) { bv = true; isBool = true; i += 4; }
    else if (line.compare(i, 5, "false") == 0) { isBool = true; i += 5; }
    else { size_t used = 0; nv = std::stod(line.substr(i), &used); i += used; isNum = true; }
    if (key == "cmd" && isStr) c.cmd = sv;
    else if (key == "mode" && isStr) c.mode = sv;
    else if (key == "file" && isStr) c.file = wide(sv);
    else if (key == "dir" && isStr) c.dir = wide(sv);
    else if (key == "pid" && isNum) c.pid = static_cast<DWORD>(nv);
    else if (key == "fps" && isNum) c.fps = nv >= 50 ? 60 : 30;
    else if (key == "bitrate" && isNum) c.bitrate = static_cast<UINT32>(std::max(2e6, std::min(80e6, nv)));
    else if (key == "seconds" && isNum) c.seconds = std::max(5.0, std::min(1800.0, nv));
    else if (key == "audio" && isBool) c.audio = bv;
    else if (key == "mic" && isBool) c.mic = bv;
    else if (key == "open" && isBool) c.open = bv;
    ws();
    if (i < line.size() && line[i] == ',') { i++; continue; }
    if (i < line.size() && line[i] == '}') return true;
    return false;
  }
}

// ---- the game's window ---------------------------------------------------------------------------

struct Find { DWORD pid; HWND best; LONGLONG area; };
BOOL CALLBACK findMain(HWND w, LPARAM p) {
  auto* f = reinterpret_cast<Find*>(p);
  DWORD pid = 0;
  GetWindowThreadProcessId(w, &pid);
  if (pid != f->pid || !IsWindowVisible(w) || GetWindow(w, GW_OWNER)) return TRUE;
  RECT r;
  if (!GetWindowRect(w, &r)) return TRUE;
  LONGLONG a = static_cast<LONGLONG>(r.right - r.left) * (r.bottom - r.top);
  if (a > f->area) { f->area = a; f->best = w; }
  return TRUE;
}
HWND mainWindow(DWORD pid) {
  Find f{pid, nullptr, 0};
  EnumWindows(findMain, reinterpret_cast<LPARAM>(&f));
  return f.best;
}
bool clientOnScreen(HWND w, RECT& r) {
  RECT c; POINT o{0, 0};
  if (!IsWindow(w) || IsIconic(w) || !GetClientRect(w, &c) || !ClientToScreen(w, &o)) return false;
  r = {o.x, o.y, o.x + c.right, o.y + c.bottom};
  return c.right > 16 && c.bottom > 16;
}

LONGLONG qpcFreq() { LARGE_INTEGER f; QueryPerformanceFrequency(&f); return f.QuadPart; }
LONGLONG qpcNow() { LARGE_INTEGER t; QueryPerformanceCounter(&t); return t.QuadPart; }
const LONGLONG FREQ = qpcFreq();
LONGLONG hns(LONGLONG ticks) { return static_cast<LONGLONG>(static_cast<double>(ticks) * 1e7 / FREQ); }

// ---- the screen: the monitor that shows the game, its part of it --------------------------------------

struct Screen {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> ctx;
  ComPtr<IDXGIOutput1> output;
  ComPtr<IDXGIOutputDuplication> dup;
  ComPtr<ID3D11Texture2D> desktop; // the monitor's latest picture, BGRA
  ComPtr<ID3D11Texture2D> latest;  // the video frame: output size, BGRA
  ComPtr<ID3D11VideoDevice> vdev;
  ComPtr<ID3D11VideoContext> vctx;
  ComPtr<ID3D11VideoProcessorEnumerator> venum;
  ComPtr<ID3D11VideoProcessor> vproc;
  ComPtr<ID3D11VideoProcessorInputView> inView;
  ComPtr<ID3D11VideoProcessorOutputView> outView;
  RECT desk{};                     // the monitor in desktop coordinates
  UINT width = 0, height = 0;      // the video: the monitor's size (even)
  HWND window = nullptr;
  bool fresh = false;              // a new desktop picture since the last frame

  // The video is the monitor's size from the start: the game's window — small
  // at first, maximized later, fullscreen — is scaled into it (black bars
  // when its shape differs), so the picture follows a resized window.
  bool open(HWND w) {
    window = w;
    RECT client;
    if (!clientOnScreen(w, client)) { fail("game window not visible"); return false; }
    HMONITOR mon = MonitorFromWindow(w, MONITOR_DEFAULTTONEAREST);
    ComPtr<IDXGIFactory1> factory;
    CHECK(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "dxgi factory");
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT a = 0; !output && factory->EnumAdapters1(a, &adapter) != DXGI_ERROR_NOT_FOUND; a++) {
      ComPtr<IDXGIOutput> o;
      for (UINT k = 0; adapter->EnumOutputs(k, &o) != DXGI_ERROR_NOT_FOUND; k++) {
        DXGI_OUTPUT_DESC d;
        if (SUCCEEDED(o->GetDesc(&d)) && d.Monitor == mon) { o.As(&output); desk = d.DesktopCoordinates; break; }
      }
      if (!output) adapter.Reset();
    }
    if (!output) { fail("monitor not found"); return false; }
    D3D_FEATURE_LEVEL got;
    CHECK(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &device, &got, &ctx), "d3d11 device");
    ComPtr<ID3D10Multithread> mt;
    if (SUCCEEDED(device.As(&mt))) mt->SetMultithreadProtected(TRUE);
    const UINT dw = static_cast<UINT>(desk.right - desk.left), dh = static_cast<UINT>(desk.bottom - desk.top);
    // up to 4K; bigger monitors are scaled down
    const double k = std::min(1.0, std::min(3840.0 / dw, 2160.0 / dh));
    width = static_cast<UINT>(dw * k) & ~1u;
    height = static_cast<UINT>(dh * k) & ~1u;
    D3D11_TEXTURE2D_DESC t{};
    t.MipLevels = 1; t.ArraySize = 1; t.SampleDesc.Count = 1; t.Usage = D3D11_USAGE_DEFAULT;
    t.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    t.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    t.Width = width; t.Height = height;
    CHECK(device->CreateTexture2D(&t, nullptr, &latest), "frame texture");
    t.Width = dw; t.Height = dh;
    CHECK(device->CreateTexture2D(&t, nullptr, &desktop), "desktop texture");
    // black until the first picture
    ComPtr<ID3D11RenderTargetView> rt;
    if (SUCCEEDED(device->CreateRenderTargetView(latest.Get(), nullptr, &rt))) { const float black[4] = {0, 0, 0, 1}; ctx->ClearRenderTargetView(rt.Get(), black); }

    CHECK(device.As(&vdev), "video device");
    CHECK(ctx.As(&vctx), "video context");
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC cd{};
    cd.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    cd.InputWidth = dw; cd.InputHeight = dh;
    cd.OutputWidth = width; cd.OutputHeight = height;
    cd.InputFrameRate = {60, 1}; cd.OutputFrameRate = {60, 1};
    cd.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
    CHECK(vdev->CreateVideoProcessorEnumerator(&cd, &venum), "video processor caps");
    CHECK(vdev->CreateVideoProcessor(venum.Get(), 0, &vproc), "video processor");
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC iv{};
    iv.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    CHECK(vdev->CreateVideoProcessorInputView(desktop.Get(), venum.Get(), &iv, &inView), "video input view");
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC ov{};
    ov.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    CHECK(vdev->CreateVideoProcessorOutputView(latest.Get(), venum.Get(), &ov, &outView), "video output view");
    D3D11_VIDEO_COLOR black{};
    black.RGBA = {0, 0, 0, 1};
    vctx->VideoProcessorSetOutputBackgroundColor(vproc.Get(), FALSE, &black);
    vctx->VideoProcessorSetStreamAutoProcessingMode(vproc.Get(), 0, FALSE);
    return duplicate();
  }

  bool duplicate() {
    dup.Reset();
    HRESULT hr = output->DuplicateOutput(device.Get(), &dup);
    if (FAILED(hr)) { fail("desktop duplication " + hex(hr)); return false; }
    return true;
  }

  // The newest picture of the monitor, when it changed.
  void grab() {
    if (!dup && !duplicate()) return;
    DXGI_OUTDUPL_FRAME_INFO info;
    ComPtr<IDXGIResource> res;
    HRESULT hr = dup->AcquireNextFrame(0, &info, &res);
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) return;
    if (hr == DXGI_ERROR_ACCESS_LOST) { dup.Reset(); return; } // a mode change, UAC, fullscreen switch: again next time
    if (FAILED(hr)) return;
    ComPtr<ID3D11Texture2D> tex;
    if (info.LastPresentTime.QuadPart && SUCCEEDED(res.As(&tex))) {
      D3D11_TEXTURE2D_DESC d;
      tex->GetDesc(&d);
      D3D11_TEXTURE2D_DESC mine;
      desktop->GetDesc(&mine);
      if (d.Width == mine.Width && d.Height == mine.Height && d.Format == mine.Format) {
        ctx->CopyResource(desktop.Get(), tex.Get());
        fresh = true;
      }
    }
    dup->ReleaseFrame();
  }

  // The game's window as it is now, scaled into the frame.
  void compose() {
    if (!fresh) return;
    fresh = false;
    RECT client;
    if (!clientOnScreen(window, client)) return;
    const LONG dw = desk.right - desk.left, dh = desk.bottom - desk.top;
    RECT src{std::max(0L, client.left - desk.left), std::max(0L, client.top - desk.top), std::min(dw, client.right - desk.left), std::min(dh, client.bottom - desk.top)};
    if (src.right - src.left < 16 || src.bottom - src.top < 16) return;
    const double sw = src.right - src.left, sh = src.bottom - src.top;
    const double k = std::min(width / sw, height / sh);
    const LONG ow = static_cast<LONG>(sw * k), oh = static_cast<LONG>(sh * k);
    RECT dst{static_cast<LONG>(width - ow) / 2, static_cast<LONG>(height - oh) / 2, 0, 0};
    dst.right = dst.left + ow;
    dst.bottom = dst.top + oh;
    RECT whole{0, 0, static_cast<LONG>(width), static_cast<LONG>(height)};
    vctx->VideoProcessorSetOutputTargetRect(vproc.Get(), TRUE, &whole);
    vctx->VideoProcessorSetStreamSourceRect(vproc.Get(), 0, TRUE, &src);
    vctx->VideoProcessorSetStreamDestRect(vproc.Get(), 0, TRUE, &dst);
    D3D11_VIDEO_PROCESSOR_STREAM stream{};
    stream.Enable = TRUE;
    stream.pInputSurface = inView.Get();
    vctx->VideoProcessorBlt(vproc.Get(), outView.Get(), 0, 1, &stream);
  }
};

// ---- sound in: the computer's (WASAPI loopback) or the microphone, as 48 kHz stereo 16-bit -------------

struct AudioIn {
  ComPtr<IAudioClient> client;
  ComPtr<IAudioCaptureClient> capture;
  UINT rate = 48000, channels = 2;
  bool isFloat = true;
  UINT bits = 32;
  std::thread worker;
  std::atomic<bool> running{false};
  std::mutex lock;
  std::vector<int16_t> pending; // interleaved stereo at 48 kHz
  double resamplePos = 0;
  float lastL = 0, lastR = 0;

  bool open(bool loopback) {
    ComPtr<IMMDeviceEnumerator> en;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en)))) return false;
    ComPtr<IMMDevice> dev;
    if (FAILED(en->GetDefaultAudioEndpoint(loopback ? eRender : eCapture, eConsole, &dev))) return false;
    if (FAILED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.GetAddressOf())))) return false;
    WAVEFORMATEX* mix = nullptr;
    if (FAILED(client->GetMixFormat(&mix))) return false;
    rate = mix->nSamplesPerSec; channels = mix->nChannels; bits = mix->wBitsPerSample;
    isFloat = mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
      (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE && reinterpret_cast<WAVEFORMATEXTENSIBLE*>(mix)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
    HRESULT hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0, 2000000, 0, mix, nullptr);
    CoTaskMemFree(mix);
    if (FAILED(hr) || FAILED(client->GetService(IID_PPV_ARGS(&capture)))) return false;
    if (FAILED(client->Start())) return false;
    running = true;
    worker = std::thread([this] { loop(); });
    return true;
  }

  float sampleAt(const BYTE* data, UINT frame, UINT ch) const {
    UINT c = std::min(ch, channels - 1);
    if (isFloat && bits == 32) return reinterpret_cast<const float*>(data)[frame * channels + c];
    if (bits == 16) return reinterpret_cast<const int16_t*>(data)[frame * channels + c] / 32768.0f;
    if (bits == 32) return reinterpret_cast<const int32_t*>(data)[frame * channels + c] / 2147483648.0f;
    return 0;
  }

  void loop() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    while (running) {
      UINT32 packet = 0;
      while (running && SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet) {
        BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
        if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
        std::vector<int16_t> out;
        out.reserve(static_cast<size_t>(frames * 48000.0 / rate + 4) * 2);
        const double step = static_cast<double>(rate) / 48000.0;
        // linear resampling to 48 kHz (a plain copy when the device runs at 48 kHz)
        for (; resamplePos < frames; resamplePos += step) {
          UINT f = static_cast<UINT>(resamplePos);
          float k = static_cast<float>(resamplePos - f);
          float l0 = f == 0 ? lastL : 0, r0 = f == 0 ? lastR : 0, l1 = 0, r1 = 0;
          if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
            l1 = sampleAt(data, f, 0); r1 = sampleAt(data, f, 1);
            if (f > 0) { l0 = sampleAt(data, f - 1, 0); r0 = sampleAt(data, f - 1, 1); }
          }
          float l = step == 1.0 ? l1 : l0 + (l1 - l0) * k, r = step == 1.0 ? r1 : r0 + (r1 - r0) * k;
          out.push_back(static_cast<int16_t>(std::max(-1.0f, std::min(1.0f, l)) * 32767));
          out.push_back(static_cast<int16_t>(std::max(-1.0f, std::min(1.0f, r)) * 32767));
        }
        resamplePos -= frames;
        if (frames && !(flags & AUDCLNT_BUFFERFLAGS_SILENT)) { lastL = sampleAt(data, frames - 1, 0); lastR = sampleAt(data, frames - 1, 1); }
        capture->ReleaseBuffer(frames);
        std::lock_guard<std::mutex> g(lock);
        pending.insert(pending.end(), out.begin(), out.end());
        if (pending.size() > 48000 * 2 * 4) pending.erase(pending.begin(), pending.end() - 48000 * 2); // never more than a second behind
      }
      Sleep(5);
    }
    CoUninitialize();
  }

  std::vector<int16_t> take() {
    std::lock_guard<std::mutex> g(lock);
    std::vector<int16_t> v;
    v.swap(pending);
    return v;
  }

  void close() {
    running = false;
    if (worker.joinable()) worker.join();
    if (client) client->Stop();
  }
};

// ---- one MP4 (or fragmented MP4) being written -------------------------------------------------------

struct Writer {
  ComPtr<IMFSinkWriter> sink;
  ComPtr<IMFVideoSampleAllocatorEx> alloc;
  ComPtr<IMFDXGIDeviceManager> manager;
  DWORD v = 0, a = 0;
  bool hasAudio = false;
  LONGLONG audioFrames = 0;  // 48 kHz frames written
  LONGLONG start = 0;        // QPC of the first frame
  LONGLONG lastFrame = -1;   // index of the last video frame written
  LONGLONG frameDur = 0;
  std::wstring path;
  ID3D11DeviceContext* ctx = nullptr;

  bool open(const std::wstring& file, bool fragmented, Screen& s, int fps, UINT32 bitrate, bool audio) {
    path = file;
    ctx = s.ctx.Get();
    hasAudio = audio;
    lastFrame = -1;
    audioFrames = 0;
    micGain = 0;
    sysBuf.clear();
    micBuf.clear();
    frameDur = 10000000LL / fps;
    UINT token = 0;
    CHECK(MFCreateDXGIDeviceManager(&token, &manager), "dxgi manager");
    CHECK(manager->ResetDevice(s.device.Get(), token), "dxgi manager device");
    ComPtr<IMFAttributes> attrs;
    MFCreateAttributes(&attrs, 4);
    attrs->SetUnknown(MF_SINK_WRITER_D3D_MANAGER, manager.Get());
    attrs->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
    attrs->SetGUID(MF_TRANSCODE_CONTAINERTYPE, fragmented ? MFTranscodeContainerType_FMPEG4 : MFTranscodeContainerType_MPEG4);
    CHECK(MFCreateSinkWriterFromURL(file.c_str(), nullptr, attrs.Get(), &sink), "sink writer");

    ComPtr<IMFMediaType> out, in;
    MFCreateMediaType(&out);
    out->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    out->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
    out->SetUINT32(MF_MT_AVG_BITRATE, bitrate);
    out->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    out->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High);
    MFSetAttributeSize(out.Get(), MF_MT_FRAME_SIZE, s.width, s.height);
    MFSetAttributeRatio(out.Get(), MF_MT_FRAME_RATE, fps, 1);
    MFSetAttributeRatio(out.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    out->SetUINT32(MF_MT_MAX_KEYFRAME_SPACING, static_cast<UINT32>(fps));
    CHECK(sink->AddStream(out.Get(), &v), "video stream");
    MFCreateMediaType(&in);
    in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_ARGB32);
    in->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    MFSetAttributeSize(in.Get(), MF_MT_FRAME_SIZE, s.width, s.height);
    MFSetAttributeRatio(in.Get(), MF_MT_FRAME_RATE, fps, 1);
    MFSetAttributeRatio(in.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    CHECK(sink->SetInputMediaType(v, in.Get(), nullptr), "video input");

    // a key frame every second: replays start on one, players seek well
    ComPtr<IMFSinkWriterEx> ex;
    if (SUCCEEDED(sink.As(&ex))) {
      GUID cat; ComPtr<IMFTransform> enc;
      for (DWORD k = 0; SUCCEEDED(ex->GetTransformForStream(v, k, &cat, &enc)); k++, enc.Reset()) {
        if (cat != MFT_CATEGORY_VIDEO_ENCODER) continue;
        ComPtr<ICodecAPI> api;
        if (SUCCEEDED(enc.As(&api))) {
          VARIANT gop; VariantInit(&gop); gop.vt = VT_UI4; gop.ulVal = static_cast<ULONG>(fps);
          api->SetValue(&CODECAPI_AVEncMPVGOPSize, &gop);
        }
      }
    }

    if (audio) {
      ComPtr<IMFMediaType> aout, ain;
      MFCreateMediaType(&aout);
      aout->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
      aout->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC);
      aout->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
      aout->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000);
      aout->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
      aout->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24000);
      if (FAILED(sink->AddStream(aout.Get(), &a))) hasAudio = false;
      if (hasAudio) {
        MFCreateMediaType(&ain);
        ain->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
        ain->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
        ain->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
        ain->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000);
        ain->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
        ain->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, 4);
        ain->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 192000);
        if (FAILED(sink->SetInputMediaType(a, ain.Get(), nullptr))) hasAudio = false;
      }
    }

    CHECK(MFCreateVideoSampleAllocatorEx(IID_PPV_ARGS(&alloc)), "sample allocator");
    CHECK(alloc->SetDirectXManager(manager.Get()), "allocator device");
    ComPtr<IMFAttributes> aa;
    MFCreateAttributes(&aa, 2);
    aa->SetUINT32(MF_SA_D3D11_BINDFLAGS, D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET);
    CHECK(alloc->InitializeSampleAllocatorEx(4, 16, aa.Get(), in.Get()), "allocator init");
    CHECK(sink->BeginWriting(), "begin writing");
    start = qpcNow();
    return true;
  }

  // The frame due now (by the clock), from the screen's latest picture.
  void video(Screen& s, LONGLONG now, int fps) {
    LONGLONG index = hns(now - start) * fps / 10000000LL;
    if (index <= lastFrame) return;
    ComPtr<IMFSample> sample;
    if (FAILED(alloc->AllocateSample(&sample))) return; // the encoder is behind: this frame is dropped
    ComPtr<IMFMediaBuffer> buf;
    ComPtr<IMFDXGIBuffer> dx;
    ComPtr<ID3D11Texture2D> tex;
    UINT sub = 0;
    if (FAILED(sample->GetBufferByIndex(0, &buf)) || FAILED(buf.As(&dx)) || FAILED(dx->GetResource(IID_PPV_ARGS(&tex))) || FAILED(dx->GetSubresourceIndex(&sub))) return;
    ctx->CopySubresourceRegion(tex.Get(), sub, 0, 0, 0, s.latest.Get(), 0, nullptr);
    buf->SetCurrentLength(s.width * s.height * 4);
    sample->SetSampleTime(index * frameDur);
    sample->SetSampleDuration(frameDur);
    if (SUCCEEDED(sink->WriteSample(v, sample.Get()))) lastFrame = index;
  }

  // The sound, strictly by the clock: every call writes exactly the time
  // since the last one. The computer's sound and our voice (its gain follows
  // whether we're talking, softly) fill it; what hasn't arrived is silence
  // (the loopback sends nothing while nothing plays), what's too late is
  // dropped — so the sound never drifts off the picture.
  float micGain = 0;
  std::vector<int16_t> sysBuf, micBuf;
  void sound(const std::vector<int16_t>& sysNew, const std::vector<int16_t>& micNew, bool micOpen, LONGLONG now) {
    if (!hasAudio) return;
    sysBuf.insert(sysBuf.end(), sysNew.begin(), sysNew.end());
    micBuf.insert(micBuf.end(), micNew.begin(), micNew.end());
    const size_t keep = 48000 / 5 * 2; // at most 200 ms waiting
    if (sysBuf.size() > keep * 2) sysBuf.erase(sysBuf.begin(), sysBuf.end() - keep);
    if (micBuf.size() > keep * 2) micBuf.erase(micBuf.begin(), micBuf.end() - keep);
    LONGLONG due = hns(now - start) * 48000 / 10000000LL;
    LONGLONG frames = due - audioFrames;
    if (frames < 480) return; // 10 ms at a time at least
    std::vector<int16_t> pcm(static_cast<size_t>(frames) * 2, 0);
    size_t fromSys = std::min(pcm.size(), sysBuf.size() & ~size_t(1));
    std::copy(sysBuf.begin(), sysBuf.begin() + fromSys, pcm.begin());
    sysBuf.erase(sysBuf.begin(), sysBuf.begin() + fromSys);
    size_t fromMic = std::min(pcm.size(), micBuf.size() & ~size_t(1));
    const float target = micOpen ? 1.0f : 0.0f;
    for (size_t i = 0; i < pcm.size(); i += 2) {
      micGain += (target - micGain) * (micOpen ? 0.004f : 0.0006f); // ~5 ms in, ~35 ms out
      if (i + 1 >= fromMic) continue;
      for (int c = 0; c < 2; c++) {
        int v = pcm[i + c] + static_cast<int>(micBuf[i + c] * micGain);
        pcm[i + c] = static_cast<int16_t>(std::max(-32768, std::min(32767, v)));
      }
    }
    micBuf.erase(micBuf.begin(), micBuf.begin() + fromMic);
    const DWORD bytes = static_cast<DWORD>(pcm.size() * sizeof(int16_t));
    ComPtr<IMFMediaBuffer> buf;
    if (FAILED(MFCreateMemoryBuffer(bytes, &buf))) return;
    BYTE* p = nullptr;
    buf->Lock(&p, nullptr, nullptr);
    memcpy(p, pcm.data(), bytes);
    buf->Unlock();
    buf->SetCurrentLength(bytes);
    ComPtr<IMFSample> sample;
    MFCreateSample(&sample);
    sample->AddBuffer(buf.Get());
    sample->SetSampleTime(audioFrames * 10000000LL / 48000);
    sample->SetSampleDuration(frames * 10000000LL / 48000);
    sink->WriteSample(a, sample.Get());
    audioFrames += frames;
  }

  // seconds written
  double close() {
    double secs = (lastFrame + 1) * frameDur / 1e7;
    if (sink) sink->Finalize();
    sink.Reset();
    alloc.Reset();
    manager.Reset();
    return secs;
  }
};

// ---- replay: rotated fragmented segments, cut into a normal MP4 ---------------------------------------

struct Segment { std::wstring path; LONGLONG start; LONGLONG duration; UINT width, height; };

// An H.264 sample from an MP4 (length-prefixed NAL units, or start codes):
// does it hold an IDR picture? The source's clean-point flag isn't reliable.
bool idr(IMFSample* sample) {
  ComPtr<IMFMediaBuffer> buf;
  if (FAILED(sample->ConvertToContiguousBuffer(&buf))) return false;
  BYTE* p = nullptr; DWORD len = 0;
  if (FAILED(buf->Lock(&p, nullptr, &len))) return false;
  bool found = false;
  if (len >= 4 && p[0] == 0 && p[1] == 0 && (p[2] == 1 || (p[2] == 0 && p[3] == 1))) {
    for (DWORD i = 0; i + 3 < len && !found; i++)
      if (p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 1 && (p[i + 3] & 0x1F) == 5) found = true;
  } else {
    for (DWORD i = 0; i + 4 < len && !found;) {
      DWORD n = (DWORD(p[i]) << 24) | (DWORD(p[i + 1]) << 16) | (DWORD(p[i + 2]) << 8) | p[i + 3];
      if ((p[i + 4] & 0x1F) == 5) found = true;
      if (n == 0 || n > len - i - 4) break;
      i += 4 + n;
    }
  }
  buf->Unlock();
  return found;
}

// The last `seconds` of the finished segments into `out`: compressed samples
// copied as they are, from the first key frame of that span, times from 0.
bool cut(const std::vector<Segment>& segs, double seconds, const std::wstring& out, double& written) {
  if (segs.empty()) { fail("replay is empty"); return false; }
  const Segment& last = segs.back();
  std::vector<Segment> use;
  for (const auto& s : segs) if (s.width == last.width && s.height == last.height) use.push_back(s); // a resized game: only matching parts
  LONGLONG end = last.start + last.duration;
  LONGLONG from = std::max(use.front().start, end - static_cast<LONGLONG>(seconds * 1e7));
  ComPtr<IMFSinkWriter> sink;
  DWORD outV = 0, outA = 0;
  const DWORD vIdxOut = 0; // which output a held sample goes to: 0 video, 1 sound
  bool haveA = false, started = false;
  LONGLONG t0 = 0, lastT = 0;
  // until the span starts: the samples since the newest key frame before it
  struct Held { DWORD idx; LONGLONG abs; ComPtr<IMFSample> sample; };
  std::vector<Held> held;
  LONGLONG heldFrom = -1;
  auto put = [&](DWORD idx, LONGLONG abs, IMFSample* sample) {
    if (abs < t0) return;
    sample->SetSampleTime(abs - t0);
    if (idx == vIdxOut) { sink->WriteSample(outV, sample); LONGLONG d = 0; sample->GetSampleDuration(&d); lastT = std::max(lastT, abs - t0 + d); }
    else if (haveA) sink->WriteSample(outA, sample);
  };
  for (const auto& seg : use) {
    if (seg.start + seg.duration <= from) continue;
    ComPtr<IMFSourceReader> reader;
    CHECK(MFCreateSourceReaderFromURL(seg.path.c_str(), nullptr, &reader), "replay read");
    DWORD vIdx = MAXDWORD, aIdx = MAXDWORD;
    for (DWORD i = 0;; i++) {
      ComPtr<IMFMediaType> native;
      if (FAILED(reader->GetNativeMediaType(i, 0, &native))) break;
      GUID major; native->GetMajorType(&major);
      reader->SetStreamSelection(i, TRUE);
      reader->SetCurrentMediaType(i, nullptr, native.Get());
      if (major == MFMediaType_Video && vIdx == MAXDWORD) vIdx = i;
      else if (major == MFMediaType_Audio && aIdx == MAXDWORD) aIdx = i;
      else reader->SetStreamSelection(i, FALSE);
    }
    if (vIdx == MAXDWORD) continue;
    if (!sink) {
      ComPtr<IMFAttributes> attrs;
      MFCreateAttributes(&attrs, 1);
      attrs->SetGUID(MF_TRANSCODE_CONTAINERTYPE, MFTranscodeContainerType_MPEG4);
      CHECK(MFCreateSinkWriterFromURL(out.c_str(), nullptr, attrs.Get(), &sink), "replay write");
      ComPtr<IMFMediaType> vt, at;
      reader->GetCurrentMediaType(vIdx, &vt);
      CHECK(sink->AddStream(vt.Get(), &outV), "replay video");
      CHECK(sink->SetInputMediaType(outV, vt.Get(), nullptr), "replay video type");
      if (aIdx != MAXDWORD && SUCCEEDED(reader->GetCurrentMediaType(aIdx, &at)) && SUCCEEDED(sink->AddStream(at.Get(), &outA)) &&
          SUCCEEDED(sink->SetInputMediaType(outA, at.Get(), nullptr))) haveA = true;
      CHECK(sink->BeginWriting(), "replay begin");
    }
    for (;;) {
      DWORD idx = 0, flags = 0; LONGLONG ts = 0;
      ComPtr<IMFSample> sample;
      if (FAILED(reader->ReadSample(MF_SOURCE_READER_ANY_STREAM, 0, &idx, &flags, &ts, &sample))) break;
      if (flags & MF_SOURCE_READERF_ENDOFSTREAM) {
        // that stream is done; the file is done when every chosen one is
        reader->SetStreamSelection(idx, FALSE);
        BOOL v = FALSE, a = FALSE;
        reader->GetStreamSelection(vIdx, &v);
        if (aIdx != MAXDWORD) reader->GetStreamSelection(aIdx, &a);
        if (!v && !a) break;
        continue;
      }
      if (!sample) continue;
      LONGLONG abs = seg.start + ts;
      if (idx != vIdx && idx != aIdx) continue;
      DWORD kind = idx == vIdx ? vIdxOut : vIdxOut + 1;
      if (!started) {
        if (idx == vIdx && (abs <= from || heldFrom < 0) && idr(sample.Get())) {
          held.clear();
          heldFrom = abs;
        }
        if (heldFrom < 0) continue;
        held.push_back({kind, abs, sample});
        if (abs < from && idx == vIdx) continue;
        if (abs < from) continue;
        started = true;
        t0 = heldFrom;
        for (auto& h : held) put(h.idx, h.abs, h.sample.Get());
        held.clear();
        continue;
      }
      put(kind, abs, sample.Get());
    }
  }
  if (!sink || !started) { fail("replay has no key frame yet"); if (sink) sink->Finalize(); return false; }
  CHECK(sink->Finalize(), "replay finalize");
  written = lastT / 1e7;
  return true;
}

// ---- the session ---------------------------------------------------------------------------------

std::mutex cmdLock;
std::deque<Command> commands;
std::atomic<bool> quit{false};

void reader() {
  std::string line;
  int ch;
  while ((ch = fgetc(stdin)) != EOF) {
    if (ch == '\n') {
      Command c;
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (!line.empty()) {
        try {
          if (parse(line, c)) { std::lock_guard<std::mutex> g(cmdLock); commands.push_back(c); }
          else fail("bad command");
        } catch (...) { fail("bad command"); }
      }
      line.clear();
    } else line += static_cast<char>(ch);
  }
  quit = true; // the launcher went away: finish the file and leave
}

bool nextCommand(Command& c) {
  std::lock_guard<std::mutex> g(cmdLock);
  if (commands.empty()) return false;
  c = commands.front();
  commands.pop_front();
  return true;
}

int run() {
  std::thread(reader).detach();
  Command start;
  while (!quit) {
    if (nextCommand(start) && start.cmd == "start") break;
    Sleep(10);
  }
  if (quit) return 0;
  HWND game = mainWindow(start.pid);
  if (!game) { fail("game window not found"); return 1; }
  Screen screen;
  if (!screen.open(game)) return 1;
  AudioIn system, mic;
  const bool sysOn = start.audio && system.open(true);
  const bool micOn = start.mic && mic.open(false);
  const bool audio = sysOn || micOn;
  std::atomic<bool> micOpen{false};
  const bool replay = start.mode == "replay";
  const int fps = start.fps;
  std::vector<Segment> done;
  int segNo = 0;
  const LONGLONG origin = qpcNow();
  // the replay lives in one-minute parts; as many are kept as cover its length
  const LONGLONG rotate = 60 * FREQ;
  auto segPath = [&](int n) { return (fs::path(start.dir) / (L"segment-" + std::to_wstring(n) + L".mp4")).wstring(); };
  Writer w;
  auto openWriter = [&]() -> bool {
    std::wstring file = replay ? segPath(segNo++) : start.file;
    if (replay) { std::error_code ec; fs::create_directories(start.dir, ec); }
    return w.open(file, replay, screen, fps, start.bitrate, audio);
  };
  if (!openWriter()) { system.close(); mic.close(); return 1; }
  emit("{\"ev\":\"started\",\"width\":" + std::to_string(screen.width) + ",\"height\":" + std::to_string(screen.height) + ",\"audio\":" + (w.hasAudio ? "true" : "false") + "}");

  auto finishSegment = [&]() {
    Segment seg{w.path, hns(w.start - origin), 0, screen.width, screen.height};
    double secs = w.close();
    seg.duration = static_cast<LONGLONG>(secs * 1e7);
    done.push_back(seg);
    // keep what a replay can need: the newest finished parts covering its length
    LONGLONG total = 0;
    for (const auto& d : done) total += d.duration;
    const LONGLONG need = static_cast<LONGLONG>(start.seconds * 1e7);
    while (done.size() > 1 && total - done.front().duration >= need) {
      total -= done.front().duration;
      std::error_code ec;
      fs::remove(done.front().path, ec);
      done.erase(done.begin());
    }
  };

  HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
  if (!timer) timeBeginPeriod(1);
  std::thread cutter;
  std::atomic<bool> cutting{false};
  bool stop = false;
  while (!stop && !quit) {
    Command c;
    while (nextCommand(c)) {
      if (c.cmd == "stop") stop = true;
      else if (c.cmd == "mic") micOpen = c.open;
      else if (c.cmd == "save" && replay && !cutting) {
        finishSegment();
        if (!openWriter()) { stop = true; break; }
        std::vector<Segment> segs = done;
        std::wstring file = c.file;
        double secs = c.seconds;
        if (cutter.joinable()) cutter.join();
        cutting = true;
        cutter = std::thread([segs, file, secs, &cutting] {
          CoInitializeEx(nullptr, COINIT_MULTITHREADED);
          double written = 0;
          if (cut(segs, secs, file, written)) emit("{\"ev\":\"saved\",\"seconds\":" + std::to_string(written) + "}");
          CoUninitialize();
          cutting = false;
        });
      }
    }
    if (stop) break;
    if (!IsWindow(game)) { fail("game closed"); break; }
    LONGLONG now = qpcNow();
    screen.grab();
    screen.compose();
    w.video(screen, now, fps);
    if (audio) w.sound(sysOn ? system.take() : std::vector<int16_t>(), micOn ? mic.take() : std::vector<int16_t>(), micOpen, now);
    if (replay && now - w.start > rotate && !cutting) {
      finishSegment();
      if (!openWriter()) break;
    }
    // sleep until the next frame is due
    LONGLONG next = w.start + (w.lastFrame + 1) * FREQ / fps;
    LONGLONG wait = next - qpcNow();
    if (wait > 0) {
      if (timer) {
        LARGE_INTEGER due; due.QuadPart = -hns(wait);
        SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE);
        WaitForSingleObject(timer, 100);
      } else Sleep(static_cast<DWORD>(std::max(1LL, wait * 1000 / FREQ)));
    }
  }
  if (cutter.joinable()) cutter.join();
  double secs = w.close();
  if (replay) {
    std::error_code ec;
    fs::remove_all(start.dir, ec);
  }
  system.close();
  mic.close();
  emit("{\"ev\":\"stopped\",\"seconds\":" + std::to_string(secs) + "}");
  if (timer) CloseHandle(timer);
  return 0;
}

}  // namespace

int wmain() {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) || FAILED(MFStartup(MF_VERSION))) { fail("media foundation"); return 1; }
  int code = run();
  MFShutdown();
  CoUninitialize();
  return code;
}
