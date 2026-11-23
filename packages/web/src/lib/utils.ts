import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'
import ramp from '@plivo/tokens/type.json'

// tailwind-merge only knows Tailwind's stock font sizes, so it reads the Plivo ramp (text-label,
// text-p-400, …) as text COLOURS and silently drops them beside text-foreground. Register every
// ramp token as a size; the list comes from the tokens package, so it can't drift.
const twMerge = extendTailwindMerge({ extend: { theme: { text: Object.keys(ramp) } } })

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// One narrow-unit formatter per binary magnitude ("512B", "3.4MB"). Not compact notation:
// its suffixes are decimal and render gigabytes as "BB" (billion bytes).
const byteFormats = (['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const).map(
  (unit) => new Intl.NumberFormat(undefined, { style: 'unit', unit, unitDisplay: 'narrow', maximumFractionDigits: 1 }),
)

export function formatBytes(bytes: number): string {
  let value = bytes
  let i = 0
  while (value >= 1024 && i < byteFormats.length - 1) {
    value /= 1024
    i++
  }
  return byteFormats[i].format(value)
}
