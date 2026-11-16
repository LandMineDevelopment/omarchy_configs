"""Verify real input format routing, including RGBA intermediate stages."""
from pathlib import Path
import subprocess
import tempfile
import unittest


class PluginFormatTests(unittest.TestCase):
    def test_rgbx_discard_alpha_is_scoped_to_the_actual_stage_input(self):
        source = (Path(__file__).parent / "plugin/Hooks.cpp").read_text()
        start = source.index("static bool mediaSourceIsRGBX(")
        helper = source[start:source.index("\n}", start) + 2]
        start = source.index("const MediaMask* previousDrawMask =")
        draw_scope = source[start:source.index("\n\n    // Page masks", start)]
        start = source.index("const bool previousSourceRGBX =", source.index("static SP<Render::ITexture> runIntermediateStages"))
        stage_scope = source[start:source.index("\n    for (int i", start)]
        start = source.index("if (activeEntry->mediaSourceRGBXLoc >= 0)")
        upload = source[start:source.index("\n        if (activeEntry->mediaFullscreenLoc", start)]
        harness = r'''
#include <cassert>
#include <functional>
#include <memory>
#include <stdexcept>
template<class T> using SP=std::shared_ptr<T>;
namespace Render {
enum Type { TEXTURE_RGBA=0,TEXTURE_RGBX=1,TEXTURE_EXTERNAL=3 };
struct ITexture { Type m_type=TEXTURE_RGBA; };
}
namespace Hyprutils::Utils {
struct CScopeGuard {
    std::function<void()> restore;
    CScopeGuard(std::function<void()> callback): restore(callback) {}
    ~CScopeGuard() { restore(); }
};
}
struct MediaMask {};
const MediaMask* g_mediaMaskForDraw=nullptr;
bool g_nativePopupForDraw=false,g_mediaSourceRGBXForDraw=false;
struct Element { struct { SP<Render::ITexture> tex; } m_data; };
struct Entry { int mediaSourceRGBXLoc=42; };
float uploaded=-1;
void glUniform1f(int location,float value) { assert(location==42);uploaded=value; }
''' + helper + r'''
void uploadFormat(Entry* activeEntry) {
''' + upload + r'''
}
void draw(Element* elem,bool throwing=false) {
''' + draw_scope + r'''
    assert(g_mediaSourceRGBXForDraw==mediaSourceIsRGBX(elem?elem->m_data.tex:nullptr));
    Entry entry;uploadFormat(&entry);assert(uploaded==(g_mediaSourceRGBXForDraw?1.f:0.f));
    // Run the same restoration scope around the production per-stage input
    // assignment. The RGBA output must keep newly introduced canvas alpha.
    {
''' + stage_scope + r'''
        auto cur=std::make_shared<Render::ITexture>();cur->m_type=Render::TEXTURE_RGBA;
        g_mediaSourceRGBXForDraw = mediaSourceIsRGBX(cur);
        uploadFormat(&entry);assert(uploaded==0.f);
        if(throwing) throw std::runtime_error("stage failed");
    }
    assert(g_mediaSourceRGBXForDraw==mediaSourceIsRGBX(elem?elem->m_data.tex:nullptr));
}
int main() {
    assert(!mediaSourceIsRGBX(nullptr));
    auto source=std::make_shared<Render::ITexture>();
    Element element; element.m_data.tex=source;
    for(auto format:{Render::TEXTURE_RGBA,Render::TEXTURE_RGBX,Render::TEXTURE_EXTERNAL}) {
        source->m_type=format;
        assert(mediaSourceIsRGBX(source)==(format==Render::TEXTURE_RGBX));
        for(bool previous:{false,true}) {
            g_mediaSourceRGBXForDraw=previous;
            draw(&element);assert(g_mediaSourceRGBXForDraw==previous);
            try { draw(&element,true);assert(false); } catch(const std::runtime_error&) {}
            assert(g_mediaSourceRGBXForDraw==previous);
        }
    }
    draw(nullptr);assert(g_mediaSourceRGBXForDraw);
    Entry absent;absent.mediaSourceRGBXLoc=-1;uploaded=-1;uploadFormat(&absent);assert(uploaded==-1);
}
'''
        with tempfile.TemporaryDirectory(prefix="brave-plugin-formats-") as directory:
            executable = str(Path(directory) / "test")
            result = subprocess.run(["g++", "-std=c++23", "-x", "c++", "-", "-o", executable],
                                    input=harness, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([executable], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
