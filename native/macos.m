#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import <dispatch/dispatch.h>
#import <unistd.h>

static const int64_t marker = 0x4c5348415245;
static BOOL capturing=NO, receiving=NO, enabled=NO, allowLeft=NO, allowRight=NO, returnLeft=YES;
static CFAbsoluteTime lastCommand=0,lastEdge=0;
static CGRect bounds;
static CFMachPortRef eventTap;
static CGEventSourceRef source;
static NSMutableSet<NSNumber *> *pressed,*buttons;
static NSDictionary<NSNumber *,NSNumber *> *keyMap,*reverseMap;
static BOOL fullFilter=NO, cursorHidden=NO, pointerDetached=NO, selfTesting=NO;
static CGPoint capturePoint;
static NSDictionary *permissionState(void) {
  BOOL accessibility=AXIsProcessTrusted(),listen=CGPreflightListenEventAccess(),postAccess=CGPreflightPostEventAccess();
  return @{@"type":@"ready",@"protocolVersion":@2,@"permission":(accessibility&&postAccess&&fullFilter)?@YES:@NO,@"accessibility":@(accessibility),@"listen":@(listen),@"post":@(postAccess),@"capture":@(fullFilter)};
}
static void emit(NSDictionary *value){NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];if(data){fwrite(data.bytes,1,data.length,stdout);fputc('\n',stdout);fflush(stdout);}}
static void post(CGEventRef event){if(!event)return;CGEventSetIntegerValueField(event,kCGEventSourceUserData,marker);CGEventPost(kCGHIDEventTap,event);CFRelease(event);}
static CGPoint cursor(void){CGEventRef event=CGEventCreate(NULL);CGPoint point=CGEventGetLocation(event);CFRelease(event);return point;}
static CGEventFlags currentFlags(void){
  CGEventFlags flags=0;
  if([pressed containsObject:@160]||[pressed containsObject:@161])flags|=kCGEventFlagMaskShift;
  if([pressed containsObject:@162]||[pressed containsObject:@163])flags|=kCGEventFlagMaskControl;
  if([pressed containsObject:@164]||[pressed containsObject:@165])flags|=kCGEventFlagMaskAlternate;
  if([pressed containsObject:@91]||[pressed containsObject:@92])flags|=kCGEventFlagMaskCommand;
  return flags;
}
static void releaseAll(void){
  BOOL wasCapturing=capturing;capturing=NO;receiving=NO;
  if(pointerDetached){CGAssociateMouseAndMouseCursorPosition(true);pointerDetached=NO;}
  if(cursorHidden){CGDisplayShowCursor(CGMainDisplayID());cursorHidden=NO;}
  if(wasCapturing&&!selfTesting)CGWarpMouseCursorPosition(capturePoint);
  lastEdge=CFAbsoluteTimeGetCurrent();
  for(NSNumber *key in [pressed copy]){NSNumber *code=reverseMap[key];if(code)post(CGEventCreateKeyboardEvent(source,code.unsignedShortValue,false));}
  for(NSNumber *button in [buttons copy]){int b=button.intValue;CGEventType type=b==0?kCGEventLeftMouseUp:b==1?kCGEventRightMouseUp:kCGEventOtherMouseUp;post(CGEventCreateMouseEvent(source,type,cursor(),b));}
  [pressed removeAllObjects];[buttons removeAllObjects];
}
static void command(NSDictionary *value){
  lastCommand=CFAbsoluteTimeGetCurrent();NSString *cmd=value[@"cmd"];
  if([cmd isEqual:@"enable"]){enabled=YES;allowLeft=[value[@"left"] boolValue];allowRight=[value[@"right"] boolValue];}
  else if([cmd isEqual:@"disable"]){enabled=NO;releaseAll();}
  else if([cmd isEqual:@"capture"]){
    releaseAll();
    if(![permissionState()[@"permission"] boolValue]||!CGEventTapIsEnabled(eventTap)){emit(@{@"type":@"error",@"operation":@"capture",@"message":@"Mac 无法完整截获键盘和鼠标，请检查辅助功能及输入监控权限并重新开启共享。"});return;}
    capturePoint=cursor();capturePoint.x=fmin(CGRectGetMaxX(bounds)-3,fmax(CGRectGetMinX(bounds)+3,capturePoint.x));
    CGError lock=CGAssociateMouseAndMouseCursorPosition(false);
    if(lock!=kCGErrorSuccess){emit(@{@"type":@"error",@"operation":@"capture",@"message":@"Mac 无法锁定本机光标，已取消跨屏控制。"});return;}
    pointerDetached=YES;
    if(CGDisplayHideCursor(CGMainDisplayID())!=kCGErrorSuccess){releaseAll();emit(@{@"type":@"error",@"operation":@"capture",@"message":@"Mac 无法隐藏本机光标，已取消跨屏控制。"});return;}
    cursorHidden=YES;capturing=YES;CGWarpMouseCursorPosition(capturePoint);emit(@{@"type":@"captured",@"requestId":value[@"requestId"]?:@""});
  }
  else if([cmd isEqual:@"receive"]){
    releaseAll();
    if(!CGPreflightPostEventAccess()){emit(@{@"type":@"error",@"operation":@"receive",@"message":@"Mac 没有输入控制权限，请在辅助功能中允许 LocalShare。"});return;}
    receiving=YES;returnLeft=[value[@"side"] isEqual:@"right"];double y=fmin(1,fmax(0,[value[@"y"] doubleValue]));
    CGError moved=CGWarpMouseCursorPosition(CGPointMake(returnLeft?CGRectGetMinX(bounds)+5:CGRectGetMaxX(bounds)-5,CGRectGetMinY(bounds)+y*(bounds.size.height-1)));
    if(moved!=kCGErrorSuccess){receiving=NO;emit(@{@"type":@"error",@"operation":@"receive",@"message":@"Mac 无法定位接收端光标，已取消跨屏控制。"});return;}
    emit(@{@"type":@"receiving",@"requestId":value[@"requestId"]?:@""});
  }
  else if([cmd isEqual:@"release"])releaseAll();
  else if([cmd isEqual:@"event"]&&receiving){
    NSString *type=value[@"type"];
    if([type isEqual:@"move"]){
      double dx=[value[@"dx"] doubleValue],dy=[value[@"dy"] doubleValue];CGPoint point=cursor();point.x+=dx;point.y+=dy;
      if((returnLeft&&dx<0&&point.x<=CGRectGetMinX(bounds))||(!returnLeft&&dx>0&&point.x>=CGRectGetMaxX(bounds)-1)){releaseAll();emit(@{@"type":@"return"});return;}
      point.x=fmin(CGRectGetMaxX(bounds)-1,fmax(CGRectGetMinX(bounds),point.x));point.y=fmin(CGRectGetMaxY(bounds)-1,fmax(CGRectGetMinY(bounds),point.y));
      CGEventType mt=[buttons containsObject:@0]?kCGEventLeftMouseDragged:[buttons containsObject:@1]?kCGEventRightMouseDragged:kCGEventMouseMoved;
      CGEventRef event=CGEventCreateMouseEvent(source,mt,point,[buttons containsObject:@1]?kCGMouseButtonRight:kCGMouseButtonLeft);CGEventSetFlags(event,currentFlags());post(event);
    }else if([type isEqual:@"key"]){
      NSNumber *vk=value[@"key"],*code=reverseMap[vk];if(!code)return;BOOL down=[value[@"down"] boolValue];if(down)[pressed addObject:vk];else [pressed removeObject:vk];
      CGEventRef event=CGEventCreateKeyboardEvent(source,code.unsignedShortValue,down);CGEventSetFlags(event,currentFlags());post(event);
    }else if([type isEqual:@"button"]){
      NSNumber *button=value[@"button"];int b=button.intValue;BOOL down=[value[@"down"] boolValue];if(down)[buttons addObject:button];else [buttons removeObject:button];
      CGEventType mt=b==0?(down?kCGEventLeftMouseDown:kCGEventLeftMouseUp):b==1?(down?kCGEventRightMouseDown:kCGEventRightMouseUp):(down?kCGEventOtherMouseDown:kCGEventOtherMouseUp);
      CGEventRef event=CGEventCreateMouseEvent(source,mt,cursor(),b);CGEventSetFlags(event,currentFlags());post(event);
    }else if([type isEqual:@"scroll"])post(CGEventCreateScrollWheelEvent(source,kCGScrollEventUnitLine,2,[value[@"dy"] intValue],[value[@"dx"] intValue]));
  }
}
static CGEventRef callback(CGEventTapProxy proxy,CGEventType type,CGEventRef event,void *context){
  if(type==kCGEventTapDisabledByTimeout||type==kCGEventTapDisabledByUserInput){releaseAll();emit(@{@"type":@"emergency"});CGEventTapEnable(eventTap,true);return event;}
  if(CGEventGetIntegerValueField(event,kCGEventSourceUserData)==marker)return event;
  int code=(int)CGEventGetIntegerValueField(event,kCGKeyboardEventKeycode);CGEventFlags flags=CGEventGetFlags(event);
  if(type==kCGEventKeyDown&&code==53&&(flags&kCGEventFlagMaskControl)&&(flags&kCGEventFlagMaskAlternate)){releaseAll();emit(@{@"type":@"emergency"});return NULL;}
  if(capturing){
    switch(type){
      case kCGEventMouseMoved:case kCGEventLeftMouseDragged:case kCGEventRightMouseDragged:case kCGEventOtherMouseDragged:
        emit(@{@"type":@"move",@"dx":@(CGEventGetDoubleValueField(event,kCGMouseEventDeltaX)),@"dy":@(CGEventGetDoubleValueField(event,kCGMouseEventDeltaY))});
        break;
      case kCGEventKeyDown:case kCGEventKeyUp:
        if(keyMap[@(code)])emit(@{@"type":@"key",@"key":keyMap[@(code)],@"down":type==kCGEventKeyDown?@YES:@NO});break;
      case kCGEventFlagsChanged:{
        NSNumber *vk=keyMap[@(code)];if(vk){int v=vk.intValue;CGEventFlags flag=(v==160||v==161)?kCGEventFlagMaskShift:(v==162||v==163)?kCGEventFlagMaskControl:(v==164||v==165)?kCGEventFlagMaskAlternate:kCGEventFlagMaskCommand;
          emit(@{@"type":@"key",@"key":vk,@"down":(flags&flag)!=0?@YES:@NO});}break;
      }
      case kCGEventLeftMouseDown:case kCGEventLeftMouseUp:case kCGEventRightMouseDown:case kCGEventRightMouseUp:case kCGEventOtherMouseDown:case kCGEventOtherMouseUp:{
        int b=(type==kCGEventLeftMouseDown||type==kCGEventLeftMouseUp)?0:(type==kCGEventRightMouseDown||type==kCGEventRightMouseUp)?1:2;
        emit(@{@"type":@"button",@"button":@(b),@"down":(type==kCGEventLeftMouseDown||type==kCGEventRightMouseDown||type==kCGEventOtherMouseDown)?@YES:@NO});break;
      }
      case kCGEventScrollWheel:emit(@{@"type":@"scroll",@"dx":@(CGEventGetDoubleValueField(event,kCGScrollWheelEventDeltaAxis2)),@"dy":@(CGEventGetDoubleValueField(event,kCGScrollWheelEventDeltaAxis1))});break;
      default:break;
    }
    return NULL;
  }
  if(enabled&&!receiving&&type==kCGEventMouseMoved&&CFAbsoluteTimeGetCurrent()-lastEdge>1){CGPoint point=CGEventGetLocation(event);double dx=CGEventGetDoubleValueField(event,kCGMouseEventDeltaX);
    if((allowLeft&&point.x<=CGRectGetMinX(bounds)+1&&dx<0)||(allowRight&&point.x>=CGRectGetMaxX(bounds)-2&&dx>0)){lastEdge=CFAbsoluteTimeGetCurrent();emit(@{@"type":@"edge",@"side":dx>0?@"right":@"left",@"y":@(fmin(1,fmax(0,(point.y-CGRectGetMinY(bounds))/bounds.size.height)))});}
  }
  return event;
}
static int selfTest(void) {
  selfTesting=YES;capturing=YES;BOOL suppressed=YES;
  CGEventRef keyDown=CGEventCreateKeyboardEvent(source,0,true),keyUp=CGEventCreateKeyboardEvent(source,0,false);
  CGEventRef down=CGEventCreateMouseEvent(source,kCGEventLeftMouseDown,CGPointMake(100,100),kCGMouseButtonLeft),up=CGEventCreateMouseEvent(source,kCGEventLeftMouseUp,CGPointMake(100,100),kCGMouseButtonLeft);
  CGEventRef move=CGEventCreateMouseEvent(source,kCGEventMouseMoved,CGPointMake(101,102),kCGMouseButtonLeft),scroll=CGEventCreateScrollWheelEvent(source,kCGScrollEventUnitLine,2,1,0);
  CGEventSetDoubleValueField(move,kCGMouseEventDeltaX,1);CGEventSetDoubleValueField(move,kCGMouseEventDeltaY,2);
  CGEventRef events[]={keyDown,keyUp,down,up,move,scroll};CGEventType types[]={kCGEventKeyDown,kCGEventKeyUp,kCGEventLeftMouseDown,kCGEventLeftMouseUp,kCGEventMouseMoved,kCGEventScrollWheel};
  for(int i=0;i<6;i++){if(!events[i]||callback(NULL,types[i],events[i],NULL)!=NULL)suppressed=NO;if(events[i])CFRelease(events[i]);}
  capturing=NO;selfTesting=NO;emit(@{@"type":@"self-test",@"suppressed":@(suppressed)});return suppressed?0:1;
}
int main(int argc,const char **argv){@autoreleasepool{
  BOOL check=argc>1&&strcmp(argv[1],"--check")==0,request=argc>1&&strcmp(argv[1],"--request")==0,test=argc>1&&strcmp(argv[1],"--self-test")==0;
  if(argc>1&&!check&&!request&&!test)return 2;
  if(request){AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)@{(__bridge NSString *)kAXTrustedCheckOptionPrompt:@YES});if(!CGPreflightListenEventAccess())CGRequestListenEventAccess();if(!CGPreflightPostEventAccess())CGRequestPostEventAccess();}
  keyMap=@{@0:@65,@1:@83,@2:@68,@3:@70,@4:@72,@5:@71,@6:@90,@7:@88,@8:@67,@9:@86,@11:@66,@12:@81,@13:@87,@14:@69,@15:@82,@16:@89,@17:@84,@18:@49,@19:@50,@20:@51,@21:@52,@22:@54,@23:@53,@24:@187,@25:@57,@26:@55,@27:@189,@28:@56,@29:@48,@30:@221,@31:@79,@32:@85,@33:@219,@34:@73,@35:@80,@36:@13,@37:@76,@38:@74,@39:@222,@40:@75,@41:@186,@42:@220,@43:@188,@44:@191,@45:@78,@46:@77,@47:@190,@48:@9,@49:@32,@50:@192,@51:@8,@53:@27,@54:@92,@55:@91,@56:@160,@57:@20,@58:@164,@59:@162,@60:@161,@61:@165,@62:@163,@65:@110,@67:@106,@69:@107,@71:@144,@75:@111,@76:@13,@78:@109,@81:@187,@82:@96,@83:@97,@84:@98,@85:@99,@86:@100,@87:@101,@88:@102,@89:@103,@91:@104,@92:@105,@96:@116,@97:@117,@98:@118,@99:@114,@100:@119,@101:@120,@103:@122,@109:@121,@111:@123,@114:@45,@115:@36,@116:@33,@117:@46,@118:@115,@119:@35,@120:@113,@121:@34,@122:@112,@123:@37,@124:@39,@125:@40,@126:@38};
  NSMutableDictionary *reverse=[NSMutableDictionary dictionary];for(NSNumber *mac in keyMap)reverse[keyMap[mac]]=mac;reverse[@13]=@36;reverseMap=[reverse copy];
  pressed=[NSMutableSet set];buttons=[NSMutableSet set];bounds=CGDisplayBounds(CGMainDisplayID());source=CGEventSourceCreate(kCGEventSourceStateHIDSystemState);lastCommand=CFAbsoluteTimeGetCurrent();
  if(test)return selfTest();
  CGEventMask mask=CGEventMaskBit(kCGEventMouseMoved)|CGEventMaskBit(kCGEventLeftMouseDragged)|CGEventMaskBit(kCGEventRightMouseDragged)|CGEventMaskBit(kCGEventOtherMouseDragged)|CGEventMaskBit(kCGEventKeyDown)|CGEventMaskBit(kCGEventKeyUp)|CGEventMaskBit(kCGEventFlagsChanged)|CGEventMaskBit(kCGEventLeftMouseDown)|CGEventMaskBit(kCGEventLeftMouseUp)|CGEventMaskBit(kCGEventRightMouseDown)|CGEventMaskBit(kCGEventRightMouseUp)|CGEventMaskBit(kCGEventOtherMouseDown)|CGEventMaskBit(kCGEventOtherMouseUp)|CGEventMaskBit(kCGEventScrollWheel);
  eventTap=CGEventTapCreate(kCGHIDEventTap,kCGHeadInsertEventTap,kCGEventTapOptionDefault,mask,callback,NULL);
  if(eventTap){CGEventTapInformation list[256];uint32_t count=0;if(CGGetEventTapList(256,list,&count)==kCGErrorSuccess)for(uint32_t i=0;i<MIN(count,256);i++)if(list[i].tappingProcess==getpid()&&list[i].tapPoint==kCGHIDEventTap&&(list[i].eventsOfInterest&mask)==mask)fullFilter=YES;}
  NSDictionary *permissions=permissionState();
  if(check||request||![permissions[@"permission"] boolValue]){emit(permissions);if(eventTap)CFRelease(eventTap);CFRelease(source);return check||request?0:1;}
  CFRunLoopSourceRef loopSource=CFMachPortCreateRunLoopSource(kCFAllocatorDefault,eventTap,0);CFRunLoopAddSource(CFRunLoopGetMain(),loopSource,kCFRunLoopCommonModes);CGEventTapEnable(eventTap,true);emit(permissions);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE,0),^{char buffer[32770];while(fgets(buffer,sizeof(buffer),stdin)){@autoreleasepool{NSData *data=[[NSString stringWithUTF8String:buffer] dataUsingEncoding:NSUTF8StringEncoding];NSDictionary *value=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];if([value isKindOfClass:[NSDictionary class]])dispatch_async(dispatch_get_main_queue(),^{command(value);});}}dispatch_async(dispatch_get_main_queue(),^{releaseAll();exit(0);});});
  dispatch_source_t watchdog=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,dispatch_get_main_queue());dispatch_source_set_timer(watchdog,DISPATCH_TIME_NOW,250*NSEC_PER_MSEC,25*NSEC_PER_MSEC);dispatch_source_set_event_handler(watchdog,^{if((capturing||receiving)&&CFAbsoluteTimeGetCurrent()-lastCommand>2){releaseAll();emit(@{@"type":@"emergency"});}});dispatch_resume(watchdog);
  CFRunLoopRun();releaseAll();CFRelease(source);return 0;
}}
