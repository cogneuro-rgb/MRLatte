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
    // Multi-file / directory mode (e.g. DICOM series): defer validation to
    // the consumer — DICOM files are often extension-less.
    if (multiple || directory) {
      onFiles?.(arr);
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
        ? "border-[#FF3B30]"
        : "border-[#27272A] hover:border-[#FF3B30]/60"
      : dragOver
      ? "border-white"
      : "border-[#27272A] hover:border-zinc-500";

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
      className={`group flex cursor-pointer items-center gap-3 border border-dashed ${borderColor} bg-[#0a0a0a] px-3 py-3 transition-colors${disabled ? " pointer-events-none opacity-50" : ""}`}
      data-testid={`${testId}-label`}
    >
      <div
        className={`flex h-8 w-8 flex-shrink-0 items-center justify-center border ${
          variant === "danger"
            ? "border-[#FF3B30]/40 text-[#FF3B30]"
            : "border-[#27272A] text-zinc-300 group-hover:border-zinc-500"
        }`}
      >
        {variant === "danger" ? <Plus size={14} /> : <Upload size={14} />}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className={`text-[12px] font-medium ${
            variant === "danger" ? "text-[#FF3B30]" : "text-zinc-200"
          }`}
        >
          {label}
        </div>
        {description && (
          <div className="font-mono text-[10px] text-zinc-500 mt-0.5 truncate">
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
