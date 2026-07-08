import { describe, expect, test } from 'bun:test'
import { defaultRecordingTitle, extForMime, pickAudioMimeType, recordingSlug } from './recorder'

describe('pickAudioMimeType — cascade with an injectable probe (W3-1, S-A)', () => {
  test('returns the first supported candidate in preference order', () => {
    // Only mp4 supported (Safari-ish) → skips the webm/opus preferences.
    expect(pickAudioMimeType((t) => t === 'audio/mp4')).toBe('audio/mp4')
    // opus-in-webm supported → wins outright.
    expect(pickAudioMimeType(() => true)).toBe('audio/webm;codecs=opus')
  })
  test('nothing supported → empty string (let MediaRecorder default)', () => {
    expect(pickAudioMimeType(() => false)).toBe('')
  })
})

describe('extForMime (W3-2)', () => {
  test('maps recording MIMEs (codec params stripped) to a server-audio extension', () => {
    expect(extForMime('audio/webm;codecs=opus')).toBe('webm')
    expect(extForMime('audio/webm')).toBe('webm')
    expect(extForMime('audio/mp4')).toBe('m4a')
    expect(extForMime('audio/ogg;codecs=opus')).toBe('ogg')
    expect(extForMime('audio/mpeg')).toBe('mp3')
  })
  test('unknown or empty MIME falls back to webm', () => {
    expect(extForMime('application/octet-stream')).toBe('webm')
    expect(extForMime('')).toBe('webm')
  })
})

describe('recording title + slug (W3-3)', () => {
  const now = new Date('2026-07-08T14:05:09')
  test('defaultRecordingTitle is a stable, human timestamp', () => {
    expect(defaultRecordingTitle(now)).toBe('Recording 2026-07-08 14:05')
  })
  test('recordingSlug is deterministic and a valid slug (lowercase alnum + hyphens)', () => {
    const slug = recordingSlug('My First Take!!', now)
    expect(slug).toBe('my-first-take')
    expect(slug).toMatch(/^[a-z0-9-]+$/)
  })
  test('a title with no slug-able chars falls back to a timestamped recording slug', () => {
    const slug = recordingSlug('🎙️🎙️', now)
    expect(slug).toBe('recording-20260708-140509')
    expect(slug).toMatch(/^[a-z0-9-]+$/)
  })
})
