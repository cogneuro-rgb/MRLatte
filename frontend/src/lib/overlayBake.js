import { NVUtilities } from "@niivue/niivue";
import { setNiftiAffine } from "@/lib/niftiHeader";

/**
 * A copy of a NIfTI file whose header carries a new voxel→world transform.
 * The voxels are untouched — nothing is resampled. Used to make a manually
 * adjusted overlay's FILE agree with what the viewer shows, because analyses,
 * downloads and workspaces all read the file (see lib/overlayTransform.js).
 *
 * @param {File|Blob} file .nii or .nii.gz
 * @param {number[][]} affine 4x4 row-major
 * @returns {Promise<File>} same name and type as the input
 * @throws if the file is not a NIfTI-1 (e.g. NIfTI-2), so the caller can refuse
 *         the adjustment rather than show a position the analyses won't use
 */
export async function fileWithAffine(file, affine) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  const gz = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (gz) bytes = await NVUtilities.decompress(bytes);
  const res = setNiftiAffine(bytes, affine);
  if (!res.ok) throw new Error(res.reason || "unsupported file");
  const out = gz ? new Uint8Array(await NVUtilities.compress(bytes, "gzip")) : bytes;
  return new File([out], file.name || "overlay.nii.gz", { type: file.type || "application/gzip" });
}
