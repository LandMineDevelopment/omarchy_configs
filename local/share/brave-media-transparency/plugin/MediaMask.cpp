#include "MediaMask.hpp"
#include <lua.hpp>
#include <hyprland/src/render/pass/SurfacePassElement.hpp>
#include <hyprland/src/render/ElementRenderer.hpp>
#include <hyprland/src/protocols/core/Compositor.hpp>
#include <hyprland/src/protocols/core/Subcompositor.hpp>
#include <hyprland/src/protocols/ContentType.hpp>
#include <hyprland/src/managers/eventLoop/EventLoopManager.hpp>
#include <charconv>
#include <cstdlib>
#include <limits>
#include <type_traits>

std::unordered_map<Desktop::View::CWindow*, MediaMask> g_mediaMasks;
std::array<float, 3> g_mediaCanvasColor{0.0f, 0.0f, 0.0f};
float g_mediaCanvasOpacity = 0.5f;
Vector2D g_mediaUVTopLeft{0,0};
Vector2D g_mediaUVBottomRight{1,1};
static CFunctionHook* opaqueHook = nullptr;
static CFunctionHook* surfaceOpaqueHook = nullptr;
static CFunctionHook* liveBlurHook = nullptr;
static CFunctionHook* precomputeBlurHook = nullptr;
static CFunctionHook* drawSurfaceHook = nullptr;
// Protected C++ method, resolved through the same exported native metadata as
// the hook targets. Call its existing policy instead of duplicating window rules.
static bool (*nativeWindowShouldBlur)(Render::IHyprRenderer*, PHLWINDOW) = nullptr;
static SP<CEventLoopTimer> expiryTimer;
bool mediaChromeEligible(Desktop::View::CWindow* w) {
    if (!w || w->m_class != "brave-browser" || !w->m_isMapped || w->isHidden() ||
        w->parent() || !g_mWindowClassShaderMap.contains("brave-browser"))
        return false;
    const auto owner = w->m_self.lock();
    return owner && Fullscreen::controller()->getFullscreenModes(owner).internal != Fullscreen::FSMODE_FULLSCREEN;
}

bool mediaBackgroundEligible(Desktop::View::CWindow* w) {
    return mediaMaskFresh(w) || mediaChromeEligible(w);
}

bool mediaMaskFresh(Desktop::View::CWindow* w) {
    if (!w || w->m_class != "brave-browser" || !w->m_isMapped || w->isHidden())
        return false;
    auto it = g_mediaMasks.find(w);
    if (it == g_mediaMasks.end()) return false;
    const auto now = std::chrono::steady_clock::now();
    const auto& mask = it->second;
    if (w->m_title != mask.title || w->m_stableID != mask.stableID || !mask.lease ||
        !mask.lease->surface.lock() || mask.lease->surface.lock() != w->resource() || !mask.lease->content.fresh(now))
        return false;
    auto box = w->surfaceLogicalBox();
    return box && std::abs(box->w - mask.width) <= 2 && std::abs(box->h - mask.height) <= 2;
}

void mediaMaskResetAll() {
    for (const auto& w : Desktop::windowState()->windows())
        if (w && (g_mediaMasks.contains(w.get()) || mediaChromeEligible(w.get())))
            g_pHyprRenderer->damageWindow(w);
    for (auto& [window, mask] : g_mediaMasks)
        if (mask.lease) mask.lease->commit.reset();
    g_mediaMasks.clear();
}

bool mediaMaskDiscard(Desktop::View::CWindow* window) {
    const auto it = g_mediaMasks.find(window);
    if (it == g_mediaMasks.end()) return false;
    // Explicitly detach even if a temporary/shared mask still owns the lease.
    // A native surface must never retain code from an unloaded plugin DSO.
    if (it->second.lease) it->second.lease->commit.reset();
    g_mediaMasks.erase(it);
    return true;
}

