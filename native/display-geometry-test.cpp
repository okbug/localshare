#include "display-geometry.h"
#include <iostream>
#include <stdexcept>
using namespace display_geometry;
inline void geometryExpect(bool ok, const char* name) { if (!ok) throw std::runtime_error(name); }
inline bool geometryNear(double a,double b) { return std::abs(a-b)<0.001; }
inline void runGeometryTests() {
  auto row=canonical({{"LEFT",-100,0,100,100},{"MAIN",0,0,100,100,true},{"RIGHT",100,0,100,100}});
  auto b=bounds(row); geometryExpect(b.x==-100&&b.width==300,"negative virtual bounds");
  geometryExpect(containing(row,{-50,20})>=0,"negative screen containment");
  auto p=move(row,{-80,50},250,0).point; geometryExpect(geometryNear(p.x,170)&&geometryNear(p.y,50),"large movement crosses two seams");
  p=move(row,{150,50},-240,0).point; geometryExpect(geometryNear(p.x,-90),"large reverse movement");
  auto pair=canonical({{"A",0,0,100,100,true},{"B",100,0,100,100}});
  p=move(pair,{99,99},2,2).point; geometryExpect(geometryNear(p.x,101)&&geometryNear(p.y,99),"diagonal at bottom seam slides across adjacent screen");
  p=move(pair,{99,0},2,-2).point; geometryExpect(geometryNear(p.x,101)&&geometryNear(p.y,0),"diagonal at top seam slides across adjacent screen");
  p=move(pair,{100,99},-2,2).point; geometryExpect(geometryNear(p.x,98)&&geometryNear(p.y,99),"reverse bottom seam slides across adjacent screen");
  auto stackedPair=canonical({{"A",0,0,100,100,true},{"B",0,100,100,100}});
  p=move(stackedPair,{99,99},2,2).point; geometryExpect(geometryNear(p.x,99)&&geometryNear(p.y,101),"diagonal at right vertical seam slides down adjacent screen");
  p=move(stackedPair,{0,99},-2,2).point; geometryExpect(geometryNear(p.x,0)&&geometryNear(p.y,101),"diagonal at left vertical seam slides down adjacent screen");
  auto grid=canonical({{"A",0,0,100,100,true},{"B",100,0,100,100},{"C",0,100,100,100},{"D",100,100,100,100}});
  p=move(grid,{99,199},2,2).point; geometryExpect(geometryNear(p.x,101)&&geometryNear(p.y,199),"grid exterior corner slides through internal seam");
  p=move(grid,{99,99},2,2).point; geometryExpect(geometryNear(p.x,101)&&geometryNear(p.y,101),"grid center corner traverses connected diagonal screen");
  auto vertical=canonical({{"TOP",0,-100,100,100},{"MAIN",0,0,100,100,true},{"BOTTOM",0,100,100,100}});
  p=move(vertical,{50,150},0,-240).point; geometryExpect(geometryNear(p.y,-90),"up across two seams");
  p=move(vertical,{50,-90},0,260).point; geometryExpect(geometryNear(p.y,170),"down across two seams");
  p=move(grid,{52,12},57,225).point; geometryExpect(geometryNear(p.x,109)&&geometryNear(p.y,199),"large diagonal slide preserves remaining horizontal movement");
  // A tiled rectangle has the same independent expected endpoint as one solid
  // desktop: clamp the unconstrained destination, irrespective of its seams.
  auto solidDesktopProperty=[](const std::vector<Display>& layout,int width,int height){
    const int xs[]={0,1,12,52,98,99,100,101,width-2,width-1};
    const int ys[]={0,1,12,52,98,99,100,101,height-2,height-1};
    const int deltas[]={-1000,-225,-200,-101,-100,-99,-57,-2,-1,0,1,2,57,99,100,101,200,225,1000};
    for(int x:xs)for(int y:ys){if(x<0||x>=width||y<0||y>=height)continue;
      for(int dx:deltas)for(int dy:deltas){auto result=move(layout,{double(x),double(y)},dx,dy).point;
        double expectedX=std::clamp(double(x+dx),0.0,double(width-1)),expectedY=std::clamp(double(y+dy),0.0,double(height-1));
        if(!geometryNear(result.x,expectedX)||!geometryNear(result.y,expectedY)||containing(layout,result)<0){
          std::cerr<<"solid desktop start("<<x<<","<<y<<") delta("<<dx<<","<<dy<<") expected("<<expectedX<<","<<expectedY<<") got("<<result.x<<","<<result.y<<")\n";
          geometryExpect(false,"solid desktop movement equals clamped unconstrained destination");
        }
      }
    }
  };
  solidDesktopProperty(grid,200,200);
  solidDesktopProperty(pair,200,100);
  solidDesktopProperty(stackedPair,100,200);
  auto gap=canonical({{"A",0,0,100,100,true},{"B",200,0,100,100}});
  p=move(gap,{50,50},500,0).point; geometryExpect(geometryNear(p.x,99),"never jump across hole");
  auto offset=canonical({{"A",0,0,100,100,true},{"B",100,50,100,100}});
  p=move(offset,{50,20},200,0).point; geometryExpect(geometryNear(p.x,99),"offset seam blocked outside overlap");
  p=move(offset,{50,75},120,0).point; geometryExpect(geometryNear(p.x,170),"offset overlap seam crosses");
  auto l=canonical({{"A",0,0,100,100,true},{"B",100,0,100,100},{"C",100,100,100,100}});
  p=move(l,{50,50},120,120).point; geometryExpect(containing(l,p)>=0&&p.x>100&&p.y>100,"L shape diagonal stays connected");
  auto corner=canonical({{"A",0,0,100,100,true},{"B",100,100,100,100}});
  p=move(corner,{50,50},100,100).point; geometryExpect(p.x<=99&&p.y<=99,"corner contact is not adjacency");
  auto left=portals(row,true); geometryExpect(left.size()==1&&left[0].id=="LEFT","auto exterior excludes internal seams");
  geometryExpect(!move(row,{50,50},-100,0,left).returned,"internal seam never returns");
  geometryExpect(move(row,{-90,50},-50,0,left).returned,"outward exterior returns");
  geometryExpect(!move(row,{-99,50},20,0,left).returned,"inward movement never returns");
  geometryExpect(move(row,{150,50},-1000,0,left).returned,"large outward delta traverses every seam before return");
  auto rightSide=portals(row,false);
  geometryExpect(rightSide.size()==1&&rightSide[0].id=="RIGHT","right exterior excludes internal seams");
  geometryExpect(move(row,{-90,50},1000,0,rightSide).returned,"large rightward delta returns only after last screen");
  geometryExpect(!move(row,{150,50},-100,0,rightSide).returned,"right portal does not return for inward movement");
  geometryExpect(portals(row,true,"MAIN").empty(),"specified fully blocked edge rejected");
  auto custom=portals(offset,true,"B"); geometryExpect(custom.size()==1&&geometryNear(custom[0].y0,100),"specified partial exposed edge only");
  geometryExpect(!move(offset,{150,75},-100,0,custom).returned,"selected partial portal preserves internal seam");
  geometryExpect(move(offset,{105,125},-50,0,custom).returned,"selected exposed portion returns");
  geometryExpect(portals(offset,true,"MISSING").empty(),"missing selected display rejected");
  auto envelope=portals(offset,true); geometryExpect(envelope.size()==2,"per-height exterior envelope");
  p=entry(offset,envelope,0.95); geometryExpect(p.x>=100&&p.y>=100,"entry uses exterior at requested height");
  p=entry(gap,portals(gap,true),0.5); geometryExpect(p.x<100,"auto never chooses inner disconnected left edge");
  auto yGap=canonical({{"A",0,0,100,100},{"B",100,200,100,100,true}});
  p=entry(yGap,portals(yGap,true),0.5); geometryExpect(containing(yGap,p)>=0,"entry gap maps to nearest valid segment");
  p=clamp(row,{-300,-20}); geometryExpect(geometryNear(p.x,-100)&&geometryNear(p.y,0),"restore clamps to actual monitor");
  auto clones=canonical({{"CLONE",0,0,100,100},{"MAIN",0,0,100,100,true}});
  geometryExpect(clones.size()==1&&clones[0].primary&&clones[0].id=="MAIN","clone prefers primary");
  geometryExpect(normalize(-100,-100,300)==0&&normalize(199,-100,300)==65535,"normalization endpoint extremes");
  geometryExpect(normalize(1000,-100,300)==65535&&normalize(-200,-100,300)==0&&normalize(0,0,1)==0,"normalization clamps and single pixel");
}
#ifndef DISPLAY_GEOMETRY_EMBEDDED_TEST
int main() { try { runGeometryTests(); std::cout<<"display geometry tests passed\n"; return 0; } catch(const std::exception& e) { std::cerr<<e.what()<<"\n"; return 1; } }
#endif
