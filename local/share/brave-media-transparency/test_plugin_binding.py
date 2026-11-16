"""Compile production Lua mask binding and exercise native lifetime identity."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from native_surface_harness import SURFACE_HARNESS


class PluginBindingTests(unittest.TestCase):
    def test_optional_guard_and_address_reuse_cannot_rebind_a_mask(self):
        root = Path(__file__).parent
        header = (root / "plugin/MediaMask.hpp").read_text()
        start = header.index("struct MediaMask {")
        mask = header[start:header.index("\n};", start) + 3]
        source = (root / "plugin/MediaMask.cpp").read_text()
        start = source.index("bool mediaMaskFresh(")
        freshness = source[start:source.index("\nvoid mediaMaskResetAll", start)]
        start = source.index("bool mediaMaskDiscard(")
        discard = source[start:source.index("\nPHLWINDOW mediaPopupOwner", start)]
        start = source.index("static PHLWINDOW findWindow(")
        binding = source[start:source.index("\nstatic int luaMediaReset", start)]
        harness = SURFACE_HARNESS + r'''
#include <array>
#include <chrono>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>
#define CHECK(condition) do { if(!(condition)) { std::cerr<<"failed "<<__LINE__<<": "<<#condition<<'\n'; std::exit(1); } } while(false)
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
using PHLWINDOW=std::shared_ptr<Desktop::View::CWindow>;
namespace Desktop {
struct State { std::vector<PHLWINDOW> values; const auto& windows() { return values; } };
State* windowState() { static State value; return &value; }
}
constexpr int MEDIA_MAX_RECTS=128;
''' + mask + r'''
std::unordered_map<Desktop::View::CWindow*,MediaMask> g_mediaMasks;
struct Renderer {
    std::vector<Desktop::View::CWindow*> damaged;
    void damageWindow(PHLWINDOW window) { damaged.push_back(window.get()); }
};
Renderer renderer;
Renderer* g_pHyprRenderer=&renderer;
constexpr int LUA_TSTRING=4,LUA_TNUMBER=3;
using Argument=std::variant<std::monostate,std::string,double>;
struct lua_State { std::vector<Argument> values; };
int lua_gettop(lua_State* state) { return state->values.size(); }
int lua_type(lua_State* state,int index) {
    if(index<1 || index>int(state->values.size()))return 0;
    return state->values[index-1].index()==1?LUA_TSTRING:state->values[index-1].index()==2?LUA_TNUMBER:0;
}
bool lua_isnumber(lua_State* state,int index) { return lua_type(state,index)==LUA_TNUMBER; }
const char* luaL_checkstring(lua_State* state,int index) { return std::get<std::string>(state->values.at(index-1)).c_str(); }
const char* luaL_checklstring(lua_State* state,int index,size_t* length) {
    const auto& value=std::get<std::string>(state->values.at(index-1));*length=value.size();return value.c_str();
}
double luaL_checknumber(lua_State* state,int index) { return std::get<double>(state->values.at(index-1)); }
int luaL_error(lua_State*,const char* error) { throw std::runtime_error(error); }
int luaL_error(lua_State*,const char*,const char* error) { throw std::runtime_error(error); }
''' + freshness + discard + binding + r'''
std::string hex(uint64_t value) { std::ostringstream out;out<<std::hex<<value;return out.str(); }
std::string address(PHLWINDOW window) { return "0x"+hex(reinterpret_cast<uintptr_t>(window.get())); }
lua_State snapshot(PHLWINDOW window) {
    return {{address(window),std::string(""),1000.,700.,std::string("New Tab - Brave")}};
}
int main() {
    auto first=std::make_shared<Desktop::View::CWindow>();
    auto second=std::make_shared<Desktop::View::CWindow>();second->m_stableID++;
    Desktop::windowState()->values={first,second};
    auto firstLegacy=snapshot(first),secondLegacy=snapshot(second);
    CHECK(luaMediaRects(&firstLegacy)==0 && luaMediaRects(&secondLegacy)==0);
    CHECK(mediaMaskFresh(first.get()) && mediaMaskFresh(second.get()));
    CHECK(g_mediaMasks[first.get()].stableID==first->m_stableID);
    auto guarded=firstLegacy;guarded.values.push_back(hex(first->m_stableID));
    renderer.damaged.clear();CHECK(luaMediaRects(&guarded)==0 && renderer.damaged.empty());
    const auto initialLease=g_mediaMasks[first.get()].lease;
    g_mediaMasks[first.get()].updated-=std::chrono::hours(24);
    CHECK(mediaMaskFresh(first.get())); // The submitted root contents never changed.
    first->content->m_current.updated.bits.damage=true;
    first->content->m_events.commit.emit();
    CHECK(initialLease->content.unacknowledgedSince && mediaMaskFresh(first.get()));
    *initialLease->content.unacknowledgedSince-=std::chrono::milliseconds(501);
    CHECK(!mediaMaskFresh(first.get()));
    CHECK(luaMediaRects(&guarded)==0 && mediaMaskFresh(first.get()));
    CHECK(g_mediaMasks[first.get()].lease==initialLease && !initialLease->content.unacknowledgedSince);
    CHECK(renderer.damaged.size()==1);renderer.damaged.clear();
    CHECK(luaMediaRects(&guarded)==0 && renderer.damaged.empty());
    first->content->m_current.updated.bits.damage=false;
    auto oldSurface=first->content;
    first->content=makeShared<CWLSurfaceResource>();
    CHECK(!mediaMaskFresh(first.get())); // Same window identity, new surface lifetime.
    CHECK(luaMediaRects(&guarded)==0 && mediaMaskFresh(first.get()));
    CHECK(g_mediaMasks[first.get()].lease!=initialLease);
    initialLease->commit.reset();CHECK(oldSurface->m_events.commit.active()==0);
    renderer.damaged.clear();
    auto left=g_mediaMasks[first.get()],right=left;
    CHECK(left.sameGeometryAndIdentity(right));right.stableID++;
    CHECK(!left.sameGeometryAndIdentity(right));
    // Simulate the same native address being reused for an identical-looking
    // New Tab: the old accepted mask already fails freshness before any update.
    first->m_stableID+=5;
    CHECK(!mediaMaskFresh(first.get()) && mediaMaskFresh(second.get()));
    try { luaMediaRects(&guarded);CHECK(false); }
    catch(const std::runtime_error& error) { CHECK(std::string(error.what())=="media window identity changed"); }
    CHECK(!g_mediaMasks.contains(first.get()) && mediaMaskFresh(second.get()));
    CHECK(renderer.damaged.size()==1 && renderer.damaged.back()==first.get());
    guarded.values.back()=hex(first->m_stableID);
    CHECK(luaMediaRects(&guarded)==0 && mediaMaskFresh(first.get()));
    // A guard belonging to another same-title/same-size window never rebinds.
    auto wrongOwner=guarded;wrongOwner.values.back()=hex(second->m_stableID);
    try { luaMediaRects(&wrongOwner);CHECK(false); }
    catch(const std::runtime_error& error) { CHECK(std::string(error.what())=="media window identity changed"); }
    CHECK(!g_mediaMasks.contains(first.get()) && mediaMaskFresh(second.get()));
    const std::vector<Argument> invalid={std::monostate{},123.,std::string(""),std::string("0"),
        std::string("0x180006b3"),std::string("+1"),std::string("-1"),std::string("g"),
        std::string("180006b3 "),std::string("fffffffffffffffff"),std::string("180006b3\0",9)};
    for(const auto& guard:invalid) {
        CHECK(luaMediaRects(&firstLegacy)==0);auto rejected=firstLegacy;rejected.values.push_back(guard);
        try { luaMediaRects(&rejected);CHECK(false); }
        catch(const std::runtime_error& error) { CHECK(std::string(error.what())=="invalid media window identity"); }
        CHECK(!g_mediaMasks.contains(first.get()) && mediaMaskFresh(second.get()));
    }
    first->m_stableID=0xffffffffffffffff;
    guarded.values.back()=std::string("ffffffffffffffff");
    CHECK(luaMediaRects(&guarded)==0 && mediaMaskFresh(first.get()));
    auto rejectedTitle=guarded;rejectedTitle.values[4]=std::string("Old Page - Brave");
    try { luaMediaRects(&rejectedTitle);CHECK(false); }
    catch(const std::runtime_error& error) { CHECK(std::string(error.what())=="media window changed during update"); }
    CHECK(!g_mediaMasks.contains(first.get()) && mediaMaskFresh(second.get()));
}
'''
        with tempfile.TemporaryDirectory(prefix="brave-plugin-binding-") as directory:
            executable = str(Path(directory) / "test")
            result = subprocess.run(["g++", "-std=c++23", "-x", "c++", "-", "-o", executable],
                                    input=harness, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([executable], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
