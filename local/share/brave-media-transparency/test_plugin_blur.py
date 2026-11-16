"""Compile the production blur declaration scope and native hook wrappers."""
from pathlib import Path
import subprocess
import tempfile
import unittest


class PluginBlurTests(unittest.TestCase):
    def test_native_planning_scoping_and_restoration(self):
        source = (Path(__file__).parent / "plugin/MediaMask.cpp").read_text()
        start = source.index("class MediaBlurDeclarationScope")
        end = source.index("\nvoid mediaMaskInit()", start)
        production = source[start:end]
        harness = r'''
#include <cassert>
#include <memory>
#include <stdexcept>
template<class T> using SP=std::shared_ptr<T>;
// Hyprland uniquely owns pass elements. Its weak-over-unique handles support
// borrowing but abort on lock(), unlike std::weak_ptr-over-shared ownership.
template<class T> struct WP {
    T* value;
    WP(const SP<T>& pointer): value(pointer.get()) {}
    T* get() const { return value; }
    SP<T> lock() const = delete;
};
struct CRegion { int value=0; };
namespace Render { struct ITexture { bool m_opaque=true; }; struct IElementRenderer {}; }
struct Window { bool fresh=true, fullscreen=false, chrome=false; };
struct CWLSurfaceResource { struct { CRegion opaque{42}; } m_current; SP<Window> popupOwner; };
bool mediaMaskFresh(Window* window) { return window && window->fresh; }
bool mediaBackgroundEligible(Window* window) {
    return mediaMaskFresh(window) || (window && window->chrome && !window->fullscreen);
}
SP<Window> mediaPopupOwner(SP<CWLSurfaceResource> surface) {
    return surface && mediaBackgroundEligible(surface->popupOwner.get()) ? surface->popupOwner : nullptr;
}
struct Renderer { bool blurEnabled=true; bool shouldBlur(SP<Window>) { return blurEnabled; } };
Renderer nativeRenderer;
struct RendererPointer { Renderer* get() { return &nativeRenderer; } } g_pHyprRenderer;
bool nativeBlur(Renderer* renderer,SP<Window> window) { return renderer->shouldBlur(window); }
auto nativeWindowShouldBlur=&nativeBlur;
struct CSurfacePassElement {
    struct {
        bool mainSurface=true, popup=false, blur=true, optimized=false;
        SP<Render::ITexture> texture=std::make_shared<Render::ITexture>();
        SP<CWLSurfaceResource> surface=std::make_shared<CWLSurfaceResource>();
        SP<Window> pWindow=std::make_shared<Window>();
    } m_data;
};
struct CFunctionHook { void* m_original; };
bool originalLive(CSurfacePassElement* element) {
    return element && element->m_data.blur && element->m_data.texture &&
           !element->m_data.texture->m_opaque && (element->m_data.popup || !element->m_data.optimized);
}
bool originalPrecompute(CSurfacePassElement* element) {
    return element && element->m_data.blur && element->m_data.texture &&
           !element->m_data.texture->m_opaque && !element->m_data.popup && element->m_data.optimized;
}
int draws=0, expectedOpaqueRegion=0;
bool expectedTextureOpaque=false, expectedPopup=false, throwing=false, nested=false;
void originalDraw(Render::IElementRenderer*, WP<CSurfacePassElement>, const CRegion&);
CFunctionHook live{reinterpret_cast<void*>(&originalLive)}, precompute{reinterpret_cast<void*>(&originalPrecompute)},
              draw{reinterpret_cast<void*>(&originalDraw)};
CFunctionHook *liveBlurHook=&live, *precomputeBlurHook=&precompute, *drawSurfaceHook=&draw;
''' + production + r'''
void originalDraw(Render::IElementRenderer* renderer, WP<CSurfacePassElement> weak, const CRegion& damage) {
    auto element=weak.get();
    assert(damage.value==7);
    assert(element->m_data.texture->m_opaque==expectedTextureOpaque);
    assert(element->m_data.surface->m_current.opaque.value==expectedOpaqueRegion);
    assert(element->m_data.popup==expectedPopup);
    ++draws;
    if (nested) { nested=false; hkMediaDrawSurface(renderer,weak,damage); }
    if (throwing) throw std::runtime_error("native draw failed");
}
void verifyRestored(const SP<CSurfacePassElement>& element) {
    assert(element->m_data.texture->m_opaque);
    assert(element->m_data.surface->m_current.opaque.value==42);
}
int main() {
    auto element=std::make_shared<CSurfacePassElement>();
    assert(hkMediaNeedsLiveBlur(element.get()));
    assert(!hkMediaNeedsPrecomputeBlur(element.get()));
    verifyRestored(element);
    element->m_data.optimized=true;
    assert(!hkMediaNeedsLiveBlur(element.get()));
    assert(hkMediaNeedsPrecomputeBlur(element.get()));
    verifyRestored(element);
    // Fullscreen inherits the same corrected native live/precompute planning;
    // it does not fade protected content or need a separate opacity branch.
    element->m_data.pWindow->fullscreen=true;
    assert(hkMediaNeedsPrecomputeBlur(element.get()));
    element->m_data.optimized=false;
    assert(hkMediaNeedsLiveBlur(element.get()));
    verifyRestored(element);
    Render::IElementRenderer renderer;
    hkMediaDrawSurface(&renderer,element,CRegion{7});
    assert(draws==1); verifyRestored(element);
    nested=true;
    hkMediaDrawSurface(&renderer,element,CRegion{7});
    assert(draws==3); verifyRestored(element);
    throwing=true;
    try { hkMediaDrawSurface(&renderer,element,CRegion{7}); assert(false); }
    catch (const std::runtime_error&) {}
    throwing=false; verifyRestored(element);
    // Internal-page chrome follows the same native blur plan with no mask;
    // fullscreen still rejects this exception because no browser chrome exists.
    element->m_data.pWindow->fresh=false;
    element->m_data.pWindow->fullscreen=false;
    element->m_data.pWindow->chrome=true;
    assert(hkMediaNeedsLiveBlur(element.get()));
    hkMediaDrawSurface(&renderer,element,CRegion{7}); verifyRestored(element);
    element->m_data.pWindow->fullscreen=true;
    assert(!hkMediaNeedsLiveBlur(element.get())); verifyRestored(element);
    element->m_data.pWindow->chrome=false;
    // Popup roots carry their own owner and use native live blur even when
    // global popup blur is off. Both the decision and opacity declarations are
    // restored synchronously, while owner/global no-blur stays authoritative.
    element->m_data.pWindow->fresh=true;
    element->m_data.mainSurface=false; element->m_data.popup=true;
    element->m_data.blur=false; element->m_data.optimized=true;
    element->m_data.surface->popupOwner=element->m_data.pWindow;
    expectedPopup=true;
    assert(hkMediaNeedsLiveBlur(element.get()));
    assert(!hkMediaNeedsPrecomputeBlur(element.get()));
    assert(!element->m_data.blur); verifyRestored(element);
    hkMediaDrawSurface(&renderer,element,CRegion{7});
    assert(!element->m_data.blur); verifyRestored(element);
    // Toolbar bubbles are interactive native wl_subsurface roots. Their
    // normal child pass must borrow popup live blur, never precomputed blur,
    // and restore the original flags after nested/throwing draw calls.
    element->m_data.popup=false;
    assert(hkMediaNeedsLiveBlur(element.get()));
    assert(!hkMediaNeedsPrecomputeBlur(element.get()));
    assert(!element->m_data.popup && !element->m_data.blur); verifyRestored(element);
    nested=true;hkMediaDrawSurface(&renderer,element,CRegion{7});
    assert(!element->m_data.popup && !element->m_data.blur); verifyRestored(element);
    throwing=true;
    try { hkMediaDrawSurface(&renderer,element,CRegion{7});assert(false); }
    catch(const std::runtime_error&) {}
    throwing=false;assert(!element->m_data.popup && !element->m_data.blur);verifyRestored(element);
    nativeRenderer.blurEnabled=false;
    assert(!hkMediaNeedsLiveBlur(element.get()));
    expectedOpaqueRegion=42; expectedTextureOpaque=true;
    hkMediaDrawSurface(&renderer,element,CRegion{7});
    assert(!element->m_data.blur); verifyRestored(element);
    nativeRenderer.blurEnabled=true;
    element->m_data.surface->popupOwner.reset();
    expectedPopup=false;
    // Native opacity declarations are untouched for popup, child, stale,
    // ownerless, and no-blur surfaces. Global/window blur decisions stay native.
    for(int scenario=0;scenario<5;++scenario) {
        element->m_data.mainSurface=true; element->m_data.popup=false;
        element->m_data.blur=true; element->m_data.pWindow->fresh=true;
        auto owner=element->m_data.pWindow;
        if(scenario==0) element->m_data.popup=true;
        if(scenario==1) element->m_data.mainSurface=false;
        if(scenario==2) element->m_data.pWindow->fresh=false;
        if(scenario==3) element->m_data.pWindow.reset();
        if(scenario==4) element->m_data.blur=false;
        assert(!hkMediaNeedsLiveBlur(element.get()));
        assert(!hkMediaNeedsPrecomputeBlur(element.get()));
        expectedOpaqueRegion=42; expectedTextureOpaque=true;
        expectedPopup=element->m_data.popup;
        hkMediaDrawSurface(&renderer,element,CRegion{7});
        verifyRestored(element);
        element->m_data.pWindow=owner;
    }
    element->m_data.blur=true;
    expectedPopup=false;
    element->m_data.texture->m_opaque=false;
    expectedOpaqueRegion=0; expectedTextureOpaque=false;
    hkMediaDrawSurface(&renderer,element,CRegion{7});
    assert(!element->m_data.texture->m_opaque);
    assert(element->m_data.surface->m_current.opaque.value==42);
    element->m_data.texture.reset();
    assert(!hkMediaNeedsLiveBlur(element.get()));
    assert(!hkMediaNeedsPrecomputeBlur(element.get()));
    assert(!hkMediaNeedsLiveBlur(nullptr));
    assert(!hkMediaNeedsPrecomputeBlur(nullptr));
}
'''
        with tempfile.TemporaryDirectory(prefix="brave-plugin-blur-") as directory:
            executable = str(Path(directory) / "test")
            result = subprocess.run(["g++", "-std=c++23", "-x", "c++", "-", "-o", executable],
                                    input=harness, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            subprocess.run([executable], check=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()
