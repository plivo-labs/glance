import { describe, expect, test } from 'bun:test'
import { AUDIO_EXTENSIONS, EXT_MIME, contentType, extOf } from './mime'

describe('AUDIO_EXTENSIONS', () => {
  test('is derived from EXT_MIME — every audio/* extension, nothing else (W0-4)', () => {
    const expected = Object.entries(EXT_MIME)
      .filter(([, m]) => m.startsWith('audio/'))
      .map(([e]) => e)
      .sort()
    expect([...AUDIO_EXTENSIONS].sort()).toEqual(expected)
    expect(AUDIO_EXTENSIONS.has('webm')).toBe(true)
    expect(AUDIO_EXTENSIONS.has('png')).toBe(false)
  })
})

describe('contentType — extension is authoritative (W0-3)', () => {
  test('webm serves as audio/webm even when stored as a video container guess', () => {
    // Tradeoff pin: a .webm we host is always treated as audio, never video — the extension
    // decides. MediaRecorder voice + audio uploads are the only .webm producers here.
    expect(contentType('take.webm', 'video/webm')).toBe('audio/webm')
    expect(contentType('take.webm', 'application/octet-stream')).toBe('audio/webm')
  })
  test('unknown extension falls back to a sane stored type, else octet-stream', () => {
    expect(contentType('data.csv', 'text/csv')).toBe('text/csv; charset=utf-8')
    expect(contentType('blob', null)).toBe('application/octet-stream')
  })
})

describe('contentType — full MIME table (W0-4 characterization)', () => {
  test('textual types pin charset=utf-8 (no latin-1 mojibake)', () => {
    expect(contentType('index.html', null)).toBe('text/html; charset=utf-8')
    expect(contentType('app.js', null)).toBe('text/javascript; charset=utf-8')
    expect(contentType('data.json', null)).toBe('application/json; charset=utf-8')
    expect(contentType('logo.svg', null)).toBe('image/svg+xml; charset=utf-8')
    expect(contentType('notes.txt', null)).toBe('text/plain; charset=utf-8')
  })
  test('binary types are left untouched', () => {
    expect(contentType('photo.png', null)).toBe('image/png')
    expect(contentType('font.woff2', null)).toBe('font/woff2')
    expect(contentType('blob', null)).toBe('application/octet-stream')
  })
  test('falls back to the stored type (charset-pinned when textual)', () => {
    expect(contentType('weird.ext', 'text/csv')).toBe('text/csv; charset=utf-8')
    expect(contentType('weird.ext', 'application/zip')).toBe('application/zip')
  })
  test('audio extensions resolve to their audio MIME regardless of stored type (extension authoritative — every CLI upload part is stamped application/octet-stream)', () => {
    expect(contentType('song.mp3', 'application/octet-stream')).toBe('audio/mpeg')
    expect(contentType('track.wav', 'application/octet-stream')).toBe('audio/wav')
    expect(contentType('voice.m4a', null)).toBe('audio/mp4')
    expect(contentType('clip.ogg', null)).toBe('audio/ogg')
    expect(contentType('clip.oga', null)).toBe('audio/ogg')
    expect(contentType('song.flac', null)).toBe('audio/flac')
    expect(contentType('song.aac', null)).toBe('audio/aac')
  })
})

describe('extOf', () => {
  test('lowercases the final segment; empty for extensionless', () => {
    expect(extOf('a/b/TAKE.WEBM')).toBe('webm')
    expect(extOf('README')).toBe('')
  })
})