PHLWINDOW mediaPopupOwner(SP<CWLSurfaceResource> surface) {
    if (!surface) return nullptr;
    if (auto content = surface->m_contentType.lock(); content && content->m_value != NContentType::CONTENT_TYPE_NONE)
        return nullptr;
    const auto wlSurface = Desktop::View::CWLSurface::fromResource(surface);
    const auto popup = wlSurface ? Desktop::View::CPopup::fromView(wlSurface->view()) : nullptr;
    SP<Desktop::View::CWLSurface> ownerSurface;
    if (popup) {
        if (popup->inert()) return nullptr;
        ownerSurface = popup->getT1Owner();
    } else {
        // Chromium's toolbar bubbles are interactive, desynchronized native
        // widgets directly under the window. Its primary/media compositor
        // planes are synchronized and explicitly input-transparent instead.
        // Match the widget root only: never shade a descendant video surface.
        if (!wlSurface || !wlSurface->view() || wlSurface->view()->type() != Desktop::View::VIEW_TYPE_SUBSURFACE ||
            !surface->m_role || surface->m_role->role() != SURFACE_ROLE_SUBSURFACE ||
            (!surface->m_current.inputIsInfinite && surface->m_current.input.empty())) return nullptr;
        const auto subsurface = static_cast<CSubsurfaceRole*>(surface->m_role.get())->m_subsurface.lock();
        if (!subsurface || subsurface->m_sync) return nullptr;
        const auto parent = subsurface->m_parent.lock();
        ownerSurface = parent ? Desktop::View::CWLSurface::fromResource(parent) : nullptr;
    }
    const auto owner = ownerSurface ? Desktop::View::CWindow::fromView(ownerSurface->view()) : nullptr;
    return owner && mediaBackgroundEligible(owner.get()) ? owner : nullptr;
}

static PHLWINDOW findWindow(const std::string& address) {
    uintptr_t value = 0;
    if (!address.starts_with("0x") || address.size() > 18) return nullptr;
    auto result = std::from_chars(address.data()+2, address.data()+address.size(), value, 16);
    if (result.ec != std::errc() || result.ptr != address.data()+address.size()) return nullptr;
    for (const auto& w : Desktop::windowState()->windows())
        if (w && reinterpret_cast<uintptr_t>(w.get()) == value && w->m_class == "brave-browser") return w;
    return nullptr;
}

static SP<MediaSurfaceLease> trackMediaSurface(SP<CWLSurfaceResource> surface) {
    auto lease = makeShared<MediaSurfaceLease>();
    lease->surface = surface;
    // Applied commits, after explicit/implicit synchronization, identify the
    // contents actually rendered. Texture pointers are not revisions: SHM
    // updates reuse textures and DMA buffer handles can be recycled.
    lease->commit = surface->m_events.commit.listen([borrowed = lease.get()] {
        const auto current = borrowed->surface.lock();
        if (!current) return;
        const auto& changed = current->m_current.updated.bits;
        if (changed.buffer || changed.damage || changed.scale || changed.transform || changed.offset || changed.viewport)
            borrowed->content.changed(std::chrono::steady_clock::now());
        // Frame callbacks and input/opaque-region-only commits do not change
        // pixels. Independent popup, cursor and child video planes have their
        // own surface signals and cannot age this root's accepted contents.
    });
    return lease;
}

