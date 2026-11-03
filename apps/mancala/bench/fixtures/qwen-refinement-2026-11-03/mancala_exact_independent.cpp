#include <array>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <unordered_map>
#include <vector>
#include <chrono>
using B=std::array<unsigned char,14>;
struct Move { B b; int side, delta, pit, captured; bool bonus, terminal; };
Move sow(const B &old,int side,int pit){
 B b=old;int n=b[pit];b[pit]=0;int own=side?13:6,enemy=side?6:13,cursor=pit;
 while(n){cursor=(cursor+1)%14;if(cursor==enemy)continue;b[cursor]++;n--;}
 int captured=0;bool isOwn=side?(cursor>=7&&cursor<=12):(cursor>=0&&cursor<=5);
 if(isOwn&&b[cursor]==1&&b[12-cursor]){captured=b[12-cursor]+1;b[own]+=captured;b[cursor]=0;b[12-cursor]=0;}
 int hs=0,as=0;for(int i=0;i<6;i++){hs+=b[i];as+=b[i+7];}
 bool terminal=hs==0||as==0;
 if(terminal){b[6]+=hs;b[13]+=as;for(int i=0;i<6;i++)b[i]=b[i+7]=0;}
 int delta=int(b[13])-int(b[6]);b[6]=b[13]=0;
 bool bonus=!terminal&&cursor==own;
 return {b,bonus?side:1-side,delta,pit,captured,bonus,terminal};
}
uint64_t key(const B&b,int side){uint64_t k=side;for(int i=0;i<6;i++)k=(k<<5)|b[i];for(int i=7;i<13;i++)k=(k<<5)|b[i];return k;}
struct Entry {signed char value;unsigned char flag,pit;};
std::unordered_map<uint64_t,Entry> tt;
uint64_t nodes=0,hits=0;int maxDepth=0;
int solve(const B&b,int side,int alpha,int beta,int depth=0){
 nodes++;maxDepth=std::max(maxDepth,depth);int remaining=0;for(int i=0;i<6;i++)remaining+=b[i]+b[i+7];if(!remaining)return 0;
 uint64_t k=key(b,side);int origA=alpha,origB=beta,hashPit=-1;
 auto found=tt.find(k);
 if(found!=tt.end()){hits++;auto e=found->second;hashPit=e.pit;if(e.flag==0)return e.value;if(e.flag==1)alpha=std::max(alpha,int(e.value));else beta=std::min(beta,int(e.value));if(alpha>=beta)return e.value;}
 std::vector<Move> options;options.reserve(6);for(int pit=side?7:0;pit<(side?13:6);pit++)if(b[pit])options.push_back(sow(b,side,pit));
 if(options.empty()){std::cerr<<"unexpected empty";std::exit(2);}
 std::sort(options.begin(),options.end(),[&](const Move&a,const Move&c){if((a.pit==hashPit)!=(c.pit==hashPit))return a.pit==hashPit;if(a.bonus!=c.bonus)return a.bonus;if(a.captured!=c.captured)return a.captured>c.captured;return side?a.delta>c.delta:a.delta<c.delta;});
 int best=side?-100:100,bestPit=options[0].pit;
 for(const auto&m:options){int value=m.delta+(m.terminal?0:solve(m.b,m.side,alpha-m.delta,beta-m.delta,depth+1));if(side?(value>best):(value<best)){best=value;bestPit=m.pit;}if(side)alpha=std::max(alpha,best);else beta=std::min(beta,best);if(alpha>=beta)break;}
 unsigned char flag=best<=origA?2:best>=origB?1:0;
 tt[k]={(signed char)best,flag,(unsigned char)bestPit};return best;
}
std::unordered_map<uint64_t,signed char> exhaustiveTable;
uint64_t exhaustiveNodes=0;
int exhaustive(const B&b,int side){
 if(++exhaustiveNodes>200000000)throw std::runtime_error("exhaustive node cap");
 int remaining=0;for(int i=0;i<6;i++)remaining+=b[i]+b[i+7];if(!remaining)return 0;
 uint64_t k=key(b,side);auto found=exhaustiveTable.find(k);if(found!=exhaustiveTable.end())return found->second;
 int best=side?-100:100;
 for(int pit=side?7:0;pit<(side?13:6);pit++)if(b[pit]){auto m=sow(b,side,pit);int v=m.delta+(m.terminal?0:exhaustive(m.b,m.side));best=side?std::max(best,v):std::min(best,v);}
 exhaustiveTable[k]=best;return best;
}
int main(int argc,char**argv){
 if(argc>1&&std::string(argv[1])=="sow"){int side,pit;while(std::cin>>side>>pit){B b{};for(int i=0;i<14;i++){int x;std::cin>>x;b[i]=x;}auto m=sow(b,side,pit);std::cout<<m.side<<' '<<m.delta<<' '<<m.captured<<' '<<m.bonus<<' '<<m.terminal;for(int i=0;i<14;i++)std::cout<<' '<<int(m.b[i]);std::cout<<'\n';}return 0;}
 if(argc>1&&std::string(argv[1])=="verify"){int side;int cases=0;while(std::cin>>side){B b{};for(int i=0;i<14;i++){int x;std::cin>>x;b[i]=x;}int a=solve(b,side,-100,100),e=exhaustive(b,side);if(a!=e){std::cout<<"MISMATCH "<<a<<' '<<e<<std::endl;return 4;}cases++;}std::cout<<"unprunedAgreement "<<cases<<" exhaustiveNodes "<<exhaustiveNodes<<" exhaustiveStates "<<exhaustiveTable.size()<<std::endl;return 0;}
 if(argc>1&&std::string(argv[1])=="position"){int side,pit;std::cin>>side>>pit;B b{};int total=0;for(int i=0;i<14;i++){int x;std::cin>>x;b[i]=x;total+=x;}int secured=int(b[13])-int(b[6]);b[6]=b[13]=0;auto first=sow(b,side,pit);int margin=secured+first.delta+(first.terminal?0:solve(first.b,first.side,-100,100));std::cout<<"margin "<<margin<<" finalAI "<<(total+margin)/2<<" finalHuman "<<(total-margin)/2<<" nodes "<<nodes<<" states "<<tt.size()<<std::endl;return 0;}
 B b={1,0,1,2,2,2,0,4,1,0,2,2,5,0};tt.reserve(2000000);
 if(argc>1&&std::string(argv[1])=="path"){int side=1,delta=0;bool terminal=false;for(int i=2;i<argc;i++){auto m=sow(b,side,std::atoi(argv[i]));delta+=m.delta;b=m.b;side=m.side;terminal=m.terminal;}int margin=delta+(terminal?0:solve(b,side,-100,100));std::cout<<"PATH finalOptimalMargin "<<margin<<" sideNext "<<side<<" accumulatedDelta "<<delta<<" nodes "<<nodes<<std::endl;return 0;}
 if(argc>1&&std::string(argv[1])=="exhaustive"){for(int pit:{11,12}){auto m=sow(b,1,pit);auto start=std::chrono::steady_clock::now();int result=m.delta+exhaustive(m.b,m.side);std::cout<<"EXHAUSTIVE_ROOT "<<pit<<" margin "<<result<<" nodes "<<exhaustiveNodes<<" states "<<exhaustiveTable.size()<<" seconds "<<std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count()<<std::endl;}return 0;}
 for(int pit:{7,8,10,11,12}){auto start=std::chrono::steady_clock::now();auto m=sow(b,1,pit);auto before=nodes;int v=m.delta+solve(m.b,m.side,-100,100);double secs=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();std::cout<<"ROOT "<<pit<<" margin "<<v<<" nodes "<<(nodes-before)<<" totalNodes "<<nodes<<" table "<<tt.size()<<" hits "<<hits<<" maxDepth "<<maxDepth<<" sec "<<secs<<std::endl;
 B line=m.b;int side=m.side;std::cout<<"LINE "<<pit;int cumulative=m.delta;for(int ply=0;ply<100&&!m.terminal;ply++){int val=solve(line,side,-100,100);auto e=tt.find(key(line,side));if(e==tt.end()){std::cout<<" MISSING";break;}m=sow(line,side,e->second.pit);std::cout<<' '<<(side?"A":"H")<<int(e->second.pit);cumulative+=m.delta;line=m.b;side=m.side;}std::cout<<" finalDelta "<<cumulative<<std::endl;
 }
}
