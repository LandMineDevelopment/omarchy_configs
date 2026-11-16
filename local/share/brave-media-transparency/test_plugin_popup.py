"""Exercise production popup ownership with native surface and content types."""
from pathlib import Path
import subprocess
import tempfile
import unittest


class PluginPopupTests(unittest.TestCase):
    def test_native_popup_and_interactive_bubble_roots_preserve_media_children(self):
        source = (Path(__file__).parent / "plugin/MediaMask.cpp").read_text()
        start = source.index("PHLWINDOW mediaPopupOwner(")
        production = source[start:source.index("\nstatic PHLWINDOW findWindow", start)]
        harness = r'''
#include <cstdlib>
#include <iostream>
#include <memory>
#define CHECK(condition) do { if(!(condition)) { std::cerr<<"failed "<<__LINE__<<": "<<#condition<<'\n'; std::exit(1); } } while(false)
template<class T> using SP=std::shared_ptr<T>;
namespace NContentType { constexpr int CONTENT_TYPE_NONE=0; }
struct CContentType { int m_value=0; };
constexpr int SURFACE_ROLE_SUBSURFACE=4;
struct ISurfaceRole { virtual ~ISurfaceRole()=default; virtual int role() { return 0; } };
struct CWLSubsurfaceResource;
struct CSubsurfaceRole: ISurfaceRole {
    std::weak_ptr<CWLSubsurfaceResource> m_subsurface;
    int role() override { return SURFACE_ROLE_SUBSURFACE; }
};
namespace Desktop::View { struct CWLSurface; }
struct CWLSurfaceResource {
    std::weak_ptr<CContentType> m_contentType;
    SP<Desktop::View::CWLSurface> wrapper;
    SP<ISurfaceRole> m_role;
    struct { bool inputIsInfinite=true; struct { bool value=true; bool empty() { return value; } } input; } m_current;
};
struct CWLSubsurfaceResource { bool m_sync=false; std::weak_ptr<CWLSurfaceResource> m_parent; };
namespace Desktop::View {
constexpr int VIEW_TYPE_SUBSURFACE=1;
struct IView { virtual ~IView()=default; virtual int type() { return -1; } };
struct CSubsurface: IView { int type() override { return VIEW_TYPE_SUBSURFACE; } };
struct CWindow: IView {
    bool eligible=true;
    static SP<CWindow> fromView(SP<IView> view) { return std::dynamic_pointer_cast<CWindow>(view); }
};
struct CWLSurface {
    SP<IView> owner;
    static SP<CWLSurface> fromResource(SP<CWLSurfaceResource> resource) { return resource?resource->wrapper:nullptr; }
    SP<IView> view() { return owner; }
};
struct CPopup: IView {
    bool inertValue=false;
    SP<CWLSurface> ownerSurface;
    static SP<CPopup> fromView(SP<IView> view) { return std::dynamic_pointer_cast<CPopup>(view); }
    bool inert() { return inertValue; }
    SP<CWLSurface> getT1Owner() { return ownerSurface; }
};
}
using PHLWINDOW=SP<Desktop::View::CWindow>;
bool mediaBackgroundEligible(Desktop::View::CWindow* window) { return window && window->eligible; }
''' + production + r'''
int main() {
    using namespace Desktop::View;
    auto window=std::make_shared<CWindow>();
    auto popup=std::make_shared<CPopup>();
    popup->ownerSurface=std::make_shared<CWLSurface>();popup->ownerSurface->owner=window;
    auto surface=std::make_shared<CWLSurfaceResource>();
    surface->wrapper=std::make_shared<CWLSurface>();surface->wrapper->owner=popup;
    CHECK(mediaPopupOwner(surface)==window);
    CHECK(!mediaPopupOwner(nullptr));
    auto content=std::make_shared<CContentType>();surface->m_contentType=content;
    CHECK(mediaPopupOwner(surface)==window);
    for(int type:{1,2,3}) { content->m_value=type;CHECK(!mediaPopupOwner(surface)); }
    content->m_value=0;
    window->eligible=false;CHECK(!mediaPopupOwner(surface));window->eligible=true;
    popup->inertValue=true;CHECK(!mediaPopupOwner(surface));popup->inertValue=false;
    surface->wrapper->owner=std::make_shared<IView>();
    CHECK(!mediaPopupOwner(surface)); // Child/subsurface, including media, has no popup-root identity.
    surface->wrapper->owner=window;CHECK(!mediaPopupOwner(surface)); // Main surface uses page policy.
    surface->wrapper->owner=popup;
    popup->ownerSurface->owner=std::make_shared<IView>();CHECK(!mediaPopupOwner(surface)); // Layer/foreign owner.
    popup->ownerSurface.reset();CHECK(!mediaPopupOwner(surface));
    surface->wrapper.reset();CHECK(!mediaPopupOwner(surface)); // Anonymous source texture.
    // Actual Extensions toolbar bubble trace: direct child, desync, no content
    // hint, infinite input represented by an empty underlying region.
    auto parent=std::make_shared<CWLSurfaceResource>();parent->wrapper=std::make_shared<CWLSurface>();parent->wrapper->owner=window;
    surface->wrapper=std::make_shared<CWLSurface>();surface->wrapper->owner=std::make_shared<CSubsurface>();
    auto role=std::make_shared<CSubsurfaceRole>();surface->m_role=role;
    auto subsurface=std::make_shared<CWLSubsurfaceResource>();role->m_subsurface=subsurface;subsurface->m_parent=parent;
    CHECK(mediaPopupOwner(surface)==window);
    surface->m_current.inputIsInfinite=false;CHECK(!mediaPopupOwner(surface)); // Empty input compositor/media plane.
    surface->m_current.input.value=false;CHECK(mediaPopupOwner(surface)==window); // Explicit finite interactive widget.
    subsurface->m_sync=true;CHECK(!mediaPopupOwner(surface)); // Synchronized primary/overlay compositor plane.
    subsurface->m_sync=false;
    for(int type:{1,2,3}) { content->m_value=type;CHECK(!mediaPopupOwner(surface)); }
    content->m_value=0;
    window->eligible=false;CHECK(!mediaPopupOwner(surface));window->eligible=true;
    parent->wrapper->owner=std::make_shared<CSubsurface>();CHECK(!mediaPopupOwner(surface)); // Nested child, including video inside bubble.
    parent->wrapper->owner=std::make_shared<IView>();CHECK(!mediaPopupOwner(surface)); // Foreign/layer-owned widget.
    parent->wrapper->owner=window;
    subsurface->m_parent.reset();CHECK(!mediaPopupOwner(surface));subsurface->m_parent=parent;
    role->m_subsurface.reset();CHECK(!mediaPopupOwner(surface));role->m_subsurface=subsurface;
    surface->m_role=std::make_shared<ISurfaceRole>();CHECK(!mediaPopupOwner(surface));
    surface->m_role=role;surface->wrapper->owner=window;CHECK(!mediaPopupOwner(surface)); // Never treat main texture as widget.
}
'''
        with tempfile.TemporaryDirectory(prefix="brave-plugin-popup-") as directory:
            executable = str(Path(directory) / "test")
            result = subprocess.run(["g++", "-std=c++23", "-x", "c++", "-", "-o", executable],
                                    input=harness, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([executable], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
