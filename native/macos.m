#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import <dispatch/dispatch.h>
#import <unistd.h>
#import <signal.h>

static const int64_t marker = 0x4c5348415245;
static BOOL capturing=NO, receiving=NO, enabled=NO, allowLeft=NO, allowRight=NO, returnLeft=YES, manualReceive=NO;
static CFAbsoluteTime lastCommand=0,lastEdge=0;
static CGRect bounds, receiveBounds;
static CFMachPortRef eventTap;
static CGEventSourceRef source;
static NSMutableSet<NSNumber *> *pressed,*buttons;
static NSDictionary<NSNumber *,NSNumber *> *keyMap,*reverseMap;
static BOOL fullFilter=NO, cursorHidden=NO, pointerDetached=NO, restorePending=NO;
static CGPoint restorePoint, captureAnchor;
// All cursor side effects go through this seam. Self-tests replace it before
// exercising the same command/callback/watchdog paths used by the app.
static CGPoint realCursor(void){CGEventRef event=CGEventCreate(NULL);if(!event)return CGPointMake(NAN,NAN);CGPoint point=CGEventGetLocation(event);CFRelease(event);return point;}
static CGRect realCaptureBounds(CGPoint point){CGDirectDisplayID display=0;uint32_t count=0;if(CGGetDisplaysWithPoint(point,1,&display,&count)!=kCGErrorSuccess||count==0)return CGRectZero;return CGDisplayBounds(display);}
static BOOL realCapturePermission(void){return AXIsProcessTrusted()&&CGPreflightPostEventAccess()&&fullFilter&&eventTap&&CGEventTapIsEnabled(eventTap);}
static CGError realHide(void){return CGDisplayHideCursor(CGMainDisplayID());}
static CGError realShow(void){return CGDisplayShowCursor(CGMainDisplayID());}
static void realPostEvent(CGEventRef event){CGEventPost(kCGHIDEventTap,event);}
static void realEnableTap(void){if(eventTap)CGEventTapEnable(eventTap,true);}
static struct {
  CGPoint (*cursor)(void);
  CGRect (*captureBounds)(CGPoint);
  BOOL (*permission)(void);
  BOOL (*postPermission)(void);
  CGError (*associate)(boolean_t);
  CGError (*hide)(void);
  CGError (*show)(void);
  CGError (*warp)(CGPoint);
  void (*enableTap)(void);
  void (*postEvent)(CGEventRef);
} captureOS={realCursor,realCaptureBounds,realCapturePermission,CGPreflightPostEventAccess,CGAssociateMouseAndMouseCursorPosition,realHide,realShow,CGWarpMouseCursorPosition,realEnableTap,realPostEvent};
static NSMutableArray *testEvents;
static BOOL atPoint(CGPoint a,CGPoint b){return isfinite(a.x)&&isfinite(a.y)&&fabs(a.x-b.x)<0.5&&fabs(a.y-b.y)<0.5;}
static NSDictionary *permissionState(void) {
  BOOL accessibility=AXIsProcessTrusted(),listen=CGPreflightListenEventAccess(),postAccess=CGPreflightPostEventAccess();
  return @{@"type":@"ready",@"protocolVersion":@4,@"permission":(accessibility&&postAccess&&fullFilter)?@YES:@NO,@"accessibility":@(accessibility),@"listen":@(listen),@"post":@(postAccess),@"capture":@(fullFilter)};
}
static void emit(NSDictionary *value){if(testEvents){[testEvents addObject:value];return;}NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];if(data){fwrite(data.bytes,1,data.length,stdout);fputc('\n',stdout);fflush(stdout);}}
static void post(CGEventRef event){if(!event)return;CGEventSetIntegerValueField(event,kCGEventSourceUserData,marker);captureOS.postEvent(event);CFRelease(event);}
static CGPoint cursor(void){return captureOS.cursor();}
static CGEventFlags currentFlags(void){
  CGEventFlags flags=0;
  if([pressed containsObject:@160]||[pressed containsObject:@161])flags|=kCGEventFlagMaskShift;
  if([pressed containsObject:@162]||[pressed containsObject:@163])flags|=kCGEventFlagMaskControl;
  if([pressed containsObject:@164]||[pressed containsObject:@165])flags|=kCGEventFlagMaskAlternate;
  if([pressed containsObject:@91]||[pressed containsObject:@92])flags|=kCGEventFlagMaskCommand;
  return flags;
}
static BOOL releaseAll(void){
  // Clear capture before OS calls: errors and later watchdog ticks cannot recurse.
  capturing=NO;receiving=NO;manualReceive=NO;
  if(pointerDetached&&captureOS.associate(true)==kCGErrorSuccess)pointerDetached=NO;
  if(restorePending&&captureOS.warp(restorePoint)==kCGErrorSuccess&&atPoint(cursor(),restorePoint)&&!pointerDetached)restorePending=NO;
  if(cursorHidden&&captureOS.show()==kCGErrorSuccess)cursorHidden=NO;
  lastEdge=CFAbsoluteTimeGetCurrent();
  for(NSNumber *key in [pressed copy]){NSNumber *code=reverseMap[key];if(code)post(CGEventCreateKeyboardEvent(source,code.unsignedShortValue,false));}
  for(NSNumber *button in [buttons copy]){int b=button.intValue;CGEventType type=b==0?kCGEventLeftMouseUp:b==1?kCGEventRightMouseUp:kCGEventOtherMouseUp;post(CGEventCreateMouseEvent(source,type,cursor(),b));}
  [pressed removeAllObjects];[buttons removeAllObjects];
  return !pointerDetached&&!restorePending&&!cursorHidden;
}
static BOOL shutdownCleanup(void){
  // EOF and graceful termination have no later watchdog tick. Retry transient
  // cursor API failures before exiting; forced termination remains OS-owned.
  for(int attempt=0;attempt<3;attempt++)if(releaseAll())return YES;
  emit(@{@"type":@"error",@"operation":@"release",@"message":@"Mac 无法完整恢复本机光标，已停止跨屏控制。"});return NO;
}
static void captureFailure(NSString *message){releaseAll();emit(@{@"type":@"error",@"operation":@"capture",@"message":message});}
static BOOL keepCaptureAnchored(void){
  if(!capturing)return YES;
  if(atPoint(cursor(),captureAnchor))return YES;
  // The public CGWarp API explicitly generates no input events. Never derive
  // remote deltas from this warp or from absolute coordinates: HID deltas survive.
  if(captureOS.warp(captureAnchor)==kCGErrorSuccess&&atPoint(cursor(),captureAnchor))return YES;
  captureFailure(@"Mac 无法保持本机光标居中，已取消跨屏控制。");return NO;
}
static void watchdogTick(void){
  if((capturing||receiving)&&CFAbsoluteTimeGetCurrent()-lastCommand>2){releaseAll();emit(@{@"type":@"emergency"});}
  else if(capturing)keepCaptureAnchored();
  else if(pointerDetached||restorePending||cursorHidden)releaseAll();
}
static void command(NSDictionary *value){
  lastCommand=CFAbsoluteTimeGetCurrent();NSString *cmd=value[@"cmd"];
  if([cmd isEqual:@"enable"]){enabled=YES;allowLeft=[value[@"left"] boolValue];allowRight=[value[@"right"] boolValue];}
  else if([cmd isEqual:@"disable"]){enabled=NO;releaseAll();}
  else if([cmd isEqual:@"capture"]){
    if(!releaseAll()){emit(@{@"type":@"error",@"operation":@"capture",@"message":@"Mac 光标恢复尚未完成，已取消跨屏控制。"});return;}
    if(!captureOS.permission()){emit(@{@"type":@"error",@"operation":@"capture",@"message":@"Mac 无法完整截获键盘和鼠标，请检查辅助功能及输入监控权限并重新开启共享。"});return;}
    restorePoint=cursor();CGRect captureBounds=captureOS.captureBounds(restorePoint);
    if(!isfinite(restorePoint.x)||!isfinite(restorePoint.y)||CGRectIsEmpty(captureBounds)){emit(@{@"type":@"error",@"operation":@"capture",@"message":@"Mac 无法读取本机光标位置，已取消跨屏控制。"});return;}
    captureAnchor=CGPointMake(CGRectGetMidX(captureBounds),CGRectGetMidY(captureBounds));
    if(captureOS.associate(false)!=kCGErrorSuccess){emit(@{@"type":@"error",@"operation":@"capture",@"message":@"Mac 无法锁定本机光标，已取消跨屏控制。"});return;}
    pointerDetached=YES;restorePending=YES;
    if(captureOS.hide()!=kCGErrorSuccess){captureFailure(@"Mac 无法隐藏本机光标，已取消跨屏控制。");return;}
    cursorHidden=YES;
    if(captureOS.warp(captureAnchor)!=kCGErrorSuccess||!atPoint(cursor(),captureAnchor)){captureFailure(@"Mac 无法将本机光标居中，已取消跨屏控制。");return;}
    capturing=YES;emit(@{@"type":@"captured",@"requestId":value[@"requestId"]?:@""});
  }
  else if([cmd isEqual:@"receive"]){
    if(!releaseAll()){emit(@{@"type":@"error",@"operation":@"receive",@"message":@"Mac 光标恢复尚未完成，已取消跨屏控制。"});return;}
    if(!captureOS.postPermission()){emit(@{@"type":@"error",@"operation":@"receive",@"message":@"Mac 没有输入控制权限，请在辅助功能中允许 LocalShare。"});return;}
    BOOL manual=[value[@"manual"] boolValue];CGPoint current=cursor();
    // Manual control keeps the current Mac display; edge entry retains the
    // existing main-display policy. Neither mode traverses Mac display seams.
    receiveBounds=manual&&isfinite(current.x)&&isfinite(current.y)?captureOS.captureBounds(current):bounds;
    if(!isfinite(current.x)||!isfinite(current.y)||CGRectIsEmpty(receiveBounds)){emit(@{@"type":@"error",@"operation":@"receive",@"message":@"Mac 无法读取接收端光标位置，已取消控制。"});return;}
    returnLeft=[value[@"side"] isEqual:@"right"];
    if(!manual){
      double y=fmin(1,fmax(0,[value[@"y"] doubleValue]));
      CGError moved=captureOS.warp(CGPointMake(returnLeft?CGRectGetMinX(receiveBounds)+5:CGRectGetMaxX(receiveBounds)-5,CGRectGetMinY(receiveBounds)+y*(receiveBounds.size.height-1)));
      if(moved!=kCGErrorSuccess){emit(@{@"type":@"error",@"operation":@"receive",@"message":@"Mac 无法定位接收端光标，已取消跨屏控制。"});return;}
    }
    manualReceive=manual;receiving=YES;
    emit(@{@"type":@"receiving",@"requestId":value[@"requestId"]?:@""});
  }
  else if([cmd isEqual:@"release"])releaseAll();
  else if([cmd isEqual:@"event"]&&receiving){
    NSString *type=value[@"type"];
    if([type isEqual:@"move"]){
      double dx=[value[@"dx"] doubleValue],dy=[value[@"dy"] doubleValue];CGPoint point=cursor();point.x+=dx;point.y+=dy;
      if(!manualReceive&&((returnLeft&&dx<0&&point.x<=CGRectGetMinX(receiveBounds))||(!returnLeft&&dx>0&&point.x>=CGRectGetMaxX(receiveBounds)-1))){releaseAll();emit(@{@"type":@"return"});return;}
      point.x=fmin(CGRectGetMaxX(receiveBounds)-1,fmax(CGRectGetMinX(receiveBounds),point.x));point.y=fmin(CGRectGetMaxY(receiveBounds)-1,fmax(CGRectGetMinY(receiveBounds),point.y));
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
  if(type==kCGEventTapDisabledByTimeout||type==kCGEventTapDisabledByUserInput){releaseAll();emit(@{@"type":@"emergency"});captureOS.enableTap();return event;}
  if(CGEventGetIntegerValueField(event,kCGEventSourceUserData)==marker||CGEventGetIntegerValueField(event,kCGEventSourceUnixProcessID)==getpid())return capturing?NULL:event;
  int code=(int)CGEventGetIntegerValueField(event,kCGKeyboardEventKeycode);CGEventFlags flags=CGEventGetFlags(event);
  if(type==kCGEventKeyDown&&code==53&&(flags&kCGEventFlagMaskControl)&&(flags&kCGEventFlagMaskAlternate)){releaseAll();emit(@{@"type":@"emergency"});return NULL;}
  if(capturing){
    switch(type){
      case kCGEventMouseMoved:case kCGEventLeftMouseDragged:case kCGEventRightMouseDragged:case kCGEventOtherMouseDragged:
        if(!keepCaptureAnchored())return NULL;
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
// Deterministic OS adapter: these functions never touch the user's cursor,
// event taps, permissions, or any running LocalShare instance.
static struct {CGPoint point;BOOL detached,hidden,permission,shiftOnAttach;int failDetach,failAttach,failHide,failShow,failWarp,ignoreWarp,warps,attaches,shows,tapEnables,posts;} fake;
static const CGPoint fakeOriginal={-125.25,977.75};
static CGPoint fakeCursor(void){return fake.point;}
static CGRect fakeCaptureBounds(CGPoint point){return CGRectMake(-1440,0,1440,1080);}
static BOOL fakePermission(void){return fake.permission;}
static CGError fakeAssociate(boolean_t attached){if(attached){fake.attaches++;if(fake.failAttach){fake.failAttach--;return kCGErrorFailure;}}else if(fake.failDetach){fake.failDetach--;return kCGErrorFailure;}if(attached&&fake.shiftOnAttach)fake.point=CGPointMake(33,44);fake.detached=!attached;return kCGErrorSuccess;}
static CGError fakeHide(void){if(fake.failHide){fake.failHide--;return kCGErrorFailure;}fake.hidden=YES;return kCGErrorSuccess;}
static CGError fakeShow(void){fake.shows++;if(fake.failShow){fake.failShow--;return kCGErrorFailure;}fake.hidden=NO;return kCGErrorSuccess;}
static CGError fakeWarp(CGPoint point){fake.warps++;if(fake.failWarp){fake.failWarp--;return kCGErrorFailure;}if(fake.ignoreWarp){fake.ignoreWarp--;return kCGErrorSuccess;}fake.point=point;return kCGErrorSuccess;}
static void fakePostEvent(CGEventRef event){fake.posts++;CGEventType type=CGEventGetType(event);if(type==kCGEventMouseMoved||type==kCGEventLeftMouseDragged||type==kCGEventRightMouseDragged||type==kCGEventOtherMouseDragged)fake.point=CGEventGetLocation(event);}
static void fakeEnableTap(void){fake.tapEnables++;}
static void fakeReset(void){
  memset(&fake,0,sizeof(fake));fake.point=fakeOriginal;fake.permission=YES;
  capturing=NO;receiving=NO;manualReceive=NO;pointerDetached=NO;cursorHidden=NO;restorePending=NO;
  [pressed removeAllObjects];[buttons removeAllObjects];testEvents=[NSMutableArray array];
}
static BOOL fakeRestored(void){return !capturing&&!receiving&&!fake.detached&&!fake.hidden&&!pointerDetached&&!cursorHidden&&!restorePending&&CGPointEqualToPoint(fake.point,fakeOriginal);}
static void fakeCapture(void){command(@{@"cmd":@"capture",@"requestId":@"self-test"});}
static CGEventRef fakeMove(double dx,double dy){CGEventRef event=CGEventCreateMouseEvent(source,kCGEventMouseMoved,captureAnchor,kCGMouseButtonLeft);CGEventSetIntegerValueField(event,kCGEventSourceUnixProcessID,0);CGEventSetDoubleValueField(event,kCGMouseEventDeltaX,dx);CGEventSetDoubleValueField(event,kCGMouseEventDeltaY,dy);return event;}
static int selfTest(void) {
  captureOS.cursor=fakeCursor;captureOS.captureBounds=fakeCaptureBounds;captureOS.permission=fakePermission;captureOS.postPermission=fakePermission;
  captureOS.associate=fakeAssociate;captureOS.hide=fakeHide;captureOS.show=fakeShow;captureOS.warp=fakeWarp;captureOS.enableTap=fakeEnableTap;captureOS.postEvent=fakePostEvent;
  NSMutableDictionary *cases=[NSMutableDictionary dictionary];fakeReset();fakeCapture();
  BOOL centered=capturing&&fake.detached&&fake.hidden&&atPoint(fake.point,CGPointMake(-720,540))&&atPoint(restorePoint,fakeOriginal);
  BOOL suppressed=YES;testEvents=nil;
  CGEventRef keyDown=CGEventCreateKeyboardEvent(source,0,true),keyUp=CGEventCreateKeyboardEvent(source,0,false);
  CGEventRef down=CGEventCreateMouseEvent(source,kCGEventLeftMouseDown,CGPointMake(100,100),kCGMouseButtonLeft),up=CGEventCreateMouseEvent(source,kCGEventLeftMouseUp,CGPointMake(100,100),kCGMouseButtonLeft);
  CGEventRef move=fakeMove(1,2),scroll=CGEventCreateScrollWheelEvent(source,kCGScrollEventUnitLine,2,1,0);
  CGEventRef events[]={keyDown,keyUp,down,up,move,scroll};CGEventType types[]={kCGEventKeyDown,kCGEventKeyUp,kCGEventLeftMouseDown,kCGEventLeftMouseUp,kCGEventMouseMoved,kCGEventScrollWheel};
  for(int i=0;i<6;i++){if(events[i])CGEventSetIntegerValueField(events[i],kCGEventSourceUnixProcessID,0);if(!events[i]||callback(NULL,types[i],events[i],NULL)!=NULL)suppressed=NO;if(events[i])CFRelease(events[i]);}
  testEvents=[NSMutableArray array];releaseAll();cases[@"centerAndRestore"]=@(centered&&fakeRestored());
  int warps=fake.warps,shows=fake.shows,attaches=fake.attaches;releaseAll();cases[@"doubleRelease"]=@(fakeRestored()&&fake.warps==warps&&fake.shows==shows&&fake.attaches==attaches);
  fakeReset();fakeCapture();command(@{@"cmd":@"disable"});cases[@"stop"]=@(fakeRestored());
  fakeReset();fakeCapture();lastCommand-=3;watchdogTick();cases[@"watchdog"]=@(fakeRestored()&&[testEvents.lastObject[@"type"] isEqual:@"emergency"]);
  fakeReset();fakeCapture();callback(NULL,kCGEventTapDisabledByTimeout,NULL,NULL);cases[@"tapDisabled"]=@(fakeRestored()&&fake.tapEnables==1);
  fakeReset();fake.permission=NO;fakeCapture();cases[@"permissionFailure"]=@(fakeRestored()&&fake.warps==0&&[testEvents.lastObject[@"type"] isEqual:@"error"]);
  fakeReset();fake.failDetach=1;fakeCapture();cases[@"detachFailure"]=@(fakeRestored()&&[testEvents.lastObject[@"type"] isEqual:@"error"]);
  fakeReset();fake.failHide=1;fakeCapture();cases[@"hideFailure"]=@(fakeRestored()&&[testEvents.lastObject[@"type"] isEqual:@"error"]);
  fakeReset();fake.failWarp=1;fakeCapture();cases[@"warpFailure"]=@(fakeRestored()&&[testEvents.lastObject[@"type"] isEqual:@"error"]);
  fakeReset();fake.ignoreWarp=1;fakeCapture();cases[@"warpVerificationFailure"]=@(fakeRestored()&&[testEvents.lastObject[@"type"] isEqual:@"error"]);
  fakeReset();fakeCapture();fake.point=CGPointMake(2,4);move=fakeMove(13,-7);NSUInteger before=testEvents.count;
  BOOL dropped=callback(NULL,kCGEventMouseMoved,move,NULL)==NULL;CFRelease(move);
  NSDictionary *delta=testEvents.lastObject;BOOL deltas=dropped&&testEvents.count==before+1&&[delta[@"type"] isEqual:@"move"]&&[delta[@"dx"] doubleValue]==13&&[delta[@"dy"] doubleValue]==-7;
  BOOL corrected=capturing&&atPoint(fake.point,captureAnchor);fake.point=CGPointMake(9,9);watchdogTick();cases[@"driftCorrection"]=@(corrected&&capturing&&atPoint(fake.point,captureAnchor));
  move=fakeMove(500,500);CGEventSetIntegerValueField(move,kCGEventSourceUserData,marker);before=testEvents.count;
  BOOL synthetic=callback(NULL,kCGEventMouseMoved,move,NULL)==NULL&&testEvents.count==before;CGEventSetIntegerValueField(move,kCGEventSourceUserData,0);CGEventSetIntegerValueField(move,kCGEventSourceUnixProcessID,getpid());
  synthetic=synthetic&&callback(NULL,kCGEventMouseMoved,move,NULL)==NULL&&testEvents.count==before;CFRelease(move);releaseAll();
  fakeReset();fakeCapture();fake.point=CGPointMake(1,1);fake.failWarp=1;move=fakeMove(4,5);before=testEvents.count;callback(NULL,kCGEventMouseMoved,move,NULL);CFRelease(move);
  cases[@"driftFailure"]=@(fakeRestored()&&testEvents.count==before+1&&[testEvents.lastObject[@"type"] isEqual:@"error"]);
  fakeReset();fakeCapture();fake.failAttach=1;fake.failWarp=1;fake.failShow=1;BOOL pending=!releaseAll()&&pointerDetached&&restorePending&&cursorHidden&&!capturing;watchdogTick();cases[@"releaseRetry"]=@(pending&&fakeRestored());
  fakeReset();fakeCapture();fake.failAttach=1;fake.shiftOnAttach=YES;releaseAll();watchdogTick();cases[@"attachFailureRestore"]=@(fakeRestored());
  fakeReset();fakeCapture();fake.failAttach=1;fake.failWarp=1;fake.failShow=1;BOOL shutdownRestored=shutdownCleanup();cases[@"shutdownRetry"]=@(shutdownRestored&&fakeRestored());
  fakeReset();fakeCapture();warps=fake.warps;move=fakeMove(5,6);callback(NULL,kCGEventMouseMoved,move,NULL);CFRelease(move);watchdogTick();cases[@"noSteadyWarp"]=@(capturing&&fake.warps==warps);releaseAll();
  fakeReset();fakeCapture();fakeCapture();BOOL recaptured=capturing&&atPoint(restorePoint,fakeOriginal);releaseAll();cases[@"repeatCapture"]=@(recaptured&&fakeRestored());
  fakeReset();fakeCapture();command(@{@"cmd":@"release"});cases[@"releaseCommand"]=@(fakeRestored());
  fakeReset();fakeCapture();keyDown=CGEventCreateKeyboardEvent(source,53,true);CGEventSetIntegerValueField(keyDown,kCGEventSourceUnixProcessID,0);CGEventSetFlags(keyDown,kCGEventFlagMaskControl|kCGEventFlagMaskAlternate);callback(NULL,kCGEventKeyDown,keyDown,NULL);CFRelease(keyDown);cases[@"escape"]=@(fakeRestored()&&[testEvents.lastObject[@"type"] isEqual:@"emergency"]);
  fakeReset();[pressed addObject:@65];[buttons addObject:@0];releaseAll();cases[@"heldInputs"]=@(fake.posts==2&&pressed.count==0&&buttons.count==0);
  NSMutableDictionary *policy=[NSMutableDictionary dictionary];CGRect realBounds=bounds;bounds=CGRectMake(0,0,100,100);
  fakeReset();command(@{@"cmd":@"receive",@"manual":@YES,@"side":@"right",@"y":@0});
  policy[@"manualPreserves"]=@(receiving&&manualReceive&&CGPointEqualToPoint(fake.point,fakeOriginal)&&fake.warps==0&&[testEvents.lastObject[@"type"] isEqual:@"receiving"]);
  fake.point=CGPointMake(-1440,0);before=testEvents.count;int posts=fake.posts;
  command(@{@"cmd":@"event",@"type":@"move",@"dx":@-100,@"dy":@-100});
  BOOL atLeft=receiving&&manualReceive&&CGPointEqualToPoint(fake.point,CGPointMake(-1440,0))&&fake.posts==posts+1&&testEvents.count==before;
  fake.point=CGPointMake(-1,1079);command(@{@"cmd":@"event",@"type":@"move",@"dx":@100,@"dy":@100});
  policy[@"manualEdges"]=@(atLeft&&receiving&&CGPointEqualToPoint(fake.point,CGPointMake(-1,1079))&&testEvents.count==before);
  command(@{@"cmd":@"release"});policy[@"manualRelease"]=@(!receiving&&!manualReceive&&fake.warps==0&&!pointerDetached&&!cursorHidden);
  fakeReset();command(@{@"cmd":@"receive",@"manual":@YES});
  keyDown=CGEventCreateKeyboardEvent(source,53,true);CGEventSetIntegerValueField(keyDown,kCGEventSourceUnixProcessID,0);CGEventSetFlags(keyDown,kCGEventFlagMaskControl|kCGEventFlagMaskAlternate);callback(NULL,kCGEventKeyDown,keyDown,NULL);CFRelease(keyDown);
  policy[@"manualEmergency"]=@(!receiving&&!manualReceive&&[testEvents.lastObject[@"type"] isEqual:@"emergency"]&&fakeRestored());
  fakeReset();command(@{@"cmd":@"receive",@"manual":@YES});lastCommand-=3;watchdogTick();policy[@"manualWatchdog"]=@(fakeRestored()&&!manualReceive&&[testEvents.lastObject[@"type"] isEqual:@"emergency"]);
  fakeReset();fake.permission=NO;command(@{@"cmd":@"receive",@"manual":@YES});policy[@"manualPermissionFailure"]=@(fakeRestored()&&!manualReceive&&fake.warps==0&&[testEvents.lastObject[@"type"] isEqual:@"error"]);
  fakeReset();command(@{@"cmd":@"receive",@"manual":@YES});command(@{@"cmd":@"receive",@"side":@"right",@"y":@0.5});
  policy[@"manualReset"]=@(receiving&&!manualReceive&&fake.warps==1&&atPoint(fake.point,CGPointMake(5,49.5)));
  command(@{@"cmd":@"event",@"type":@"move",@"dx":@-10,@"dy":@0});policy[@"edgeReceiveReturn"]=@(!receiving&&!manualReceive&&[testEvents.lastObject[@"type"] isEqual:@"return"]);
  bounds=realBounds;
  BOOL passed=suppressed&&deltas&&synthetic;for(NSString *name in [cases.allKeys copy]){BOOL result=[cases[name] boolValue];passed=passed&&result;cases[name]=result?@YES:@NO;}
  for(NSString *name in [policy.allKeys copy]){BOOL result=[policy[name] boolValue];passed=passed&&result;policy[name]=result?@YES:@NO;}
  testEvents=nil;emit(@{@"type":@"self-test",@"receivePolicy":policy,@"suppressed":@(suppressed),@"hardwareDeltasPreserved":@(deltas),@"syntheticSuppressed":@(synthetic),@"lifecycle":cases});return passed?0:1;
}
int main(int argc,const char **argv){@autoreleasepool{
  signal(SIGPIPE,SIG_IGN);
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
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE,0),^{char buffer[32770];while(fgets(buffer,sizeof(buffer),stdin)){@autoreleasepool{NSData *data=[[NSString stringWithUTF8String:buffer] dataUsingEncoding:NSUTF8StringEncoding];NSDictionary *value=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];if([value isKindOfClass:[NSDictionary class]])dispatch_async(dispatch_get_main_queue(),^{command(value);});}}dispatch_async(dispatch_get_main_queue(),^{BOOL restored=shutdownCleanup();exit(restored?0:1);});});
  dispatch_source_t watchdog=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,dispatch_get_main_queue());dispatch_source_set_timer(watchdog,DISPATCH_TIME_NOW,250*NSEC_PER_MSEC,25*NSEC_PER_MSEC);dispatch_source_set_event_handler(watchdog,^{watchdogTick();});dispatch_resume(watchdog);
  signal(SIGTERM,SIG_IGN);signal(SIGINT,SIG_IGN);
  dispatch_source_t terminate=dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,SIGTERM,0,dispatch_get_main_queue());
  dispatch_source_t interrupt=dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,SIGINT,0,dispatch_get_main_queue());
  dispatch_source_set_event_handler(terminate,^{BOOL restored=shutdownCleanup();exit(restored?0:1);});dispatch_source_set_event_handler(interrupt,^{BOOL restored=shutdownCleanup();exit(restored?0:1);});dispatch_resume(terminate);dispatch_resume(interrupt);
  CFRunLoopRun();BOOL restored=shutdownCleanup();CFRelease(source);return restored?0:1;
}}
