import { type DroppedFile, stripCommonRoot } from './walkFiles'

// fetch() cannot report upload progress — XHR is required. Posts a multipart form to the
// Worker (Option B): each file is appended with its relative path as the filename, which
// the server reads as the storage path. Sends the session cookie (withCredentials).

export interface UploadResult {
  url: string
  siteSlug: string
  fileCount: number
}

export function uploadFiles(
  endpoint: string,
  files: DroppedFile[],
  opts: { visibility?: string; replace?: boolean; onProgress?: (pct: number) => void },
): Promise<UploadResult> {
  const form = new FormData()
  if (opts.visibility) form.append('visibility', opts.visibility)
  // Drop the shared top-level folder so index.html serves at the site root.
  for (const { file, path } of stripCommonRoot(files)) form.append('files', file, path)

  const url = opts.replace ? `${endpoint}?replace=true` : endpoint

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.withCredentials = true
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult)
        } catch {
          reject(new Error('Bad response from server'))
        }
      } else {
        let message = `Upload failed (${xhr.status})`
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string }
          if (body.error) message = body.error
        } catch {
          // keep default
        }
        reject(new UploadError(xhr.status, message))
      }
    }
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.onabort = () => reject(new Error('Upload aborted'))
    xhr.send(form)
  })
}

export class UploadError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'UploadError'
  }
}