// Lua errors longjmp instead of unwinding C++ destructors. Keep the entire
// owning operation in a normal C++ frame and raise only after it has returned.
// In particular Hyprutils shared-pointer move assignment swaps owners: the
// local mask can still own the previous commit listener after map replacement.
static const char* applyMediaRects(lua_State* L) {
    if (lua_type(L, 1) != LUA_TSTRING) return "invalid Brave window address";
    auto w = findWindow(luaL_checkstring(L, 1));
    if (!w) return "unknown Brave window";
    // Validate before replacing: a valid heartbeat must not toggle opacity or
    // damage an unchanged window. Malformed updates still immediately fail closed.
    const auto reject = [&](const char* error) {
        mediaMaskDiscard(w.get());
        g_pHyprRenderer->damageWindow(w);
        return error;
    };
    // Addresses can be reused after a window closes. Real native-host updates
    // include Hyprland's lifetime identity; legacy five-argument callers still
    // bind the resulting mask to the current native lifetime below.
    if (lua_gettop(L) >= 6) {
        if (lua_type(L, 6) != LUA_TSTRING) return reject("invalid media window identity");
        size_t identityLength = 0;
        const char* identity = luaL_checklstring(L, 6, &identityLength);
        uint64_t expectedID = 0;
        if (identityLength < 1 || identityLength > 16) return reject("invalid media window identity");
        const auto parsed = std::from_chars(identity, identity + identityLength, expectedID, 16);
        if (parsed.ec != std::errc() || parsed.ptr != identity + identityLength || expectedID == 0)
            return reject("invalid media window identity");
        if (expectedID != w->m_stableID) return reject("media window identity changed");
    }
    if (lua_type(L, 2) != LUA_TSTRING || !lua_isnumber(L, 3) || !lua_isnumber(L, 4) || lua_type(L, 5) != LUA_TSTRING)
        return reject("invalid media mask arguments");
    size_t length = 0;
    const char* csv = luaL_checklstring(L, 2, &length);
    if (length > 16384) return reject("media mask too large");
    MediaMask mask;
    mask.stableID = w->m_stableID;
    mask.width = luaL_checknumber(L, 3); mask.height = luaL_checknumber(L, 4);
    if (!std::isfinite(mask.width) || !std::isfinite(mask.height) || mask.width < 1 || mask.height < 1 || mask.width > 16384 || mask.height > 16384)
        return reject("invalid media dimensions");
    mask.title = luaL_checkstring(L, 5);
    if (mask.title.size() > 4096) return reject("media title too large");
    std::string input(csv, length);
    std::istringstream stream(input);
    std::string part;
    int values = 0;
    while (std::getline(stream, part, ',')) {
        if (values >= MEDIA_MAX_RECTS * 4 || part.empty()) return reject("invalid media rectangles");
        char* end = nullptr;
        const float value = std::strtof(part.c_str(), &end);
        if (end != part.c_str()+part.size() || !std::isfinite(value) || value < 0 || value > 1)
            return reject("invalid media coordinate");
        mask.rects[values++] = value;
    }
    if (values % 4 || (!input.empty() && input.back() == ',')) return reject("incomplete media rectangle");
    mask.count = values / 4;
    for (int i = 0; i < mask.count; ++i) {
        const auto* r = &mask.rects[i*4];
        if (r[2] <= 0 || r[3] <= 0 || r[0]+r[2] > 1.00001 || r[1]+r[3] > 1.00001)
            return reject("invalid media extent");
    }
    mask.updated = std::chrono::steady_clock::now();
    const auto previous = g_mediaMasks.find(w.get());
    const bool needsDamage = !mediaMaskFresh(w.get()) || previous == g_mediaMasks.end() ||
                             !previous->second.sameGeometryAndIdentity(mask);
    const auto surface = w->resource();
    if (!surface || !surface->m_current.texture) return reject("media window has no content surface");
    mask.lease = previous != g_mediaMasks.end() && previous->second.lease &&
                 previous->second.lease->surface.lock() == surface ? previous->second.lease : trackMediaSurface(surface);
    mask.lease->content.acknowledge();
    if (previous != g_mediaMasks.end() && previous->second.lease && previous->second.lease != mask.lease)
        previous->second.lease->commit.reset();
    g_mediaMasks[w.get()] = std::move(mask);
    if (!mediaMaskFresh(w.get())) {
        return reject("media window changed during update");
    }
    if (needsDamage) g_pHyprRenderer->damageWindow(w);
    return nullptr;
}

static int luaMediaRects(lua_State* L) {
    const char* error = applyMediaRects(L);
    return error ? luaL_error(L, "%s", error) : 0;
}

static int luaMediaReset(lua_State* L) {
    const std::string address = luaL_checkstring(L,1);
    if (address == "all") mediaMaskResetAll();
    else if (auto w = findWindow(address)) {
        mediaMaskDiscard(w.get()); g_pHyprRenderer->damageWindow(w);
    }
    return 0;
}

