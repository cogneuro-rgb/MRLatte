// ===== Vendored niivue 3D volume raycast shader (base render variant) =====
//
// The vertex shader and the assembled fragment shader below are copied,
// nearly verbatim, from this app's own copy of niivue's shader source:
//   frontend/node_modules/@niivue/niivue/src/shader-srcs.ts
//   (vertRenderShader L1-10; kRenderFunc L21, kRenderInit L102, kRenderTail
//   L184, fragRenderShader assembly L450-501 — @niivue/niivue 0.68.2)
//
// This is a deliberate, zero-node_modules-edits vendoring — see
// frontend/src/lib/gl/volumeRenderShader.js for why (nv.renderShader is a
// plain public property niivue itself reassigns; we take ownership of it the
// same way tractShaders.js/tractPrograms.js already own the tract pipeline).
//
// -----------------------------------------------------------------------
// @niivue/niivue is BSD-2-Clause licensed:
//
// Copyright (c) the NiiVue contributors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
// 1. Redistributions of source code must retain the above copyright
//    notice, this list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright
//    notice, this list of conditions and the following disclaimer in the
//    documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
// IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
// THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
// PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
// CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
// EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
// PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
// PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
// LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
// NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
// -----------------------------------------------------------------------

// ---- Tunables ----------------------------------------------------------
// Attenuation strength for overlay samples that sit behind the background
// surface (bug 2: "overlay visible through the head when rotated"). 0.0
// reproduces stock niivue behaviour exactly (see installer's clobber-safe
// default wiring); this is the value volumeClip.js's drawScene wrapper
// actually installs per-frame.
// CORRECTED 2026-07-31 — do not raise this above 0.0 without re-reading the
// note below first.
//
// Stock niivue already has a "ghost through opaque tissue" mechanism: the
// overlay accumulator colAcc is entirely separate from the background's, and
// the tail does `fColor.a = max(fColor.a, colAcc.a)` — the overlay's own
// alpha ALWAYS shows through, at full strength, regardless of background
// opacity. That is precisely the "slightly visible even at 100% base volume
// opacity" behaviour the user wants kept — it is not a bug to route around.
//
// The occlusion patch below multiplies colorSample.a DOWN *before* it
// accumulates into colAcc, inside the per-sample loop. At occlusion values
// that actually did anything (>= ~1.0), a sample fully behind tissue
// contributes ZERO alpha — and if the whole overlay ray sits behind tissue,
// colAcc.a collapses to ~0 and the shader takes the `if (colAcc.a <= 0.0)
// return;` early-out a few lines below, skipping the overlay ENTIRELY rather
// than dimming it. That is the opposite of "slightly visible" and must not
// ship as the default. 0.0 makes the `overlayOcclusion > 0.0` guard a
// complete no-op, so this reproduces stock (liked) behaviour exactly — the
// GLSL patch is inert, not removed, so a real fix can still enable it later.
//
// If real occlusion is revisited, it must dim the FINAL colAcc.a/fColor
// ONCE, after the loop (alongside overMix), the same way the tract renderer
// applies occludedScale once per fragment rather than per ray sample —
// never inside this loop again.
export const OVERLAY_OCCLUSION = 0.0;

// New uniform names, exported so volumeRenderShader.js/volumeClip.js never
// hand-type a string that could drift from the GLSL declarations below.
export const UNIFORM_OVERLAY_CLIP_EXEMPT = "overlayClipExempt";
export const UNIFORM_OVERLAY_OCCLUSION = "overlayOcclusion";

// ---- vertRenderShader (verbatim, shader-srcs.ts L1-10) ------------------
export const RENDER_VERT = `#version 300 es
#line 4
layout(location=0) in vec3 pos;
layout(location=1) in vec3 texCoords;
uniform mat4 mvpMtx;
out vec3 vColor;
void main(void) {
	gl_Position = mvpMtx * vec4(pos, 1.0);
	vColor = texCoords;
}`;

