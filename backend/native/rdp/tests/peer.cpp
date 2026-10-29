// Test-only TLS RDP server. It binds loopback, draws synthetic pixels and prints input events.
// Never ships with the runtime and never connects to user machines.
#include <freerdp/peer.h>
#include <freerdp/freerdp.h>
#include <freerdp/listener.h>
#include <freerdp/settings.h>
#include <freerdp/crypto/certificate.h>
#include <freerdp/crypto/privatekey.h>
#include <freerdp/primary.h>
#include <winpr/wlog.h>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>
#include <cstring>
#include <chrono>
#include <algorithm>
using Bytes=std::vector<BYTE>;
struct PeerState { HANDLE clip=nullptr; Bytes pending; UINT32 paints=0,animationFrame=0; bool animating=false; std::chrono::steady_clock::time_point nextFrame; };
static void add16(Bytes& bytes,UINT16 n) { bytes.push_back(n&255); bytes.push_back(n>>8); }
static void add32(Bytes& bytes,UINT32 n) { add16(bytes,n&65535); add16(bytes,n>>16); }
static bool clipSend(freerdp_peer* peer,UINT16 type,UINT16 flags,const Bytes& payload={}) {
  Bytes bytes; add16(bytes,type); add16(bytes,flags); add32(bytes,static_cast<UINT32>(payload.size())); bytes.insert(bytes.end(),payload.begin(),payload.end());
  return peer->VirtualChannelWrite(peer,static_cast<PeerState*>(peer->ContextExtra)->clip,bytes.data(),static_cast<UINT32>(bytes.size()))>=0;
}
static int channelRead(freerdp_peer* peer,HANDLE channel,BYTE* bytes,UINT32 length) {
  auto& s=*static_cast<PeerState*>(peer->ContextExtra); if(channel!=s.clip || !channel) return 0;
  s.pending.insert(s.pending.end(),bytes,bytes+length); if(s.pending.size()>128*1024) return -1;
  while(s.pending.size()>=8) {
    UINT16 type; UINT32 size; memcpy(&type,s.pending.data(),2); memcpy(&size,s.pending.data()+4,4); if(size>65536) return -1; if(s.pending.size()<8+size) break;
    if(type==2) { if(!clipSend(peer,3,1)) return -1; Bytes request; add32(request,CF_UNICODETEXT); if(!clipSend(peer,4,0,request)) return -1; }
    else if(type==4) { const wchar_t text[]=L"WebNav remote clipboard"; Bytes data(reinterpret_cast<const BYTE*>(text),reinterpret_cast<const BYTE*>(text)+sizeof(text)); if(!clipSend(peer,5,1,data)) return -1; }
    else if(type==5) { const wchar_t expected[]=L"local\u6d4b\u8bd5"; if(size==sizeof(expected) && memcmp(s.pending.data()+8,expected,size)==0) { printf("clipboard-ok\n"); fflush(stdout); } }
    s.pending.erase(s.pending.begin(),s.pending.begin()+8+size);
  }
  return 0;
}
static const char* certPath;
static const char* keyPath;
static BOOL key(rdpInput* input,UINT16 flags,UINT8 code) {
  printf("key %u %u\n",flags,code); fflush(stdout);
  if(flags==0 && code==0x42) {
    auto& s=*static_cast<PeerState*>(input->context->peer->ContextExtra); s.animating=!s.animating; s.nextFrame=std::chrono::steady_clock::now();
  }
  // F6 paints the full desktop; F7 paints just a 20px square near the bottom right.
  // Used to measure complete-frame delivery and small dirty-region overhead.
  if(flags==0 && (code==0x40 || code==0x41)) {
    auto ctx=input->context; auto& s=*static_cast<PeerState*>(ctx->peer->ContextExtra);
    UINT32 width=freerdp_settings_get_uint32(ctx->settings,FreeRDP_DesktopWidth),height=freerdp_settings_get_uint32(ctx->settings,FreeRDP_DesktopHeight);
    OPAQUE_RECT_ORDER rect{}; rect.nLeftRect=code==0x41?width-30:0; rect.nTopRect=code==0x41?height-30:0;
    rect.nWidth=code==0x41?20:width; rect.nHeight=code==0x41?20:height; rect.color=(++s.paints%2)?0x61a9d4:0xd47e61;
    if(!ctx->update->BeginPaint(ctx) || !ctx->update->primary->OpaqueRect(ctx,&rect) || !ctx->update->EndPaint(ctx)) return FALSE;
    printf("paint %u\n",s.paints); fflush(stdout);
  }
  return TRUE;
}
static BOOL unicode(rdpInput*,UINT16 flags,UINT16 code) { printf("unicode %u %u\n",flags,code); fflush(stdout); return TRUE; }
static BOOL mouse(rdpInput*,UINT16 flags,UINT16 x,UINT16 y) { printf("mouse %u %u %u\n",flags,x,y); fflush(stdout); return TRUE; }
static BOOL sync(rdpInput*,UINT32) { return TRUE; }
static BOOL activate(freerdp_peer* peer) {
  auto ctx=peer->context; auto update=ctx->update;
  OPAQUE_RECT_ORDER rect{}; rect.nLeftRect=0; rect.nTopRect=0;
  rect.nWidth=freerdp_settings_get_uint32(ctx->settings,FreeRDP_DesktopWidth); rect.nHeight=freerdp_settings_get_uint32(ctx->settings,FreeRDP_DesktopHeight); rect.color=0x324b65;
  if(!update->BeginPaint(ctx) || !update->primary->OpaqueRect(ctx,&rect)) return FALSE;
  rect.nLeftRect=40; rect.nTopRect=40; rect.nWidth=400; rect.nHeight=200; rect.color=0x91c6b4;
  if(!update->primary->OpaqueRect(ctx,&rect) || !update->EndPaint(ctx)) return FALSE;
  auto& s=*static_cast<PeerState*>(peer->ContextExtra);
  if(!s.clip) {
    s.clip=peer->VirtualChannelOpen(peer,"cliprdr",0);
    if(s.clip) { Bytes caps; add16(caps,1); add16(caps,0); add16(caps,1); add16(caps,12); add32(caps,2); add32(caps,2);
      Bytes formats; add32(formats,CF_UNICODETEXT); add16(formats,0);
      if(!clipSend(peer,7,0,caps) || !clipSend(peer,1,0) || !clipSend(peer,2,0,formats)) return FALSE;
    }
  }
  printf("activated\n"); fflush(stdout); return TRUE;
}
static BOOL connected(freerdp_peer*) { return TRUE; }
static BOOL animate(freerdp_peer* peer) {
  auto ctx=peer->context; auto& s=*static_cast<PeerState*>(peer->ContextExtra);
  const UINT32 width=freerdp_settings_get_uint32(ctx->settings,FreeRDP_DesktopWidth),height=freerdp_settings_get_uint32(ctx->settings,FreeRDP_DesktopHeight);
  if(!ctx->update->BeginPaint(ctx)) return FALSE;
  // Hundreds of moving coloured cells cover the entire screen, not a static/solid frame.
  for(UINT y=0;y<height;y+=48) for(UINT x=0;x<width;x+=48) {
    UINT n=(x/48+s.animationFrame)*1103515245u+(y/48)*12345u;
    OPAQUE_RECT_ORDER rect{}; rect.nLeftRect=x; rect.nTopRect=y; rect.nWidth=std::min(48u,width-x); rect.nHeight=std::min(48u,height-y);
    rect.color=((n>>8)&0xff)|(((n>>16)&0xff)<<8)|(((n>>24)&0xff)<<16);
    if(!ctx->update->primary->OpaqueRect(ctx,&rect)) return FALSE;
  }
  s.animationFrame++; return ctx->update->EndPaint(ctx);
}
static void serve(freerdp_peer* peer) {
  PeerState state; peer->ContextExtra=&state; peer->VirtualChannelRead=channelRead;
  if(!freerdp_peer_context_new(peer)) {freerdp_peer_free(peer); return;}
  auto settings=peer->context->settings;
  auto cert=freerdp_certificate_new_from_file(certPath); auto key=freerdp_key_new_from_file_enc(keyPath,nullptr);
  bool ok=cert && key && freerdp_settings_set_pointer_len(settings,FreeRDP_RdpServerCertificate,cert,1) && freerdp_settings_set_pointer_len(settings,FreeRDP_RdpServerRsaKey,key,1);
  ok=ok && freerdp_settings_set_bool(settings,FreeRDP_NlaSecurity,FALSE) && freerdp_settings_set_bool(settings,FreeRDP_TlsSecurity,TRUE) && freerdp_settings_set_bool(settings,FreeRDP_RdpSecurity,FALSE) && freerdp_settings_set_bool(settings,FreeRDP_ExtSecurity,FALSE) && freerdp_settings_set_uint32(settings,FreeRDP_ColorDepth,32);
  peer->Activate=activate; peer->PostConnect=connected;
  auto input=peer->context->input; input->KeyboardEvent=::key; input->UnicodeKeyboardEvent=unicode; input->MouseEvent=mouse; input->SynchronizeEvent=sync;
  if(ok && peer->Initialize(peer)) for(;;) {
    HANDLE handles[64]; DWORD n=peer->GetEventHandles(peer,handles,64); if(!n || WaitForMultipleObjects(n,handles,FALSE,state.animating?1:1000)==WAIT_FAILED || !peer->CheckFileDescriptor(peer)) break;
    auto now=std::chrono::steady_clock::now();
    if(state.animating && now>=state.nextFrame) {
      if(!animate(peer)) break;
      state.nextFrame+=std::chrono::microseconds(16667);
      if(now-state.nextFrame>std::chrono::milliseconds(100)) state.nextFrame=now;
    }
  }
  peer->Disconnect(peer); freerdp_peer_context_free(peer); freerdp_peer_free(peer); printf("closed\n"); fflush(stdout);
}
static BOOL accepted(freerdp_listener*,freerdp_peer* peer) { std::thread(serve,peer).detach(); return TRUE; }
int main(int argc,char** argv) {
  if(argc!=4) return 2; int port=atoi(argv[1]); if(port<1024 || port>65535) return 2; certPath=argv[2]; keyPath=argv[3];
  WLog_SetLogLevel(WLog_GetRoot(),WLOG_OFF); WSADATA data; WSAStartup(MAKEWORD(2,2),&data);
  auto listener=freerdp_listener_new(); if(!listener) return 1; listener->PeerAccepted=accepted;
  if(!listener->Open(listener,"127.0.0.1",static_cast<UINT16>(port))) return 1; printf("listening\n"); fflush(stdout);
  for(;;) { HANDLE handles[64]; auto n=listener->GetEventHandles(listener,handles,64); if(!n || WaitForMultipleObjects(n,handles,FALSE,INFINITE)==WAIT_FAILED || !listener->CheckFileDescriptor(listener)) break; }
  listener->Close(listener); freerdp_listener_free(listener); WSACleanup(); return 0;
}
