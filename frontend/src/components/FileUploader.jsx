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
        ? "border-destructive"
        : "border-border hover:border-destructive/60"
      : dragOver
      ? "border-foreground"
      : "border-border hover:border-muted-foreground";

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
      className={`group flex cursor-pointer items-center gap-3 border border-dashed ${borderColor} bg-panel px-3 py-3 transition-colors${disabled ? " pointer-events-none opacity-50" : ""}`}
      data-testid={`${testId}-label`}
    >
      <div
        className={`flex h-8 w-8 flex-shrink-0 items-center justify-center border ${
          variant === "danger"
            ? "border-destructive/40 text-destructive"
            : "border-border text-foreground group-hover:border-muted-foreground"
        }`}
      >
        {variant === "danger" ? <Plus size={14} /> : <Upload size={14} />}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className={`text-[12px] font-medium ${
            variant === "danger" ? "text-destructive" : "text-foreground"
          }`}
        >
          {label}
        </div>
        {description && (
          <div className="font-mono text-[10px] text-muted-foreground mt-0.5 truncate">
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
