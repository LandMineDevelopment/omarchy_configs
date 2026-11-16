#version 320 es
precision highp float;
in vec2 v_texcoord;
uniform sampler2D tex;
uniform vec2 surface_size;
uniform float is_active;
uniform float media_fullscreen;
uniform float chrome_only;
uniform float native_popup;
uniform float source_rgbx;
uniform vec3 canvas_color;
uniform float canvas_opacity;
uniform int media_count;
uniform vec4 media_rects[128];
out vec4 fragColor;
const float outlineBrightness = 0.10;
vec4 sourcePixel(vec2 coordinates) {
    vec4 sampleColor = texture(tex, coordinates);
    // Hyprland's RGBX path discards the unused channel rather than treating it
    // as alpha. Its value may differ across toolbar/page pixels or repaint.
    // Real RGBA content, including transparent image edges, keeps its alpha.
    if (source_rgbx > 0.5) sampleColor.a = 1.0;
    return sampleColor;
}
bool subtleHorizontalSeparator(vec4 center, vec2 pixel) {
    vec3 base = center.rgb / max(center.a, 0.000001);
    float high = max(max(base.r, base.g), base.b);
    float low = min(min(base.r, base.g), base.b);
    // Native toolbar dividers can be above the dark-canvas cutoff. Require a
    // long, flat neutral stroke bounded by dark UI, rather than dimming glyphs.
    if (high <= 0.32 || high >= 0.65 || high - low > 0.02) return false;
    for (int i = 0; i < 4; ++i) {
        float offset = i == 0 ? -24.0 : i == 1 ? -8.0 : i == 2 ? 8.0 : 24.0;
        vec4 sampleColor = sourcePixel(v_texcoord + vec2(offset * pixel.x, 0.0));
        vec3 sampleRgb = sampleColor.rgb / max(sampleColor.a, 0.000001);
        if (max(max(abs(sampleRgb.r - base.r), abs(sampleRgb.g - base.g)), abs(sampleRgb.b - base.b)) > 0.008) return false;
    }
    for (int i = 0; i < 2; ++i) {
        vec4 sampleColor = sourcePixel(v_texcoord + vec2(0.0, (i == 0 ? -3.0 : 3.0) * pixel.y));
        vec3 sampleRgb = sampleColor.rgb / max(sampleColor.a, 0.000001);
        float sampleHigh = max(max(sampleRgb.r, sampleRgb.g), sampleRgb.b);
        float sampleLow = min(min(sampleRgb.r, sampleRgb.g), sampleRgb.b);
        if (sampleHigh > 0.22 || sampleHigh - sampleLow > 0.04) return false;
    }
    return true;
}
float darkNeutralEdge(vec4 center, vec4 neighbor) {
    vec3 rgb = neighbor.rgb / max(neighbor.a, 0.000001);
    float high = max(max(rgb.r, rgb.g), rgb.b);
    float low = min(min(rgb.r, rgb.g), rgb.b);
    // Only UI-to-UI boundaries count. Text and colorful artwork must not
    // acquire a generated halo.
    float ui = (1.0 - smoothstep(0.22, 0.32, high)) *
               (1.0 - smoothstep(0.04, 0.14, high - low));
    vec3 base = center.rgb / max(center.a, 0.000001);
    // A near-black fill meeting another canvas is spacing, not a control
    // outline. This keeps player margins and page sections free of boxes.
    if (max(high, max(max(base.r, base.g), base.b)) <= 0.10) return 0.0;
    float difference = max(max(abs(base.r - rgb.r), abs(base.g - rgb.g)), abs(base.b - rgb.b));
    return smoothstep(0.012, 0.04, difference) * ui;
}
void main() {
    vec4 src = sourcePixel(v_texcoord);
    // This band is native browser chrome, measured in desktop logical units.
    // With no trusted page mask, content below it is copied byte-for-byte.
    // A fullscreen surface has no chrome and can never use this exception.
    float logicalY = v_texcoord.y * surface_size.y;
    if (chrome_only > 0.5 && (media_fullscreen > 0.5 || surface_size.y <= 96.0 || logicalY >= 96.0)) {
        fragColor = src;
        return;
    }
    for (int i = 0; i < media_count; ++i) {
        vec4 r = media_rects[i];
        if (all(greaterThanEqual(v_texcoord, r.xy)) && all(lessThanEqual(v_texcoord, r.xy + r.zw))) {
            fragColor = src;
            return;
        }
    }
    vec3 rgb = src.rgb / max(src.a, 0.000001);
    float highest = max(max(rgb.r, rgb.g), rgb.b);
    float lowest = min(min(rgb.r, rgb.g), rgb.b);
    float dark = 1.0 - smoothstep(0.22, 0.32, highest);
    float neutral = 1.0 - smoothstep(0.04, 0.14, highest - lowest);
    // Semantic page styling supplies this exact Omarchy canvas color. It can
    // be colored or above the generic dark cutoff; allow one 8-bit channel
    // step for texture quantization without fading nearby foreground colors.
    vec3 canvasDifference = abs(rgb - canvas_color);
    bool configuredCanvas = max(max(canvasDifference.r, canvasDifference.g), canvasDifference.b) <= 1.0 / 255.0 + 0.00001;
    float background = configuredCanvas ? 1.0 : dark * neutral;
    vec2 pixel = 1.0 / vec2(textureSize(tex, 0));
    // This adjustment belongs to Brave's toolbar/page separator alone. A long
    // flat page-control outline can have the same pixels; its geometry is not
    // evidence of native chrome ownership. Keep the tolerance inside the known
    // 96-unit chrome band and never apply it to fullscreen content or popups.
    bool toolbarSeparator = native_popup < 0.5 && media_fullscreen < 0.5 &&
                            surface_size.y > 96.0 && logicalY >= 94.0 && logicalY < 96.0;
    if (toolbarSeparator && !configuredCanvas && subtleHorizontalSeparator(src, pixel)) {
        fragColor = vec4(vec3(outlineBrightness * src.a), src.a);
        return;
    }
    if (background == 0.0) { fragColor = src; return; }
    float edge = max(max(darkNeutralEdge(src, sourcePixel(v_texcoord + vec2(pixel.x, 0.0))),
                         darkNeutralEdge(src, sourcePixel(v_texcoord - vec2(pixel.x, 0.0)))),
                     max(darkNeutralEdge(src, sourcePixel(v_texcoord + vec2(0.0, pixel.y))),
                         darkNeutralEdge(src, sourcePixel(v_texcoord - vec2(0.0, pixel.y)))));
    // Brave's native tab strip uses desktop logical units, independent of page
    // zoom and output scale. Keep one short right-hand divider instead of
    // outlining the rounded tab background.
    // Fullscreen has no browser tab strip: the top of the viewport is page/video.
    bool tabStrip = native_popup < 0.5 && media_fullscreen < 0.5 && surface_size.y > 48.0 && logicalY < 48.0;
    if (tabStrip) {
        vec4 right = sourcePixel(v_texcoord + vec2(pixel.x, 0.0));
        vec3 rightRgb = right.rgb / max(right.a, 0.000001);
        float rightHigh = max(max(rightRgb.r, rightRgb.g), rightRgb.b);
        edge = logicalY >= 12.0 && logicalY <= 36.0 && highest > rightHigh
             ? darkNeutralEdge(src, right) : 0.0;
    }
    // Keep the black translucent canvas, but retain slight fill differences
    // and emphasize existing UI outlines at native texture-pixel resolution.
    float fill = tabStrip || configuredCanvas ? 0.0 : max(highest - 0.06, 0.0) * 0.20;
    // Mirror Ghostty: configured app background opacity multiplied by the
    // installed terminal rule and desktop opacity for each focus state. Keep this change
    // inside the canvas so protected media and bright text retain their pixels.
    float backgroundOpacity = mix(canvas_opacity * 0.96 * 0.90, canvas_opacity * 0.985 * 0.98,
                                  clamp(is_active, 0.0, 1.0));
    // Ghostty uses its app background opacity with desktop fullscreen opacity 1.
    backgroundOpacity = mix(backgroundOpacity, canvas_opacity, clamp(media_fullscreen, 0.0, 1.0));
    vec3 canvasRgb = min(vec3(1.0), canvas_color + vec3((fill + outlineBrightness * edge) / 0.5));
    vec4 canvas = vec4(canvasRgb * src.a * backgroundOpacity,
                       src.a * backgroundOpacity);
    fragColor = mix(src, canvas, background);
}
