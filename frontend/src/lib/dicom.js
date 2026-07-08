// DICOM import. This Niivue build ships no client-side DICOM decoder, so
// conversion is delegated to the backend `dcm2niix` endpoint. The resulting
// NIfTI is returned as a File and fed into the existing volume loaders.

const apiBase = process.env.REACT_APP_BACKEND_URL || "";

const DICOM_EXTS = [".dcm", ".ima", ".zip"];

export function isDicomFile(file) {
  const n = (file?.name || "").toLowerCase();
  // Many DICOMs have no extension; treat extension-less files as candidates.
  return DICOM_EXTS.some((e) => n.endsWith(e)) || !/\.[a-z0-9]+$/i.test(n);
}

export async function dicomConvertAvailable() {
  try {
    const r = await fetch(`${apiBase}/api/convert/dicom/available`);
    if (!r.ok) return false;
    const j = await r.json();
    return !!j.available;
  } catch {
    return false;
  }
}

/**
 * Convert a DICOM folder (or .zip) via the backend. dcm2niix may emit multiple
 * series; this returns the list so the caller can pick one.
 * @param {FileList|File[]} fileList
 * @param {(fraction:number)=>void} [onUploadProgress]  upload progress 0..1
 * @returns {Promise<{job_id:string, series:Array<{id,name,description,dims,n_slices,bytes}>}>}
 */
export async function convertDicom(fileList, onUploadProgress) {
  const fd = new FormData();
  for (const f of fileList) fd.append("files", f, f.name);

  // XHR (not fetch) so we can report real upload progress for large studies.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBase}/api/convert/dicom`);
    xhr.responseType = "json";
    if (onUploadProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onUploadProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response);
      } else {
        const detail = xhr.response?.detail || `HTTP ${xhr.status}`;
        reject(new Error(detail));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during DICOM upload"));
    xhr.send(fd);
  });
}

/**
 * Direct URL to download a converted series as a .nii.gz. The backend serves it
 * with a Content-Disposition filename, so an <a href download> saves it directly.
 */
export function dicomSeriesDownloadUrl(jobId, seriesId) {
  return `${apiBase}/api/convert/dicom/result/${jobId}/${encodeURIComponent(seriesId)}`;
}

/**
 * Fetch one converted series as a File to hand to the volume loaders.
 */
export async function fetchDicomSeriesFile(jobId, seriesId) {
  const r = await fetch(dicomSeriesDownloadUrl(jobId, seriesId));
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      detail = (await r.json()).detail || detail;
    } catch { /* keep status */ }
    throw new Error(detail);
  }
  const blob = await r.blob();
  return new File([blob], `${seriesId}.nii.gz`, { type: "application/gzip" });
}
