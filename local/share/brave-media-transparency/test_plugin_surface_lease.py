"""Exercise applied surface content ownership and its bounded uncertainty lease."""
from pathlib import Path
import subprocess
import tempfile
import unittest

from native_surface_harness import SURFACE_HARNESS


class PluginSurfaceLeaseTests(unittest.TestCase):
    def test_idle_is_stable_and_applied_content_starts_one_bounded_lease(self):
        source = (Path(__file__).parent / "plugin/MediaMask.cpp").read_text()
        start = source.index("static SP<MediaSurfaceLease> trackMediaSurface(")
        production = source[start:source.index("\n// Lua errors", start)]
        harness = SURFACE_HARNESS + r'''
#include <cstdlib>
#include <iostream>
#define CHECK(condition) do { if(!(condition)) { std::cerr<<"failed "<<__LINE__<<": "<<#condition<<'\n'; std::exit(1); } } while(false)
''' + production + r'''
int main() {
    const auto now=std::chrono::steady_clock::now();
    MediaContentLease clock;
    // No repaint means the exact same accepted pixels, even after long idle.
    CHECK(clock.fresh(now+std::chrono::hours(24)));
    clock.changed(now);
    CHECK(clock.revision==1 && clock.acknowledgedRevision==0);
    CHECK(clock.fresh(now+std::chrono::milliseconds(500)));
    CHECK(!clock.fresh(now+std::chrono::milliseconds(500)+std::chrono::nanoseconds(1)));
    clock.changed(now+std::chrono::milliseconds(400));
    CHECK(clock.revision==2 && *clock.unacknowledgedSince==now);
    CHECK(!clock.fresh(now+std::chrono::milliseconds(501))); // Repaints cannot extend uncertainty.
    clock.acknowledge();
    CHECK(clock.acknowledgedRevision==2 && !clock.unacknowledgedSince);
    CHECK(clock.fresh(now+std::chrono::hours(24)));
    clock.changed(now+std::chrono::hours(24));
    CHECK(clock.fresh(now+std::chrono::hours(24)+std::chrono::milliseconds(500)));
    CHECK(!clock.fresh(now+std::chrono::hours(24)+std::chrono::milliseconds(501)));

    auto root=makeShared<CWLSurfaceResource>();
    auto lease=trackMediaSurface(root);
    CHECK(root->m_events.commit.active()==1);
    CHECK(lease->surface.lock()==root);
    // No-op, callback, input-region and opaque-declaration commits do not
    // change content. They must not make an idle browser canvas flash.
    root->m_events.commit.emit();
    auto& bits=root->m_current.updated.bits;
    bits.frame=bits.input=bits.opaque=true;
    root->m_events.commit.emit();
    CHECK(lease->content.revision==0 && !lease->content.unacknowledgedSince);
    // Only this root is observed: popovers/cursor surfaces/video child planes
    // cannot disturb its mask even when they submit new pixels every frame.
    auto child=makeShared<CWLSurfaceResource>();
    child->m_current.updated.bits.buffer=true;
    for(int i=0;i<20;i++) child->m_events.commit.emit();
    CHECK(lease->content.revision==0);
    // Buffer reuse and damage-only SHM updates still create new content.
    for(auto flag:{&bits.buffer,&bits.damage,&bits.scale,&bits.transform,&bits.offset,&bits.viewport}) {
        const auto revision=lease->content.revision;
        *flag=true;root->m_events.commit.emit();*flag=false;
        CHECK(lease->content.revision==revision+1 && lease->content.unacknowledgedSince);
        const auto firstChange=lease->content.unacknowledgedSince;
        root->m_events.commit.emit();
        CHECK(lease->content.unacknowledgedSince==firstChange);
        lease->content.acknowledge();
        CHECK(!lease->content.unacknowledgedSince);
    }
    // The tracker neither keeps the native surface alive nor leaves a dangling
    // callback after mask reset/rejection/plugin unload.
    root.reset();CHECK(!lease->surface.lock());
    lease.reset();
    auto second=makeShared<CWLSurfaceResource>();
    lease=trackMediaSurface(second);CHECK(second->m_events.commit.active()==1);
    lease.reset();CHECK(second->m_events.commit.active()==0);
    second->m_events.commit.emit();
}
'''
        with tempfile.TemporaryDirectory(prefix="brave-plugin-lease-") as directory:
            executable = str(Path(directory) / "test")
            result = subprocess.run(["g++", "-std=c++23", "-x", "c++", "-", "-o", executable],
                                    input=harness, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([executable], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
