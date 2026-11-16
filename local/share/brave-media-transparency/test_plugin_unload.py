"""Exercise plugin-owned callbacks across actual Lua errors and DSO unloading.

These tests use the installed Hyprutils pointers/signals and Lua's real longjmp
boundary. C++ exceptions and std::shared_ptr stand-ins hide this ownership bug.
Only window/render state is substituted; the production mask bindings and
listener lifecycle are compiled into an unloadable shared object.
"""
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest


COMMON = r'''
#include <hyprutils/memory/SharedPtr.hpp>
#include <hyprutils/memory/WeakPtr.hpp>
#include <hyprutils/signal/Signal.hpp>
#include <lua.hpp>
#include <array>
#include <chrono>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>
using namespace Hyprutils::Memory;
using namespace Hyprutils::Signal;
template<class T> using SP=CSharedPointer<T>;
template<class T> using WP=CWeakPointer<T>;
#define CHECK(condition) do { if(!(condition)) { std::cerr<<"failed "<<__LINE__<<": "<<#condition<<'\n'; std::exit(1); } } while(false)
struct TestSignal: CSignalT<> {
    int active() { int count=0;for(auto& listener:m_vListeners)count+=bool(listener.lock());return count; }
};
struct CWLSurfaceResource {
    struct { struct { struct {
        bool buffer=false,damage=false,scale=false,transform=false,offset=false,viewport=false,
             frame=false,input=false,opaque=false;
    } bits; } updated; SP<int> texture=makeShared<int>(1); } m_current;
    struct { TestSignal commit; } m_events;
};
namespace Desktop::View {
struct CWindow {
    std::string m_class="brave-browser",m_title="New Tab - Brave";
    bool m_isMapped=true,hidden=false;
    uint64_t m_stableID=0x180006b3;
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
struct Renderer { void damageWindow(PHLWINDOW) {} };
Renderer renderer;
Renderer* g_pHyprRenderer=&renderer;
constexpr int MEDIA_MAX_RECTS=128;
'''


