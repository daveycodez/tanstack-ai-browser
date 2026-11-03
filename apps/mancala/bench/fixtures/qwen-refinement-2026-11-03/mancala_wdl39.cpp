#include <array>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <unordered_map>
#include <vector>
#include <chrono>
#include <stdexcept>
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
 int delta=int(b[13])-int(b[6]);
 bool bonus=!terminal&&cursor==own;
 return {b,bonus?side:1-side,delta,pit,captured,bonus,terminal};
}

using Key=unsigned __int128;
struct Hash { size_t operator()(Key v)const {uint64_t lo=v,hi=v>>64;lo^=hi*0x9e3779b97f4a7c15ULL;lo^=lo>>30;lo*=0xbf58476d1ce4e5b9ULL;lo^=lo>>27;lo*=0x94d049bb133111ebULL;return lo^(lo>>31);} };
struct Entry {signed char score;unsigned char flag,pit;};
std::unordered_map<Key,Entry,Hash> table;
Key keyOf(const B&b,int side){Key k=side;for(int i=0;i<14;i++)k=(k<<6)|b[i];return k;}
uint64_t nodes=0,hits=0;int maxDepth=0;std::chrono::steady_clock::time_point deadline;
int value(const B&b,int side,int alpha,int beta,int depth=0){
 nodes++;maxDepth=std::max(maxDepth,depth);if((nodes&16383)==0&&std::chrono::steady_clock::now()>deadline)throw std::runtime_error("time-limit");
 if(b[13]>24)return 1;if(b[6]>24)return -1;
 int human=0,ai=0;for(int i=0;i<6;i++){human+=b[i];ai+=b[i+7];}if(!human||!ai){int margin=int(b[13])+ai-int(b[6])-human;return (margin>0)-(margin<0);}
 const Key key=keyOf(b,side);int hashPit=-1,origA=alpha,origB=beta;auto found=table.find(key);
 if(found!=table.end()){hits++;auto e=found->second;hashPit=e.pit;if(e.flag==0)return e.score;if(e.flag==1)alpha=std::max(alpha,int(e.score));else beta=std::min(beta,int(e.score));if(alpha>=beta)return e.score;}
 std::vector<Move> moves;moves.reserve(6);for(int pit=side?7:0;pit<(side?13:6);pit++)if(b[pit])moves.push_back(sow(b,side,pit));
 std::sort(moves.begin(),moves.end(),[&](const Move&a,const Move&c){if((a.pit==hashPit)!=(c.pit==hashPit))return a.pit==hashPit;if(a.bonus!=c.bonus)return a.bonus;if(a.captured!=c.captured)return a.captured>c.captured;return side?a.delta>c.delta:a.delta<c.delta;});
 int best=side?-2:2,bestPit=moves[0].pit;bool domainExact=false;
 for(const auto&m:moves){int score=value(m.b,m.side,alpha,beta,depth+1);if(side?(score>best):(score<best)){best=score;bestPit=m.pit;}if(side)alpha=std::max(alpha,best);else beta=std::min(beta,best);if((side&&best==1)||(!side&&best==-1)){domainExact=true;break;}if(alpha>=beta)break;}
 unsigned char flag=domainExact?0:best<=origA?2:best>=origB?1:0;if(table.size()<2000000||table.find(key)!=table.end())table[key]={(signed char)best,flag,(unsigned char)bestPit};return best;
}
int main(int argc,char**argv){int pit=argc>1?std::atoi(argv[1]):7;int budget=argc>2?std::atoi(argv[2]):20;B b={0,0,4,1,10,1,6,1,0,3,10,1,8,3};if(argc>3){for(int i=0;i<14;i++){int n;std::cin>>n;b[i]=n;}}
 table.reserve(2000000);auto start=std::chrono::steady_clock::now();deadline=start+std::chrono::seconds(budget);auto first=sow(b,1,pit);
 try {int result=value(first.b,first.side,-2,2);std::cout<<"complete true root "<<pit<<" wdl "<<result;}catch(const std::exception&e){std::cout<<"complete false root "<<pit<<" reason "<<e.what();}
 std::cout<<" nodes "<<nodes<<" states "<<table.size()<<" hits "<<hits<<" maxDepth "<<maxDepth<<" seconds "<<std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count()<<std::endl;
}
