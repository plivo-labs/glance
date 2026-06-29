import type { SpaceSummary } from '@/lib/types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

// One space picker, shared by the Deploy card and the Move dialog so the option rendering
// (mono slug + `· personal` tag) lives in exactly one place.
export function SpaceSelect({
  id,
  value,
  onChange,
  spaces,
  placeholder = 'Select a space',
}: {
  id?: string
  value: string
  onChange: (slug: string) => void
  spaces: SpaceSummary[]
  placeholder?: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {spaces.map((s) => (
          <SelectItem key={s.id} value={s.slug}>
            <span className="font-mono">{s.slug}</span>
            {s.type === 'personal' && <span className="text-muted-foreground"> · personal</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
