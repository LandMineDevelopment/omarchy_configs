"""Exercise production browser-chrome eligibility and opacity declarations."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from native_surface_harness import SURFACE_HARNESS


class PluginChromeTests(unittest.TestCase):
    def test_palette_validation_atomicity_and_damage(self):
        source = (Path(__file__).parent / "plugin/MediaMask.cpp").read_text()
        start = source.index("static int luaMediaPalette(")
        production = source[start:source.index("\n}", start) + 2]
        harness = r'''
#include <array>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <vector>
#define CHECK(condition) do { if(!(condition)) { std::cerr<<"failed "<<__LINE__<<": "<<#condition<<'\n'; std::exit(1); } } while(false)
constexpr int LUA_TNUMBER=3;
struct lua_State { std::vector<double> values; std::vector<int> types; };
int lua_gettop(lua_State* state) { return state->values.size(); }
int lua_type(lua_State* state,int index) { return state->types.at(index-1); }
double luaL_checknumber(lua_State* state,int index) { return state->values.at(index-1); }
int luaL_error(lua_State*,const char* error) { throw std::runtime_error(error); }
std::array<float,3> g_mediaCanvasColor{0,0,0};
float g_mediaCanvasOpacity=.5f;
struct Window { int id=0; bool eligible=false; };
using PHLWINDOW=std::shared_ptr<Window>;
bool mediaBackgroundEligible(Window* window) { return window && window->eligible; }
namespace Desktop {
struct Windows { std::vector<PHLWINDOW> values; const auto& windows() { return values; } };
Windows* windowState() { static Windows value; return &value; }
}
struct Renderer {
    std::vector<int> damaged;
    void damageWindow(PHLWINDOW window) { damaged.push_back(window->id); }
};
Renderer renderer;
Renderer* g_pHyprRenderer=&renderer;
''' + production + r'''
int main() {
    Desktop::windowState()->values={std::make_shared<Window>(Window{1,true}),nullptr,
        std::make_shared<Window>(Window{2,false}),std::make_shared<Window>(Window{3,true})};
    lua_State state{{0,0,0,.5},{3,3,3,3}};
    CHECK(luaMediaPalette(&state)==0 && renderer.damaged.empty());
    state.values={.1,.2,.3,.8};
    CHECK(luaMediaPalette(&state)==0);
    CHECK(g_mediaCanvasColor[0]==.1f && g_mediaCanvasColor[1]==.2f && g_mediaCanvasColor[2]==.3f);
    CHECK(g_mediaCanvasOpacity==.8f && renderer.damaged==std::vector<int>({1,3}));
    CHECK(luaMediaPalette(&state)==0 && renderer.damaged.size()==2);
    const auto color=g_mediaCanvasColor;
    const auto reject=[&](lua_State invalid) {
        try { luaMediaPalette(&invalid); CHECK(false); } catch(const std::runtime_error&) {}
        CHECK(g_mediaCanvasColor==color && g_mediaCanvasOpacity==.8f && renderer.damaged.size()==2);
    };
    reject({{0,0,0},{3,3,3}});
    reject({{0,0,0,.5,0},{3,3,3,3,3}});
    reject({{0,0,0,.5},{3,3,3,4}}); // Numeric strings are not the typed API.
    for(double invalid:{-.001,1.001,std::numeric_limits<double>::infinity(),
                       -std::numeric_limits<double>::infinity(),std::numeric_limits<double>::quiet_NaN()})
        for(int channel=0;channel<4;channel++) {
            auto args=state; args.values[channel]=invalid; reject(args);
        }
    state.values={0,1,0,0}; CHECK(luaMediaPalette(&state)==0);
    CHECK(g_mediaCanvasOpacity==0 && renderer.damaged.size()==4);
    state.values={1,0,1,1}; CHECK(luaMediaPalette(&state)==0);
    CHECK(g_mediaCanvasOpacity==1 && renderer.damaged.size()==6);
}
'''
        with tempfile.TemporaryDirectory(prefix="brave-plugin-palette-") as directory:
            executable = str(Path(directory) / "test")
            result = subprocess.run(["g++", "-std=c++23", "-x", "c++", "-", "-o", executable],
                                    input=harness, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([executable], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_chrome_is_independent_of_page_masks_and_preserves_fullscreen_policy(self):
        source = (Path(__file__).parent / "plugin/MediaMask.cpp").read_text()
        start = source.index("bool mediaChromeEligible(")
        helpers = source[start:source.index("\nvoid mediaMaskResetAll", start)]
        start = source.index("static bool hkWindowOpaque(")
        opacity = source[start:source.index("\n// Correct only", start)]
        harness = SURFACE_HARNESS + r'''
#include <cstdlib>
#include <iostream>
#include <memory>
#include <chrono>
#include <cmath>
#include <optional>
#include <string>
#include <unordered_map>
#define CHECK(condition) do { if(!(condition)) { std::cerr<<"failed "<<__LINE__<<": "<<#condition<<'\n'; std::exit(1); } } while(false)
namespace Desktop::View {
struct CWindow {
    std::string m_class="brave-browser", m_title="Page - Brave";
    bool m_isMapped=true, hidden=false, nativeOpaque=true;
    uint64_t m_stableID=0x2137;
    int internal=0;
    std::weak_ptr<CWindow> m_self;
    std::shared_ptr<CWindow> parentWindow;
    struct Box { double w=1000,h=700; };
    std::optional<Box> box=Box{};
    bool isHidden() const { return hidden; }
    std::shared_ptr<CWindow> parent() { return parentWindow; }
    std::optional<Box> surfaceLogicalBox() const { return box; }
    SP<CWLSurfaceResource> resource() const { return defaultSurface(); }
};
}
using PHLWINDOW=std::shared_ptr<Desktop::View::CWindow>;
namespace Fullscreen {
constexpr int FSMODE_FULLSCREEN=2;
struct State { int internal; };
struct Controller { State getFullscreenModes(PHLWINDOW window) { return {window->internal}; } };
Controller* controller() { static Controller value; return &value; }
}
struct MediaMask {
    double width=1000,height=700;
    uint64_t stableID=0x2137;
    std::string title="Page - Brave";
    std::chrono::steady_clock::time_point updated=std::chrono::steady_clock::now();
    SP<MediaSurfaceLease> lease=defaultLease();
};
std::unordered_map<Desktop::View::CWindow*,MediaMask> g_mediaMasks;
std::unordered_map<std::string,std::string> g_mWindowClassShaderMap;
bool mediaMaskFresh(Desktop::View::CWindow*);
struct CRegion { int value=0; };
bool mediaBackgroundEligible(Desktop::View::CWindow*);
PHLWINDOW mediaPopupOwner(std::shared_ptr<CWLSurfaceResource> surface) {
    return surface && mediaBackgroundEligible(surface->popupOwner.get()) ? surface->popupOwner : nullptr;
}
struct CSurfacePassElement {
    struct { bool mainSurface=true,popup=false; PHLWINDOW pWindow; std::shared_ptr<CWLSurfaceResource> surface=std::make_shared<CWLSurfaceResource>(); } m_data;
};
struct CFunctionHook { void* m_original; };
bool originalWindow(Desktop::View::CWindow* window) { return window && window->nativeOpaque; }
CRegion originalSurface(CSurfacePassElement*) { return {42}; }
CFunctionHook windowHook{reinterpret_cast<void*>(&originalWindow)},
              surfaceHook{reinterpret_cast<void*>(&originalSurface)};
CFunctionHook *opaqueHook=&windowHook,*surfaceOpaqueHook=&surfaceHook;
''' + helpers + opacity + r'''
int main() {
    auto window=std::make_shared<Desktop::View::CWindow>(); window->m_self=window;
    CSurfacePassElement element; element.m_data.pWindow=window;
    CHECK(!mediaChromeEligible(window.get())); // Installed shader must be enabled.
    CHECK(hkWindowOpaque(window.get()));
    g_mWindowClassShaderMap["brave-browser"]="background";
    CHECK(mediaChromeEligible(window.get()));
    CHECK(mediaBackgroundEligible(window.get()) && !mediaMaskFresh(window.get()));
    CHECK(!hkWindowOpaque(window.get()) && hkSurfaceOpaque(&element).value==0);
    element.m_data.popup=true; CHECK(hkSurfaceOpaque(&element).value==42);
    element.m_data.popup=false; element.m_data.mainSurface=false;
    CHECK(hkSurfaceOpaque(&element).value==42); element.m_data.mainSurface=true;
    element.m_data.mainSurface=false; element.m_data.popup=true;
    element.m_data.surface->popupOwner=window;
    CHECK(hkSurfaceOpaque(&element).value==0);
    element.m_data.popup=false; CHECK(hkSurfaceOpaque(&element).value==0); // Native interactive wl_subsurface bubble.
    element.m_data.surface->popupOwner.reset();
    element.m_data.mainSurface=true; element.m_data.popup=false;
    window->internal=1; CHECK(mediaChromeEligible(window.get())); // Maximized has chrome.
    window->internal=2;
    CHECK(!mediaChromeEligible(window.get()) && !mediaBackgroundEligible(window.get()));
    CHECK(hkWindowOpaque(window.get()) && hkSurfaceOpaque(&element).value==42);
    g_mediaMasks[window.get()]=MediaMask{};
    CHECK(mediaBackgroundEligible(window.get()) && !hkWindowOpaque(window.get()));
    auto& lease=g_mediaMasks[window.get()].lease->content;
    lease.changed(std::chrono::steady_clock::now()-std::chrono::milliseconds(501));
    CHECK(!mediaBackgroundEligible(window.get()) && hkWindowOpaque(window.get()));
    window->internal=0; CHECK(mediaBackgroundEligible(window.get()));
    window->m_title="New Tab - Brave"; CHECK(mediaChromeEligible(window.get()));
    window->box->w=1004; CHECK(mediaChromeEligible(window.get())); // Page mask invalid, chrome stable.
    window->parentWindow=std::make_shared<Desktop::View::CWindow>();
    CHECK(!mediaChromeEligible(window.get())); window->parentWindow.reset();
    window->hidden=true; CHECK(!mediaBackgroundEligible(window.get())); window->hidden=false;
    window->m_isMapped=false; CHECK(!mediaChromeEligible(window.get())); window->m_isMapped=true;
    window->m_class="other"; CHECK(!mediaBackgroundEligible(window.get())); window->m_class="brave-browser";
    window->m_self.reset(); CHECK(!mediaChromeEligible(window.get())); window->m_self=window;
    g_mWindowClassShaderMap.clear(); CHECK(!mediaChromeEligible(window.get()));
    CHECK(!mediaChromeEligible(nullptr) && !mediaBackgroundEligible(nullptr));
    CHECK(hkSurfaceOpaque(nullptr).value==42);
}
'''
        with tempfile.TemporaryDirectory(prefix="brave-plugin-chrome-") as directory:
            executable = str(Path(directory) / "test")
            result = subprocess.run(["g++", "-std=c++23", "-x", "c++", "-", "-o", executable],
                                    input=harness, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([executable], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
