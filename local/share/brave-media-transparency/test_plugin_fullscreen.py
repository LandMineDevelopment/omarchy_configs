"""Compile the production fullscreen shader gates against a focused fixture."""
from pathlib import Path
import subprocess
import tempfile
import unittest


class PluginFullscreenTests(unittest.TestCase):
    def test_fresh_mask_opts_into_steady_shading_without_animation_opt_in(self):
        source = (Path(__file__).parent / "plugin/Hooks.cpp").read_text()
        declarations = []
        for signature in (
            "template <typename Map>\nstatic const typename Map::mapped_type* lookupLayerEntry",
            "static const std::string* resolveShaderPath(",
            "static bool fullscreenSuppresses(",
            "static bool fullscreenRendersNothing(",
            "static int collectBaseLayers(",
        ):
            start = source.index(signature)
            declarations.append(source[start:source.index("\n}", start) + 2])
        harness = r'''
#include <cassert>
#include <memory>
#include <string>
#include <unordered_map>
namespace Desktop::View {
struct CWindow {
    std::string m_class="brave-browser", m_initialClass="brave-browser";
    bool m_isFloating=false, fullscreen=true, fresh=false, active=true;
    int internal=2;
};
}
using PHLWINDOW=std::shared_ptr<Desktop::View::CWindow>;
struct Layer { std::string m_namespace; };
using PHLLS=std::shared_ptr<Layer>;
namespace Fullscreen {
struct Controller { bool isFullscreen(const PHLWINDOW& w) { return w->fullscreen; } };
Controller* controller() { static Controller value; return &value; }
}
namespace Desktop {
struct Focus { bool isWindowActive(const PHLWINDOW& w) { return w->active; } };
Focus* focusState() { static Focus value; return &value; }
}
bool mediaMaskFresh(Desktop::View::CWindow* w) { return w && w->m_class=="brave-browser" && w->fresh; }
bool mediaBackgroundEligible(Desktop::View::CWindow* w) {
    return mediaMaskFresh(w) || (w && w->m_class=="brave-browser" && w->internal==1);
}
struct Rule {
    bool fullscreenStack=false;
    std::string fullscreen, floating, tiled, active, inactive, fallback, fsEnterAnim, fsExitAnim;
};
constexpr int MAX_SHADER_STAGES=16;
const std::string LAYER_CATCH_ALL="*";
std::unordered_map<Desktop::View::CWindow*,Rule> g_mWindowRuleShaders;
std::unordered_map<Desktop::View::CWindow*,std::string> g_mWindowManualShaders;
std::unordered_map<std::string,std::string> g_mWindowClassShaderMap, g_mLayerNamespaceShaderMap;
''' + "\n".join(declarations) + r'''
int main() {
    auto w=std::make_shared<Desktop::View::CWindow>();
    const std::string* layers[MAX_SHADER_STAGES]{};
    g_mWindowClassShaderMap["brave-browser"]="background";
    // All three steady gates must reject stale geometry in fullscreen.
    assert(resolveShaderPath(w,nullptr)==nullptr);
    assert(collectBaseLayers(w,nullptr,layers)==0);
    assert(fullscreenRendersNothing(w));
    w->internal=1; // Native maximize keeps chrome even without a page mask.
    assert(*resolveShaderPath(w,nullptr)=="background");
    assert(collectBaseLayers(w,nullptr,layers)==1 && *layers[0]=="background");
    assert(!fullscreenRendersNothing(w));
    w->internal=2; // True fullscreen has no independent chrome exception.
    assert(resolveShaderPath(w,nullptr)==nullptr);
    assert(collectBaseLayers(w,nullptr,layers)==0);
    w->fresh=true;
    assert(*resolveShaderPath(w,nullptr)=="background");
    assert(collectBaseLayers(w,nullptr,layers)==1 && *layers[0]=="background");
    assert(!fullscreenRendersNothing(w));
    assert(fullscreenSuppresses(w)); // Media opt-in does not enable animations.
    auto& rule=g_mWindowRuleShaders[w.get()];
    rule.fallback="rule"; rule.tiled="tiled"; rule.active="active";
    g_mWindowManualShaders[w.get()]="manual";
    assert(*resolveShaderPath(w,nullptr)=="manual");
    assert(collectBaseLayers(w,nullptr,layers)==5);
    assert(*layers[0]=="background" && *layers[1]=="rule" && *layers[2]=="manual");
    assert(*layers[3]=="tiled" && *layers[4]=="active");
    w->active=false; rule.inactive="inactive";
    assert(collectBaseLayers(w,nullptr,layers)==5 && *layers[4]=="inactive");
    w->fresh=false;
    assert(resolveShaderPath(w,nullptr)==nullptr);
    assert(collectBaseLayers(w,nullptr,layers)==0);
    assert(fullscreenRendersNothing(w));
    rule.fullscreen="explicit-fullscreen";
    assert(*resolveShaderPath(w,nullptr)=="explicit-fullscreen");
    assert(collectBaseLayers(w,nullptr,layers)==1 && *layers[0]=="explicit-fullscreen");
    assert(!fullscreenRendersNothing(w));
    rule.fullscreenStack=true;
    assert(*resolveShaderPath(w,nullptr)=="explicit-fullscreen");
    assert(collectBaseLayers(w,nullptr,layers)==6 && *layers[5]=="explicit-fullscreen");
    assert(!fullscreenSuppresses(w));
    // An unrelated fullscreen app cannot inherit Brave's implicit opt-in.
    g_mWindowRuleShaders.clear(); g_mWindowManualShaders.clear();
    w->m_class=w->m_initialClass="game"; w->fresh=true;
    g_mWindowClassShaderMap["game"]="game-shader";
    assert(resolveShaderPath(w,nullptr)==nullptr);
    assert(collectBaseLayers(w,nullptr,layers)==0);
    assert(fullscreenRendersNothing(w));
    w->fullscreen=false;
    assert(*resolveShaderPath(w,nullptr)=="game-shader");
    assert(collectBaseLayers(w,nullptr,layers)==1);
    assert(!fullscreenRendersNothing(w) && !fullscreenSuppresses(w));
    assert(resolveShaderPath(nullptr,nullptr)==nullptr);
    assert(collectBaseLayers(nullptr,nullptr,layers)==0);
    assert(!fullscreenRendersNothing(nullptr));
}
'''
        with tempfile.TemporaryDirectory(prefix="brave-plugin-fullscreen-") as directory:
            executable = str(Path(directory) / "test")
            result = subprocess.run(
                ["g++", "-std=c++23", "-x", "c++", "-", "-o", executable],
                input=harness, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([executable], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