class PluginUnloadTests(unittest.TestCase):
    def test_rejection_reset_and_unload_detach_real_hyprutils_callbacks(self):
        root = Path(__file__).parent
        header = (root / "plugin/MediaMask.hpp").read_text()
        start = header.index("struct MediaContentLease {")
        types = header[start:header.index("extern std::unordered_map", start)]
        source = (root / "plugin/MediaMask.cpp").read_text()
        start = source.index("bool mediaMaskFresh(")
        lifecycle = source[start:source.index("\nPHLWINDOW mediaPopupOwner", start)]
        start = source.index("static PHLWINDOW findWindow(")
        bindings = source[start:source.index("\nstatic int luaMediaPalette", start)]
        plugin = COMMON + types + r'''
std::unordered_map<Desktop::View::CWindow*,MediaMask> g_mediaMasks;
SP<MediaSurfaceLease> retainedLease;
bool mediaChromeEligible(Desktop::View::CWindow*) { return false; }
''' + lifecycle + bindings + r'''
#define EXPORTED extern "C" __attribute__((visibility("default")))
EXPORTED void attach(PHLWINDOW* window) { Desktop::windowState()->values={*window}; }
EXPORTED lua_CFunction rects() { return &luaMediaRects; }
EXPORTED lua_CFunction reset() { return &luaMediaReset; }
EXPORTED void retain(PHLWINDOW* window) { retainedLease=g_mediaMasks.at(window->get()).lease; }
EXPORTED void shutdown() { mediaMaskResetAll();retainedLease.reset();Desktop::windowState()->values.clear(); }
'''
        host = COMMON + r'''
#include <dlfcn.h>
#include <unistd.h>
std::string address(PHLWINDOW window) {
    std::ostringstream out;out<<"0x"<<std::hex<<reinterpret_cast<uintptr_t>(window.get());return out.str();
}
int snapshot(lua_State* lua,lua_CFunction fn,PHLWINDOW window,bool valid) {
    lua_pushcfunction(lua,fn);
    lua_pushstring(lua,address(window).c_str());
    lua_pushliteral(lua,"");lua_pushnumber(lua,1000);lua_pushnumber(lua,700);
    lua_pushstring(lua,valid?"New Tab - Brave":"Old Page - Brave");
    const int result=lua_pcall(lua,5,0,0);
    if(result) { CHECK(std::string(lua_tostring(lua,-1)).find("media window changed during update")!=std::string::npos);lua_pop(lua,1); }
    return result;
}
int main(int argc,char** argv) {
    CHECK(argc==2);
    auto window=makeShared<Desktop::View::CWindow>();
    auto* lua=luaL_newstate();CHECK(lua);
    const auto rootRefs=window->content.strongRef(),windowRefs=window.strongRef();
    for(int cycle=0;cycle<30;cycle++) {
        void* dso=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);CHECK(dso);
        const auto attach=reinterpret_cast<void(*)(PHLWINDOW*)>(dlsym(dso,"attach"));
        const auto rects=reinterpret_cast<lua_CFunction(*)()>(dlsym(dso,"rects"));
        const auto reset=reinterpret_cast<lua_CFunction(*)()>(dlsym(dso,"reset"));
        const auto retain=reinterpret_cast<void(*)(PHLWINDOW*)>(dlsym(dso,"retain"));
        const auto shutdown=reinterpret_cast<void(*)()>(dlsym(dso,"shutdown"));
        CHECK(attach&&rects&&reset&&retain&&shutdown);attach(&window);
        for(int attempt=0;attempt<20;attempt++) {
            CHECK(snapshot(lua,rects(),window,true)==LUA_OK);
            CHECK(window->content->m_events.commit.active()==1);
            window->content->m_current.updated.bits.damage=true;
            window->content->m_events.commit.emit();
            CHECK(snapshot(lua,rects(),window,false)!=LUA_OK);
            CHECK(window->content->m_events.commit.active()==0);
            CHECK(window->content.strongRef()==rootRefs);
            CHECK(window.strongRef()==windowRefs+1); // Plugin's window-state stand-in.
        }
        CHECK(snapshot(lua,rects(),window,true)==LUA_OK);
        retain(&window); // Reset must detach independently of shared ownership.
        lua_pushcfunction(lua,reset());lua_pushliteral(lua,"all");
        CHECK(lua_pcall(lua,1,0,0)==LUA_OK);
        CHECK(window->content->m_events.commit.active()==0);
        CHECK(snapshot(lua,rects(),window,true)==LUA_OK);
        shutdown();CHECK(window->content->m_events.commit.active()==0);
        CHECK(window->content.strongRef()==rootRefs && window.strongRef()==windowRefs);
        const auto fn=reinterpret_cast<void*>(rects());
        CHECK(dlclose(dso)==0);
        // Ensure this is an actual unload, not NODELETE or a reused resident DSO.
        Dl_info info{};CHECK(!dladdr(fn,&info));
        for(int commit=0;commit<100;commit++)window->content->m_events.commit.emit();
    }
    lua_close(lua);
}
'''
        flags = shlex.split(subprocess.check_output(
            ["pkg-config", "--cflags", "--libs", "hyprutils", "lua"], text=True))
        with tempfile.TemporaryDirectory(prefix="brave-plugin-unload-") as directory:
            library = str(Path(directory) / "plugin.so")
            executable = str(Path(directory) / "host")
            for body, output, extras in ((plugin, library, ["-shared", "-fPIC"]),
                                         (host, executable, ["-ldl"])):
                result = subprocess.run(
                    ["g++", "-std=c++23", "-O2", "-fvisibility=hidden", "-fno-gnu-unique",
                     *extras, "-x", "c++", "-", "-o", output, *flags],
                    input=body, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([executable, library], text=True, capture_output=True,
                                    timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