// ---- fragRenderShader header (shader-srcs.ts L450-477) -------------------
// Two new uniforms added, EACH ON ITS OWN LINE. niivue's own uniform
// regex (Shader constructor in src/shader.ts: /uniform[^;]+[ ](\w+);/g)
// captures only the LAST identifier of a declaration line — e.g.
// `uniform highp sampler3D volume, overlay;` registers only `overlay` — so
// a new sampler sharing a line with an existing one would silently never
// get a uniform location. See volumeRenderShader.js for the (matching)
// manual uniforms.clipPlanes fixup niivue's own initRenderShader also needs
// for the identical reason (clipPlanes[MAX_CLIP_PLANES] never matches this
// regex at all, array or not).
const RENDER_FRAG_HEADER = `#version 300 es
#line 215
#define MAX_CLIP_PLANES 6
precision highp int;
precision highp float;
uniform vec3 rayDir;
uniform vec3 texVox;
uniform int backgroundMasksOverlays;
uniform vec3 volScale;
uniform vec4 clipPlane;
uniform vec4 clipPlanes[MAX_CLIP_PLANES];
uniform bool isClipCutaway;
uniform highp sampler3D volume, overlay;
uniform highp sampler3D paqd;
uniform vec4 paqdUniforms;
uniform float overlays;
uniform float backOpacity;
uniform mat4 mvpMtx;
uniform mat4 matRAS;
uniform vec4 clipPlaneColor;
uniform float renderOverlayBlend;
uniform highp sampler3D drawing;
uniform highp sampler2D colormap;
uniform vec2 renderDrawAmbientOcclusionXY;
uniform highp sampler3D overlayClipExempt;
uniform float overlayOcclusion;
in vec3 vColor;
out vec4 fColor;
`;

