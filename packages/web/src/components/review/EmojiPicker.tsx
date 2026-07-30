import { Smile } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { EMOJI_CATEGORIES, searchEmoji } from '@/lib/emoji'

// Emoji trigger for the composer's action row. Open state and the query live here so the caller
// only has to say what to do with the glyph — a pick always closes the popover, and reopening
// starts from the full grid rather than the last search.
//
// `cmdk` drives the list with `shouldFilter={false}`: the matching is `searchEmoji`'s (name AND
// keywords, curated per entry), while cmdk contributes the part that is tedious to hand-roll —
// arrow-key movement and Enter selecting the highlighted item, which is the first result.
export function EmojiPicker({
  onPick,
  disabled,
  label = 'Insert emoji',
  className,
}: {
  onPick: (emoji: string) => void
  disabled?: boolean
  // The two callers want the same picker under different affordances: the composer's action-row
  // button, and a chip-sized "add reaction" trigger in a thread. Only the trigger differs, so it
  // takes a label and a class rather than the picker being forked in two.
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // A pick hands focus back to the textarea (the composer restores the caret there). Radix would
  // otherwise pull it onto the trigger as the popover unmounts, landing the next keystroke nowhere
  // near the draft. Escape still returns to the trigger — that IS where the user is.
  const picked = useRef(false)

  function pick(emoji: string) {
    picked.current = true
    onPick(emoji)
    setOpen(false)
  }

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next) setQuery('')
  }

  const results = query.trim() ? searchEmoji(query) : null

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled} aria-label={label} className={className}>
          <Smile className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 p-0"
        onCloseAutoFocus={(e) => {
          if (picked.current) e.preventDefault()
          picked.current = false
        }}
      >
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search emoji" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-64">
            <CommandEmpty>No emoji found.</CommandEmpty>
            {results ? (
              <EmojiGrid emojis={results} onPick={pick} />
            ) : (
              EMOJI_CATEGORIES.map((c) => <EmojiGrid key={c.name} heading={c.name} emojis={c.emojis} onPick={pick} />)
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// A wrapping grid rather than cmdk's default one-item-per-row list: eight glyphs to a line is the
// only layout in which a couple of hundred emojis are scannable. The items stay real CommandItems,
// so keyboard selection still works — only the box they sit in changed.
function EmojiGrid({
  heading,
  emojis,
  onPick,
}: {
  heading?: string
  emojis: { emoji: string; name: string }[]
  onPick: (emoji: string) => void
}) {
  return (
    <CommandGroup heading={heading} className="[&_[cmdk-group-items]]:flex [&_[cmdk-group-items]]:flex-wrap">
      {emojis.map((e) => (
        <CommandItem
          key={e.emoji}
          // cmdk keys items by value, so the name (unique per entry) keeps two glyphs that share a
          // keyword from collapsing into one selectable row.
          value={e.name}
          onSelect={() => onPick(e.emoji)}
          title={e.name}
          className="size-8 justify-center p-0 text-lg"
        >
          {e.emoji}
        </CommandItem>
      ))}
    </CommandGroup>
  )
}
