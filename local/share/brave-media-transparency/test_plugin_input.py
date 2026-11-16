"""Exercise actual plugin input subscriptions against a small native signal bus."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from native_surface_harness import SURFACE_HARNESS


class PluginInputTests(unittest.TestCase):
    def test_unchanged_surface_masks_survive_idle_and_unacknowledged_content_expires(self):
        source = (Path(__file__).parent / "plugin/MediaMask.cpp").read_text()
        start = source.index("bool mediaMaskFresh(")
        end = source.index("\nvoid mediaMaskResetAll", start)
        function = source[start:end]
        harness = SURFACE_HARNESS + r'''
#include <cassert>
#include <chrono>
#include <cmath>
#include <optional>
#include <string>
#include <unordered_map>
namespace Desktop::View {
struct CWindow {
    std::string m_class="brave-browser", m_title="Page - Brave";
    bool m_isMapped=true, hidden=false;
    uint64_t m_stableID=0x2137;
    struct Box { double w=1000,h=700; };
    std::optional<Box> box=Box{};
    bool isHidden() const { return hidden; }
    std::optional<Box> surfaceLogicalBox() const { return box; }
    SP<CWLSurfaceResource> resource() const { return defaultSurface(); }
};
}
struct MediaMask {
    double width=1000,height=700;
    uint64_t stableID=0x2137;
    std::string title="Page - Brave";
    std::chrono::steady_clock::time_point updated=std::chrono::steady_clock::now();
    SP<MediaSurfaceLease> lease=defaultLease();
};
std::unordered_map<Desktop::View::CWindow*,MediaMask> g_mediaMasks;
''' + function + r'''
int main() {
    Desktop::View::CWindow first,second;
    g_mediaMasks[&first]=MediaMask{}; g_mediaMasks[&second]=MediaMask{};
    assert(mediaMaskFresh(&first) && mediaMaskFresh(&second));
    assert(!mediaMaskFresh(nullptr));
    first.hidden=true; assert(!mediaMaskFresh(&first) && mediaMaskFresh(&second)); first.hidden=false;
    first.m_isMapped=false; assert(!mediaMaskFresh(&first)); first.m_isMapped=true;
    first.m_class="other"; assert(!mediaMaskFresh(&first)); first.m_class="brave-browser";
    first.m_title="Changed"; assert(!mediaMaskFresh(&first)); first.m_title="Page - Brave";
    first.box->w=1003; assert(!mediaMaskFresh(&first)); first.box->w=1000;
    first.box.reset(); assert(!mediaMaskFresh(&first)); first.box=Desktop::View::CWindow::Box{};
    first.m_stableID++; assert(!mediaMaskFresh(&first) && mediaMaskFresh(&second)); first.m_stableID--;
    g_mediaMasks[&first].updated-=std::chrono::milliseconds(501);
    assert(mediaMaskFresh(&first) && mediaMaskFresh(&second));
    g_mediaMasks[&first].lease->content.changed(std::chrono::steady_clock::now()-std::chrono::milliseconds(501));
    assert(!mediaMaskFresh(&first) && mediaMaskFresh(&second));
}
'''
        with tempfile.TemporaryDirectory(prefix="brave-plugin-fresh-") as directory:
            executable = str(Path(directory) / "test")
            subprocess.run(["g++", "-std=c++23", "-x", "c++", "-", "-o", executable],
                           input=harness, text=True, check=True, capture_output=True)
            subprocess.run([executable], check=True, capture_output=True)

    def test_input_focus_and_title_invalidation(self):
        source = (Path(__file__).parent / "plugin/MediaMask.cpp").read_text()
        start = source.index("    // Native media-mask invalidation subscriptions.")
        end = source.index("    expiryTimer =", start)
        subscriptions = source[start:end]
        # Compile the production subscriptions, so additions/removals exercise
        # event behavior rather than asserting a duplicate list of strings.
        harness = r'''
#include <cassert>
#include <functional>
#include <memory>
#include <unordered_map>
#include <vector>
struct Window { bool chrome=false; };
using PHLWINDOW = std::shared_ptr<Window>;
struct PHLWINDOWREF {
    std::weak_ptr<Window> value;
    PHLWINDOWREF(PHLWINDOW window): value(window) {}
    Window* get() const { return value.lock().get(); }
    PHLWINDOW lock() const { return value.lock(); }
    PHLWINDOWREF& operator=(PHLWINDOW window) { value=window; return *this; }
};
namespace Desktop {
    struct FocusState { PHLWINDOW focused; PHLWINDOW window() { return focused; } };
    FocusState* focusState() { static FocusState value; return &value; }
}
struct Signal {
    std::vector<std::function<void(int,int&)>> callbacks;
    template<class F> int listen(F fn) { callbacks.emplace_back(fn); return 0; }
    void emit() { int event=0; for(auto& fn:callbacks) fn(0,event); }
};
struct WindowSignal {
    std::vector<std::function<void(PHLWINDOW,int)>> callbacks;
    template<class F> int listen(F fn) { callbacks.emplace_back(fn); return 0; }
    void emit(PHLWINDOW window) { for(auto& fn:callbacks) fn(window,0); }
};
struct TitleSignal {
    std::vector<std::function<void(PHLWINDOW)>> callbacks;
    template<class F> int listen(F fn) { callbacks.emplace_back(fn); return 0; }
    void emit(PHLWINDOW window) { for(auto& fn:callbacks) fn(window); }
};
struct Bus {
    struct { struct {
        struct { Signal axis, button; } mouse;
        struct { Signal key; } keyboard;
        struct { Signal down, motion; } touch;
    } input; struct { WindowSignal active; TitleSignal title; } window; } m_events;
};
namespace Event { Bus* bus() { static Bus value; return &value; } }
std::vector<int> g_Listeners;
std::unordered_map<Window*,int> g_mediaMasks;
bool mediaMaskDiscard(Window* window) { return g_mediaMasks.erase(window)!=0; }
bool mediaChromeEligible(Window* window) { return window && window->chrome; }
bool mediaBackgroundEligible(Window* window) { return window && (g_mediaMasks.contains(window) || mediaChromeEligible(window)); }
void mediaMaskResetAll() { g_mediaMasks.clear(); }
struct Renderer {
    std::vector<Window*> damaged;
    void damageWindow(PHLWINDOW window) { damaged.push_back(window.get()); }
};
Renderer renderer;
Renderer* g_pHyprRenderer=&renderer;
void protect(PHLWINDOW window) { g_mediaMasks[window.get()]=1; }
bool protectedMedia(PHLWINDOW window) { return g_mediaMasks.contains(window.get()); }
int main() {
    auto browser=std::make_shared<Window>();
    auto otherBrowser=std::make_shared<Window>();
    auto terminal=std::make_shared<Window>();
    protect(browser);
    Desktop::focusState()->focused=browser;
''' + subscriptions + r'''
    auto& input=Event::bus()->m_events.input;
    for(int i=0;i<4;i++) {
        input.mouse.button.emit(); input.keyboard.key.emit(); input.touch.down.emit();
        input.mouse.axis.emit(); input.touch.motion.emit();
        assert(protectedMedia(browser));
    }
    auto& active=Event::bus()->m_events.window.active;
    // Repeated clicks or keyboard surface changes retain the same owner.
    for(int i=0;i<4;i++) { active.emit(browser); assert(protectedMedia(browser)); }
    assert(renderer.damaged.empty());
    protect(otherBrowser);
    active.emit(otherBrowser);
    assert(protectedMedia(browser) && protectedMedia(otherBrowser));
    assert(renderer.damaged.size()==2 && renderer.damaged[0]==browser.get() && renderer.damaged[1]==otherBrowser.get());
    active.emit(otherBrowser);
    assert(renderer.damaged.size()==2);
    active.emit(terminal);
    assert(protectedMedia(browser) && protectedMedia(otherBrowser));
    assert(renderer.damaged.size()==3 && renderer.damaged.back()==otherBrowser.get());
    active.emit(nullptr);
    assert(renderer.damaged.size()==3);
    active.emit(browser);
    assert(protectedMedia(browser) && protectedMedia(otherBrowser));
    assert(renderer.damaged.size()==4 && renderer.damaged.back()==browser.get());
    renderer.damaged.clear();
    auto& title=Event::bus()->m_events.window.title;
    title.emit(terminal); title.emit(nullptr);
    assert(protectedMedia(browser) && protectedMedia(otherBrowser));
    assert(renderer.damaged.empty());
    title.emit(otherBrowser);
    assert(protectedMedia(browser) && !protectedMedia(otherBrowser));
    assert(renderer.damaged.size()==1 && renderer.damaged.back()==otherBrowser.get());
    title.emit(browser);
    assert(!protectedMedia(browser));
    assert(renderer.damaged.size()==2 && renderer.damaged.back()==browser.get());
    // Browser chrome still changes focus and repaints its title with no page
    // mask, including restricted browser pages and expired HTTP snapshots.
    renderer.damaged.clear();
    browser->chrome=true; otherBrowser->chrome=true;
    active.emit(otherBrowser);
    assert(renderer.damaged.size()==2 && renderer.damaged[0]==browser.get() && renderer.damaged[1]==otherBrowser.get());
    title.emit(otherBrowser);
    assert(renderer.damaged.size()==3 && renderer.damaged.back()==otherBrowser.get());
    active.emit(terminal);
    assert(renderer.damaged.size()==4 && renderer.damaged.back()==otherBrowser.get());
}
'''
        with tempfile.TemporaryDirectory(prefix="brave-plugin-input-") as directory:
            executable = str(Path(directory) / "test")
            subprocess.run(["g++", "-std=c++23", "-x", "c++", "-", "-o", executable],
                           input=harness, text=True, check=True, capture_output=True)
            subprocess.run([executable], check=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()