// ---- kRenderFunc (verbatim, shader-srcs.ts L21-100) ----------------------
// GetBackPosition / distance2Plane / clipSampleRange / skipSample /
// frac2ndc, plus kDrawFunc's drawColor() appended exactly as niivue does.
const K_RENDER_FUNC = `vec3 GetBackPosition(vec3 startPositionTex) {
	vec3 startPosition = startPositionTex * volScale;
	vec3 invR = 1.0 / rayDir;
	vec3 tbot = invR * (vec3(0.0)-startPosition);
	vec3 ttop = invR * (volScale-startPosition);
	vec3 tmax = max(ttop, tbot);
	vec2 t = min(tmax.xx, tmax.yz);
	vec3 endPosition = startPosition + (rayDir * min(t.x, t.y));
	//convert world position back to texture position:
	endPosition = endPosition / volScale;
	return endPosition;
}

float distance2Plane(in vec4 samplePos, in vec4 clipPlane) {
	// treat clipPlane.a > 1 as "no clip" sentinel (keeps existing behavior)
	if (clipPlane.a > 1.0) {
			return 1000.0; // sentinel large distance
	}
	vec3 n = clipPlane.xyz;
	const float EPS = 1e-6;
	float nlen = length(n);
	if (nlen < EPS) {
			return 1000.0; // invalid plane normal
	}
	// signed plane value: dot(n, p-0.5) + a
	float signedDist = dot(n, samplePos.xyz - 0.5) + clipPlane.a;
	// perpendicular (Euclidean) distance is |signedDist| / |n|
	return abs(signedDist) / nlen;
}

// see if clip plane trims ray sampling range sampleStartEnd.x..y
void clipSampleRange(in vec3 dir, in vec4 rayStart, in vec4 clipPlane, inout vec2 sampleStartEnd, inout bool hasClip) {
	const float CSR_EPS = 1e-6;
	// quick exit: no clip plane
	if (clipPlane.a > 1.0)
			return;
	hasClip = true;
	// quick exit: empty range
	if ((sampleStartEnd.y - sampleStartEnd.x) <= CSR_EPS)
			return;
	// Which side does the ray start on? (plane eqn: dot(n, p-0.5) + a = 0)
	float sampleSide = dot(clipPlane.xyz, rayStart.xyz - 0.5) + clipPlane.a;
	bool startsFront = (sampleSide < 0.0);
	float dis = - 1.0;
	// plane normal dot ray direction
	float cdot = dot(dir, clipPlane.xyz);
	// avoid division by 0 for near-parallel plne
	if (abs(cdot) >= CSR_EPS)
		dis = (-clipPlane.a - dot(clipPlane.xyz, rayStart.xyz - 0.5)) / cdot;
	if (dis < 0.0 || dis > sampleStartEnd.y + CSR_EPS) {
			if (startsFront)
				sampleStartEnd = vec2(0.0, 0.0);
			return;
	}
	bool frontface = (cdot > 0.0);
	if (frontface)
		sampleStartEnd.x = max(sampleStartEnd.x, dis);
	else
		sampleStartEnd.y = min(sampleStartEnd.y, dis);
	// if nothing remains, mark empty
	if (sampleStartEnd.y - sampleStartEnd.x <= CSR_EPS)
		sampleStartEnd = vec2(0.0, 0.0);
}

bool skipSample (float pos, vec2 sampleRange) {
	return (pos < sampleRange.x || pos > sampleRange.y);
}

float frac2ndc(vec3 frac) {
//https://stackoverflow.com/questions/7777913/how-to-render-depth-linearly-in-modern-opengl-with-gl-fragcoord-z-in-fragment-sh
	vec4 pos = vec4(frac.xyz, 1.0); //fraction
	vec4 dim = vec4(vec3(textureSize(volume, 0)), 1.0);
	pos = pos * dim;
	vec4 shim = vec4(-0.5, -0.5, -0.5, 0.0);
	pos += shim;
	vec4 mm = transpose(matRAS) * pos;
	float z_ndc = (mvpMtx * vec4(mm.xyz, 1.0)).z;
	return (z_ndc + 1.0) / 2.0;
}
vec4 drawColor(float scalar, float drawOpacity) {
	float nlayer = float(textureSize(colormap, 0).y);
	float layer = (nlayer - 0.5) / nlayer;
	vec4 dcolor = texture(colormap, vec2((scalar * 255.0)/256.0 + 0.5/256.0, layer)).rgba;
	dcolor.a *= drawOpacity;
	return dcolor;
}`;