static int luaMediaPalette(lua_State* L) {
    if (lua_gettop(L) != 4) return luaL_error(L, "media palette requires red, green, blue and opacity");
    std::array<float, 4> values{};
    for (int i = 0; i < 4; ++i) {
        if (lua_type(L, i + 1) != LUA_TNUMBER) return luaL_error(L, "media palette values must be numbers");
        const double value = luaL_checknumber(L, i + 1);
        if (!std::isfinite(value) || value < 0.0 || value > 1.0)
            return luaL_error(L, "media palette values must be finite and between 0 and 1");
        values[i] = static_cast<float>(value);
    }
    const std::array<float, 3> color{values[0], values[1], values[2]};
    if (color == g_mediaCanvasColor && values[3] == g_mediaCanvasOpacity) return 0;
    g_mediaCanvasColor = color;
    g_mediaCanvasOpacity = values[3];
    for (const auto& window : Desktop::windowState()->windows())
        if (window && mediaBackgroundEligible(window.get())) g_pHyprRenderer->damageWindow(window);
    return 0;
}

static void snapshotMediaPlanes(const SP<CWLSurfaceResource>& surface, uint32_t parentID, int depth,
                                double x, double y, int zIndex, bool synchronized, bool inheritedSync,
                                MediaStatusSnapshot& status) {
    if (!surface) return;
    if (status.planeCount == MEDIA_STATUS_MAX_PLANES) {
        status.topologyTruncated = true;
        return;
    }
    auto& plane = status.planes[status.planeCount++];
    plane.surfaceID = surface->id();
    plane.parentID = parentID;
    plane.depth = depth;
    plane.zIndex = zIndex;
    plane.root = depth == 0;
    plane.role = surface->m_role ? surface->m_role->role() : SURFACE_ROLE_UNASSIGNED;
    plane.subsurface = plane.role == SURFACE_ROLE_SUBSURFACE;
    plane.synchronized = synchronized;
    plane.effectiveSynchronized = synchronized || inheritedSync;
    plane.mapped = surface->m_mapped;
    const auto& current = surface->m_current;
    plane.hasTexture = bool(current.texture);
    if (current.texture) {
        plane.textureType = current.texture->m_type;
        plane.textureOpaque = current.texture->m_opaque;
    }
    plane.inputInfinite = current.inputIsInfinite;
    plane.inputEmpty = !current.inputIsInfinite && current.input.empty();
    plane.opaqueRegionEmpty = current.opaque.empty();
    plane.x = x;
    plane.y = y;
    plane.width = current.size.x;
    plane.height = current.size.y;
    plane.bufferWidth = current.bufferSize.x;
    plane.bufferHeight = current.bufferSize.y;
    if (const auto content = surface->m_contentType.lock()) plane.contentType = content->m_value;
    // Report current protocol geometry, including unmapped children. The
    // compositor's render traversal would omit some of those diagnostic clues.
    for (const auto& weakChild : surface->m_subsurfaces) {
        const auto child = weakChild.lock();
        if (!child) continue;
        snapshotMediaPlanes(child->m_surface.lock(), plane.surfaceID, depth + 1,
                            x + child->m_position.x, y + child->m_position.y, child->m_zIndex,
                            child->m_sync, plane.effectiveSynchronized, status);
        if (status.topologyTruncated) return;
    }
}

static const char* snapshotMediaStatus(const char* address, size_t length, MediaStatusSnapshot& status) {
    if (length < 3 || length > 18) return "invalid Brave window address";
    const auto window = findWindow(std::string(address, length));
    if (!window) return "unknown Brave window";
    const auto now = std::chrono::steady_clock::now();
    status.fresh = mediaMaskFresh(window.get());
    status.chromeEligible = mediaChromeEligible(window.get());
    status.mapped = window->m_isMapped;
    status.hidden = window->isHidden();
    status.stableID = window->m_stableID;
    const auto bounds = window->surfaceLogicalBox();
    status.hasBounds = bool(bounds);
    if (bounds) {
        status.width = bounds->w;
        status.height = bounds->h;
    }
    const auto root = window->resource();
    if (root) {
        status.rootSurfaceID = root->id();
        snapshotMediaPlanes(root, 0, 0, 0, 0, 0, false, false, status);
    }
    const auto accepted = g_mediaMasks.find(window.get());
    if (accepted == g_mediaMasks.end()) return nullptr;
    const auto& mask = accepted->second;
    status.hasMask = true;
    status.regionCount = mask.count;
    status.maskStableID = mask.stableID;
    status.maskWidth = mask.width;
    status.maskHeight = mask.height;
    status.maskAgeMs = std::chrono::duration<double, std::milli>(now - mask.updated).count();
    status.titleMatch = window->m_title == mask.title;
    status.identityMatch = window->m_stableID == mask.stableID;
    status.boundsMatch = bounds && std::abs(bounds->w - mask.width) <= 2 && std::abs(bounds->h - mask.height) <= 2;
    status.hasLease = bool(mask.lease);
    if (mask.lease) {
        const auto leasedSurface = mask.lease->surface.lock();
        status.hasLeaseSurface = bool(leasedSurface);
        status.surfaceMatch = leasedSurface && leasedSurface == root;
        if (leasedSurface) status.leaseSurfaceID = leasedSurface->id();
        const auto& content = mask.lease->content;
        status.revision = content.revision;
        status.acknowledgedRevision = content.acknowledgedRevision;
        status.contentFresh = content.fresh(now);
        if (content.unacknowledgedSince)
            status.unacknowledgedAgeMs = std::chrono::duration<double, std::milli>(now - *content.unacknowledgedSince).count();
    }
    return nullptr;
}

