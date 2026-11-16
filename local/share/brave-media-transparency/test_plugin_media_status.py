"""Exercise read-only native diagnostics through Lua's real longjmp boundary."""
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest


class PluginMediaStatusTests(unittest.TestCase):
    def test_freshness_topology_and_lua_allocation_failure_preserve_ownership(self):
        root = Path(__file__).parent
        header = (root / "plugin/MediaMask.hpp").read_text()
        types = header[header.index("struct MediaContentLease {"):header.index("extern std::unordered_map")]
        source = (root / "plugin/MediaMask.cpp").read_text()
        start = source.index("bool mediaMaskFresh(")
        freshness = source[start:source.index("\nvoid mediaMaskResetAll", start)]
        start = source.index("static PHLWINDOW findWindow(")
        lookup = source[start:source.index("\nstatic SP<MediaSurfaceLease>", start)]
        start = source.index("static void snapshotMediaPlanes(")
        diagnostic = source[start:source.index("\nstatic bool hkWindowOpaque", start)]
        harness = r'''
#include <hyprutils/memory/SharedPtr.hpp>
#include <hyprutils/memory/WeakPtr.hpp>
#include <hyprutils/signal/Signal.hpp>
#include <lua.hpp>
#include <array>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <optional>
#include <sstream>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <vector>
using namespace Hyprutils::Memory;
using namespace Hyprutils::Signal;
template<class T> using SP=CSharedPointer<T>;
template<class T> using WP=CWeakPointer<T>;
#define CHECK(condition) do { if(!(condition)) { std::cerr<<"failed "<<__LINE__<<": "<<#condition<<'\n'; std::exit(1); } } while(false)
struct Vec { double x=0,y=0; };
struct Region { bool emptyValue=true; bool empty() const { return emptyValue; } };
struct Texture { int m_type=0; bool m_opaque=false; };
constexpr int SURFACE_ROLE_UNASSIGNED=0,SURFACE_ROLE_SUBSURFACE=4;
struct Role { int value=0; int role() { return value; } };
struct ContentType { int m_value=0; };
struct CWLSubsurfaceResource;
struct CWLSurfaceResource {
    uint32_t surfaceID=1;
    uint32_t id() { return surfaceID; }
    bool m_mapped=true;
    SP<Role> m_role=makeShared<Role>();
    WP<ContentType> m_contentType;
    std::vector<WP<CWLSubsurfaceResource>> m_subsurfaces;
    struct {
        bool inputIsInfinite=true;
        Region input,opaque;
        Vec size{1000,700},bufferSize{1000,700};
        SP<Texture> texture=makeShared<Texture>();
    } m_current;
};
struct CWLSubsurfaceResource {
    bool m_sync=false;
    int m_zIndex=1;
    Vec m_position;
    WP<CWLSurfaceResource> m_surface;
};
namespace Desktop::View {
struct CWindow {
    std::string m_class="brave-browser",m_title="Finance - Brave";
    bool m_isMapped=true,hidden=false;
    uint64_t m_stableID=0xffffffffffffffff;
    struct Box { double w=1000,h=700; };
    std::optional<Box> box=Box{};
    bool isHidden() const { return hidden; }
    std::optional<Box> surfaceLogicalBox() const { return box; }
    SP<CWLSurfaceResource> content=makeShared<CWLSurfaceResource>();
    SP<CWLSurfaceResource> resource() const { return content; }
};
}
using PHLWINDOW=SP<Desktop::View::CWindow>;
namespace Desktop {
struct State { std::vector<PHLWINDOW> values; const auto& windows() { return values; } };
State* windowState() { static State state;return &state; }
}
constexpr int MEDIA_MAX_RECTS=128;
''' + types + r'''
std::unordered_map<Desktop::View::CWindow*,MediaMask> g_mediaMasks;
bool mediaChromeEligible(Desktop::View::CWindow* window) { return window && window->m_isMapped && !window->hidden; }
''' + freshness + lookup + diagnostic + r'''
struct Allocator { int remaining=-1; };
void* allocate(void* context,void* pointer,size_t,size_t size) {
    if(!size) { std::free(pointer);return nullptr; }
    auto& allocator=*static_cast<Allocator*>(context);
    if(allocator.remaining>=0) {
        if(allocator.remaining==0)return nullptr;
        --allocator.remaining;
    }
    return std::realloc(pointer,size);
}
std::string address(PHLWINDOW window) {
    std::ostringstream out;out<<"0x"<<std::hex<<reinterpret_cast<uintptr_t>(window.get());return out.str();
}
bool booleanField(lua_State* lua,int index,const char* key) {
    lua_getfield(lua,index,key);CHECK(lua_isboolean(lua,-1));const bool value=lua_toboolean(lua,-1);lua_pop(lua,1);return value;
}
double numberField(lua_State* lua,int index,const char* key) {
    lua_getfield(lua,index,key);CHECK(lua_isnumber(lua,-1));const double value=lua_tonumber(lua,-1);lua_pop(lua,1);return value;
}
std::string stringField(lua_State* lua,int index,const char* key) {
    lua_getfield(lua,index,key);CHECK(lua_type(lua,-1)==LUA_TSTRING);const std::string value=lua_tostring(lua,-1);lua_pop(lua,1);return value;
}
int query(lua_State* lua,const std::string& value) {
    lua_pushcfunction(lua,&luaMediaStatus);lua_pushlstring(lua,value.data(),value.size());return lua_pcall(lua,1,1,0);
}
int main() {
    auto window=makeShared<Desktop::View::CWindow>();
    Desktop::windowState()->values={window};
    const auto target=address(window);
    auto root=window->content;
    root->m_role->value=1;
    std::vector<SP<CWLSurfaceResource>> surfaces;
    std::vector<SP<CWLSubsurfaceResource>> links;
    auto attach=[&](SP<CWLSurfaceResource> parent,uint32_t id,double x,double y,bool sync) {
        auto child=makeShared<CWLSurfaceResource>();child->surfaceID=id;child->m_role->value=4;
        auto link=makeShared<CWLSubsurfaceResource>();link->m_surface=child;link->m_position={x,y};link->m_sync=sync;
        parent->m_subsurfaces.emplace_back(link);links.push_back(link);surfaces.push_back(child);return child;
    };
    auto primary=attach(root,2,0,100,true);
    primary->m_current.inputIsInfinite=false;
    primary->m_current.size={1000,600};primary->m_current.bufferSize={2000,1200};
    primary->m_current.texture->m_type=1;primary->m_current.texture->m_opaque=true;
    auto video=attach(primary,3,20,30,false);video->m_mapped=false;
    auto hint=makeShared<ContentType>();hint->m_value=2;video->m_contentType=hint;
    const auto now=std::chrono::steady_clock::now();
    MediaMask mask;mask.stableID=window->m_stableID;mask.title=window->m_title;
    mask.width=1000;mask.height=700;mask.count=43;mask.updated=now;
    mask.lease=makeShared<MediaSurfaceLease>();mask.lease->surface=root;
    mask.lease->content.revision=7;mask.lease->content.acknowledgedRevision=7;
    g_mediaMasks[window.get()]=mask;
    Allocator allocator;
    auto* lua=lua_newstate(&allocate,&allocator,0);CHECK(lua);
    CHECK(query(lua,target)==LUA_OK);
    CHECK(booleanField(lua,-1,"hasMask") && booleanField(lua,-1,"fresh"));
    for(const char* key:{"titleMatch","identityMatch","boundsMatch","surfaceMatch","hasLease","hasLeaseSurface","contentFresh"})CHECK(booleanField(lua,-1,key));
    CHECK(stringField(lua,-1,"stableID")=="ffffffffffffffff" && stringField(lua,-1,"maskStableID")=="ffffffffffffffff");
    CHECK(numberField(lua,-1,"regionCount")==43 && numberField(lua,-1,"revision")==7);
    CHECK(numberField(lua,-1,"acknowledgedRevision")==7 && numberField(lua,-1,"unacknowledgedAgeMs")==-1);
    CHECK(numberField(lua,-1,"planeCount")==3 && !booleanField(lua,-1,"topologyTruncated"));
    lua_getfield(lua,-1,"planes");CHECK(lua_rawlen(lua,-1)==3);
    lua_rawgeti(lua,-1,2);
    CHECK(booleanField(lua,-1,"synchronized") && booleanField(lua,-1,"effectiveSynchronized"));
    CHECK(booleanField(lua,-1,"inputEmpty") && !booleanField(lua,-1,"inputInfinite"));
    CHECK(numberField(lua,-1,"textureType")==1 && booleanField(lua,-1,"textureOpaque"));
    CHECK(numberField(lua,-1,"y")==100 && numberField(lua,-1,"height")==600 && numberField(lua,-1,"bufferHeight")==1200);
    lua_pop(lua,1);lua_rawgeti(lua,-1,3);
    CHECK(numberField(lua,-1,"parentID")==2 && numberField(lua,-1,"depth")==2);
    CHECK(numberField(lua,-1,"x")==20 && numberField(lua,-1,"y")==130 && numberField(lua,-1,"contentType")==2);
    CHECK(!booleanField(lua,-1,"mapped") && !booleanField(lua,-1,"synchronized") && booleanField(lua,-1,"effectiveSynchronized"));
    lua_settop(lua,0);
    auto& accepted=g_mediaMasks.at(window.get());
    accepted.lease->content.changed(now-std::chrono::milliseconds(601));
    CHECK(query(lua,target)==LUA_OK && !booleanField(lua,-1,"fresh") && !booleanField(lua,-1,"contentFresh"));
    CHECK(numberField(lua,-1,"unacknowledgedAgeMs")>=601);
    CHECK(accepted.lease->content.revision==8 && accepted.lease->content.acknowledgedRevision==7 && accepted.lease->content.unacknowledgedSince);
    lua_settop(lua,0);accepted.lease->content.acknowledge();
    window->m_title="Other page";CHECK(query(lua,target)==LUA_OK && !booleanField(lua,-1,"titleMatch") && !booleanField(lua,-1,"fresh"));
    lua_settop(lua,0);window->m_title=mask.title;
    window->m_stableID--;CHECK(query(lua,target)==LUA_OK && !booleanField(lua,-1,"identityMatch"));
    lua_settop(lua,0);window->m_stableID=mask.stableID;
    window->box->w+=3;CHECK(query(lua,target)==LUA_OK && !booleanField(lua,-1,"boundsMatch"));
    lua_settop(lua,0);window->box->w-=3;
    window->content=makeShared<CWLSurfaceResource>();
    CHECK(query(lua,target)==LUA_OK && !booleanField(lua,-1,"surfaceMatch") && booleanField(lua,-1,"hasLeaseSurface"));
    lua_settop(lua,0);window->content=root;
    accepted.lease->surface.reset();CHECK(query(lua,target)==LUA_OK && !booleanField(lua,-1,"hasLeaseSurface"));
    lua_settop(lua,0);accepted.lease->surface=root;
    g_mediaMasks.clear();CHECK(query(lua,target)==LUA_OK && !booleanField(lua,-1,"hasMask") && !booleanField(lua,-1,"fresh"));
    CHECK(numberField(lua,-1,"planeCount")==3 && numberField(lua,-1,"maskAgeMs")==-1 && g_mediaMasks.empty());
    lua_settop(lua,0);g_mediaMasks[window.get()]=mask;
    for(const auto& invalid:{std::string("0x"),std::string("0xg"),target+std::string("\0",1)}) {
        CHECK(query(lua,invalid)!=LUA_OK);lua_settop(lua,0);CHECK(g_mediaMasks.size()==1);
    }
    // The fixed bound reports truncation explicitly and includes unmapped nodes.
    for(int i=0;i<61;++i)attach(root,10+i,i,0,false);
    CHECK(query(lua,target)==LUA_OK && numberField(lua,-1,"planeCount")==64 && !booleanField(lua,-1,"topologyTruncated"));
    lua_settop(lua,0);attach(root,100,0,0,false);
    CHECK(query(lua,target)==LUA_OK && numberField(lua,-1,"planeCount")==64 && booleanField(lua,-1,"topologyTruncated"));
    lua_settop(lua,0);
    // Lua OOM uses longjmp. Every possible output allocation failure must
    // release the window, root, child, hint and lease owning refs first.
    const auto rootRefs=root.strongRef(),windowRefs=window.strongRef(),leaseRefs=mask.lease.strongRef();
    const auto primaryRefs=primary.strongRef(),videoRefs=video.strongRef(),hintRefs=hint.strongRef();
    for(int budget=0;budget<100;++budget) {
        lua_pushcfunction(lua,&luaMediaStatus);lua_pushlstring(lua,target.data(),target.size());
        allocator.remaining=budget;
        const int result=lua_pcall(lua,1,1,0);
        allocator.remaining=-1;
        CHECK(result==LUA_ERRMEM);lua_settop(lua,0);
        CHECK(root.strongRef()==rootRefs && window.strongRef()==windowRefs && mask.lease.strongRef()==leaseRefs);
        CHECK(primary.strongRef()==primaryRefs && video.strongRef()==videoRefs && hint.strongRef()==hintRefs);
        CHECK(g_mediaMasks.size()==1 && g_mediaMasks.at(window.get()).lease==mask.lease);
    }
    auto& restored=g_mediaMasks.at(window.get());
    restored.lease->content.revision=std::numeric_limits<uint64_t>::max();
    restored.lease->content.acknowledgedRevision=std::numeric_limits<uint64_t>::max();
    CHECK(query(lua,target)==LUA_OK && stringField(lua,-1,"revision")=="18446744073709551615");
    lua_close(lua);
}
'''
        flags = shlex.split(subprocess.check_output(
            ["pkg-config", "--cflags", "--libs", "hyprutils", "lua"], text=True))
        with tempfile.TemporaryDirectory(prefix="brave-plugin-status-") as directory:
            executable = str(Path(directory) / "test")
            result = subprocess.run(
                ["g++", "-std=c++23", "-O2", "-fno-gnu-unique", "-x", "c++", "-", "-o", executable, *flags],
                input=harness, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([executable], text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