// ---- kRenderInit (verbatim, shader-srcs.ts L102-182) ---------------------
const K_RENDER_INIT = `void main() {
	if (fColor.x > 2.0) {
		fColor = vec4(1.0, 0.0, 0.0, 0.5);
		return;
	}
	fColor = vec4(0.0,0.0,0.0,0.0);
	vec4 clipPlaneColorX = clipPlaneColor;
	//if (clipPlaneColor.a < 0.0)
	//	clipPlaneColorX.a = - 1.0;
	bool isColorPlaneInVolume = false;
	if (clipPlaneColorX.a < 0.0) {
		isColorPlaneInVolume = true;
		clipPlaneColorX.a = 0.0;
	}
	//fColor = vec4(vColor.rgb, 1.0); return;
	vec3 start = vColor;
	gl_FragDepth = 1.0;
	vec3 backPosition = GetBackPosition(start);
	// fColor = vec4(backPosition, 1.0); return;
	vec3 dir = normalize(backPosition - start);
	//clipVolumeStart(start, backPosition);
	dir = normalize(dir);
	float len = length(backPosition - start);
	float lenVox = length((texVox * start) - (texVox * backPosition));
	if ((lenVox < 0.5) || (len > 3.0)) { //length limit for parallel rays
		return;
	}
	float sliceSize = len / lenVox; //e.g. if ray length is 1.0 and traverses 50 voxels, each voxel is 0.02 in unit cube
	float stepSize = sliceSize; //quality: larger step is faster traversal, but fewer samples
	float opacityCorrection = stepSize/sliceSize;
	vec4 deltaDir = vec4(dir.xyz * stepSize, stepSize);
	vec4 samplePos = vec4(start.xyz, 0.0); //ray position

	vec2 sampleRange = vec2(0.0, len);
	bool hasClip = false;
	for (int i = 0; i < MAX_CLIP_PLANES; i++)
		clipSampleRange(dir, samplePos, clipPlanes[i], sampleRange, hasClip);
	bool isClip = (sampleRange.x > 0.0) || ((sampleRange.y < len) && (sampleRange.y > 0.0));
	float stepSizeFast = sliceSize * 1.9;
	vec4 deltaDirFast = vec4(dir.xyz * stepSizeFast, stepSizeFast);
	if ((isClipCutaway) && (sampleRange.x <= 0.0) && (sampleRange.y >= len)) {
		//completely clipped, but ray does not intersect plane
		if (hasClip)
			samplePos.a = len + 1.0;
		else
			sampleRange = vec2(0.0, 0.0);
	}
	if ((!isClipCutaway) && (sampleRange.x >= sampleRange.y))
		samplePos.a = len + 1.0;
	while (samplePos.a <= len) {
		if (skipSample(samplePos.a, sampleRange) ^^ isClipCutaway) {
			samplePos += deltaDirFast;
			continue;
		}
		float val = texture(volume, samplePos.xyz).a;
		if (val > 0.01)
			break;
		samplePos += deltaDirFast; //advance ray position
	}
	float drawOpacityA = renderDrawAmbientOcclusionXY.y;
	if ((samplePos.a >= len) && (((overlays < 1.0) && (drawOpacityA <= 0.0) ) || (backgroundMasksOverlays > 0)))  {
		if (isClip)
			fColor += clipPlaneColorX;
		return;
	}
	fColor = vec4(1.0, 1.0, 1.0, 1.0);
	//gl_FragDepth = frac2ndc(samplePos.xyz); //crude due to fast pass resolution
	if (samplePos.a > deltaDirFast.a )
		samplePos -= deltaDirFast;
	//end: fast pass
	vec4 colAcc = vec4(0.0,0.0,0.0,0.0);
	vec4 firstHit = vec4(0.0,0.0,0.0,2.0 * len);
	const float earlyTermination = 0.95;
	float backNearest = len; //assume no hit
	float ran = fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453);
	// clip planes create steep gradients: reduce aliasing with more jitter
	if (isClip)
		samplePos += deltaDir * ran * 1.41; //jitter ray
	else
		samplePos += deltaDir * ran; //jitter ray
`;

// ---- fragRenderShader's own background-loop block (shader-srcs.ts L480-499) ----
const RENDER_BACKGROUND_LOOP = `while (samplePos.a <= len) {
		if (skipSample(samplePos.a, sampleRange) ^^ isClipCutaway) {
			samplePos += deltaDirFast;
			continue;
		}
		vec4 colorSample = texture(volume, samplePos.xyz);
		samplePos += deltaDir; //advance ray position
		if (colorSample.a >= 0.01) {
			if (firstHit.a > len)
				firstHit = samplePos;
			// backNearest = min(backNearest, samplePos.a);
			colorSample.a = 1.0-pow((1.0 - colorSample.a), opacityCorrection);
			colorSample.rgb *= colorSample.a;
			colAcc= (1.0 - colAcc.a) * colorSample + colAcc;
			if ( colAcc.a > earlyTermination )
				break;
		}
	}
	if (firstHit.a < len)
		backNearest = firstHit.a;
`;