static void mediaStatusBool(lua_State* L, const char* key, bool value) {
    lua_pushboolean(L, value);
    lua_setfield(L, -2, key);
}
static void mediaStatusNumber(lua_State* L, const char* key, double value) {
    lua_pushnumber(L, value);
    lua_setfield(L, -2, key);
}
static void mediaStatusUInt(lua_State* L, const char* key, uint64_t value) {
    if (value <= static_cast<uint64_t>(std::numeric_limits<lua_Integer>::max()))
        lua_pushinteger(L, static_cast<lua_Integer>(value));
    else {
        // Preserve the full revision even if it outgrows Lua's signed integer.
        char digits[20];
        const auto result = std::to_chars(digits, digits + sizeof(digits), value);
        lua_pushlstring(L, digits, result.ptr - digits);
    }
    lua_setfield(L, -2, key);
}
static void mediaStatusHex(lua_State* L, const char* key, uint64_t value) {
    char digits[16];
    const auto result = std::to_chars(digits, digits + sizeof(digits), value, 16);
    lua_pushlstring(L, digits, result.ptr - digits);
    lua_setfield(L, -2, key);
}

static int luaMediaStatus(lua_State* L) {
    if (lua_gettop(L) != 1 || lua_type(L, 1) != LUA_TSTRING)
        return luaL_error(L, "media status requires one Brave window address");
    size_t length = 0;
    const char* address = lua_tolstring(L, 1, &length);
    MediaStatusSnapshot status{};
    static_assert(std::is_trivially_destructible_v<MediaStatusSnapshot>);
    // This call returns from all native owning frames before any Lua output
    // allocation can longjmp. Status queries never acknowledge or damage.
    if (const char* error = snapshotMediaStatus(address, length, status)) return luaL_error(L, "%s", error);
    lua_createtable(L, 0, 30);
    mediaStatusBool(L, "hasMask", status.hasMask);
    mediaStatusBool(L, "fresh", status.fresh);
    mediaStatusBool(L, "mapped", status.mapped);
    mediaStatusBool(L, "hidden", status.hidden);
    mediaStatusBool(L, "chromeEligible", status.chromeEligible);
    mediaStatusBool(L, "backgroundEligible", status.fresh || status.chromeEligible);
    mediaStatusBool(L, "hasBounds", status.hasBounds);
    mediaStatusBool(L, "titleMatch", status.titleMatch);
    mediaStatusBool(L, "identityMatch", status.identityMatch);
    mediaStatusBool(L, "boundsMatch", status.boundsMatch);
    mediaStatusBool(L, "surfaceMatch", status.surfaceMatch);
    mediaStatusBool(L, "hasLease", status.hasLease);
    mediaStatusBool(L, "hasLeaseSurface", status.hasLeaseSurface);
    mediaStatusBool(L, "contentFresh", status.contentFresh);
    mediaStatusHex(L, "stableID", status.stableID);
    mediaStatusHex(L, "maskStableID", status.maskStableID);
    mediaStatusUInt(L, "rootSurfaceID", status.rootSurfaceID);
    mediaStatusUInt(L, "leaseSurfaceID", status.leaseSurfaceID);
    mediaStatusUInt(L, "regionCount", status.regionCount);
    mediaStatusUInt(L, "revision", status.revision);
    mediaStatusUInt(L, "acknowledgedRevision", status.acknowledgedRevision);
    mediaStatusNumber(L, "width", status.width);
    mediaStatusNumber(L, "height", status.height);
    mediaStatusNumber(L, "maskWidth", status.maskWidth);
    mediaStatusNumber(L, "maskHeight", status.maskHeight);
    mediaStatusNumber(L, "maskAgeMs", status.maskAgeMs);
    mediaStatusNumber(L, "unacknowledgedAgeMs", status.unacknowledgedAgeMs);
    mediaStatusUInt(L, "planeCount", status.planeCount);
    mediaStatusBool(L, "topologyTruncated", status.topologyTruncated);
    lua_createtable(L, status.planeCount, 0);
    for (int i = 0; i < status.planeCount; ++i) {
        const auto& plane = status.planes[i];
        lua_createtable(L, 0, 24);
        mediaStatusUInt(L, "surfaceID", plane.surfaceID);
        mediaStatusUInt(L, "parentID", plane.parentID);
        mediaStatusUInt(L, "depth", plane.depth);
        mediaStatusNumber(L, "zIndex", plane.zIndex);
        mediaStatusUInt(L, "role", plane.role);
        mediaStatusUInt(L, "contentType", plane.contentType);
        mediaStatusNumber(L, "textureType", plane.textureType);
        mediaStatusBool(L, "root", plane.root);
        mediaStatusBool(L, "mapped", plane.mapped);
        mediaStatusBool(L, "hasTexture", plane.hasTexture);
        mediaStatusBool(L, "textureOpaque", plane.textureOpaque);
        mediaStatusBool(L, "subsurface", plane.subsurface);
        mediaStatusBool(L, "synchronized", plane.synchronized);
        mediaStatusBool(L, "effectiveSynchronized", plane.effectiveSynchronized);
        mediaStatusBool(L, "inputInfinite", plane.inputInfinite);
        mediaStatusBool(L, "inputEmpty", plane.inputEmpty);
        mediaStatusBool(L, "opaqueRegionEmpty", plane.opaqueRegionEmpty);
        mediaStatusNumber(L, "x", plane.x);
        mediaStatusNumber(L, "y", plane.y);
        mediaStatusNumber(L, "width", plane.width);
        mediaStatusNumber(L, "height", plane.height);
        mediaStatusNumber(L, "bufferWidth", plane.bufferWidth);
        mediaStatusNumber(L, "bufferHeight", plane.bufferHeight);
        lua_rawseti(L, -2, i + 1);
    }
    lua_setfield(L, -2, "planes");
    return 1;
}

