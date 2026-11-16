"""Render the actual separator shader in a private surfaceless GLES context."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest


HARNESS = r'''
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl32.h>
#include <array>
#include <cassert>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>
#include <cstdlib>
#undef assert
#define assert(condition) do { if (!(condition)) { std::cerr << "Failed check at line " << __LINE__ << ": " << #condition << '\n'; std::exit(1); } } while (false)
GLuint compile(GLenum kind, const std::string& source) {
    GLuint shader=glCreateShader(kind);
    const char* code=source.c_str(); glShaderSource(shader,1,&code,nullptr); glCompileShader(shader);
    GLint ok=0; glGetShaderiv(shader,GL_COMPILE_STATUS,&ok);
    if(!ok) { char log[4096]; glGetShaderInfoLog(shader,sizeof(log),nullptr,log); std::cerr<<log; }
    assert(ok); return shader;
}
int main(int argc,char** argv) {
    assert(argc==2);
    EGLDisplay display=eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA,EGL_DEFAULT_DISPLAY,nullptr);
    assert(display!=EGL_NO_DISPLAY && eglInitialize(display,nullptr,nullptr));
    assert(eglBindAPI(EGL_OPENGL_ES_API));
    EGLint attrs[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,
                    EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
    EGLConfig config; EGLint count=0; assert(eglChooseConfig(display,attrs,&config,1,&count)&&count==1);
    EGLint size[]={EGL_WIDTH,128,EGL_HEIGHT,128,EGL_NONE};
    EGLSurface surface=eglCreatePbufferSurface(display,config,size); assert(surface!=EGL_NO_SURFACE);
    EGLint version[]={EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE};
    EGLContext context=eglCreateContext(display,config,EGL_NO_CONTEXT,version); assert(context!=EGL_NO_CONTEXT);
    assert(eglMakeCurrent(display,surface,surface,context));
    std::ifstream file(argv[1]); assert(file);
    std::string fragment((std::istreambuf_iterator<char>(file)),{});
    GLuint program=glCreateProgram();
    glAttachShader(program,compile(GL_VERTEX_SHADER,R"(
#version 320 es
out vec2 v_texcoord;
void main() {
    vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
    v_texcoord=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0);
})"));
    glAttachShader(program,compile(GL_FRAGMENT_SHADER,fragment)); glLinkProgram(program);
    GLint linked=0;glGetProgramiv(program,GL_LINK_STATUS,&linked);assert(linked);
    glUseProgram(program);glUniform1i(glGetUniformLocation(program,"tex"),0);
    glUniform1f(glGetUniformLocation(program,"is_active"),1.0f);
    glUniform3f(glGetUniformLocation(program,"canvas_color"),0.0f,0.0f,0.0f);
    glUniform1f(glGetUniformLocation(program,"canvas_opacity"),0.5f);
    glUniform1f(glGetUniformLocation(program,"source_rgbx"),0.0f);
    glUniform2f(glGetUniformLocation(program,"surface_size"),128,592);
    GLuint vao;glGenVertexArrays(1,&vao);glBindVertexArray(vao);
    GLuint texture;glGenTextures(1,&texture);glBindTexture(GL_TEXTURE_2D,texture);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_EDGE);
    using Pixel=std::array<unsigned char,4>;
    std::vector<Pixel> input(128*128,Pixel{32,32,32,255}),output(128*128);
    auto line=[&](int y,Pixel color){for(int x=0;x<128;x++)input[y*128+x]=color;};
    line(20,{97,97,97,255}); // Measured native toolbar separator.
    line(40,{244,244,244,255}); // Bright text strokes remain unchanged.
    line(60,{97,97,150,255}); // Colorful UI remains unchanged.
    for(int x=58;x<=70;x++)input[80*128+x]={97,97,97,255}; // Midgray glyph stroke.
    for(int y=96;y<=104;y++)line(y,{97,97,97,255}); // Filled controls are not dividers.
    line(110,{97,97,97,255});line(111,{97,97,97,255}); // Thin HiDPI divider.
    auto render=[&](int masks){
        glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,128,128,0,GL_RGBA,GL_UNSIGNED_BYTE,input.data());
        glUniform1i(glGetUniformLocation(program,"media_count"),masks);
        if(masks)glUniform4f(glGetUniformLocation(program,"media_rects[0]"),.2f,.1f,.6f,.1f);
        glViewport(0,0,128,128);glDisable(GL_BLEND);glDrawArrays(GL_TRIANGLES,0,3);
        glReadPixels(0,0,128,128,GL_RGBA,GL_UNSIGNED_BYTE,output.data());assert(glGetError()==GL_NO_ERROR);
    };
    auto grayNear=[&](const Pixel& p,int value,int alpha){
        bool ok=std::abs(int(p[0])-value)<=1 && p[0]==p[1] && p[1]==p[2] && std::abs(int(p[3])-alpha)<=1;
        if(!ok)std::cerr<<"Pixel "<<int(p[0])<<','<<int(p[1])<<','<<int(p[2])<<','<<int(p[3])<<" expected "<<value<<','<<alpha<<'\n';
        return ok;
    };
    render(0);
    assert(grayNear(output[10*128+64],3,123)); // Ghostty focused canvas: .5*.985*.98.
    assert(grayNear(output[20*128+64],26,255));
    assert(output[40*128+64]==input[40*128+64]);
    assert(output[60*128+64]==input[60*128+64]);
    assert(output[80*128+64]==input[80*128+64]);
    assert(output[100*128+64]==input[100*128+64]);
    assert(output[110*128+64]==input[110*128+64]); // Long web input outlines retain their stroke.
    render(1);assert(output[20*128+64]==input[20*128+64]); // Media protection wins.
    glUniform1f(glGetUniformLocation(program,"is_active"),0.0f);
    render(0);
    assert(grayNear(output[10*128+64],3,110)); // Ghostty inactive canvas: .5*.96*.90.
    assert(output[40*128+64]==input[40*128+64]); // Text retains normal rendering.
    assert(output[60*128+64]==input[60*128+64]); // Colorful UI retains normal rendering.
    assert(grayNear(output[20*128+64],26,255)); // Minimal separator stays legible.
    render(1);assert(output[20*128+64]==input[20*128+64]); // Unfocused media stays opaque.
    glUniform1f(glGetUniformLocation(program,"is_active"),1.0f);
    for(auto& pixel:input) {
        for(int channel=0;channel<3;channel++)pixel[channel]=(pixel[channel]+1)/2;
        pixel[3]=128;
    }
    render(0);assert(grayNear(output[20*128+64],13,128));
    assert(output[40*128+64]==input[40*128+64]);
    render(1);assert(output[20*128+64]==input[20*128+64]);
    // Native ownership, not stroke shape, determines separator dimming. Test
    // two output scales with indistinguishable neutral lines in URL/page
    // controls, plus fullscreen and popup surfaces at the same coordinates.
    for(int scale:{1,2}) {
        glUniform2f(glGetUniformLocation(program,"surface_size"),128*scale,128*scale);
        input.assign(128*128,Pixel{32,32,32,255});
        const int toolbarRow=scale==1?95:47;
        const int urlControlRow=scale==1?60:30;
        const int pageControlRow=scale==1?110:100;
        line(toolbarRow,{97,97,97,255});
        line(urlControlRow,{97,97,97,255});
        line(pageControlRow,{97,97,97,255});
        render(0);
        assert(grayNear(output[toolbarRow*128+64],26,255));
        assert(output[urlControlRow*128+64]==input[urlControlRow*128+64]);
        assert(output[pageControlRow*128+64]==input[pageControlRow*128+64]);
        glUniform1f(glGetUniformLocation(program,"chrome_only"),1.0f);
        render(0);
        assert(grayNear(output[toolbarRow*128+64],26,255));
        assert(output[pageControlRow*128+64]==input[pageControlRow*128+64]);
        glUniform1f(glGetUniformLocation(program,"chrome_only"),0.0f);
        glUniform1f(glGetUniformLocation(program,"native_popup"),1.0f);
        render(0);
        assert(output[toolbarRow*128+64]==input[toolbarRow*128+64]);
        assert(output[pageControlRow*128+64]==input[pageControlRow*128+64]);
        glUniform1f(glGetUniformLocation(program,"native_popup"),0.0f);
        glUniform1f(glGetUniformLocation(program,"media_fullscreen"),1.0f);
        render(0);
        assert(output[toolbarRow*128+64]==input[toolbarRow*128+64]);
        assert(output[pageControlRow*128+64]==input[pageControlRow*128+64]);
        glUniform1f(glGetUniformLocation(program,"media_fullscreen"),0.0f);
    }
    input.assign(128*128,Pixel{16,16,16,255});
    for(int y=4;y<=43;y++)for(int x=10;x<=100;x++)input[y*128+x]={48,48,48,255};
    input[20*128+40]={244,244,244,255};
    glUniform2f(glGetUniformLocation(program,"surface_size"),128,128);
    render(0);
    assert(grayNear(output[4*128+50],0,123)); // No top tab outline.
    assert(grayNear(output[43*128+50],0,123)); // No bottom tab outline.
    assert(grayNear(output[24*128+10],0,123)); // No left tab outline.
    assert(grayNear(output[24*128+100],25,123)); // One right-hand divider.
    assert(grayNear(output[8*128+100],0,123)); // Divider stays short.
    assert(output[20*128+40]==input[20*128+40]); // Tab label unchanged.
    glUniform1f(glGetUniformLocation(program,"is_active"),0.0f);
    render(0);
    assert(grayNear(output[24*128+100],22,110)); // Inactive tab divider remains subtle.
    assert(output[20*128+40]==input[20*128+40]); // Inactive tab label unchanged.
    glUniform1f(glGetUniformLocation(program,"is_active"),1.0f);
    glUniform1f(glGetUniformLocation(program,"media_fullscreen"),1.0f);
    input.assign(128*128,Pixel{48,48,48,255});
    render(0);assert(grayNear(output[10*128+64],7,128)); // Page top, not tab strip.
    glUniform1f(glGetUniformLocation(program,"is_active"),0.0f);
    render(0);assert(grayNear(output[10*128+64],7,128)); // Ghostty fullscreen ignores focus.
    render(1);assert(output[20*128+64]==input[20*128+64]); // Fullscreen media unmodified.
    glUniform1f(glGetUniformLocation(program,"media_fullscreen"),0.0f);
    glUniform1f(glGetUniformLocation(program,"is_active"),1.0f);
    glUniform2f(glGetUniformLocation(program,"surface_size"),0,0);
    input.assign(128*128,Pixel{15,15,15,255});
    for(int y=60;y<=100;y++)for(int x=10;x<=100;x++)input[y*128+x]={0,0,0,255};
    render(0);
    assert(grayNear(output[60*128+50],0,123)); // No player top divider.
    assert(grayNear(output[100*128+50],0,123)); // No player bottom divider.
    assert(grayNear(output[80*128+10],0,123)); // No player side divider.
    // Native chrome remains translucent with no extension geometry. Every
    // page pixel below its 96 logical-unit band is preserved, including dark
    // images on restricted browser pages. Text and protected media still win.
    glUniform2f(glGetUniformLocation(program,"surface_size"),128,128);
    glUniform1f(glGetUniformLocation(program,"chrome_only"),1.0f);
    input.assign(128*128,Pixel{32,32,32,255});
    input[20*128+40]={244,244,244,255};
    input[120*128+40]={0,0,0,255};
    input[110*128+40]={250,120,10,255};
    render(0);
    assert(grayNear(output[24*128+64],0,123));
    assert(grayNear(output[70*128+64],3,123));
    assert(output[20*128+40]==input[20*128+40]);
    for(int y=96;y<128;y++)for(int x=0;x<128;x++)assert(output[y*128+x]==input[y*128+x]);
    glUniform1f(glGetUniformLocation(program,"is_active"),0.0f);
    render(0);
    assert(grayNear(output[24*128+64],0,110));
    for(int y=96;y<128;y++)for(int x=0;x<128;x++)assert(output[y*128+x]==input[y*128+x]);
    render(1);assert(output[20*128+64]==input[20*128+64]);
    // Output scale only changes the buffer size, never the logical chrome
    // boundary. At half this logical height the cutoff is row 48.
    glUniform2f(glGetUniformLocation(program,"surface_size"),256,256);
    render(0);
    assert(grayNear(output[40*128+64],3,110));
    for(int y=48;y<128;y++)for(int x=0;x<128;x++)assert(output[y*128+x]==input[y*128+x]);
    glUniform1f(glGetUniformLocation(program,"media_fullscreen"),1.0f);
    render(0);assert(output==input); // Never shade unverified fullscreen content.
    glUniform1f(glGetUniformLocation(program,"media_fullscreen"),0.0f);
    glUniform2f(glGetUniformLocation(program,"surface_size"),128,80);
    render(0);assert(output==input); // No inferred chrome in short surfaces.
    // Palette and opacity are live uniforms, so theme changes never require
    // recompiling the shader or fading opaque foreground/media pixels.
    glUniform1f(glGetUniformLocation(program,"chrome_only"),0.0f);
    glUniform2f(glGetUniformLocation(program,"surface_size"),128,128);
    glUniform3f(glGetUniformLocation(program,"canvas_color"),0.1f,0.2f,0.3f);
    glUniform1f(glGetUniformLocation(program,"canvas_opacity"),0.8f);
    glUniform1f(glGetUniformLocation(program,"is_active"),1.0f);
    input.assign(128*128,Pixel{0,0,0,255});
    input[40*128+64]={244,244,244,255};
    input[60*128+64]={97,97,150,255};
    auto nearPixel=[&](const Pixel& actual,const Pixel& expected){
        for(int channel=0;channel<4;channel++)if(std::abs(int(actual[channel])-int(expected[channel]))>1)return false;
        return true;
    };
    render(0);assert(nearPixel(output[10*128+64],Pixel{20,39,59,197}));
    assert(output[40*128+64]==input[40*128+64]);
    assert(output[60*128+64]==input[60*128+64]);
    render(1);assert(output[20*128+64]==input[20*128+64]);
    glUniform1f(glGetUniformLocation(program,"is_active"),0.0f);
    render(0);assert(nearPixel(output[10*128+64],Pixel{18,35,53,176}));
    glUniform1f(glGetUniformLocation(program,"media_fullscreen"),1.0f);
    render(0);assert(nearPixel(output[10*128+64],Pixel{20,41,61,204}));
    // Dark Reader and local New Tab supply the exact configured canvas color.
    // A saturated midtone Omarchy background must receive full canvas alpha,
    // without the legacy neutral cutoff or an additional gray fill lift.
    glUniform3f(glGetUniformLocation(program,"canvas_color"),99.0f/255.0f,71.0f/255.0f,143.0f/255.0f);
    glUniform1f(glGetUniformLocation(program,"media_fullscreen"),0.0f);
    glUniform1f(glGetUniformLocation(program,"is_active"),1.0f);
    input.assign(128*128,Pixel{99,71,143,255});
    input[70*128+60]={100,71,143,255}; // One quantized channel step still matches.
    input[70*128+80]={102,71,143,255}; // Distinct artwork/UI color is not the canvas.
    input[40*128+64]={244,244,244,255};
    render(0);
    assert(nearPixel(output[70*128+64],Pixel{76,55,110,197}));
    assert(nearPixel(output[70*128+60],Pixel{76,55,110,197}));
    assert(output[70*128+80]==input[70*128+80]);
    assert(output[40*128+64]==input[40*128+64]);
    render(1);assert(output[20*128+64]==input[20*128+64]); // Exact theme-colored media is protected.
    glUniform1f(glGetUniformLocation(program,"is_active"),0.0f);
    render(0);assert(nearPixel(output[70*128+64],Pixel{68,49,99,176}));
    glUniform1f(glGetUniformLocation(program,"media_fullscreen"),1.0f);
    render(0);assert(nearPixel(output[70*128+64],Pixel{79,57,114,204}));
    glUniform3f(glGetUniformLocation(program,"canvas_color"),1.0f,1.0f,1.0f);
    input.assign(128*128,Pixel{32,32,32,255});
    render(0);assert(grayNear(output[10*128+64],204,204)); // Valid premultiplied white.
    glUniform1f(glGetUniformLocation(program,"canvas_opacity"),0.0f);
    render(0);assert(grayNear(output[10*128+64],0,0));
    render(1);assert(output[20*128+64]==input[20*128+64]);
    // Native browser popups have their own texture; its top is a menu body,
    // never a tab strip. Actual sampled native dark colors get canvas alpha,
    // while menu text, disabled text, accents, and minimal dividers stay clear.
    glUniform3f(glGetUniformLocation(program,"canvas_color"),0,0,0);
    glUniform1f(glGetUniformLocation(program,"canvas_opacity"),0.5f);
    glUniform1f(glGetUniformLocation(program,"native_popup"),1.0f);
    glUniform1f(glGetUniformLocation(program,"media_fullscreen"),0.0f);
    glUniform1f(glGetUniformLocation(program,"is_active"),1.0f);
    input.assign(128*128,Pixel{23,29,30,255});
    input[20*128+40]={244,244,244,255};
    input[30*128+40]={116,213,228,255};
    input[40*128+40]={97,97,97,255};
    line(60,{97,97,97,255});
    render(0);
    assert(grayNear(output[20*128+64],3,123));
    assert(grayNear(output[100*128+64],3,123)); // Full popup, not only 96 logical units.
    assert(output[20*128+40]==input[20*128+40]);
    assert(output[30*128+40]==input[30*128+40]);
    assert(output[40*128+40]==input[40*128+40]);
    assert(output[60*128+64]==input[60*128+64]); // Popup dividers keep their authored style.
    glUniform1f(glGetUniformLocation(program,"is_active"),0.0f);
    render(0);assert(grayNear(output[20*128+64],3,110));
    glUniform1f(glGetUniformLocation(program,"media_fullscreen"),1.0f);
    render(0);assert(grayNear(output[20*128+64],3,128));
    // RGBX padding is never alpha. Match native rendering even when the
    // client writes different unused bytes during page/toolbar repaints.
    // Compare whole rendered frames, including protected media and divider
    // neighbor samples, against the identical RGB source with alpha=255.
    glUniform1f(glGetUniformLocation(program,"native_popup"),0.0f);
    glUniform1f(glGetUniformLocation(program,"media_fullscreen"),0.0f);
    glUniform1f(glGetUniformLocation(program,"is_active"),1.0f);
    input.assign(128*128,Pixel{32,32,32,255});
    line(95,{97,97,97,255});
    input[40*128+64]={244,244,244,255};
    input[60*128+64]={97,97,150,255};
    input[20*128+64]={250,120,10,255};
    render(0);const auto opaqueSource=output;
    render(1);const auto protectedOpaqueSource=output;
    glUniform1f(glGetUniformLocation(program,"source_rgbx"),1.0f);
    for(int padding:{0,27,128,255}) {
        for(size_t index=0;index<input.size();++index)
            input[index][3]=index%3==0?0:index%3==1?padding:255;
        render(0);assert(output==opaqueSource);
        render(1);assert(output==protectedOpaqueSource);
    }
    // RGBA has genuine premultiplied alpha. Partial/transparent foreground
    // and protected media retain their bytes, while only canvas alpha changes.
    glUniform1f(glGetUniformLocation(program,"source_rgbx"),0.0f);
    input.assign(128*128,Pixel{0,0,0,128});
    input[40*128+64]={120,120,120,128};
    input[60*128+64]={32,5,64,80};
    input[80*128+64]={0,0,0,0};
    input[20*128+64]={10,10,10,64};
    render(0);
    assert(grayNear(output[70*128+64],0,62));
    assert(output[40*128+64]==input[40*128+64]);
    assert(output[60*128+64]==input[60*128+64]);
    assert(output[80*128+64]==input[80*128+64]);
    render(1);assert(output[20*128+64]==input[20*128+64]);
    eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);
    eglDestroyContext(display,context);eglDestroySurface(display,surface);eglTerminate(display);
    std::cout<<"Separator97->26; text/color/fills/media unchanged.\n";
}
'''


class SeparatorShaderTests(unittest.TestCase):
    def test_native_separator_matches_existing_outline_brightness(self):
        with tempfile.TemporaryDirectory(prefix="brave-separator-gles-") as directory:
            executable = str(Path(directory) / "test")
            subprocess.run(["g++", "-std=c++23", "-x", "c++", "-", "-o", executable,
                            "-lEGL", "-lGLESv2"], input=HARNESS, text=True,
                           check=True, capture_output=True)
            environment = {**os.environ, "LIBGL_ALWAYS_SOFTWARE": "1"}
            result = subprocess.run([executable, str(Path(__file__).parent / "media-backgrounds.frag")],
                                    env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
