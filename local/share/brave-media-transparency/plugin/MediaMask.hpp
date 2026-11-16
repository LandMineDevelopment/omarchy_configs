#pragma once
#include "Globals.hpp"
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>

inline constexpr int MEDIA_MAX_RECTS = 128;
// A mask owns the last acknowledged surface contents, not a wall-clock poll.
// Only an applied content change starts the existing bounded fail-closed lease.
struct MediaContentLease {
    uint64_t revision = 0, acknowledgedRevision = 0;
    std::optional<std::chrono::steady_clock::time_point> unacknowledgedSince;

    void changed(std::chrono::steady_clock::time_point now) {
        ++revision;
        if (!unacknowledgedSince) unacknowledgedSince = now;
    }
    void acknowledge() {
        acknowledgedRevision = revision;
        unacknowledgedSince.reset();
    }
    bool fresh(std::chrono::steady_clock::time_point now) const {
        return revision == acknowledgedRevision ||
               (unacknowledgedSince && now - *unacknowledgedSince <= std::chrono::milliseconds(500));
    }
};
struct MediaSurfaceLease {
    WP<CWLSurfaceResource> surface;
    MediaContentLease content;
    CHyprSignalListener commit;
};
struct MediaMask {
    std::array<float, MEDIA_MAX_RECTS * 4> rects{};
    int count = 0;
    double width = 0, height = 0;
    uint64_t stableID = 0;
    std::string title;
    std::chrono::steady_clock::time_point updated{};
    SP<MediaSurfaceLease> lease;

    bool sameGeometryAndIdentity(const MediaMask& other) const {
        return count == other.count && width == other.width && height == other.height &&
               title == other.title && stableID == other.stableID && rects == other.rects;
    }
};

// Read-only diagnostics cross Lua's allocation/longjmp boundary only after
// native owning references have been released. Keep this bounded snapshot
// entirely in values; topology is rooted at the window's wl_surface.
inline constexpr int MEDIA_STATUS_MAX_PLANES = 64;
struct MediaPlaneStatus {
    uint32_t surfaceID = 0, parentID = 0;
    int depth = 0, zIndex = 0, role = 0, contentType = 0, textureType = -1;
    bool root = false, mapped = false, hasTexture = false, textureOpaque = false;
    bool subsurface = false, synchronized = false, effectiveSynchronized = false;
    bool inputInfinite = false, inputEmpty = false, opaqueRegionEmpty = true;
    double x = 0, y = 0, width = 0, height = 0, bufferWidth = 0, bufferHeight = 0;
};
struct MediaStatusSnapshot {
    bool hasMask = false, fresh = false, mapped = false, hidden = false;
    bool chromeEligible = false, hasBounds = false, titleMatch = false, identityMatch = false;
    bool boundsMatch = false, surfaceMatch = false, hasLease = false, hasLeaseSurface = false, contentFresh = false;
    uint64_t stableID = 0, maskStableID = 0, revision = 0, acknowledgedRevision = 0;
    uint32_t rootSurfaceID = 0, leaseSurfaceID = 0;
    int regionCount = 0, planeCount = 0;
    double width = 0, height = 0, maskWidth = 0, maskHeight = 0;
    double maskAgeMs = -1, unacknowledgedAgeMs = -1;
    bool topologyTruncated = false;
    std::array<MediaPlaneStatus, MEDIA_STATUS_MAX_PLANES> planes{};
};
extern std::unordered_map<Desktop::View::CWindow*, MediaMask> g_mediaMasks;
extern std::array<float, 3> g_mediaCanvasColor;
extern float g_mediaCanvasOpacity;
bool mediaMaskFresh(Desktop::View::CWindow* window);
// Browser chrome has stable native geometry even on pages where extensions
// cannot run. This never grants ownership of page pixels below the toolbar.
bool mediaChromeEligible(Desktop::View::CWindow* window);
bool mediaBackgroundEligible(Desktop::View::CWindow* window);
// A native popup owns its own texture coordinates; it never inherits page
// rectangles. Photo/video/game surfaces and child subsurfaces stay untouched.
PHLWINDOW mediaPopupOwner(SP<CWLSurfaceResource> surface);
void mediaMaskResetAll();
// Disconnect the native commit callback before releasing any mask ownership.
bool mediaMaskDiscard(Desktop::View::CWindow* window);
void mediaMaskInit();
void mediaMaskExit();

extern Vector2D g_mediaUVTopLeft;
extern Vector2D g_mediaUVBottomRight;