static bool hkWindowOpaque(Desktop::View::CWindow* w) {
    if (mediaBackgroundEligible(w)) return false;
    return reinterpret_cast<bool(*)(Desktop::View::CWindow*)>(opaqueHook->m_original)(w);
}
static CRegion hkSurfaceOpaque(CSurfacePassElement* elem) {
    if (elem && ((elem->m_data.mainSurface && !elem->m_data.popup && mediaBackgroundEligible(elem->m_data.pWindow.get())) ||
                 mediaPopupOwner(elem->m_data.surface))) return {};
    return reinterpret_cast<CRegion(*)(CSurfacePassElement*)>(surfaceOpaqueHook->m_original)(elem);
}

// Correct only the declarations used by native blur planning. The shader's
// output introduces alpha even when the client's original buffer is RGBX or
// declares an opaque region. Never change source pixels or whole-window alpha.
class MediaBlurDeclarationScope {
  public:
    MediaBlurDeclarationScope(CSurfacePassElement* element, bool clearSurfaceRegion) {
        if (!element || !element->m_data.texture) return;
        const auto popupOwner = mediaPopupOwner(element->m_data.surface);
        const bool mainEligible = element->m_data.mainSurface && !element->m_data.popup &&
                                  mediaBackgroundEligible(element->m_data.pWindow.get());
        if (!mainEligible && !popupOwner) return;
        // Native popup blur is normally opt-in globally. This popup's shader
        // introduces alpha, so inherit its owner's actual native blur decision
        // for this synchronous plan/draw only; never alter the global setting.
        if (popupOwner) {
            popupElement = element;
            wasBlur = element->m_data.blur;
            wasPopup = element->m_data.popup;
            element->m_data.blur = nativeWindowShouldBlur(g_pHyprRenderer.get(), popupOwner);
            // Toolbar bubbles are wl_subsurfaces, but their independently
            // painted box needs the same live blur pass as an xdg_popup. The
            // native child draw path otherwise skips blur after the root.
            element->m_data.popup = true;
        }
        if (!element->m_data.blur) return;
        texture = element->m_data.texture;
        wasOpaque = texture->m_opaque;
        if (clearSurfaceRegion && element->m_data.surface) {
            surface = element->m_data.surface;
            opaqueRegion = surface->m_current.opaque;
            surface->m_current.opaque = {};
        }
        texture->m_opaque = false;
    }
    ~MediaBlurDeclarationScope() {
        if (surface) surface->m_current.opaque = opaqueRegion;
        if (texture) texture->m_opaque = wasOpaque;
        if (popupElement) {
            popupElement->m_data.blur = wasBlur;
            popupElement->m_data.popup = wasPopup;
        }
    }
    MediaBlurDeclarationScope(const MediaBlurDeclarationScope&) = delete;
    MediaBlurDeclarationScope& operator=(const MediaBlurDeclarationScope&) = delete;
  private:
    SP<Render::ITexture> texture;
    SP<CWLSurfaceResource> surface;
    bool wasOpaque = false;
    CSurfacePassElement* popupElement = nullptr;
    bool wasBlur = false;
    bool wasPopup = false;
    CRegion opaqueRegion;
};

