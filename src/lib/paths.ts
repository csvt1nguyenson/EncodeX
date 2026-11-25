import type { ExportSettings, FormatId, OutputMode, QueueItem } from "./types";

export function normalizeFolderInput(value: string | undefined | null): string {
  let folder = String(value ?? "").trim();
  if (folder.startsWith('"') && folder.endsWith('"') && folder.length >= 2) {
    folder = folder.slice(1, -1).trim();
  }
  return folder.replace(/\//g, "\\");
}

export function getExtension(format: FormatId | string): string {
  switch (format) {
    case "h265_mp4":
    case "h264_mp4":
      return ".mp4";
    case "mov_h264":
    case "mov_prores":
      return ".mov";
    case "mp3":
      return ".mp3";
    case "wav":
      return ".wav";
    case "aac":
      return ".m4a";
    case "webm":
      return ".webm";
    default:
      return ".mp4";
  }
}

export function baseName(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function dirname(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  if (idx < 0) return "";
  const dir = filePath.slice(0, idx);
  // Preserve trailing slash for Windows drive roots like "D:\" so joins stay valid.
  if (/^[A-Za-z]:$/.test(dir)) {
    return `${dir}\\`;
  }
  return dir;
}

export function stem(filePath: string): string {
  const name = baseName(filePath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function joinPath(folder: string, name: string): string {
  if (!folder) return name;
  const sep = folder.includes("\\") ? "\\" : "/";
  return folder.endsWith("\\") || folder.endsWith("/") ? `${folder}${name}` : `${folder}${sep}${name}`;
}

function folderLeafName(folder: string): string {
  const stripped = folder.replace(/[\\/]+$/, "");
  // Windows drive root ("D:") has no folder name, matching Rust Path::file_name() == None.
  if (!stripped || /^[A-Za-z]:$/.test(stripped)) {
    return "";
  }
  return baseName(stripped);
}

export function outputFolderFromItem(
  item: Pick<QueueItem, "source" | "outputMode" | "customFolder">,
  fallback: Pick<ExportSettings, "outputMode" | "customFolder">
): string {
  const sourceFolder = dirname(item.source);
  const mode: OutputMode = item.outputMode || fallback.outputMode || "source_output";
  const custom = normalizeFolderInput(item.customFolder || fallback.customFolder || "");

  if (mode === "same_folder") {
    return sourceFolder;
  }

  if (mode === "custom_folder" && custom) {
    return custom;
  }

  const leaf = folderLeafName(sourceFolder);
  return joinPath(sourceFolder, `${leaf}_OUTPUT`);
}

/**
 * Mirrors Rust `build_output_path` exactly:
 * - `same_folder` always appends `_encoded`
 * - drive-root sources (`D:\a.mp4`) map to `D:\_OUTPUT\a.mp4`
 * - never collides with the source path itself
 */
export function buildOutputPreview(
  item: Pick<QueueItem, "source" | "format" | "outputMode" | "customFolder">,
  fallback: Pick<ExportSettings, "format" | "outputMode" | "customFolder">
): string {
  const mode: OutputMode = item.outputMode || fallback.outputMode || "source_output";
  const ext = getExtension(item.format || fallback.format);
  const folder = outputFolderFromItem(item, fallback);
  const suffix = mode === "same_folder" ? "_encoded" : "";
  const fileStem = stem(item.source);

  let outputPath = joinPath(folder, `${fileStem}${suffix}${ext}`);
  if (outputPath.toLowerCase() === item.source.toLowerCase()) {
    outputPath = joinPath(folder, `${fileStem}_encoded${ext}`);
  }
  return outputPath;
}
