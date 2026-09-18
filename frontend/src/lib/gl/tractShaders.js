// ===== mrview-parity tractography renderer: shader sources + tunables =====
// This module supersedes the deleted depth-ghost occlusion shaders. That
// previous approach tried to approximate mrview's occlusion behaviour with a
// captured depth texture and an exponential falloff; measured result was 0.00%
// of tile pixels changing at full tissue opacity — i.e. it silently did
// nothing. This renderer
// instead uses the fixed-function depth unit (depthFunc(GREATER) against the
// volume's real first-hit depth) so occlusion cannot silently no-op, plus
// mrview's own two-pass (additive + over) transparency model.
//
// Lines geometry uses TRACT_VERT_LINES + TRACT_FRAG; Pseudotubes and Points
// use TRACT_VERT_INSTANCED + TRACT_FRAG.

// ---- Tunables ----
export const OCC_MIN            = 0.35;   // occluded fragment keeps 35% alpha at full tissue opacity
export const FAR_DIM             = 0.45;   // far side of the scene renders at 45% of the near side
export const SOFT_EDGE           = 0.25;   // radians of sin(height) used for the antialiased tube edge
// mrview: line_opacity = slider^2 / 1e6. Carried verbatim from the deleted
// depth-ghost occlusion module — squaring re-spreads the opacity slider's
// perceptual response across its travel.
export const TRACT_OPACITY_GAMMA = 2.0;
export const LIGHT_AMBIENT       = 0.4;
export const LIGHT_DIFFUSE       = 0.8;    // mrview default
export const LIGHT_SPECULAR      = 0.4;
export const LIGHT_SHINE         = 5.0;    // mrview default
export const LIGHT_DIR           = [0.0, 0.0, -1.0];  // unit, view space (headlight)
export const BASE_THICKNESS_MM   = 0.35;   // thickness at UI slider 50 / mrview slider 0
export const MIN_THICKNESS_PX    = 1.0;    // a tube never gets thinner than one pixel
export const POINT_BUDGET_TUBES  = 4e6;
export const POINT_BUDGET_LINES  = 1.2e7;

