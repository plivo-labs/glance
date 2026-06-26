// One walker for both drag-drop (DataTransferItemList) and the <input webkitdirectory>
// picker (FileList). Returns a flat {file, path}[] with folder structure preserved in
// `path`. Pure async — no React, no useEffect.

export interface DroppedFile {
  file: File
  path: string
}

// Chromium's readEntries returns at most 100 entries per call and resolves [] only when
// exhausted — must loop until empty or large folders silently drop files.
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = []
    const pump = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(out)
        out.push(...batch)
        pump()
      }, reject)
    pump()
  })
}

async function walkEntry(entry: FileSystemEntry, prefix: string): Promise<DroppedFile[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
    return [{ file, path: prefix + entry.name }]
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const children = await readAllEntries(reader)
  const nested = await Promise.all(children.map((child) => walkEntry(child, `${prefix}${entry.name}/`)))
  return nested.flat()
}

/** Drop handler: capture entries SYNCHRONOUSLY (DataTransferItem is cleared after the event). */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<DroppedFile[]> {
  const entries = Array.from(dt.items)
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e != null)

  if (entries.length === 0) {
    // Fallback: no entries API (rare) — use the flat file list.
    return Array.from(dt.files).map((file) => ({ file, path: file.name }))
  }
  const groups = await Promise.all(entries.map((e) => walkEntry(e, '')))
  return groups.flat()
}

/** Picker handler: <input type="file" webkitdirectory> populates webkitRelativePath. */
export function filesFromInput(list: FileList): DroppedFile[] {
  return Array.from(list).map((file) => ({ file, path: file.webkitRelativePath || file.name }))
}

// Both folder pickers prefix every path with the dropped folder's name (`site/index.html`),
// so the site's index.html would never sit at the served root (`/space/site/` → index.html).
// Strip that shared top-level segment so `index.html` lands at the root and relative asset
// links resolve. No-op for loose files, or when more than one top-level entry was dropped.
export function stripCommonRoot(files: DroppedFile[]): DroppedFile[] {
  if (files.length === 0) return files
  const root = files[0].path.split('/')[0]
  if (!root) return files
  const allUnderRoot = files.every((f) => f.path.startsWith(`${root}/`))
  if (!allUnderRoot) return files
  return files.map((f) => ({ ...f, path: f.path.slice(root.length + 1) }))
}
