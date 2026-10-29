// WebNav's headless FreeRDP adapter. stdout is exclusively a bounded binary protocol.
// No command-line credentials, OS clipboard access, drive redirection or shell execution.
#include <windows.h>
#include <wincodec.h>
#include <wincrypt.h>
#include <wrl/client.h>
#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/client/disp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/channels/rdpgfx.h>
#include <freerdp/codec/color.h>
#include <freerdp/input.h>
#include <freerdp/scancode.h>
#include <freerdp/error.h>
#include <winpr/input.h>
#include <winpr/wlog.h>
#include <algorithm>
#include <atomic>
#include <array>
#include <deque>
#include <mutex>
#include <condition_variable>
#include <chrono>
#include <string>
#include <thread>
#include <vector>
#include <stdexcept>
#include <cstring>
#include <future>
using Bytes = std::vector<BYTE>;
using Microsoft::WRL::ComPtr;
constexpr size_t MAX_RECORD = 1024 * 1024;
constexpr UINT TILE = 256;
static HANDLE pipeIn, pipeOut;
static void require(bool ok) { if (!ok) throw std::runtime_error("RDP adapter failure"); }
static UINT32 u32(const BYTE* p) { UINT32 v; memcpy(&v, p, 4); return v; }
static void append(Bytes& b, UINT32 n) { auto p = reinterpret_cast<BYTE*>(&n); b.insert(b.end(), p, p + 4); }
static Bytes nums(std::initializer_list<UINT32> values) { Bytes b; for (auto v : values) append(b,v); return b; }
static bool readAll(void* p, size_t len) {
  auto bytes = static_cast<BYTE*>(p);
  while (len) { DWORD n = 0; if (!ReadFile(pipeIn,bytes,static_cast<DWORD>(len),&n,nullptr) || !n) return false; bytes += n; len -= n; }
  return true;
}
static bool readRecord(UINT32& type, Bytes& b) {
  UINT32 h[2]; if (!readAll(h,sizeof(h))) return false;
  require(h[1] <= MAX_RECORD); type = h[0]; b.resize(h[1]); return readAll(b.data(),b.size());
}
static void output(UINT32 type, const Bytes& payload) {
  require(payload.size() <= MAX_RECORD); Bytes record = nums({type,static_cast<UINT32>(payload.size())}); record.insert(record.end(),payload.begin(),payload.end());
  size_t at = 0; while (at < record.size()) { DWORD n = 0; require(WriteFile(pipeOut,record.data()+at,static_cast<DWORD>(record.size()-at),&n,nullptr) && n); at += n; }
}
struct Config {
  std::string host,user,domain,password,certs;
  UINT32 port,width,height,security; bool tofu,fixed;
  explicit Config(const Bytes& data) {
    size_t at=0;
    auto number=[&]() { require(at+4<=data.size()); auto v=u32(data.data()+at); at+=4; return v; };
    auto text=[&]() { auto n=number(); require(n<=65536 && at+n<=data.size()); std::string v(reinterpret_cast<const char*>(data.data()+at),n); at+=n; require(v.find('\0')==std::string::npos); return v; };
    require(number()==1); host=text(); port=number(); user=text(); domain=text(); password=text(); width=number(); height=number(); security=number(); tofu=number()!=0; fixed=number()!=0; certs=text();
    require(at==data.size() && !host.empty() && port>0 && port<=65535 && width>=200 && width<=4096 && height>=200 && height<=2160 && security<=3 && !certs.empty());
  }
  ~Config() { SecureZeroMemory(password.data(),password.size()); }
};
struct Command { UINT32 type; Bytes data; };
struct DirtyRegion {
  UINT left=TILE,top=TILE,right=0,bottom=0;
  bool empty() const { return left>=right || top>=bottom; }
  void include(UINT l,UINT t,UINT r,UINT b) { left=std::min(left,l); top=std::min(top,t); right=std::max(right,r); bottom=std::max(bottom,b); }
};
static UINT64 clockUs() { return std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
struct PendingFrame { UINT32 sequence; UINT64 sentAt; };
// A bounded per-session encoder pool. Large desktops use four quadrants from the
// same locked framebuffer; no extra frames or background screenshots are queued.
class EncoderPool {
  using Task=std::packaged_task<Bytes(IWICImagingFactory*)>;
  std::vector<std::thread> workers;
  std::deque<Task> jobs;
  std::mutex mutex;
  std::condition_variable ready;
  size_t active=0;
  bool stopping=false;
  void stop() {
    {std::lock_guard lock(mutex); stopping=true;} ready.notify_all();
    for(auto& worker:workers) if(worker.joinable()) worker.join();
  }
public:
  EncoderPool() {
    try { for(int i=0;i<4;i++) workers.emplace_back([this] {
      bool com=SUCCEEDED(CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED)); ComPtr<IWICImagingFactory> imaging;
      if(com) CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&imaging));
      for(;;) {
        Task task;
        { std::unique_lock lock(mutex); ready.wait(lock,[this]{return stopping || !jobs.empty();}); if(stopping) break; task=std::move(jobs.front()); jobs.pop_front(); active++; }
        task(imaging.Get());
        {std::lock_guard lock(mutex); active--;} ready.notify_all();
      }
      imaging.Reset(); if(com) CoUninitialize();
    }); } catch(...) { stop(); throw; }
  }
  ~EncoderPool() { stop(); }
  void drain() { std::unique_lock lock(mutex); ready.wait(lock,[this]{return jobs.empty() && active==0;}); }
  std::future<Bytes> submit(Task job) {
    auto result=job.get_future(); {std::lock_guard lock(mutex); require(!stopping && jobs.size()<4); jobs.push_back(std::move(job));} ready.notify_one(); return result;
  }
};
struct State {
  ComPtr<IWICImagingFactory> imaging;
  std::unique_ptr<EncoderPool> encoders;
  std::atomic_bool stopping=false;
  std::mutex mutex;
  // GFX channels are created/destroyed by FreeRDP's DVC worker. Its public
  // gdi->gfx pointer is assigned before gfx->mux is initialized, so protect
  // that lifetime separately from the framebuffer critical section.
  std::mutex graphicsLifecycle;
  std::deque<Command> commands;
  size_t commandBytes=0;
  std::array<DirtyRegion,16*9> dirty{};
  UINT32 sequence=0,mouse=0,shownWidth=0,shownHeight=0;
  std::deque<PendingFrame> pendingFrames;
  UINT64 lastFrameAt=0,lastPaintAt=0;
  bool refine=false,viewing=true;
  HANDLE commandsReady=nullptr;
  HANDLE paintReady=nullptr;
  std::atomic_uint32_t paints=0,gfxFrames=0;
  pcRdpgfxEndFrame gfxEndFrame=nullptr;
  bool fixed=false;
  std::atomic_bool displayReady=false,clipReady=false;
  DispClientContext* display=nullptr;
  CliprdrClientContext* clip=nullptr;
  std::wstring localClipboard;
  Bytes remoteClipboard,pendingCursor,currentCursor;
  bool remoteChanged=false;
  UINT32 failureStage=0;
  DWORD failureDetail=0;
  std::condition_variable certificateReady;
  bool certificateWaiting=false;
  int certificateDecision=0;
};
struct Context { rdpClientContext common; State* state; };
static State& state(rdpContext* ctx) { return *reinterpret_cast<Context*>(ctx)->state; }
struct PaintLock {
  std::unique_lock<std::mutex> lifetime;
  RdpgfxClientContext* gfx;
  explicit PaintLock(rdpContext* ctx):lifetime(state(ctx).graphicsLifecycle),gfx(ctx->gdi->gfx) { if(gfx) EnterCriticalSection(&gfx->mux); }
  ~PaintLock() { if(gfx) LeaveCriticalSection(&gfx->mux); }
};
static Bytes encodeImage(IWICImagingFactory* imaging, const BYTE* data, UINT width, UINT height, UINT stride, bool jpeg=false) {
  ComPtr<IStream> stream; ComPtr<IWICBitmapEncoder> encoder; ComPtr<IWICBitmapFrameEncode> frame; ComPtr<IPropertyBag2> props;
  require(SUCCEEDED(CreateStreamOnHGlobal(nullptr,TRUE,&stream)));
  require(imaging && SUCCEEDED(imaging->CreateEncoder(jpeg?GUID_ContainerFormatJpeg:GUID_ContainerFormatPng,nullptr,&encoder)));
  require(SUCCEEDED(encoder->Initialize(stream.Get(),WICBitmapEncoderNoCache)));
  require(SUCCEEDED(encoder->CreateNewFrame(&frame,&props)));
  if(jpeg) {
    PROPBAG2 option{}; option.pstrName=const_cast<wchar_t*>(L"ImageQuality"); VARIANT value{}; value.vt=VT_R4; value.fltVal=0.85f;
    require(SUCCEEDED(props->Write(1,&option,&value)));
  }
  require(SUCCEEDED(frame->Initialize(props.Get())));
  require(SUCCEEDED(frame->SetSize(width,height)));
  WICPixelFormatGUID expected=jpeg?GUID_WICPixelFormat24bppBGR:GUID_WICPixelFormat32bppBGRA,format=expected;
  require(SUCCEEDED(frame->SetPixelFormat(&format)) && IsEqualGUID(format,expected));
  // Copy rows: WIC's input size includes padding, which would read beyond a final framebuffer row.
  UINT bpp=jpeg?3:4; Bytes pixels(static_cast<size_t>(width)*height*bpp);
  for (UINT y=0;y<height;y++) {
    auto row=pixels.data()+y*width*bpp; auto source=data+y*stride;
    if(jpeg) for(UINT x=0;x<width;x++) { row[x*3]=source[x*4]; row[x*3+1]=source[x*4+1]; row[x*3+2]=source[x*4+2]; }
    else memcpy(row,source,width*4);
  }
  require(SUCCEEDED(frame->WritePixels(height,width*bpp,static_cast<UINT>(pixels.size()),pixels.data())));
  require(SUCCEEDED(frame->Commit()) && SUCCEEDED(encoder->Commit()));
  STATSTG stat{}; require(SUCCEEDED(stream->Stat(&stat,STATFLAG_NONAME)) && stat.cbSize.QuadPart<=static_cast<UINT64>(width)*height*4+65536);
  LARGE_INTEGER zero{}; require(SUCCEEDED(stream->Seek(zero,STREAM_SEEK_SET,nullptr)));
  Bytes result(static_cast<size_t>(stat.cbSize.QuadPart)); ULONG count=0;
  require(SUCCEEDED(stream->Read(result.data(),static_cast<ULONG>(result.size()),&count)) && count==result.size()); return result;
}
static void dirtyAll(rdpContext* ctx) {
  auto& dirty=state(ctx).dirty; dirty.fill({});
  UINT w=ctx->gdi->width,h=ctx->gdi->height;
  for(UINT y=0;y<h;y+=TILE) for(UINT x=0;x<w;x+=TILE) dirty[(y/TILE)*16+x/TILE].include(0,0,std::min(TILE,w-x),std::min(TILE,h-y));
}
static BOOL beginPaint(rdpContext* ctx) { ctx->gdi->primary->hdc->hwnd->invalid->null=TRUE; return TRUE; }
static BOOL endPaint(rdpContext* ctx) {
  const auto rect=ctx->gdi->primary->hdc->hwnd->invalid; if (rect->null) return TRUE;
  int left=std::max(0,rect->x),top=std::max(0,rect->y),right=std::min(static_cast<int>(ctx->gdi->width),rect->x+rect->w),bottom=std::min(static_cast<int>(ctx->gdi->height),rect->y+rect->h);
  if (left>=right || top>=bottom) return TRUE;
  state(ctx).lastPaintAt=clockUs();
  state(ctx).paints++;
  for(int y=top/TILE;y<=(bottom-1)/TILE;y++) for(int x=left/TILE;x<=(right-1)/TILE;x++) {
    int tx=x*TILE,ty=y*TILE;
    state(ctx).dirty[y*16+x].include(std::max(0,left-tx),std::max(0,top-ty),std::min(static_cast<int>(TILE),right-tx),std::min(static_cast<int>(TILE),bottom-ty));
  }
  // GFX EndPaint runs on the DVC thread after the network read has returned.
  // Wake the owner when pixels are ready, rather than waiting for its next poll.
  SetEvent(state(ctx).paintReady);
  return TRUE;
}
static BOOL resize(rdpContext* ctx) {
  auto w=freerdp_settings_get_uint32(ctx->settings,FreeRDP_DesktopWidth),h=freerdp_settings_get_uint32(ctx->settings,FreeRDP_DesktopHeight);
  if(w<200 || w>4096 || h<200 || h>2160) return FALSE;
  if(!gdi_resize(ctx->gdi,w,h)) return FALSE; dirtyAll(ctx); SetEvent(state(ctx).paintReady); return TRUE;
}
static BOOL pointerNew(rdpContext*,rdpPointer* p) { return p->width<=256 && p->height<=256; }
static void pointerFree(rdpContext*,rdpPointer*) {}
static BOOL pointerSet(rdpContext* ctx,rdpPointer* p) {
  try {
    if (!p->width || !p->height) return TRUE;
    Bytes pixels(p->width*p->height*4);
    require(freerdp_image_copy_from_pointer_data(pixels.data(),PIXEL_FORMAT_BGRA32,0,0,0,p->width,p->height,p->xorMaskData,p->lengthXorMask,p->andMaskData,p->lengthAndMask,p->xorBpp,&ctx->gdi->palette));
    auto& s=state(ctx); auto data=nums({p->xPos,p->yPos,p->width,p->height}); auto image=encodeImage(s.imaging.Get(),pixels.data(),p->width,p->height,p->width*4); data.insert(data.end(),image.begin(),image.end()); s.pendingCursor=std::move(data); return TRUE;
  } catch (...) { return FALSE; }
}
static BOOL pointerNull(rdpContext* ctx) {
  try { BYTE empty[4]{}; auto& s=state(ctx); s.pendingCursor=nums({0,0,1,1}); auto image=encodeImage(s.imaging.Get(),empty,1,1,4); s.pendingCursor.insert(s.pendingCursor.end(),image.begin(),image.end()); return TRUE; } catch (...) { return FALSE; }
}
static BOOL pointerDefault(rdpContext* ctx) {
  // A small visible arrow until the server provides its own cursor.
  rdpPointer unused{}; (void)unused;
  try { Bytes pixels(16*20*4); for(UINT y=0;y<17;y++) for(UINT x=0;x<=y/2;x++){auto i=(y*16+x)*4; pixels[i]=pixels[i+1]=pixels[i+2]=(x==0||x==y/2)?20:245; pixels[i+3]=255;}
    auto& s=state(ctx); s.pendingCursor=nums({0,0,16,20}); auto image=encodeImage(s.imaging.Get(),pixels.data(),16,20,64); s.pendingCursor.insert(s.pendingCursor.end(),image.begin(),image.end()); return TRUE;
  } catch (...) { return FALSE; }
}
static UINT advertiseClipboard(CliprdrClientContext* clip) {
  CLIPRDR_FORMAT format{CF_UNICODETEXT,nullptr}; CLIPRDR_FORMAT_LIST list{}; list.numFormats=1; list.formats=&format; return clip->ClientFormatList(clip,&list);
}
static UINT clipMonitor(CliprdrClientContext* clip,const CLIPRDR_MONITOR_READY*) {
  auto& s=state(clip->rdpcontext); CLIPRDR_GENERAL_CAPABILITY_SET general{}; general.capabilitySetType=CB_CAPSTYPE_GENERAL; general.capabilitySetLength=12; general.version=CB_CAPS_VERSION_2; general.generalFlags=CB_USE_LONG_FORMAT_NAMES;
  CLIPRDR_CAPABILITIES caps{}; caps.cCapabilitiesSets=1; caps.capabilitySets=reinterpret_cast<CLIPRDR_CAPABILITY_SET*>(&general);
  auto result=clip->ClientCapabilities(clip,&caps); if(result) return result; s.clipReady=true; return advertiseClipboard(clip);
}
static UINT clipCapabilities(CliprdrClientContext*,const CLIPRDR_CAPABILITIES*) { return CHANNEL_RC_OK; }
static UINT clipList(CliprdrClientContext* clip,const CLIPRDR_FORMAT_LIST* list) {
  if(list->numFormats>256) return ERROR_INVALID_DATA;
  CLIPRDR_FORMAT_LIST_RESPONSE response{}; response.common.msgFlags=CB_RESPONSE_OK; auto result=clip->ClientFormatListResponse(clip,&response); if(result) return result;
  for(UINT32 i=0;i<list->numFormats;i++) if(list->formats[i].formatId==CF_UNICODETEXT) { CLIPRDR_FORMAT_DATA_REQUEST request{}; request.requestedFormatId=CF_UNICODETEXT; return clip->ClientFormatDataRequest(clip,&request); } return CHANNEL_RC_OK;
}
static UINT clipRequest(CliprdrClientContext* clip,const CLIPRDR_FORMAT_DATA_REQUEST* request) {
  auto& s=state(clip->rdpcontext); std::wstring text; {std::lock_guard lock(s.mutex); text=s.localClipboard;}
  CLIPRDR_FORMAT_DATA_RESPONSE response{}; response.common.msgFlags=request->requestedFormatId==CF_UNICODETEXT?CB_RESPONSE_OK:CB_RESPONSE_FAIL;
  if(response.common.msgFlags==CB_RESPONSE_OK) { response.common.dataLen=static_cast<UINT32>((text.size()+1)*2); response.requestedFormatData=reinterpret_cast<const BYTE*>(text.c_str()); }
  return clip->ClientFormatDataResponse(clip,&response);
}
static UINT clipResponse(CliprdrClientContext* clip,const CLIPRDR_FORMAT_DATA_RESPONSE* response) {
  if(!(response->common.msgFlags&CB_RESPONSE_OK) || response->common.dataLen>128*1024 || response->common.dataLen%2) return CHANNEL_RC_OK;
  auto p=reinterpret_cast<const wchar_t*>(response->requestedFormatData); int len=static_cast<int>(response->common.dataLen/2); while(len && p[len-1]==0) len--;
  int bytes=len?WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,p,len,nullptr,0,nullptr,nullptr):0; if((len && bytes<=0) || bytes>65536) return CHANNEL_RC_OK;
  Bytes text(bytes); if(bytes) WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,p,len,reinterpret_cast<char*>(text.data()),bytes,nullptr,nullptr);
  auto& s=state(clip->rdpcontext); std::lock_guard lock(s.mutex); s.remoteClipboard=std::move(text); s.remoteChanged=true; return CHANNEL_RC_OK;
}
static UINT displayCaps(DispClientContext* display,UINT32,UINT32,UINT32) { static_cast<State*>(display->custom)->displayReady=true; return CHANNEL_RC_OK; }
static UINT gfxEndFrame(RdpgfxClientContext* gfx,const RDPGFX_END_FRAME_PDU* frame) {
  auto gdi=static_cast<rdpGdi*>(gfx->custom); auto& s=state(gdi->context);
  s.gfxFrames++; return s.gfxEndFrame(gfx,frame);
}
static void channelConnected(void* context,const ChannelConnectedEventArgs* e) {
  auto ctx=static_cast<rdpContext*>(context); auto& s=state(ctx);
  if(strcmp(e->name,CLIPRDR_SVC_CHANNEL_NAME)==0) {
    s.clip=static_cast<CliprdrClientContext*>(e->pInterface); s.clip->custom=ctx; s.clip->rdpcontext=ctx; s.clip->MonitorReady=clipMonitor; s.clip->ServerCapabilities=clipCapabilities; s.clip->ServerFormatList=clipList; s.clip->ServerFormatDataRequest=clipRequest; s.clip->ServerFormatDataResponse=clipResponse;
  } else if(strcmp(e->name,DISP_DVC_CHANNEL_NAME)==0) { s.display=static_cast<DispClientContext*>(e->pInterface); s.display->custom=&s; s.display->DisplayControlCaps=displayCaps; }
  else if(strcmp(e->name,RDPGFX_DVC_CHANNEL_NAME)==0) {
    std::lock_guard lifetime(s.graphicsLifecycle);
    freerdp_client_OnChannelConnectedEventHandler(&reinterpret_cast<Context*>(ctx)->common,e);
    auto gfx=static_cast<RdpgfxClientContext*>(e->pInterface); s.gfxEndFrame=gfx->EndFrame; gfx->EndFrame=::gfxEndFrame;
  } else freerdp_client_OnChannelConnectedEventHandler(&reinterpret_cast<Context*>(ctx)->common,e);
}
static void channelDisconnected(void* context,const ChannelDisconnectedEventArgs* e) {
  auto ctx=static_cast<rdpContext*>(context); auto& s=state(ctx);
  if(strcmp(e->name,CLIPRDR_SVC_CHANNEL_NAME)==0) { s.clip=nullptr; s.clipReady=false; }
  else if(strcmp(e->name,DISP_DVC_CHANNEL_NAME)==0) { s.display=nullptr; s.displayReady=false; }
  else if(strcmp(e->name,RDPGFX_DVC_CHANNEL_NAME)==0) {
    std::lock_guard lifetime(s.graphicsLifecycle);
    freerdp_client_OnChannelDisconnectedEventHandler(&reinterpret_cast<Context*>(ctx)->common,e);
    s.gfxEndFrame=nullptr;
  } else freerdp_client_OnChannelDisconnectedEventHandler(&reinterpret_cast<Context*>(ctx)->common,e);
}
static BOOL preConnect(freerdp* instance) {
  return PubSub_SubscribeChannelConnected(instance->context->pubSub,channelConnected)>=0 && PubSub_SubscribeChannelDisconnected(instance->context->pubSub,channelDisconnected)>=0;
}
static BOOL postConnect(freerdp* instance) {
  if(!gdi_init(instance,PIXEL_FORMAT_BGRA32) || !resize(instance->context)) return FALSE;
  auto ctx=instance->context; ctx->update->BeginPaint=beginPaint; ctx->update->EndPaint=endPaint; ctx->update->DesktopResize=resize;
  rdpPointer pointer{}; pointer.size=sizeof(rdpPointer); pointer.New=pointerNew; pointer.Free=pointerFree; pointer.Set=pointerSet; pointer.SetNull=pointerNull; pointer.SetDefault=pointerDefault; graphics_register_pointer(ctx->graphics,&pointer); return pointerDefault(ctx);
}
static void postDisconnect(freerdp* instance) { gdi_free(instance); }
static DWORD rejectCert(freerdp* instance,const char*,UINT16,const char*,const char*,const char*,const char*,DWORD) { state(instance->context).failureStage=8; return 0; }
static DWORD confirmChangedCertificate(freerdp* instance,const char*,UINT16,const char*,const char*,const char*,const char* fingerprint,const char*,const char*,const char* previous,DWORD) {
  auto& s=state(instance->context);
  try {
    Bytes payload;
    for(const char* text : {previous,fingerprint}) { require(text!=nullptr); size_t length=strnlen(text,1025); require(length>0 && length<=1024); append(payload,static_cast<UINT32>(length)); payload.insert(payload.end(),text,text+length); }
    {std::lock_guard lock(s.mutex); s.certificateWaiting=true; s.certificateDecision=0;}
    output(8,payload);
    std::unique_lock lock(s.mutex);
    s.certificateReady.wait_for(lock,std::chrono::seconds(125),[&] {return s.stopping || s.certificateDecision!=0;});
    s.certificateWaiting=false;
    if(!s.stopping && s.certificateDecision==1) return 1; // FreeRDP replaces the saved fingerprint.
  } catch(...) {}
  s.failureStage=9; return 0;
}
static int verifyWindowsCertificate(freerdp* instance,const BYTE* pem,size_t length,const char* hostname,UINT16,DWORD flags) {
  if(flags&VERIFY_CERT_FLAG_CHANGED || length>1024*1024) { state(instance->context).failureStage=8; return 0; }
  HCERTSTORE store=CertOpenStore(CERT_STORE_PROV_MEMORY,0,0,0,nullptr); if(!store) return 0;
  PCCERT_CONTEXT leaf=nullptr; PCCERT_CHAIN_CONTEXT chain=nullptr; int accepted=0;
  try {
    std::string source(reinterpret_cast<const char*>(pem),length); size_t at=0;
    while((at=source.find("-----BEGIN CERTIFICATE-----",at))!=std::string::npos) {
      auto end=source.find("-----END CERTIFICATE-----",at); require(end!=std::string::npos); end+=25; auto size=static_cast<DWORD>(end-at); DWORD decoded=0;
      require(CryptStringToBinaryA(source.data()+at,size,CRYPT_STRING_BASE64HEADER,nullptr,&decoded,nullptr,nullptr)); Bytes der(decoded);
      require(CryptStringToBinaryA(source.data()+at,size,CRYPT_STRING_BASE64HEADER,der.data(),&decoded,nullptr,nullptr)); PCCERT_CONTEXT item=nullptr;
      require(CertAddEncodedCertificateToStore(store,X509_ASN_ENCODING,der.data(),decoded,CERT_STORE_ADD_ALWAYS,&item)); if(!leaf) leaf=item; else CertFreeCertificateContext(item); at=end;
    }
    require(leaf!=nullptr); CERT_CHAIN_PARA params{}; params.cbSize=sizeof(params);
    require(CertGetCertificateChain(nullptr,leaf,nullptr,store,&params,CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL,nullptr,&chain));
    int count=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,hostname,-1,nullptr,0); require(count>0); std::wstring host(count,L'\0'); MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,hostname,-1,host.data(),count);
    SSL_EXTRA_CERT_CHAIN_POLICY_PARA ssl{}; ssl.cbSize=sizeof(ssl); ssl.dwAuthType=AUTHTYPE_SERVER; ssl.pwszServerName=host.data();
    CERT_CHAIN_POLICY_PARA policy{}; policy.cbSize=sizeof(policy); policy.pvExtraPolicyPara=&ssl;
    CERT_CHAIN_POLICY_STATUS status{}; status.cbSize=sizeof(status);
    if(CertVerifyCertificateChainPolicy(CERT_CHAIN_POLICY_SSL,chain,&policy,&status) && status.dwError==0) accepted=1;
    else state(instance->context).failureDetail=status.dwError;
  } catch(...) {}
  if(!accepted) state(instance->context).failureStage=8;
  if(chain) CertFreeCertificateChain(chain); if(leaf) CertFreeCertificateContext(leaf); CertCloseStore(store,0); return accepted;
}
static BOOL noPrompt(freerdp* instance,char**,char**,char**,rdp_auth_reason reason) {
  if(reason==AUTH_TLS || reason==AUTH_RDP) return TRUE;
  if(reason==AUTH_NLA) state(instance->context).failureStage=7;
  return FALSE;
}
static BOOL clientNew(freerdp* instance,rdpContext*) {
  instance->PreConnect=preConnect; instance->PostConnect=postConnect; instance->PostDisconnect=postDisconnect; instance->AuthenticateEx=noPrompt; instance->VerifyCertificateEx=rejectCert; instance->VerifyChangedCertificateEx=confirmChangedCertificate; instance->VerifyX509Certificate=verifyWindowsCertificate; return TRUE;
}
static UINT32 virtualKey(UINT32 key) {
  if(key>=0xffbe && key<=0xffd5) return VK_F1+key-0xffbe;
  if(key>=0xffb0 && key<=0xffb9) return VK_NUMPAD0+key-0xffb0;
  switch(key) {
    case 0xff08:return VK_BACK;case 0xff09:case 0xfe20:return VK_TAB;case 0xff0d:return VK_RETURN;case 0xff1b:return VK_ESCAPE;
    case 0xff50:return VK_HOME;case 0xff51:return VK_LEFT;case 0xff52:return VK_UP;case 0xff53:return VK_RIGHT;case 0xff54:return VK_DOWN;
    case 0xff55:return VK_PRIOR;case 0xff56:return VK_NEXT;case 0xff57:return VK_END;case 0xff63:return VK_INSERT;case 0xffff:return VK_DELETE;
    case 0xffe1:return VK_LSHIFT;case 0xffe2:return VK_RSHIFT;case 0xffe3:return VK_LCONTROL;case 0xffe4:return VK_RCONTROL;
    case 0xffe9:return VK_LMENU;case 0xffea:case 0xfe03:return VK_RMENU;case 0xffeb:return VK_LWIN;case 0xffec:return VK_RWIN;
    case 0xffe5:return VK_CAPITAL;case 0xff7f:return VK_NUMLOCK;case 0xff14:return VK_SCROLL;case 0xff61:return VK_SNAPSHOT;case 0xff67:return VK_APPS;
    case 0xffaa:return VK_MULTIPLY;case 0xffab:return VK_ADD;case 0xffad:return VK_SUBTRACT;case 0xffae:return VK_DECIMAL;case 0xffaf:return VK_DIVIDE;
    default: if(key>=32 && key<127) { SHORT vk=VkKeyScanExW(static_cast<wchar_t>(key),GetKeyboardLayout(0)); if(vk!=-1) return vk&255; } return 0;
  }
}
static UINT32 scanCode(UINT32 key) {
  // Navigation and right-side modifiers need E0 scancodes; plain VK lookup
  // does not include KBDEXT and may otherwise return zero (notably Delete).
  switch(key) {
    case 0xff50:return RDP_SCANCODE_HOME;case 0xff51:return RDP_SCANCODE_LEFT;case 0xff52:return RDP_SCANCODE_UP;
    case 0xff53:return RDP_SCANCODE_RIGHT;case 0xff54:return RDP_SCANCODE_DOWN;case 0xff55:return RDP_SCANCODE_PRIOR;
    case 0xff56:return RDP_SCANCODE_NEXT;case 0xff57:return RDP_SCANCODE_END;case 0xff63:return RDP_SCANCODE_INSERT;case 0xffff:return RDP_SCANCODE_DELETE;
    case 0xffe4:return RDP_SCANCODE_RCONTROL;case 0xffea:case 0xfe03:return RDP_SCANCODE_RMENU;
    case 0xffeb:return RDP_SCANCODE_LWIN;case 0xffec:return RDP_SCANCODE_RWIN;case 0xff67:return RDP_SCANCODE_APPS;
    case 0xff61:return RDP_SCANCODE_PRINTSCREEN;case 0xff13:return RDP_SCANCODE_PAUSE;case 0xff8d:return RDP_SCANCODE_RETURN_KP;case 0xffaf:return RDP_SCANCODE_DIVIDE;
    default: {auto vk=virtualKey(key); return vk?GetVirtualScanCodeFromVirtualKeyCode(vk,4):0;}
  }
}
static void command(rdpContext* ctx,const Command& c) {
  auto& s=state(ctx); auto input=ctx->input;
  auto n=[&](size_t index) { require((index+1)*4<=c.data.size()); return u32(c.data.data()+index*4); };
  if(c.type==2) {
    require(c.data.size()==8 && n(1)<=1); auto key=n(0),scan=scanCode(key); bool down=n(1)!=0;
    if(scan) require(freerdp_input_send_keyboard_event_ex(input,down,FALSE,scan));
    else if(key<0xff00 || (key&0xff000000)==0x01000000) { auto unicode=(key&0xff000000)==0x01000000?key&0xffffff:key; if(unicode<=0x10ffff && !(unicode>=0xd800&&unicode<=0xdfff)) {
      auto flags=down?0:KBD_FLAGS_RELEASE; if(unicode>0xffff) { unicode-=0x10000; require(freerdp_input_send_unicode_keyboard_event(input,flags,static_cast<UINT16>(0xd800+(unicode>>10)))); unicode=0xdc00+(unicode&1023); }
      require(freerdp_input_send_unicode_keyboard_event(input,flags,static_cast<UINT16>(unicode))); }
    }
  } else if(c.type==3) {
    require(c.data.size()==12 && n(0)<4096 && n(1)<2160 && n(2)<256); UINT16 x=static_cast<UINT16>(n(0)),y=static_cast<UINT16>(n(1)); auto mask=n(2);
    require(freerdp_input_send_mouse_event(input,PTR_FLAGS_MOVE,x,y)); UINT16 buttons[]={PTR_FLAGS_BUTTON1,PTR_FLAGS_BUTTON3,PTR_FLAGS_BUTTON2};
    for(UINT i=0;i<3;i++) if((s.mouse^mask)&(1<<i)) require(freerdp_input_send_mouse_event(input,buttons[i]|((mask&(1<<i))?PTR_FLAGS_DOWN:0),x,y));
    if((mask&8)&&!(s.mouse&8)) require(freerdp_input_send_mouse_event(input,PTR_FLAGS_WHEEL|120,0,0));
    if((mask&16)&&!(s.mouse&16)) require(freerdp_input_send_mouse_event(input,PTR_FLAGS_WHEEL|PTR_FLAGS_WHEEL_NEGATIVE|0x88,0,0)); s.mouse=mask;
  } else if(c.type==4) {
    require(c.data.size()==8 && n(0)>=200 && n(0)<=4096 && n(1)>=200 && n(1)<=2160);
    if(!s.fixed && s.display && s.displayReady) { DISPLAY_CONTROL_MONITOR_LAYOUT monitor{}; monitor.Flags=DISPLAY_CONTROL_MONITOR_PRIMARY; monitor.Width=n(0)&~1u; monitor.Height=n(1); monitor.PhysicalWidth=0; monitor.PhysicalHeight=0; monitor.DesktopScaleFactor=100; monitor.DeviceScaleFactor=100; require(s.display->SendMonitorLayout(s.display,1,&monitor)==CHANNEL_RC_OK); }
  } else if(c.type==5) {
    require(c.data.size()<=65536); int len=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,reinterpret_cast<const char*>(c.data.data()),static_cast<int>(c.data.size()),nullptr,0); require(len>0 || c.data.empty());
    std::wstring text(len,L'\0'); if(len) MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,reinterpret_cast<const char*>(c.data.data()),static_cast<int>(c.data.size()),text.data(),len);
    {std::lock_guard lock(s.mutex); s.localClipboard=std::move(text);} if(s.clip && s.clipReady) require(advertiseClipboard(s.clip)==CHANNEL_RC_OK);
  } else if(c.type==6) {
    require(c.data.size()==4);
    auto found=std::find_if(s.pendingFrames.begin(),s.pendingFrames.end(),[&](const PendingFrame& frame){return frame.sequence==n(0);});
    require(found!=s.pendingFrames.end()); s.pendingFrames.erase(s.pendingFrames.begin(),std::next(found));
  }
  else if(c.type==9) {
    require(c.data.size()==8 && n(1)<=1);
    PaintLock paintLock(ctx); s.viewing=n(1)!=0; s.pendingFrames.clear(); s.refine=false;
    if(s.viewing) { s.shownWidth=0; s.shownHeight=0; dirtyAll(ctx); s.pendingCursor=s.currentCursor; }
    output(11,c.data); SetEvent(s.paintReady);
  }
  else if(c.type==7 && c.data.empty()) s.stopping=true;
  else require(false);
}
static void jpegRegion(rdpContext* ctx,UINT x,UINT y,UINT width,UINT height,Bytes image={}) {
  auto& s=state(ctx); auto gdi=ctx->gdi;
  if(image.empty()) image=encodeImage(s.imaging.Get(),gdi->primary_buffer+y*gdi->stride+x*4,width,height,gdi->stride,true);
  if(image.size()>MAX_RECORD-16) {
    // High-entropy images can exceed a record. Split without changing frame boundaries.
    if(height>=width && height>1) { auto half=height/2; jpegRegion(ctx,x,y,width,half); jpegRegion(ctx,x,y+half,width,height-half); }
    else { require(width>1); auto half=width/2; jpegRegion(ctx,x,y,half,height); jpegRegion(ctx,x+half,y,width-half,height); }
    return;
  }
  auto payload=nums({x,y,width,height}); payload.insert(payload.end(),image.begin(),image.end()); output(9,payload);
}
static void flush(rdpContext* ctx) {
  auto& s=state(ctx); auto now=clockUs();
  PaintLock paintLock(ctx);
  // Reset while holding the same framebuffer lock as GFX EndPaint: either we
  // consume its dirty region below, or the next paint leaves a fresh signal.
  // Also drain while backpressured so an unacknowledged frame cannot busy-spin.
  ResetEvent(s.paintReady);
  if(!s.viewing) return;
  if(!s.pendingFrames.empty()) require(now-s.pendingFrames.front().sentAt<30000000);
  if(s.pendingFrames.size()>=2) return;
  auto gdi=ctx->gdi; UINT w=gdi->width,h=gdi->height; bool sent=false;
  if(s.shownWidth!=w || s.shownHeight!=h) { output(3,nums({w,h})); s.shownWidth=w; s.shownHeight=h; sent=true; }
  bool refine=s.refine && now-s.lastPaintAt>=250000;
  if(refine) { dirtyAll(ctx); s.refine=false; }
  UINT left=w,top=h,right=0,bottom=0,pixels=0;
  for(UINT y=0;y<h;y+=TILE) for(UINT x=0;x<w;x+=TILE) {
    const auto& rect=s.dirty[(y/TILE)*16+x/TILE]; if(rect.empty()) continue;
    left=std::min(left,x+rect.left); top=std::min(top,y+rect.top); right=std::max(right,x+rect.right); bottom=std::max(bottom,y+rect.bottom); pixels+=(rect.right-rect.left)*(rect.bottom-rect.top);
  }
  // Motion uses one fast JPEG rectangle; quiet desktops receive a lossless refresh.
  // Two complete frames may overlap encode/decode/presentation; never a screenshot queue.
  if(pixels>16384 && !refine) {
    UINT width=right-left,height=bottom-top;
    if(width*height>1280*720) {
      if(!s.encoders) s.encoders=std::make_unique<EncoderPool>();
      struct WorkFence { EncoderPool* pool; ~WorkFence() { pool->drain(); } } fence{s.encoders.get()};
      struct Part { UINT x,y,w,h; std::future<Bytes> image; }; std::vector<Part> parts;
      UINT splitX=(width+1)/2,splitY=(height+1)/2;
      for(UINT py=top;py<bottom;py+=splitY) for(UINT px=left;px<right;px+=splitX) {
        UINT pw=std::min(splitX,right-px),ph=std::min(splitY,bottom-py);
        parts.push_back({px,py,pw,ph,s.encoders->submit(std::packaged_task<Bytes(IWICImagingFactory*)>([=](IWICImagingFactory* factory){return encodeImage(factory,gdi->primary_buffer+py*gdi->stride+px*4,pw,ph,gdi->stride,true);}))});
      }
      // Complete all jobs before releasing the framebuffer lock, including failures.
      std::exception_ptr failure;
      for(auto& part:parts) try { auto encoded=part.image.get(); if(!failure) jpegRegion(ctx,part.x,part.y,part.w,part.h,std::move(encoded)); } catch(...) { if(!failure) failure=std::current_exception(); }
      if(failure) std::rethrow_exception(failure);
    } else jpegRegion(ctx,left,top,width,height);
    s.dirty.fill({}); s.refine=true; sent=true;
  } else for(UINT y=0;y<h;y+=TILE) for(UINT x=0;x<w;x+=TILE) {
    auto& rect=s.dirty[(y/TILE)*16+x/TILE]; if(rect.empty()) continue;
    UINT px=x+rect.left,py=y+rect.top,width=rect.right-rect.left,height=rect.bottom-rect.top; auto payload=nums({px,py,width,height});
    auto image=encodeImage(s.imaging.Get(),gdi->primary_buffer+py*gdi->stride+px*4,width,height,gdi->stride); payload.insert(payload.end(),image.begin(),image.end()); output(2,payload); rect={}; sent=true;
  }
  if(!s.pendingCursor.empty()) { output(5,s.pendingCursor); s.currentCursor=s.pendingCursor; s.pendingCursor.clear(); sent=true; }
  {std::lock_guard lock(s.mutex); if(s.remoteChanged) { output(4,s.remoteClipboard); s.remoteClipboard.clear(); s.remoteChanged=false; sent=true; }}
  if(sent) {
    if(++s.sequence==0) ++s.sequence; s.lastFrameAt=now; s.pendingFrames.push_back({s.sequence,clockUs()});
    output(10,nums({s.sequence,static_cast<UINT32>(clockUs()-now),s.paints.load(),s.gfxFrames.load()})); output(7,nums({s.sequence}));
  }
}
int main() {
  pipeIn=GetStdHandle(STD_INPUT_HANDLE); pipeOut=GetStdHandle(STD_OUTPUT_HANDLE);
  // FreeRDP diagnostics must never mix into the protocol or disclose credentials.
  WLog_SetLogLevel(WLog_GetRoot(),WLOG_OFF);
  rdpContext* ctx=nullptr; State s; std::thread reader; bool com=false,sockets=false; int result=1; UINT32 stage=1;
  try {
    UINT32 type; Bytes data; require(readRecord(type,data) && type==1); Config config(data); SecureZeroMemory(data.data(),data.size()); data.clear();
    // NLA must use the explicit per-entry identity, never an implicit Windows/SAM identity.
    if((config.security==0 || config.security==1) && (config.user.empty() || config.password.empty())) { s.failureStage=7; require(false); }
    // FreeRDP's Media Foundation backend uses STA and balances its own COM calls.
    // A conflicting MTA would make its cleanup invalidate our WIC factory.
    stage=2; require(SUCCEEDED(CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED))); com=true;
    WSADATA socketData{}; require(WSAStartup(MAKEWORD(2,2),&socketData)==0); sockets=true;
    require(SUCCEEDED(CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&s.imaging)))); s.fixed=config.fixed;
    s.commandsReady=CreateEvent(nullptr,TRUE,FALSE,nullptr); require(s.commandsReady!=nullptr);
    s.paintReady=CreateEvent(nullptr,TRUE,FALSE,nullptr); require(s.paintReady!=nullptr);
    RDP_CLIENT_ENTRY_POINTS entry{}; entry.Size=sizeof(entry); entry.Version=RDP_CLIENT_INTERFACE_VERSION; entry.ContextSize=sizeof(Context); entry.ClientNew=clientNew;
    stage=3; ctx=freerdp_client_context_new(&entry); require(ctx!=nullptr); reinterpret_cast<Context*>(ctx)->state=&s;
    auto settings=ctx->settings;
    auto str=[&](FreeRDP_Settings_Keys_String id,const std::string& value){require(freerdp_settings_set_string(settings,id,value.empty()?nullptr:value.c_str()));};
    auto flag=[&](FreeRDP_Settings_Keys_Bool id,bool value){require(freerdp_settings_set_bool(settings,id,value));};
    auto number=[&](FreeRDP_Settings_Keys_UInt32 id,UINT32 value){require(freerdp_settings_set_uint32(settings,id,value));};
    stage=4; str(FreeRDP_ServerHostname,config.host); number(FreeRDP_ServerPort,config.port); str(FreeRDP_Username,config.user); str(FreeRDP_Domain,config.domain); str(FreeRDP_Password,config.password); str(FreeRDP_ConfigPath,config.certs);
    SecureZeroMemory(config.password.data(),config.password.size()); config.password.clear();
    number(FreeRDP_DesktopWidth,config.width); number(FreeRDP_DesktopHeight,config.height); number(FreeRDP_ColorDepth,32);
    flag(FreeRDP_NlaSecurity,config.security==0 || config.security==1); flag(FreeRDP_TlsSecurity,config.security==0 || config.security==2); flag(FreeRDP_RdpSecurity,config.security==0 || config.security==3);
    flag(FreeRDP_IgnoreCertificate,false); flag(FreeRDP_AutoAcceptCertificate,config.tofu); flag(FreeRDP_AutoDenyCertificate,!config.tofu); flag(FreeRDP_ExternalCertificateManagement,!config.tofu);
    if(config.tofu) ctx->instance->VerifyX509Certificate=nullptr; // Let FreeRDP compare its own saved pin and ask on a change.
    flag(FreeRDP_RedirectClipboard,true); flag(FreeRDP_SupportDisplayControl,!config.fixed); flag(FreeRDP_SupportGraphicsPipeline,true); flag(FreeRDP_GfxH264,true); flag(FreeRDP_GfxAVC444,false); flag(FreeRDP_GfxAVC444v2,false); flag(FreeRDP_AutoReconnectionEnabled,false);
    flag(FreeRDP_AudioPlayback,false); flag(FreeRDP_DeviceRedirection,false); flag(FreeRDP_RedirectDrives,false); flag(FreeRDP_RedirectPrinters,false); flag(FreeRDP_RedirectSmartCards,false);
    reader=std::thread([&] { try {UINT32 op; Bytes payload; while(readRecord(op,payload)) {
      std::lock_guard lock(s.mutex);
      if(op==8) { require(payload.size()==4 && u32(payload.data())<=1 && s.certificateWaiting && s.certificateDecision==0); s.certificateDecision=u32(payload.data())?1:-1; s.certificateReady.notify_all(); continue; }
      require(s.commands.size()<4096 && s.commandBytes+payload.size()<=MAX_RECORD); s.commandBytes+=payload.size(); s.commands.push_back({op,std::move(payload)});
      SetEvent(s.commandsReady);
    } } catch(...) {} s.stopping=true; s.certificateReady.notify_all(); freerdp_abort_connect_context(ctx); });
    stage=5; require(freerdp_connect(ctx->instance)); stage=6;
    { PaintLock paintLock(ctx); output(1,nums({static_cast<UINT32>(ctx->gdi->width),static_cast<UINT32>(ctx->gdi->height)})); dirtyAll(ctx); s.lastPaintAt=clockUs(); }
    while(!s.stopping && !freerdp_shall_disconnect_context(ctx)) {
      std::deque<Command> commands; {std::lock_guard lock(s.mutex); commands.swap(s.commands); s.commandBytes=0; ResetEvent(s.commandsReady);} for(const auto& c:commands) command(ctx,c);
      flush(ctx); HANDLE handles[MAXIMUM_WAIT_OBJECTS]{}; DWORD count=freerdp_get_event_handles(ctx,handles,MAXIMUM_WAIT_OBJECTS-2); require(count>0); handles[count++]=s.commandsReady; handles[count++]=s.paintReady;
      // Remote paints and input/ACK events wake immediately; no local FPS ceiling.
      require(WaitForMultipleObjects(count,handles,FALSE,s.refine?16:100)!=WAIT_FAILED); require(freerdp_check_event_handles(ctx));
    }
    result=0;
  } catch(...) { try { output(6,nums({s.failureStage?s.failureStage:stage,ctx?freerdp_get_last_error(ctx):0,s.failureStage?s.failureDetail:GetLastError()})); } catch(...) {} }
  s.stopping=true;
  if(reader.joinable()) { CancelSynchronousIo(reader.native_handle()); reader.join(); }
  if(s.commandsReady) CloseHandle(s.commandsReady);
  s.encoders.reset();
  if(ctx) { freerdp_disconnect(ctx->instance); freerdp_client_context_free(ctx); }
  if(s.paintReady) CloseHandle(s.paintReady);
  s.imaging.Reset(); if(sockets) WSACleanup(); if(com) CoUninitialize(); return result;
}
