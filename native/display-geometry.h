#pragma once
#include <algorithm>
#include <cmath>
#include <limits>
#include <string>
#include <vector>
namespace display_geometry {
struct Point { double x, y; };
struct Display { std::string id; int x, y, width, height; bool primary = false; };
struct Bounds { int x, y, width, height; };
// Portal vertical intervals use monitor edges (pixel centers are y + .5).
struct Portal { std::string id; double x, y0, y1; bool left; };
struct Movement { Point point; bool returned; };
inline double right(const Display& d) { return double(d.x)+d.width; }
inline double bottom(const Display& d) { return double(d.y)+d.height; }
inline std::vector<Display> canonical(std::vector<Display> displays) {
  std::vector<Display> result;
  for(const auto& d:displays) {
    if(d.width<=0||d.height<=0)continue;
    auto same=std::find_if(result.begin(),result.end(),[&](const Display& r){return r.x==d.x&&r.y==d.y&&r.width==d.width&&r.height==d.height;});
    if(same==result.end())result.push_back(d);else if(d.primary)*same=d;
  }
  std::sort(result.begin(),result.end(),[](const Display&a,const Display&b){return a.id<b.id;});
  return result;
}
inline Bounds bounds(const std::vector<Display>& ds) {
  if(ds.empty())return {0,0,0,0};
  double x=ds[0].x,y=ds[0].y,r=right(ds[0]),b=bottom(ds[0]);
  for(const auto&d:ds){x=std::min(x,double(d.x));y=std::min(y,double(d.y));r=std::max(r,right(d));b=std::max(b,bottom(d));}
  return {int(x),int(y),int(r-x),int(b-y)};
}
inline int containing(const std::vector<Display>& ds, Point p) {
  for(size_t n=0;n<ds.size();++n){const auto&d=ds[n];if(p.x>=d.x&&p.x<=right(d)-1&&p.y>=d.y&&p.y<=bottom(d)-1)return int(n);}
  return -1;
}
inline Point clamp(const std::vector<Display>& ds, Point p) {
  Point best=p;double distance=std::numeric_limits<double>::infinity();
  for(const auto&d:ds){Point c{std::clamp(p.x,double(d.x),right(d)-1),std::clamp(p.y,double(d.y),bottom(d)-1)};double v=(p.x-c.x)*(p.x-c.x)+(p.y-c.y)*(p.y-c.y);if(v<distance){best=c;distance=v;}}
  return best;
}
inline std::vector<Portal> portals(const std::vector<Display>& ds,bool left,const std::string& selected="") {
  std::vector<double> cuts;for(const auto&d:ds){cuts.push_back(d.y);cuts.push_back(bottom(d));}
  std::sort(cuts.begin(),cuts.end());cuts.erase(std::unique(cuts.begin(),cuts.end()),cuts.end());
  std::vector<Portal> result;
  for(size_t n=1;n<cuts.size();++n){
    double y=(cuts[n-1]+cuts[n])/2;const Display* candidate=nullptr;
    for(const auto&d:ds){if(y<d.y||y>=bottom(d)||(!selected.empty()&&d.id!=selected))continue;
      if(!candidate||(left?d.x<candidate->x:right(d)>right(*candidate)))candidate=&d;}
    if(!candidate)continue;
    double x=left?candidate->x:right(*candidate);bool exposed=true;
    for(const auto&d:ds){if(&d==candidate||y<d.y||y>=bottom(d))continue;
      if(left?(d.x<x&&right(d)>=x):(d.x<=x&&right(d)>x)){exposed=false;break;}}
    if(!exposed)continue;
    if(!result.empty()&&result.back().id==candidate->id&&result.back().x==x&&result.back().y1==cuts[n-1])result.back().y1=cuts[n];
    else result.push_back({candidate->id,x,cuts[n-1],cuts[n],left});
  }
  return result;
}
inline Point entry(const std::vector<Display>& ds,const std::vector<Portal>& ps,double ratio) {
  if(ps.empty())return clamp(ds,{0,0});
  auto b=bounds(ds);double y=b.y+.5+std::clamp(std::isfinite(ratio)?ratio:0.5,0.0,1.0)*std::max(0,b.height-1);
  const Portal* best=&ps[0];double bestY=0,distance=std::numeric_limits<double>::infinity();
  for(const auto&p:ps){double cy=std::clamp(y,p.y0+.5,p.y1-.5),v=std::abs(cy-y);if(v<distance){distance=v;best=&p;bestY=cy;}}
  const auto&d=*std::find_if(ds.begin(),ds.end(),[&](const Display&d){return d.id==best->id;});
  double inset=std::min(5.0,(d.width-1)/2.0);
  return {best->left?d.x+inset:right(d)-1-inset,bestY-.5};
}
inline bool portalAt(const std::vector<Portal>& ps,const Display&d,bool left,double y) {
  for(const auto&p:ps)if(p.id==d.id&&p.left==left&&y>=p.y0&&y<p.y1)return true;
  return false;
}
inline Movement move(const std::vector<Display>& ds,Point start,double dx,double dy,const std::vector<Portal>& ps={}) {
  if(ds.empty()||!std::isfinite(dx)||!std::isfinite(dy))return {start,false};
  start=clamp(ds,start);int index=containing(ds,start);if(index<0)return {start,false};
  Point p{start.x+.5,start.y+.5};constexpr double eps=1e-7;
  // Every crossing consumes distance; after a blocked edge its normal component
  // is removed. This preserves sliding while never crossing an empty rectangle.
  for(int step=0;step<256&&(std::abs(dx)>eps||std::abs(dy)>eps);++step){
    const auto&d=ds[size_t(index)];
    double tx=dx>eps?(right(d)-p.x)/dx:dx< -eps?(d.x-p.x)/dx:std::numeric_limits<double>::infinity();
    double ty=dy>eps?(bottom(d)-p.y)/dy:dy< -eps?(d.y-p.y)/dy:std::numeric_limits<double>::infinity();
    double t=std::min(tx,ty);
    if(t>1){p.x+=dx;p.y+=dy;break;}
    double edgeX=dx>0?right(d):d.x,edgeY=dy>0?bottom(d):d.y;
    t=std::max(0.0,t);p.x+=dx*t;p.y+=dy*t;
    // Snap intersected edges exactly. A parameter-space tolerance grows with
    // delta magnitude; coordinate-space ties keep large movements accurate.
    bool hitX=tx<=ty||(std::isfinite(tx)&&std::abs(p.x-edgeX)<eps);
    bool hitY=ty<=tx||(std::isfinite(ty)&&std::abs(p.y-edgeY)<eps);
    if(hitX)p.x=edgeX;if(hitY)p.y=edgeY;
    dx*=1-t;dy*=1-t;int next=-1;
    // A positive-length shared segment is required; corner-only contact cannot
    // teleport diagonally into a disconnected monitor.
    for(size_t n=0;n<ds.size();++n){if(int(n)==index)continue;const auto&o=ds[n];
      bool horizontal=hitX&&((dx>0&&right(d)==o.x)||(dx<0&&d.x==right(o)))&&p.y>std::max(d.y,o.y)+eps&&p.y<std::min(bottom(d),bottom(o))-eps;
      bool vertical=hitY&&((dy>0&&bottom(d)==o.y)||(dy<0&&d.y==bottom(o)))&&p.x>std::max(d.x,o.x)+eps&&p.x<std::min(right(d),right(o))-eps;
      if(horizontal||vertical){next=int(n);break;}}
    if(next<0&&hitX&&hitY){
      std::vector<int> connected{index};
      for(size_t q=0;q<connected.size();++q){const auto&a=ds[size_t(connected[q])];
        for(size_t n=0;n<ds.size();++n){const auto&o=ds[n];if(std::find(connected.begin(),connected.end(),int(n))!=connected.end())continue;
          bool edgeX=(right(a)==o.x||a.x==right(o))&&std::max(a.y,o.y)<std::min(bottom(a),bottom(o))&&p.y>=std::max(a.y,o.y)&&p.y<=std::min(bottom(a),bottom(o))&&p.x>=o.x&&p.x<=right(o)&&p.x>=a.x&&p.x<=right(a);
          bool edgeY=(bottom(a)==o.y||a.y==bottom(o))&&std::max(a.x,o.x)<std::min(right(a),right(o))&&p.x>=std::max(a.x,o.x)&&p.x<=std::min(right(a),right(o))&&p.y>=o.y&&p.y<=bottom(o)&&p.y>=a.y&&p.y<=bottom(a);
          if(edgeX||edgeY)connected.push_back(int(n));}}
      double px=p.x+(dx>0?eps:-eps),py=p.y+(dy>0?eps:-eps);
      for(int n:connected){const auto&o=ds[size_t(n)];if(n!=index&&px>o.x&&px<right(o)&&py>o.y&&py<bottom(o)){next=n;break;}}
    }
    if(next>=0){index=next;continue;}
    if(hitX&&hitY){
      // At an exterior corner the other component may still cross a real
      // shared edge (for example, diagonally along the bottom of a row).
      // Project away the blocked component, then retry that edge crossing.
      // Requiring positive overlap excludes monitors touching only at a point.
      const Display* acrossX=nullptr;const Display* acrossY=nullptr;
      for(size_t n=0;n<ds.size();++n){if(int(n)==index)continue;const auto&o=ds[n];
        if(((dx>0&&right(d)==o.x)||(dx<0&&d.x==right(o)))&&std::max(d.y,o.y)<std::min(bottom(d),bottom(o))&&p.y>=std::max(d.y,o.y)&&p.y<=std::min(bottom(d),bottom(o)))acrossX=&o;
        if(((dy>0&&bottom(d)==o.y)||(dy<0&&d.y==bottom(o)))&&std::max(d.x,o.x)<std::min(right(d),right(o))&&p.x>=std::max(d.x,o.x)&&p.x<=std::min(right(d),right(o)))acrossY=&o;
      }
      if(acrossX&&(!acrossY||std::abs(dx)>=std::abs(dy))){
        p.y=std::clamp(p.y,double(std::max(d.y,acrossX->y))+.5,std::min(bottom(d),bottom(*acrossX))-.5);dy=0;continue;
      }
      if(acrossY){
        p.x=std::clamp(p.x,double(std::max(d.x,acrossY->x))+.5,std::min(right(d),right(*acrossY))-.5);dx=0;continue;
      }
    }
    if(hitX&&((dx<0&&portalAt(ps,d,true,p.y))||(dx>0&&portalAt(ps,d,false,p.y))))return {clamp(ds,{p.x-.5,p.y-.5}),true};
    if(hitX){p.x=std::clamp(p.x,double(d.x)+.5,right(d)-.5);dx=0;}
    if(hitY){p.y=std::clamp(p.y,double(d.y)+.5,bottom(d)-.5);dy=0;}
  }
  const auto&d=ds[size_t(index)];
  return {{std::clamp(p.x-.5,double(d.x),right(d)-1),std::clamp(p.y-.5,double(d.y),bottom(d)-1)},false};
}
inline int normalize(double coordinate,int origin,int extent) {
  if(extent<=1)return 0;
  return int(std::llround(std::clamp((coordinate-origin)/double(extent-1),0.0,1.0)*65535.0));
}
}
