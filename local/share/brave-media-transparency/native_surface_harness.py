"""Small native signal/resource stand-ins for production mask lease tests."""
from pathlib import Path

_header = (Path(__file__).parent / "plugin/MediaMask.hpp").read_text()
LEASE_TYPES = _header[_header.index("struct MediaContentLease {"):_header.index("struct MediaMask {")]
SURFACE_HARNESS = r'''
#include <array>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <vector>
template<class T> using SP=std::shared_ptr<T>;
template<class T> using WP=std::weak_ptr<T>;
template<class T,class... Args> SP<T> makeShared(Args&&... args) {
    return std::make_shared<T>(std::forward<Args>(args)...);
}
using CHyprSignalListener=SP<std::function<void()>>;
namespace Desktop::View { struct CWindow; }
using PHLWINDOW=SP<Desktop::View::CWindow>;
struct SurfaceSignal {
    std::vector<WP<std::function<void()>>> handlers;
    template<class F> CHyprSignalListener listen(F fn) {
        auto handler=makeShared<std::function<void()>>(fn);handlers.push_back(handler);return handler;
    }
    void emit() { for(auto& weak:handlers) if(auto handler=weak.lock()) (*handler)(); }
    int active() const { int count=0;for(const auto& weak:handlers) count+=!weak.expired();return count; }
};
struct CWLSurfaceResource {
    PHLWINDOW popupOwner;
    struct { struct { struct {
        bool buffer=false,damage=false,scale=false,transform=false,offset=false,viewport=false,
             frame=false,input=false,opaque=false;
    } bits; } updated; SP<int> texture=makeShared<int>(1); } m_current;
    struct { SurfaceSignal commit; } m_events;
};
SP<CWLSurfaceResource> defaultSurface() {
    static auto surface=makeShared<CWLSurfaceResource>();return surface;
}
''' + LEASE_TYPES + r'''
SP<MediaSurfaceLease> defaultLease() {
    auto lease=makeShared<MediaSurfaceLease>();lease->surface=defaultSurface();return lease;
}
'''
