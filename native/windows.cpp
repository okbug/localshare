#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <iostream>
#include <string>
#include <thread>
#include <set>
#include <algorithm>
#include <cmath>
#include <cctype>
#include <vector>
#include "display-geometry.h"
#define DISPLAY_GEOMETRY_EMBEDDED_TEST
#include "display-geometry-test.cpp"

constexpr ULONG_PTR marker = 0x4c534841;
constexpr UINT commandMessage = WM_APP + 1;
DWORD mainThread;
bool capture = false, receiving = false, enabled = false, allowLeft = false, allowRight = false;
std::vector<display_geometry::Display> displays;
std::vector<display_geometry::Portal> returnPortals;
ULONGLONG receivedAt = 0, lastLayoutCheck = 0;
HWND notificationWindow = nullptr;
ULONGLONG lastCommand = 0, lastEdge = 0;
POINT anchor{};
POINT returnPoint{};
std::set<int> keys, buttons;
std::set<DWORD> physicalKeys;
HHOOK mouseHook, keyHook;
bool layoutValid = false;
std::string layoutFields() {
  std::string result="\"version\":1,\"platform\":\"windows\",\"entrySelection\":true,\"displays\":[";
  for(size_t n=0;n<displays.size();++n){const auto&d=displays[n];if(n)result+=",";
    result+="{\"id\":\""+d.id+"\",\"name\":\""+d.id+"\",\"x\":"+std::to_string(d.x)+",\"y\":"+std::to_string(d.y)+",\"width\":"+std::to_string(d.width)+",\"height\":"+std::to_string(d.height)+",\"primary\":"+(d.primary?"true":"false")+"}";}
  return result+"]";
}
std::string displayID(const wchar_t* device) {
  std::string id;for(;*device;++device){wchar_t c=*device;if((c>=L'A'&&c<=L'Z')||(c>=L'a'&&c<=L'z')||(c>=L'0'&&c<=L'9')||c==L'_'||c==L'.'||c==L':'||c==L'-')id+=char(c);}
  while(!id.empty()&&id.front()=='.')id.erase(id.begin());
  if(id.size()>80)id.resize(80);return id;
}
bool validDisplayID(const std::string& id) {
  if(id.empty()||id.size()>80)return false;
  for(unsigned char c:id)if(!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='_'||c=='.'||c==':'||c=='-'))return false;
  return true;
}
BOOL CALLBACK enumerateMonitor(HMONITOR monitor,HDC,LPRECT,LPARAM param) {
  auto&result=*reinterpret_cast<std::vector<display_geometry::Display>*>(param);
  MONITORINFOEXW info{};info.cbSize=sizeof(info);
  if(!GetMonitorInfoW(monitor,&info))return FALSE;
  // Resolve the display adapter, not its optional child monitor device.
  bool active=false;
  for(DWORD n=0;;++n){DISPLAY_DEVICEW device{};device.cb=sizeof(device);
    if(!EnumDisplayDevicesW(nullptr,n,&device,0))break;
    if(wcscmp(device.DeviceName,info.szDevice)==0){
      if(device.StateFlags&DISPLAY_DEVICE_MIRRORING_DRIVER)return TRUE;
      active=(device.StateFlags&DISPLAY_DEVICE_ACTIVE)!=0;break;}}
  if(!active)return FALSE;
  auto r=info.rcMonitor;auto id=displayID(info.szDevice);
  if(!validDisplayID(id)||r.right<=r.left||r.bottom<=r.top)return FALSE;
  result.push_back({id,int(r.left),int(r.top),int(r.right-r.left),int(r.bottom-r.top),(info.dwFlags&MONITORINFOF_PRIMARY)!=0});return TRUE;
}
bool readLayout(std::vector<display_geometry::Display>& result) {
  if(!EnumDisplayMonitors(nullptr,nullptr,enumerateMonitor,reinterpret_cast<LPARAM>(&result))||result.empty())return false;
  result=display_geometry::canonical(result);if(result.size()>32)return false;
  std::set<std::string> ids;int primary=0;
  for(const auto&d:result){if(d.primary)++primary;if(!ids.insert(d.id).second||std::abs(double(d.x))>1000000||std::abs(double(d.y))>1000000||d.width>32768||d.height>32768)return false;}
  return primary==1;
}
bool sameLayout(const std::vector<display_geometry::Display>& a,const std::vector<display_geometry::Display>& b) {
  if(a.size()!=b.size())return false;for(size_t n=0;n<a.size();++n){const auto&x=a[n];const auto&y=b[n];if(x.id!=y.id||x.x!=y.x||x.y!=y.y||x.width!=y.width||x.height!=y.height||x.primary!=y.primary)return false;}return true;
}
bool releaseAll(bool restore = true);
bool refreshLayout(bool report=true);
bool configureDPI() {
  using SetContext=BOOL(WINAPI*)(HANDLE);
  auto setContext=reinterpret_cast<SetContext>(GetProcAddress(GetModuleHandleW(L"user32.dll"),"SetProcessDpiAwarenessContext"));
  if(!setContext)return false;
  HANDLE pmv2=reinterpret_cast<HANDLE>(static_cast<INT_PTR>(-4));
  if(setContext(pmv2))return true;
  using GetContext=HANDLE(WINAPI*)();using EqualContext=BOOL(WINAPI*)(HANDLE,HANDLE);
  auto getContext=reinterpret_cast<GetContext>(GetProcAddress(GetModuleHandleW(L"user32.dll"),"GetThreadDpiAwarenessContext"));
  auto equalContext=reinterpret_cast<EqualContext>(GetProcAddress(GetModuleHandleW(L"user32.dll"),"AreDpiAwarenessContextsEqual"));
  return getContext&&equalContext&&equalContext(getContext(),pmv2);
}
void emit(const std::string& s) { std::cout << s << std::endl; }
// The parent sends flat, validated JSON with fixed ASCII keys. No remote strings
// or clipboard content reach this helper.
size_t valueAt(const std::string& s, const std::string& key) {
  auto pos = s.find("\"" + key + "\""); if (pos == std::string::npos) return pos;
  pos = s.find(':', pos); if (pos == std::string::npos) return pos;
  return s.find_first_not_of(" \t\r\n", pos + 1);
}
std::string str(const std::string& s, const std::string& key) {
  auto pos = valueAt(s,key); if(pos==std::string::npos||s[pos]!='"')return "";
  auto end=s.find('"',pos+1);return end==std::string::npos?"":s.substr(pos+1,end-pos-1);
}
double num(const std::string& s,const std::string& key) {auto pos=valueAt(s,key);if(pos==std::string::npos)return 0;try{return std::stod(s.substr(pos));}catch(...){return 0;}}
bool boolean(const std::string& s,const std::string& key) {auto pos=valueAt(s,key);return pos!=std::string::npos&&s.compare(pos,4,"true")==0;}
void inputFailure(const char* operation,DWORD code) {
  releaseAll();
  emit("{\"type\":\"error\",\"operation\":\""+std::string(operation)+"\",\"code\":"+std::to_string(code)+"}");
}
bool inject(INPUT& input,const char* operation,bool report=true) {
  SetLastError(ERROR_SUCCESS);
  if(SendInput(1,&input,sizeof(input))==1)return true;
  DWORD code=GetLastError();if(report)inputFailure(operation,code);return false;
}
INPUT keyInput(int key,bool down) {
  INPUT i{};i.type=INPUT_KEYBOARD;i.ki.wVk=WORD(key);i.ki.dwExtraInfo=marker;
  UINT scan=MapVirtualKeyW(UINT(key),MAPVK_VK_TO_VSC_EX);
  if(scan){i.ki.wVk=0;i.ki.wScan=WORD(scan&0xff);i.ki.dwFlags|=KEYEVENTF_SCANCODE;if(scan&0xff00)i.ki.dwFlags|=KEYEVENTF_EXTENDEDKEY;}
  if(!down)i.ki.dwFlags|=KEYEVENTF_KEYUP;
  if(key==VK_RCONTROL||key==VK_RMENU||key==VK_LEFT||key==VK_RIGHT||key==VK_UP||key==VK_DOWN||key==VK_INSERT||key==VK_DELETE||key==VK_HOME||key==VK_END||key==VK_PRIOR||key==VK_NEXT||key==VK_LWIN||key==VK_RWIN)i.ki.dwFlags|=KEYEVENTF_EXTENDEDKEY;
  return i;
}
bool sendKey(int key,bool down,bool report=true) {INPUT i=keyInput(key,down);return inject(i,"key",report);}
INPUT buttonInput(int b,bool down) {
  INPUT i{};i.type=INPUT_MOUSE;i.mi.dwExtraInfo=marker;
  i.mi.dwFlags=b==0?(down?MOUSEEVENTF_LEFTDOWN:MOUSEEVENTF_LEFTUP):b==1?(down?MOUSEEVENTF_RIGHTDOWN:MOUSEEVENTF_RIGHTUP):(down?MOUSEEVENTF_MIDDLEDOWN:MOUSEEVENTF_MIDDLEUP);
  return i;
}
bool sendButton(int b,bool down,bool report=true) {INPUT i=buttonInput(b,down);return inject(i,"button",report);}
bool releaseAll(bool restore) {
  if(capture)ShowCursor(TRUE);
  if(capture&&restore&&!displays.empty()){auto p=display_geometry::clamp(displays,{double(returnPoint.x),double(returnPoint.y)});SetCursorPos(LONG(std::lround(p.x)),LONG(std::lround(p.y)));}
  capture=false;receiving=false;lastEdge=GetTickCount64();
  bool ok=true;
  for(int key:keys)if(!sendKey(key,false,false))ok=false;
  for(int b:buttons)if(!sendButton(b,false,false))ok=false;
  keys.clear();buttons.clear();returnPortals.clear();return ok;
}
std::string releasedEvent(const std::string& id,bool ok) {
  return "{\"type\":\"released\",\"requestId\":\""+id+"\",\"ok\":"+(ok?"true":"false")+"}";
}
bool idleHeartbeat(const std::string& s) {
  return str(s,"cmd")=="heartbeat"&&valueAt(s,"active")!=std::string::npos&&!boolean(s,"active");
}
bool refreshLayout(bool report) {
  lastLayoutCheck=GetTickCount64();
  std::vector<display_geometry::Display> next;
  if(!readLayout(next)){
    bool active=capture||receiving;releaseAll(false);layoutValid=false;
    if(report){emit("{\"type\":\"error\",\"operation\":\"layout\",\"code\":"+std::to_string(ERROR_INVALID_DATA)+"}");if(active)emit("{\"type\":\"emergency\"}");}
    return false;
  }
  bool changed=!layoutValid||!sameLayout(displays,next),active=capture||receiving;
  if(changed){
    // Install the new safe restore bounds before restoring a removed monitor.
    displays=std::move(next);releaseAll();layoutValid=true;
    if(report){emit("{\"type\":\"layout\","+layoutFields()+"}");if(active)emit("{\"type\":\"emergency\"}");}
  }
  lastLayoutCheck=GetTickCount64();return true;
}
LRESULT CALLBACK windowProc(HWND window,UINT message,WPARAM w,LPARAM l) {
  if(message==WM_DISPLAYCHANGE||message==WM_DPICHANGED||message==WM_DEVICECHANGE){refreshLayout();return 0;}
  return DefWindowProcW(window,message,w,l);
}
void command(const std::string& s) {
  lastCommand=GetTickCount64();auto cmd=str(s,"cmd");
  if(cmd=="enable"){if(!refreshLayout())return;enabled=true;allowLeft=boolean(s,"left");allowRight=boolean(s,"right");}
  else if(cmd=="disable"){enabled=false;releaseAll();}
  else if(cmd=="capture"){
    releaseAll();if(!refreshLayout())return;
    if(!GetCursorPos(&returnPoint)){inputFailure("capture",GetLastError());return;}
    auto restore=display_geometry::clamp(displays,{double(returnPoint.x),double(returnPoint.y)});
    returnPoint={LONG(std::lround(restore.x)),LONG(std::lround(restore.y))};
    int index=display_geometry::containing(displays,restore);if(index<0){inputFailure("capture",ERROR_INVALID_DATA);return;}
    const auto&d=displays[size_t(index)];anchor={LONG(d.x+d.width/2),LONG(d.y+d.height/2)};
    if(!SetCursorPos(anchor.x,anchor.y)){inputFailure("capture",GetLastError());return;}
    capture=true;ShowCursor(FALSE);emit("{\"type\":\"captured\",\"requestId\":\""+str(s,"requestId")+"\"}");
  }
  else if(cmd=="receive"){
    releaseAll();if(!refreshLayout())return;
    bool manual=boolean(s,"manual");auto selected=str(s,"display");
    if(!manual&&!selected.empty()&&!validDisplayID(selected)){inputFailure("receive",ERROR_INVALID_DATA);return;}
    POINT current{};
    if(manual&&!GetCursorPos(&current)){inputFailure("receive",GetLastError());return;}
    auto plan=display_geometry::planReceive(displays,manual,{double(current.x),double(current.y)},str(s,"side")=="right",num(s,"y"),selected);
    if(!plan.valid){inputFailure("receive",ERROR_NOT_FOUND);return;}
    if(plan.reposition&&!SetCursorPos(LONG(std::lround(plan.point.x)),LONG(std::lround(plan.point.y)))){inputFailure("receive",GetLastError());return;}
    returnPortals=std::move(plan.returnPortals);receivedAt=GetTickCount64();receiving=true;
    emit("{\"type\":\"receiving\",\"requestId\":\""+str(s,"requestId")+"\"}");
  }
  else if(cmd=="release"||cmd=="recover"){
    if(cmd=="recover")enabled=false;
    bool ok=releaseAll(cmd!="recover");
    emit(releasedEvent(str(s,"requestId"),ok));
    if(!ok)emit("{\"type\":\"error\",\"operation\":\"release\"}");
  }
  else if(idleHeartbeat(s)){
    // Once idle, subsequent heartbeats must not warp or touch the cursor.
    bool ok=true;if(capture||receiving||!keys.empty()||!buttons.empty())ok=releaseAll();
    auto id=str(s,"releaseRequestId");if(!id.empty())emit(releasedEvent(id,ok));
  }
  else if(cmd=="event"&&receiving){
    auto type=str(s,"type");
    if(type=="move"){
      POINT current;if(!GetCursorPos(&current)){inputFailure("move",GetLastError());return;}
      auto result=display_geometry::move(displays,{double(current.x),double(current.y)},num(s,"dx"),num(s,"dy"),GetTickCount64()-receivedAt>=250?returnPortals:std::vector<display_geometry::Portal>{});
      if(result.returned){releaseAll();emit("{\"type\":\"return\"}");return;}
      auto b=display_geometry::bounds(displays);
      INPUT i{};i.type=INPUT_MOUSE;i.mi.dwFlags=MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK;i.mi.dwExtraInfo=marker;
      i.mi.dx=display_geometry::normalize(std::lround(result.point.x),b.x,b.width);i.mi.dy=display_geometry::normalize(std::lround(result.point.y),b.y,b.height);inject(i,"move");
    }else if(type=="key"){int key=int(num(s,"key"));bool down=boolean(s,"down");if(sendKey(key,down)){if(down)keys.insert(key);else keys.erase(key);}}
    else if(type=="button"){int b=int(num(s,"button"));bool down=boolean(s,"down");if(sendButton(b,down)){if(down)buttons.insert(b);else buttons.erase(b);}}
    else if(type=="scroll"){
      double dy=num(s,"dy"),dx=num(s,"dx");INPUT i{};i.type=INPUT_MOUSE;i.mi.dwExtraInfo=marker;
      if(dy){i.mi.dwFlags=MOUSEEVENTF_WHEEL;i.mi.mouseData=DWORD(int(dy*120));if(!inject(i,"scroll"))return;}
      if(dx){i.mi.dwFlags=MOUSEEVENTF_HWHEEL;i.mi.mouseData=DWORD(int(dx*120));inject(i,"scroll");}
    }
  }
}
LRESULT CALLBACK mouseProc(int code,WPARAM message,LPARAM param){
  if(code<0)return CallNextHookEx(mouseHook,code,message,param);
  auto e=reinterpret_cast<MSLLHOOKSTRUCT*>(param);
  if(e->flags&LLMHF_INJECTED||e->dwExtraInfo==marker)return CallNextHookEx(mouseHook,code,message,param);
  if(capture){
    if(message==WM_MOUSEMOVE){
      int dx=e->pt.x-anchor.x,dy=e->pt.y-anchor.y;
      if(dx||dy)emit("{\"type\":\"move\",\"dx\":"+std::to_string(dx)+",\"dy\":"+std::to_string(dy)+"}");
      if(!SetCursorPos(anchor.x,anchor.y)){inputFailure("capture-warp",GetLastError());return 1;}
    }else if(message==WM_MOUSEWHEEL||message==WM_MOUSEHWHEEL){
      double delta=double(static_cast<short>(HIWORD(e->mouseData)))/120;
      emit("{\"type\":\"scroll\",\"dx\":"+std::to_string(message==WM_MOUSEHWHEEL?delta:0)+",\"dy\":"+std::to_string(message==WM_MOUSEWHEEL?delta:0)+"}");
    }else{
      int b=(message==WM_LBUTTONDOWN||message==WM_LBUTTONUP)?0:(message==WM_RBUTTONDOWN||message==WM_RBUTTONUP)?1:2;
      bool down=message==WM_LBUTTONDOWN||message==WM_RBUTTONDOWN||message==WM_MBUTTONDOWN;
      if(message==WM_LBUTTONDOWN||message==WM_LBUTTONUP||message==WM_RBUTTONDOWN||message==WM_RBUTTONUP||message==WM_MBUTTONDOWN||message==WM_MBUTTONUP)emit("{\"type\":\"button\",\"button\":"+std::to_string(b)+",\"down\":"+(down?"true":"false")+"}");
    }
    return 1;
  }
  if(enabled&&!receiving&&message==WM_MOUSEMOVE&&GetTickCount64()-lastEdge>1000){
    if(!layoutValid)return CallNextHookEx(mouseHook,code,message,param);
    auto b=display_geometry::bounds(displays);bool left=false,right=false;
    if(allowLeft)for(const auto&p:display_geometry::portals(displays,true))if(e->pt.x<=p.x&&e->pt.y+.5>=p.y0&&e->pt.y+.5<p.y1)left=true;
    if(allowRight)for(const auto&p:display_geometry::portals(displays,false))if(e->pt.x>=p.x-1&&e->pt.y+.5>=p.y0&&e->pt.y+.5<p.y1)right=true;
    if(left||right){lastEdge=GetTickCount64();emit("{\"type\":\"edge\",\"side\":\""+std::string(left?"left":"right")+"\",\"y\":"+std::to_string(double(e->pt.y-b.y)/std::max(1,b.height-1))+"}");}
  }
  return CallNextHookEx(mouseHook,code,message,param);
}
LRESULT CALLBACK keyProc(int code,WPARAM message,LPARAM param){
  if(code<0)return CallNextHookEx(keyHook,code,message,param);
  auto e=reinterpret_cast<KBDLLHOOKSTRUCT*>(param);
  if(e->flags&LLKHF_INJECTED||e->dwExtraInfo==marker)return CallNextHookEx(keyHook,code,message,param);
  bool down=message==WM_KEYDOWN||message==WM_SYSKEYDOWN;
  if(down)physicalKeys.insert(e->vkCode);else physicalKeys.erase(e->vkCode);
  bool ctrl=physicalKeys.count(VK_CONTROL)||physicalKeys.count(VK_LCONTROL)||physicalKeys.count(VK_RCONTROL)||(GetAsyncKeyState(VK_CONTROL)&0x8000);
  bool alt=physicalKeys.count(VK_MENU)||physicalKeys.count(VK_LMENU)||physicalKeys.count(VK_RMENU)||(GetAsyncKeyState(VK_MENU)&0x8000);
  if(down&&e->vkCode==VK_ESCAPE&&ctrl&&alt){releaseAll();emit("{\"type\":\"emergency\"}");return 1;}
  if(capture){emit("{\"type\":\"key\",\"key\":"+std::to_string(e->vkCode)+",\"down\":"+(down?"true":"false")+"}");return 1;}
  return CallNextHookEx(keyHook,code,message,param);
}
int main(int argc,char** argv){
  // Self-tests exercise constructed input records and pure geometry only.
  if(!(argc>1&&std::string(argv[1])=="--self-test")&&!configureDPI()){
    emit("{\"type\":\"error\",\"operation\":\"dpi-awareness\"}");return 1;
  }
  if(argc>1){
    std::string arg=argv[1];
    if(arg=="--self-test"){
      std::string value="{\"cmd\":\"event\",\"type\":\"key\",\"key\":65,\"down\":true}";
      INPUT down=keyInput(65,true),up=keyInput(65,false),button=buttonInput(0,true);
      bool geometry=false;try{runGeometryTests();geometry=true;}catch(const std::exception&e){std::cerr<<e.what()<<std::endl;}
      bool releaseProtocol=idleHeartbeat("{\"cmd\":\"heartbeat\",\"active\":false}")&&!idleHeartbeat("{\"cmd\":\"heartbeat\",\"active\":true}")&&!idleHeartbeat("{\"cmd\":\"heartbeat\"}")&&releasedEvent("release-id",true)=="{\"type\":\"released\",\"requestId\":\"release-id\",\"ok\":true}";
      bool passed=geometry&&releaseProtocol&&boolean("{\"cmd\":\"receive\",\"manual\":true}","manual")&&str(value,"cmd")=="event"&&str(value,"type")=="key"&&num(value,"key")==65&&boolean(value,"down")&&down.ki.wScan!=0&&(down.ki.dwFlags&KEYEVENTF_SCANCODE)&&(up.ki.dwFlags&KEYEVENTF_KEYUP)&&button.mi.dwFlags==MOUSEEVENTF_LEFTDOWN&&displayID(L"\\\\.\\DISPLAY1")=="DISPLAY1"&&validDisplayID("DISPLAY1")&&!validDisplayID("bad\"id");
      emit(std::string("{\"type\":\"self-test\",\"geometry\":")+(geometry?"true":"false")+",\"releaseProtocol\":"+(releaseProtocol?"true":"false")+",\"manualReceive\":"+(geometry?"true":"false")+",\"passed\":"+(passed?"true":"false")+"}");return passed?0:1;
    }
    if(arg!="--check"&&arg!="--request"&&arg!="--layout")return 2;
    if(!refreshLayout(false)){emit("{\"type\":\"error\",\"operation\":\"layout\"}");return 1;}
    if(arg=="--layout")emit("{"+layoutFields()+"}");
    else emit("{\"type\":\"ready\",\"protocolVersion\":5,\"permission\":true,"+layoutFields()+"}");return 0;
  }
  if(!refreshLayout(false)){emit("{\"type\":\"error\",\"operation\":\"layout\"}");return 1;}
  mainThread=GetCurrentThreadId();MSG msg;PeekMessage(&msg,nullptr,0,0,PM_NOREMOVE);
  WNDCLASSW wc{};wc.lpfnWndProc=windowProc;wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=L"LocalShareDisplayNotifications";
  if(!RegisterClassW(&wc)){inputFailure("display-notifications",GetLastError());return 1;}
  // A message-only window does not receive broadcast WM_DISPLAYCHANGE.
  notificationWindow=CreateWindowExW(0,wc.lpszClassName,L"",WS_OVERLAPPED,0,0,0,0,nullptr,nullptr,wc.hInstance,nullptr);
  if(!notificationWindow){inputFailure("display-notifications",GetLastError());return 1;}
  mouseHook=SetWindowsHookEx(WH_MOUSE_LL,mouseProc,GetModuleHandle(nullptr),0);keyHook=SetWindowsHookEx(WH_KEYBOARD_LL,keyProc,GetModuleHandle(nullptr),0);
  if(!mouseHook||!keyHook){emit("{\"type\":\"ready\",\"protocolVersion\":5,\"permission\":false}");return 1;}
  lastCommand=GetTickCount64();emit("{\"type\":\"ready\",\"protocolVersion\":5,\"permission\":true,"+layoutFields()+"}");
  std::thread([](){std::string line;while(std::getline(std::cin,line)){if(line.size()>32768)continue;auto p=new std::string(line);if(!PostThreadMessage(mainThread,commandMessage,0,reinterpret_cast<LPARAM>(p)))delete p;}PostThreadMessage(mainThread,WM_QUIT,0,0);}).detach();
  if(!SetTimer(nullptr,1,100,nullptr)){inputFailure("watchdog",GetLastError());return 1;}
  while(GetMessage(&msg,nullptr,0,0)>0){
    if(msg.message==commandMessage){auto p=reinterpret_cast<std::string*>(msg.lParam);command(*p);delete p;}
    else if(msg.message==WM_TIMER){
      if(GetTickCount64()-lastLayoutCheck>=3000)refreshLayout();
      if((capture||receiving)&&GetTickCount64()-lastCommand>2000){releaseAll();emit("{\"type\":\"emergency\"}");}
    }
    else{TranslateMessage(&msg);DispatchMessage(&msg);}
  }
  releaseAll();UnhookWindowsHookEx(mouseHook);UnhookWindowsHookEx(keyHook);DestroyWindow(notificationWindow);return 0;
}
