/** Encode path segments so `?`/`#` in filenames can't truncate the pathname. */
export const encodePathSegments = (filePath: string): string =>
  filePath.split('/').map(encodeURIComponent).join('/')