// ---- TRACT_VERT_INSTANCED (Pseudotubes + Points) ----
export const TRACT_VERT_INSTANCED = `#version 300 es
// permutations: TUBE | POINTS_MODE
layout(location=0) in vec3  prevPos;
layout(location=1) in vec3  aPos;
layout(location=2) in vec3  bPos;
layout(location=3) in vec3  nextPos;
layout(location=4) in vec4  aClr;
layout(location=5) in vec4  bClr;
layout(location=6) in float segValid;

uniform mat4  mvpMtx;        // mm -> clip
uniform mat4  mvMtx;         // mm -> view (niivue's modelMatrix)
uniform mat4  mm2frac;       // mm -> volume fractional coords
uniform vec4  clipPlane;     // xyz = normal (frac space), w = offset; w > 1 => no clip
uniform float clipEnabled;   // per-tract opt-out
uniform vec2  halfFovMM;     // ortho half-extents of the tile, in mm
uniform vec2  viewportPx;
uniform float thicknessMM;
uniform float minThicknessPx;
uniform vec3  viewZmm;       // unit mm-space direction of +view_z (toward camera)
uniform float slabCenter;    // dot(crosshairMM, viewZmm)
uniform vec3  pivotMM;
uniform float sceneRadiusMM;

out vec4  v_clr;
out float v_height;          // 0..PI across the tube width
out vec3  v_tangentView;
out float v_slab;            // signed mm distance from the slab centre
out float v_clip;            // signed clip-plane distance, frac units
out float v_depth01;         // 0 = nearest, 1 = farthest
out vec2  v_quad;            // POINTS_MODE only

const float PI = 3.14159265;

void main() {
  int   corner = gl_VertexID;                    // TRIANGLE_STRIP corner 0..3
  float along  = (corner < 2) ? 0.0 : 1.0;
  float side   = ((corner & 1) == 0) ? -1.0 : 1.0;

  vec3 P = mix(aPos, bPos, along);
  vec4 C = mix(aClr, bClr, along);

  // mrview: v_tangent = next_vertex - prev_vertex, evaluated at THIS endpoint.
  // Endpoint duplication in the compact buffer makes this degrade correctly.
  vec3 T = (along < 0.5) ? (bPos - prevPos) : (nextPos - aPos);
  if (dot(T, T) < 1e-12) T = bPos - aPos;

  vec4 clipA = mvpMtx * vec4(aPos, 1.0);
  vec4 clipB = mvpMtx * vec4(bPos, 1.0);
  vec4 clipP = mix(clipA, clipB, along);

  // Screen-space perpendicular measured in isotropic mm so the tube reads as a
  // circular cross-section (mrview divides by scale_x/scale_y for this reason).
  vec2 ndcA = clipA.xy / max(clipA.w, 1e-6);
  vec2 ndcB = clipB.xy / max(clipB.w, 1e-6);
  vec2 dScr = (ndcB - ndcA) * halfFovMM;
  dScr = (dot(dScr, dScr) < 1e-12) ? vec2(1.0, 0.0) : normalize(dScr);
  vec2 perpMM = vec2(dScr.y, -dScr.x);

  vec2  mmPerPx = 2.0 * halfFovMM / viewportPx;
  float halfW   = max(0.5 * thicknessMM,
                      0.5 * minThicknessPx * max(mmPerPx.x, mmPerPx.y));

#ifdef POINTS_MODE
  v_quad = vec2(side, (along < 0.5) ? -1.0 : 1.0);
  vec2 offNdc = v_quad * halfW / halfFovMM;
  clipP = clipA; P = aPos; C = aClr;
  gl_Position = vec4(clipP.xy + offNdc * clipP.w, clipP.zw);
  v_height = 0.0;
#else
  v_quad = vec2(0.0);
  vec2 offNdc = (perpMM * halfW * side) / halfFovMM;
  gl_Position = vec4(clipP.xy + offNdc * clipP.w, clipP.zw);
  v_height = (side < 0.0) ? 0.0 : PI;            // mrview's g_height
#endif

  v_clr         = C;
  v_tangentView = mat3(mvMtx) * normalize(T);
  v_slab        = dot(P, viewZmm) - slabCenter;
  v_clip        = (clipEnabled > 0.5 && clipPlane.w <= 1.0)
                ? dot(clipPlane.xyz, (mm2frac * vec4(P, 1.0)).xyz - 0.5) + clipPlane.w
                : 1.0;   // positive = KEEP, so no-clip must be +1
  v_depth01     = clamp(0.5 - dot(P - pivotMM, viewZmm) / (2.0 * sceneRadiusMM), 0.0, 1.0);

  if (segValid < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // degenerate
}
`;

// ---- TRACT_VERT_LINES (binds niivue's vaoFiber unchanged) ----
// vaoFiber layout: attrib 0 = vec3 @0, attrib 1 = vec4 UNSIGNED_BYTE @12,
// stride 16. Driven by drawElements(LINE_STRIP).
export const TRACT_VERT_LINES = `#version 300 es
layout(location=0) in vec3 pos;
layout(location=1) in vec4 clr;
uniform mat4 mvpMtx, mvMtx, mm2frac;
uniform vec4 clipPlane;  uniform float clipEnabled;
uniform vec3 viewZmm, pivotMM;  uniform float slabCenter, sceneRadiusMM;
out vec4 v_clr; out float v_height; out vec3 v_tangentView;
out float v_slab, v_clip, v_depth01; out vec2 v_quad;
void main() {
  gl_Position   = mvpMtx * vec4(pos, 1.0);
  v_clr         = clr;
  v_height      = 1.5707963;             // sin = 1 -> soft-edge term is a no-op
  v_tangentView = vec3(0.0, 0.0, 1.0);   // unused (LIGHTING never defined here)
  v_quad        = vec2(0.0);
  v_slab        = dot(pos, viewZmm) - slabCenter;
  v_clip        = (clipEnabled > 0.5 && clipPlane.w <= 1.0)
                ? dot(clipPlane.xyz, (mm2frac * vec4(pos, 1.0)).xyz - 0.5) + clipPlane.w
                : 1.0;   // positive = KEEP, so no-clip must be +1
  v_depth01     = clamp(0.5 - dot(pos - pivotMM, viewZmm) / (2.0 * sceneRadiusMM), 0.0, 1.0);
}
`;