static bool hkMediaNeedsLiveBlur(CSurfacePassElement* element) {
    MediaBlurDeclarationScope declarations(element, false);
    return reinterpret_cast<bool(*)(CSurfacePassElement*)>(liveBlurHook->m_original)(element);
}

static bool hkMediaNeedsPrecomputeBlur(CSurfacePassElement* element) {
    MediaBlurDeclarationScope declarations(element, false);
    return reinterpret_cast<bool(*)(CSurfacePassElement*)>(precomputeBlurHook->m_original)(element);
}

static void hkMediaDrawSurface(Render::IElementRenderer* renderer, WP<CSurfacePassElement> element, const CRegion& damage) {
    // Render pass elements are unique-owned; their weak handles cannot lock.
    // The synchronous native draw already guarantees this borrowed lifetime.
    MediaBlurDeclarationScope declarations(element.get(), true);
    reinterpret_cast<void(*)(Render::IElementRenderer*, WP<CSurfacePassElement>, const CRegion&)>(drawSurfaceHook->m_original)(renderer, element, damage);
}

void mediaMaskInit() {
    for (auto& m : HyprlandAPI::findFunctionsByName(PHANDLE, "shouldBlur"))
        if (m.signature.find("13IHyprRenderer10shouldBlurE") != std::string::npos &&
            m.signature.find("14CSharedPointerIN7Desktop4View7CWindow") != std::string::npos)
            nativeWindowShouldBlur = reinterpret_cast<bool(*)(Render::IHyprRenderer*, PHLWINDOW)>(m.address);
    for (auto& m : HyprlandAPI::findFunctionsByName(PHANDLE, "opaque")) {
        if (m.signature.find("7CWindow6opaqueEv") != std::string::npos)
            opaqueHook = HyprlandAPI::createFunctionHook(PHANDLE,m.address,reinterpret_cast<void*>(&hkWindowOpaque));
        if (m.signature.find("19CSurfacePassElement12opaqueRegionEv") != std::string::npos)
            surfaceOpaqueHook = HyprlandAPI::createFunctionHook(PHANDLE,m.address,reinterpret_cast<void*>(&hkSurfaceOpaque));
    }
    for (auto& m : HyprlandAPI::findFunctionsByName(PHANDLE, "needsLiveBlur"))
        if (m.signature.find("19CSurfacePassElement13needsLiveBlurEv") != std::string::npos)
            liveBlurHook = HyprlandAPI::createFunctionHook(PHANDLE, m.address, reinterpret_cast<void*>(&hkMediaNeedsLiveBlur));
    for (auto& m : HyprlandAPI::findFunctionsByName(PHANDLE, "needsPrecomputeBlur"))
        if (m.signature.find("19CSurfacePassElement19needsPrecomputeBlurEv") != std::string::npos)
            precomputeBlurHook = HyprlandAPI::createFunctionHook(PHANDLE, m.address, reinterpret_cast<void*>(&hkMediaNeedsPrecomputeBlur));
    for (auto& m : HyprlandAPI::findFunctionsByName(PHANDLE, "drawSurface"))
        if (m.signature.find("16IElementRenderer11drawSurfaceE") != std::string::npos)
            drawSurfaceHook = HyprlandAPI::createFunctionHook(PHANDLE, m.address, reinterpret_cast<void*>(&hkMediaDrawSurface));
    if (!nativeWindowShouldBlur || !opaqueHook || !surfaceOpaqueHook || !liveBlurHook || !precomputeBlurHook || !drawSurfaceHook ||
        !opaqueHook->hook() || !surfaceOpaqueHook->hook() || !liveBlurHook->hook() ||
        !precomputeBlurHook->hook() || !drawSurfaceHook->hook())
        throw std::runtime_error("Brave media trial: required opacity/blur hooks unavailable");
    HyprlandAPI::addLuaFunction(PHANDLE,"HyprWindowShade","mediarects",&luaMediaRects);
    HyprlandAPI::addLuaFunction(PHANDLE,"HyprWindowShade","mediareset",&luaMediaReset);
    HyprlandAPI::addLuaFunction(PHANDLE,"HyprWindowShade","mediapalette",&luaMediaPalette);
    HyprlandAPI::addLuaFunction(PHANDLE,"HyprWindowShade","mediastatus",&luaMediaStatus);
    // Native media-mask invalidation subscriptions.
    // Input itself does not revoke accepted geometry. The extension refreshes
    // page coordinates during scrolling; identity, dimensions and expiry still
    // fail closed when a snapshot no longer belongs to the current window.
    // Focus changes affect background alpha, not media ownership. Damage both
    // owners so the shader updates even when their page pixels are unchanged.
    g_Listeners.push_back(Event::bus()->m_events.window.active.listen(
        [previousWindow = PHLWINDOWREF(Desktop::focusState()->window())](PHLWINDOW window, auto) mutable {
            if (previousWindow.get() == window.get()) return;
            if (auto previous = previousWindow.lock(); previous && mediaBackgroundEligible(previous.get()))
                g_pHyprRenderer->damageWindow(previous);
            previousWindow = window;
            if (window && mediaBackgroundEligible(window.get())) g_pHyprRenderer->damageWindow(window);
        }));
    g_Listeners.push_back(Event::bus()->m_events.window.title.listen([](PHLWINDOW window) {
        // A terminal, another browser window or T3 can update its title without
        // changing this page. Revoke only the snapshot belonging to its owner.
        if (!window) return;
        const bool hadMask = mediaMaskDiscard(window.get());
        if (hadMask || mediaChromeEligible(window.get())) g_pHyprRenderer->damageWindow(window);
    }));
    expiryTimer = makeShared<CEventLoopTimer>(std::chrono::milliseconds(50), [](auto timer, void*) {
        for (const auto& w : Desktop::windowState()->windows()) {
            if (w && g_mediaMasks.contains(w.get()) && !mediaMaskFresh(w.get())) {
                mediaMaskDiscard(w.get()); g_pHyprRenderer->damageWindow(w);
            }
        }
        timer->updateTimeout(std::chrono::milliseconds(50));
    },nullptr);
    g_pEventLoopManager->addTimer(expiryTimer);
}
void mediaMaskExit() {
    mediaMaskResetAll();
    if (expiryTimer) { expiryTimer->cancel(); g_pEventLoopManager->removeTimer(expiryTimer); expiryTimer.reset(); }
    HyprlandAPI::removeLuaFunction(PHANDLE,"HyprWindowShade","mediarects");
    HyprlandAPI::removeLuaFunction(PHANDLE,"HyprWindowShade","mediareset");
    HyprlandAPI::removeLuaFunction(PHANDLE,"HyprWindowShade","mediapalette");
    HyprlandAPI::removeLuaFunction(PHANDLE,"HyprWindowShade","mediastatus");
}
