import { installVolumeClipPass } from "./volumeClip";

// A WebGL stand-in that only tracks which texture each unit holds.
function mockGl() {
  let active = 0;
  let n = 0;
  const units = {};
  return {
    TEXTURE0: 33984, TEXTURE9: 33993, TEXTURE_3D: 32879,
    RGBA8: 0, RGBA: 0, UNSIGNED_BYTE: 0, LINEAR: 0, CLAMP_TO_EDGE: 0,
    TEXTURE_MIN_FILTER: 0, TEXTURE_MAG_FILTER: 0, TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0, TEXTURE_WRAP_R: 0,
    units,
    activeTexture(u) { active = u; },
    bindTexture(_target, tex) { units[active] = tex; },
    createTexture() { n += 1; return { id: n }; },
    deleteTexture() {}, texStorage3D() {}, texSubImage3D() {}, texParameteri() {}, uniform1f() {},
  };
}

// niivue's real updateGLVolume merges the layers into a fresh overlay texture,
// uses unit 9 for its own scratch texture on the way, and leaves another unit
// active when it returns.
function mockNiivue(gl, activationClipped) {
  return {
    gl,
    renderShader: { use() {}, uniforms: { overlayOcclusion: 0 } },
    scene: { clipPlaneDepthAziElevs: [[0, 0, 0]] }, // clip plane engaged
    volumes: [{ id: "base" }, { id: "activation", __optOutClip: !activationClipped }],
    overlayTexture: null,
    updateGLVolume() {
      gl.activeTexture(gl.TEXTURE9);
      gl.bindTexture(gl.TEXTURE_3D, gl.createTexture());
      this.overlayTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + 2);
      gl.bindTexture(gl.TEXTURE_3D, this.overlayTexture);
      this.drawScene();
    },
    drawScene() {},
  };
}

describe("volume clip pass", () => {
  test("the clip-exempt overlay texture is on unit 9 after a rebuild", () => {
    const gl = mockGl();
    const nv = mockNiivue(gl, false);
    installVolumeClipPass(nv);
    nv.drawScene();
    expect(nv.__clipExemptOverlayTex).toBeTruthy();
    expect(gl.units[gl.TEXTURE9]).toBe(nv.__clipExemptOverlayTex);
  });

  // Inbox 28 Oct: clip on, an activation map's own clip turned on and then off
  // again blanked the 3D render until the next redraw. Turning it off makes the
  // map clip-exempt, so the exempt texture is rebuilt inside that draw, and the
  // rebuild (niivue's updateGLVolume) left another texture unit active: the
  // exempt texture went onto that unit and unit 9 kept niivue's scratch texture.
  test("turning a layer's clip on and then off again keeps unit 9 on the exempt texture", () => {
    const gl = mockGl();
    const nv = mockNiivue(gl, false);
    installVolumeClipPass(nv);
    nv.drawScene();

    nv.volumes[1].__optOutClip = false; // clip on: nothing is exempt
    nv.updateGLVolume();
    nv.drawScene();
    expect(gl.units[gl.TEXTURE9]).toBe(nv.__clipExemptOverlayTex);

    nv.volumes[1].__optOutClip = true; // clip off again: the map is exempt
    nv.updateGLVolume();
    expect(gl.units[gl.TEXTURE9]).toBe(nv.__clipExemptOverlayTex);
    nv.drawScene();
    expect(gl.units[gl.TEXTURE9]).toBe(nv.__clipExemptOverlayTex);
  });

  test("the full overlay texture survives the exempt-group rebuild", () => {
    const gl = mockGl();
    const nv = mockNiivue(gl, false);
    installVolumeClipPass(nv);
    nv.updateGLVolume();
    const full = nv.overlayTexture;
    nv.drawScene();
    expect(nv.overlayTexture).toBe(full);
    expect(nv.__clipExemptOverlayTex).not.toBe(full);
  });
});