// The Lines VS declares halfFovMM, viewportPx, thicknessMM, minThicknessPx NOT
// at all — they are unused there and GL will report their locations as null.
// setFrameUniforms must null-guard every uniform* call (see the u1f/etc.
// helpers in tractPrograms.js), or WebGL will spam warnings.

// ---- TRACT_FRAG (shared) ----
export const TRACT_FRAG = `#version 300 es
// permutations: TUBE | POINTS_MODE | LIGHTING
precision highp float;
in vec4  v_clr;
in float v_height;
in vec3  v_tangentView;
in float v_slab;
in float v_clip;
in float v_depth01;
in vec2  v_quad;
out vec4 fragColor;

uniform float slabHalfMM;      // <= 0 => crop-to-slab disabled
uniform float softEdge;        // 0 disables the antialiased tube edge
uniform float passScale;       // mrview's blend constant: min(lineOpacity/0.5, 1.0)
uniform float occludedScale;   // 1.0 unoccluded pass, OCC otherwise
uniform float depthCueFloor;   // 1.0 unoccluded pass, FAR_DIM otherwise
uniform float clampToOne;      // 1.0 in the "over" pass, 0.0 in the additive pass
uniform vec3  lightDir;        // unit, view space
uniform float ambient, diffuse, specular, shine;

void main() {
  if (slabHalfMM > 0.0 && abs(v_slab) > slabHalfMM) discard;   // crop-to-slab
  // niivue's raycast does NOT half-space-discard; its
  // clipSampleRange() trims the ray's sample range, and BOTH branches
  // (frontface -> sampleStart = plane, else sampleEnd = plane) keep the region
  // where dot(n, p-0.5) + a >= 0. The original "v_clip > 0.0" discarded exactly
  // the half niivue KEEPS, so the tract's cut face survived while the part that
  // should have remained was removed. Positive = keep, negative = clipped.
  if (v_clip < 0.0) discard;                                    // 3D clip plane

  vec3  rgb = v_clr.rgb;
  float a   = 1.0;
  vec3  N   = vec3(0.0, 0.0, 1.0);

#ifdef POINTS_MODE
  float r = length(v_quad);
  if (r > 1.0) discard;                                         // mrview's circle discard
  a *= smoothstep(1.0, 1.0 - max(softEdge, 0.05), r);
  N  = normalize(vec3(v_quad, sqrt(max(0.0, 1.0 - r * r))));
#endif

#ifdef TUBE
  // mrview's faked cylinder normal. in_plane_x is the screen-plane perpendicular
  // to the projected tangent; in_plane_y is the remaining basis vector, whose
  // toward-viewer component is sqrt(1 - t.z^2).
  float s = sin(v_height), c = cos(v_height);
  vec3  t = normalize(v_tangentView);
  vec2  d = normalize(t.xy + vec2(1e-6, 0.0));
  vec3  in_plane_x = vec3(d.y, -d.x, 0.0);
  vec3  in_plane_y = vec3(-t.z * d, sqrt(clamp(1.0 - t.z * t.z, 0.0, 1.0)));
  N = normalize(c * in_plane_x + s * in_plane_y);
  if (softEdge > 0.0) a *= smoothstep(0.0, softEdge, s);
#endif

#ifdef LIGHTING
  rgb *= ambient + diffuse * clamp(dot(lightDir, N), 0.0, 1.0);
  vec3 R = reflect(lightDir, N);
  rgb += specular * pow(clamp(-R.z, 0.0, 1.0), shine);
#endif

  a *= occludedScale * mix(1.0, depthCueFloor, v_depth01) * passScale;
  if (clampToOne > 0.5) a = min(a, 1.0);
  if (a <= 0.002) discard;
  fragColor = vec4(rgb * a, a);          // premultiplied
}
`;

// Why premultiplied output instead of glBlendColor: mrview's
// BlendFunc(CONSTANT_ALPHA, ONE) scales the whole source by a per-draw
// constant, leaving no room for per-fragment modulation (occlusion, soft
// edge, point circle). Emitting vec4(rgb*a, a) with blendFunc(ONE, ONE) /
// blendFunc(ONE, ONE_MINUS_SRC_ALPHA) is algebraically identical when
// a == passScale, and generalises when it is not. passScale is clamped to
// 1.0 to match GL's own clamping of glBlendColor on a fixed-point target, so
// line_opacity >= 0.5 behaves exactly as mrview does.
