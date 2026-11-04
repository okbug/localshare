#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <iostream>
#include <string>
#include <thread>
#include <set>
#include <algorithm>
#include <cmath>

constexpr ULONG_PTR marker = 0x4c534841;
constexpr UINT commandMessage = WM_APP + 1;
DWORD mainThread;
bool capture = false, receiving = false, enabled = false, allowLeft = false, allowRight = false;
bool returnLeft = true;
ULONGLONG lastCommand = 0, lastEdge = 0;
POINT anchor{};
POINT returnPoint{};
std::set<int> keys, buttons;
std::set<DWORD> physicalKeys;
HHOOK mouseHook, keyHook;
int screenWidth, screenHeight;
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
void releaseAll();
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
void releaseAll() {
  if(capture){ShowCursor(TRUE);SetCursorPos(returnPoint.x,returnPoint.y);}
  capture=false;receiving=false;lastEdge=GetTickCount64();
  for(int key:keys)sendKey(key,false,false);for(int b:buttons)sendButton(b,false,false);
  keys.clear();buttons.clear();
}
void command(const std::string& s) {
  lastCommand=GetTickCount64();auto cmd=str(s,"cmd");
  if(cmd=="enable"){enabled=true;allowLeft=boolean(s,"left");allowRight=boolean(s,"right");}
  else if(cmd=="disable"){enabled=false;releaseAll();}
  else if(cmd=="capture"){releaseAll();GetCursorPos(&returnPoint);returnPoint.x=std::clamp(returnPoint.x,LONG(3),LONG(screenWidth-4));anchor={screenWidth/2,screenHeight/2};if(!SetCursorPos(anchor.x,anchor.y)){inputFailure("capture",GetLastError());return;}capture=true;ShowCursor(FALSE);emit("{\"type\":\"captured\",\"requestId\":\""+str(s,"requestId")+"\"}");}
  else if(cmd=="receive"){releaseAll();returnLeft=str(s,"side")=="right";if(!SetCursorPos(returnLeft?5:screenWidth-6,int(std::clamp(num(s,"y"),0.0,1.0)*(screenHeight-1)))){inputFailure("receive",GetLastError());return;}receiving=true;emit("{\"type\":\"receiving\",\"requestId\":\""+str(s,"requestId")+"\"}");}
  else if(cmd=="release")releaseAll();
  else if(cmd=="event"&&receiving){
    auto type=str(s,"type");
    if(type=="move"){
      POINT current;GetCursorPos(&current);double dx=num(s,"dx"),dy=num(s,"dy");
      int x=current.x+int(dx),y=current.y+int(dy);
      if((returnLeft&&dx<0&&x<=0)||(!returnLeft&&dx>0&&x>=screenWidth-1)){releaseAll();emit("{\"type\":\"return\"}");return;}
      INPUT i{};i.type=INPUT_MOUSE;i.mi.dwFlags=MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE;i.mi.dwExtraInfo=marker;
      i.mi.dx=LONG(double(std::clamp(x,0,screenWidth-1))*65535/(screenWidth-1));i.mi.dy=LONG(double(std::clamp(y,0,screenHeight-1))*65535/(screenHeight-1));inject(i,"move");
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
      SetCursorPos(anchor.x,anchor.y);
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
    const bool left=allowLeft&&e->pt.x<=0,right=allowRight&&e->pt.x>=screenWidth-1;
    if(left||right){lastEdge=GetTickCount64();emit("{\"type\":\"edge\",\"side\":\""+std::string(left?"left":"right")+"\",\"y\":"+std::to_string(double(e->pt.y)/(screenHeight-1))+"}");}
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
  if(argc>1){
    std::string arg=argv[1];
    if(arg=="--self-test"){
      std::string value="{\"cmd\":\"event\",\"type\":\"key\",\"key\":65,\"down\":true}";
      INPUT down=keyInput(65,true),up=keyInput(65,false),button=buttonInput(0,true);
      bool passed=str(value,"cmd")=="event"&&str(value,"type")=="key"&&num(value,"key")==65&&boolean(value,"down")&&down.ki.wScan!=0&&(down.ki.dwFlags&KEYEVENTF_SCANCODE)&&(up.ki.dwFlags&KEYEVENTF_KEYUP)&&button.mi.dwFlags==MOUSEEVENTF_LEFTDOWN;
      emit(std::string("{\"type\":\"self-test\",\"passed\":")+(passed?"true":"false")+"}");return passed?0:1;
    }
    if(arg!="--check"&&arg!="--request")return 2;
    emit("{\"type\":\"ready\",\"protocolVersion\":2,\"permission\":true}");return 0;
  }
  SetProcessDPIAware();screenWidth=GetSystemMetrics(SM_CXSCREEN);screenHeight=GetSystemMetrics(SM_CYSCREEN);
  mainThread=GetCurrentThreadId();MSG msg;PeekMessage(&msg,nullptr,0,0,PM_NOREMOVE);
  mouseHook=SetWindowsHookEx(WH_MOUSE_LL,mouseProc,GetModuleHandle(nullptr),0);keyHook=SetWindowsHookEx(WH_KEYBOARD_LL,keyProc,GetModuleHandle(nullptr),0);
  if(!mouseHook||!keyHook){emit("{\"type\":\"ready\",\"protocolVersion\":2,\"permission\":false}");return 1;}
  lastCommand=GetTickCount64();emit("{\"type\":\"ready\",\"protocolVersion\":2,\"permission\":true}");
  std::thread([](){std::string line;while(std::getline(std::cin,line)){if(line.size()>32768)continue;auto p=new std::string(line);if(!PostThreadMessage(mainThread,commandMessage,0,reinterpret_cast<LPARAM>(p)))delete p;}PostThreadMessage(mainThread,WM_QUIT,0,0);}).detach();
  SetTimer(nullptr,1,100,nullptr);
  while(GetMessage(&msg,nullptr,0,0)>0){
    if(msg.message==commandMessage){auto p=reinterpret_cast<std::string*>(msg.lParam);command(*p);delete p;}
    else if(msg.message==WM_TIMER){if((capture||receiving)&&GetTickCount64()-lastCommand>2000){releaseAll();emit("{\"type\":\"emergency\"}");}}
    else{TranslateMessage(&msg);DispatchMessage(&msg);}
  }
  releaseAll();UnhookWindowsHookEx(mouseHook);UnhookWindowsHookEx(keyHook);return 0;
}
