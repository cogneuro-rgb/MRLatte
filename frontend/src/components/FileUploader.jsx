import React, { useRef } from "react";
import { Upload, Plus } from "lucide-react";
import { toast } from "sonner";

/**
 * FileUploader - dashed dropzone for .nii / .nii.gz / .mgz / .mgh files.
 */
export const FileUploader = ({
  label,
  description,
  accept = ".nii,.nii.gz,.mgz,.mgh",
  onFile,
  onFiles,
  multiple = false,
  directory = false,
  testId,
  variant = "primary",
  disabled = false,
}) => {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = React.useState(false);

  // Parse the `accept` prop into a lowercase extension allowlist so callers
  // can validate against custom format sets (e.g. tract/mesh files).
  const allowedExts = accept
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const handleFiles = (fileList) => {
    const arr = Array.from(fileList || []);
    if (arr.length === 0) return;
    // Directory mode (DICOM series): defer validation entirely to the
    // consumer — DICOM files are often extension-less.
    if (directory) {
      onFiles?.(arr);
      return;
    }
    // Multi-file mode (item 95): validate each file against the same
    // allowlist the single-file path uses, dropping invalid entries and
    // reporting them individually rather than rejecting the whole batch —
    // one bad file in a 5-file selection shouldn't block the other 4.
    if (multiple) {
      const valid = [];
      const rejected = [];
      for (const file of arr) {
        const name = file.name.toLowerCase();
        if (allowedExts.some((ext) => name.endsWith(ext))) valid.push(file);
        else rejected.push(file.name);
      }
      if (rejected.length) {
        toast.error(
          rejected.length === 1 ? "Unsupported file format" : `${rejected.length} files skipped — unsupported format`,
          { description: rejected.length === 1 ? `${rejected[0]} — please upload ${accept}` : `${rejected.join(", ")} — please upload ${accept}` },
        );
      }
      if (valid.length) onFiles?.(valid);
      return;
    }
    const file = arr[0];
    const name = file.name.toLowerCase();
    const valid = allowedExts.some((ext) => name.endsWith(ext));
    if (!valid) {
      toast.error("Unsupported file format", {
        description: `Please upload ${accept}`,
      });
      return;
    }
    onFile?.(file);
  };

  const borderColor =
    variant === "danger"
      ? dragOver
        ? "border-destructive bg-destructive/10"
        : "border-edge hover:border-destructive/60"
      : dragOver
      ? "border-crema bg-crema-tint"
      : "border-edge hover:bg-panel-hover";

  return (
    <label
      htmlFor={testId}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
      }}
      className={`group flex min-h-[34px] cursor-pointer items-start gap-2 rounded-md border ${borderColor} px-[11px] py-[7px] transition-colors${disabled ? " pointer-events-none opacity-50" : ""}`}
      data-testid={`${testId}-label`}
    >
      <span className={`mt-px flex-shrink-0 ${variant === "danger" ? "text-destructive" : "text-foreground"}`}>
        {variant === "danger" ? <Plus size={14} /> : <Upload size={14} />}
      </span>
      <div className="flex-1 min-w-0">
        <div
          className={`text-[12.5px] font-medium leading-4 ${
            variant === "danger" ? "text-destructive" : "text-foreground"
          }`}
        >
          {label}
        </div>
        {description && (
          <div className="mt-px text-[11.5px] leading-4 text-subtle">
            {description}
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        id={testId}
        type="file"
        accept={accept}
        multiple={multiple || directory}
        className="hidden"
        data-testid={testId}
        disabled={disabled}
        onChange={(e) => handleFiles(e.target.files)}
        {...(directory ? { webkitdirectory: "", directory: "" } : {})}
      />
    </label>
  );
};

export default FileUploader;