// ---- kRenderTail (shader-srcs.ts L184-358), WITH THE TWO PATCHES --------
//
// Patch (a) — overlayClipExempt: single-pass per-group clip. In the clip
// cut-away (skipSample == true) the clip-ABIDING overlays are removed, but a
// clip-EXEMPT overlay (e.g. a lesion mask with clip turned off) must survive.
// overlayClipExempt is a merged texture of ONLY the exempt overlays' colour
// (maintained by volumeClip.js), so in the cut-away the ray samples that
// instead of the full union `overlay`. Sampling the union there was the item-3
// bug: at a voxel where an exempt lesion and a clipped activation map overlap,
// the union blends both, and the old "skip the whole sample" discarded the
// lesion too — punching a hole in the floating lesion. Inserted at the very
// top of the overlay while loop, before the union texture is sampled.
//
// Patch (b) — overlayOcclusion: attenuate an overlay sample once it's known
// to sit behind the background's own nearest opaque hit (samplePos.a >
// backNearest), scaled by how opaque the background is at this pixel
// (fColor.a). overlayOcclusion is a tunable gate — 0.0 reproduces stock
// behaviour exactly (see OVERLAY_OCCLUSION above / volumeClip.js). Inserted
// where colorSample.a is finalized for compositing, i.e. right after the
// loop's own `if (colorSample.a >= 0.01) {` guard.
const K_RENDER_TAIL = `
	if (firstHit.a < len) {
		gl_FragDepth = frac2ndc(firstHit.xyz);
		vec4 paqdSample = texture(paqd, samplePos.xyz);
		if (paqdSample.a > 0.0) {
			//colAcc.rgb = paqdSample.rgb;
			float a = max(abs(paqdUniforms[2]), abs(paqdUniforms[3]));
			colAcc.rgb = mix(colAcc.rgb, paqdSample.rgb, 0.5 * paqdSample.a * a);
		}
		if (isClip) {
			//shade voxels with clip color
			if (clipPlaneColor.a < 0.0) {
					float thresh = 4.0 * sliceSize;
					float firstHit1 = firstHit.a + deltaDir.a;
				if (isClipCutaway) {
					float min1 = abs(firstHit1 - sampleRange.y);
					float dx = samplePos.a - firstHit1;
					if (min1 < thresh)
						colAcc.rgb = mix(colAcc.rgb, clipPlaneColorX.rgb, abs(clipPlaneColor.a));
					else if (( colAcc.a > earlyTermination ) && (dx > thresh)) {
						min1 = abs(firstHit1 - sampleRange.x);
						if (min1 < (thresh * 0.5)) {
							colAcc.rgb = mix(colAcc.rgb , clipPlaneColorX.rgb, abs(clipPlaneColor.a)*0.5);
						}

					}
				} else {
					if (abs(firstHit1 - sampleRange.x) < thresh)
						colAcc.rgb = mix(colAcc.rgb, clipPlaneColorX.rgb, abs(clipPlaneColor.a));
				} // clipPlaneColor.a < 0.0
			}
			//ambient occlusion: make creases dark
			float min1 = 1000.0;
			float min2 = 1000.0;
			// find smallest and second-smallest distances
			vec4 firstHit1 = firstHit - deltaDir;
			for (int i = 0; i < MAX_CLIP_PLANES; i++) {
				float d = distance2Plane(firstHit1, clipPlanes[i]);
				if (d < min1) {
						min2 = min1;
						min1 = d;
				} else if (d < min2) {
						min2 = d;
				}
			}
			float thresh = 1.2 * sliceSize;
			if ((isClipCutaway) && (min2 < thresh) && (sampleRange.x > 0.0)) {
				if ((abs(sampleRange.x - firstHit.a) > ( 2.0 * thresh)) && ((abs(sampleRange.y - firstHit.a) > (2.0 * thresh))))
					min2 = thresh;
			}
			// if second is 0 -> factor 0 (black), if second >= sliceSize -> factor 1 (unchanged)
			const float aoFrac = 0.5;
			float factor = (1.0 - aoFrac) + aoFrac * clamp(min2 / thresh, 0.0, 1.0);
			// linear darkening: multiply color by factor (or use mix(vec3(0), colAcc.rgb, factor))
			colAcc.rgb *= factor;
		}
	}
	colAcc.a = (colAcc.a / earlyTermination) * backOpacity;
	fColor = colAcc;
	float renderDrawAmbientOcclusionX = renderDrawAmbientOcclusionXY.x;
	float drawOpacity = renderDrawAmbientOcclusionXY.y;
	if ((overlays < 1.0) && (drawOpacity <= 0.0))
		return;
	//overlay pass
	samplePos = vec4(start.xyz, 0.0); //ray position
	//start: OPTIONAL fast pass: rapid traversal until first hit
	stepSizeFast = sliceSize * 1.0;
	deltaDirFast = vec4(dir.xyz * stepSizeFast, stepSizeFast);
	while (samplePos.a <= len) {
		float val = texture(overlay, samplePos.xyz).a;
		if (drawOpacity > 0.0)
			val = max(val, texture(drawing, samplePos.xyz).r);
		if (val > 0.001)
			break;
		samplePos += deltaDirFast; //advance ray position
	}
	if (samplePos.a >= len) {
		if (isClip && (fColor.a == 0.0))
				fColor += clipPlaneColorX;
			return;
	}
	samplePos -= deltaDirFast;
	if (samplePos.a < 0.0)
		vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	//end: fast pass
	float overFarthest = len;
	colAcc = vec4(0.0, 0.0, 0.0, 0.0);

	samplePos += deltaDir * ran; //jitter ray
	vec4 overFirstHit = vec4(0.0,0.0,0.0,2.0 * len);
	if (backgroundMasksOverlays > 0)
		samplePos = firstHit;
	bool firstDraw = true;
	while (samplePos.a <= len) {
		// Item 3: inside the clip cut-away, render ONLY the exempt overlays'
		// colour; outside it, the full union. A cut-away sample with no exempt
		// colour and no scratch drawing is skipped fast (as before). Keeping the
		// drawOpacity>0 case out of the fast-skip preserves the scratch drawing
		// showing through the cut, unchanged.
		bool inCutaway = skipSample(samplePos.a, sampleRange);
		vec4 colorSample = inCutaway ? texture(overlayClipExempt, samplePos.xyz)
		                             : texture(overlay, samplePos.xyz);
		if (inCutaway && colorSample.a < 0.001 && drawOpacity <= 0.0) {
			samplePos += deltaDir;
			continue;
		}
		if ((colorSample.a < 0.01) && (drawOpacity > 0.0)) {
			float val = texture(drawing, samplePos.xyz).r;
			vec4 draw = drawColor(val, drawOpacity);
			if ((draw.a > 0.0) && (firstDraw)) {
				firstDraw = false;
				float sum = 0.0;
				const float mn = 1.0 / 256.0;
				const float sampleRadius = 1.1;
				float dx = sliceSize * sampleRadius;
				vec3 center = samplePos.xyz;
				//six neighbors that share a face
				sum += min(texture(drawing, center.xyz + cross(vec3(0.0,0.0,+dx), dir)).r, mn);
				sum += min(texture(drawing, center.xyz + cross(vec3(0.0,0.0,-dx), dir)).r, mn);
				sum += min(texture(drawing, center.xyz + cross(vec3(0.0,+dx,0.0), dir)).r, mn);
				sum += min(texture(drawing, center.xyz + cross(vec3(0.0,-dx,0.0), dir)).r, mn);
				sum += min(texture(drawing, center.xyz + cross(vec3(+dx,0.0,0.0), dir)).r, mn);
				sum += min(texture(drawing, center.xyz + cross(vec3(-dx,0.0,0.0), dir)).r, mn);
				//float proportion = (sum / mn) / 6.0;

				//12 neighbors that share an edge
				dx = sliceSize * sampleRadius * sqrt(2.0) * 0.5;
				sum += min(texture(drawing, center.xyz + cross(vec3(0.0,+dx,+dx), dir)).r, mn);
				sum += min(texture(drawing, center.xyz + cross(vec3(+dx,0.0,+dx), dir)).r, mn);
				sum += min(texture(drawing, center.xyz + cross(vec3(+dx,+dx,0.0), dir)).r, mn);
				sum += min(texture(drawing, center.xyz + cross(vec3(0.0,-dx,-dx), dir)).r, mn);
				sum += min(texture(drawing, center.xyz + cross(vec3(-dx,0.0,-dx), dir)).r, mn);
				sum += min(texture(drawing, center.xyz + cross(vec3(-dx,-dx,0.0), dir)).r, mn);

				sum += min(texture(drawing, center.xyz + cross(vec3(0.0,+dx,-dx), dir)).r, mn);
				sum += min(texture(drawing, center.xyz + cross(vec3(+dx,0.0,-dx), dir)).r, mn);
				sum += min(texture(drawing, center.xyz + cross(vec3(+dx,-dx,0.0), dir)).r, mn);

				sum += min(texture(drawing, center.xyz + cross(vec3(0.0,-dx,+dx), dir)).r, mn);
				sum += min(texture(drawing, center.xyz + cross(vec3(-dx,0.0,+dx), dir)).r, mn);
				sum += min(texture(drawing, center.xyz + cross(vec3(-dx,+dx,0.0), dir)).r, mn);
				float proportion = (sum / mn) / 18.0; //proportion of six neighbors is non-zero

				//a high proportion of hits means crevice
				//since the AO term adds shadows that darken most voxels, it will result in dark surfaces
				//the term brighten adds a little illumination to balance this
				// without brighten, only the most extreme ridges will not be darker
				const float brighten = 1.2;
				vec3 ao = draw.rgb * (1.0 - proportion) * brighten;
				draw.rgb = mix (draw.rgb, ao , renderDrawAmbientOcclusionX);
			}
			colorSample = draw;
		}
		samplePos += deltaDir; //advance ray position
		if (colorSample.a >= 0.01) {
			if (overlayOcclusion > 0.0 && fColor.a > 0.05 && samplePos.a > backNearest) {
				// Normalise against a realistic reference alpha. MEASURED: a
				// standard T1 (mni152) background march accumulates only ~0.2
				// total alpha, so scaling directly by fColor.a made
				// overlayOcclusion = 0.85 attenuate by barely 15% — visually
				// nothing (overlay pixel count moved 2914 -> 2990, i.e. noise).
				// Saturating fColor.a at a 0.25 reference makes the uniform mean
				// what its name implies: 1.0 = fully hidden behind tissue,
				// 0.0 = stock niivue behaviour, and it degrades smoothly for
				// genuinely faint/transparent backgrounds.
				colorSample.a *= (1.0 - overlayOcclusion * clamp(fColor.a / 0.25, 0.0, 1.0));
			}
			if (overFirstHit.a > len)
				overFirstHit = samplePos;
			colorSample.a *= renderOverlayBlend;
			colorSample.a = 1.0-pow((1.0 - colorSample.a), opacityCorrection);
			colorSample.rgb *= colorSample.a;
			colAcc= (1.0 - colAcc.a) * colorSample + colAcc;
			overFarthest = samplePos.a;
			if ( colAcc.a > earlyTermination )
				break;
		}
	}
	//if (samplePos.a >= len) {
	if (colAcc.a <= 0.0) {
		if (isClip && (fColor.a == 0.0))
			fColor += clipPlaneColorX;
		return;
	}
	if (overFirstHit.a < firstHit.a)
		gl_FragDepth = frac2ndc(overFirstHit.xyz);
	float overMix = colAcc.a;
	float overlayDepth = 0.3;
	if (fColor.a <= 0.0)
		overMix = 1.0;
	else if (((overFarthest) > backNearest)) {
		float dx = (overFarthest - backNearest)/1.73;
		dx = fColor.a * pow(dx, overlayDepth);
		overMix *= 1.0 - dx;
	}
	fColor.rgb = mix(fColor.rgb, colAcc.rgb, overMix);
	fColor.a = max(fColor.a, colAcc.a);
}`;

// ---- Assembled base render fragment shader (fragRenderShader equivalent) ----
export const RENDER_FRAG = RENDER_FRAG_HEADER + K_RENDER_FUNC + K_RENDER_INIT + RENDER_BACKGROUND_LOOP + K_RENDER_TAIL;
