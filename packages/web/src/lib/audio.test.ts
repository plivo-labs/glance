import { describe, expect, test } from 'bun:test'
import { formatTimestamp, isAudioFile, timestampPrefix } from './audio'

describe('isAudioFile', () => {
  test('recognizes every extension the content worker serves as audio', () => {
    expect(isAudioFile('song.mp3')).toBe(true)
    expect(isAudioFile('track.wav')).toBe(true)
    expect(isAudioFile('voice.m4a')).toBe(true)
    expect(isAudioFile('clip.ogg')).toBe(true)
    expect(isAudioFile('clip.oga')).toBe(true)
    expect(isAudioFile('song.flac')).toBe(true)
    expect(isAudioFile('song.aac')).toBe(true)
  })
  test('is case-insensitive on the extension', () => {
    expect(isAudioFile('SONG.MP3')).toBe(true)
  })
  test('a nested path still resolves off the final extension', () => {
    expect(isAudioFile('a/b/track.wav')).toBe(true)
  })
  test('non-audio files, and the extensionless/empty splat, are false', () => {
    expect(isAudioFile('index.html')).toBe(false)
    expect(isAudioFile('photo.png')).toBe(false)
    expect(isAudioFile('README')).toBe(false)
    expect(isAudioFile('')).toBe(false)
  })
})

describe('formatTimestamp', () => {
  test('formats seconds as m:ss with zero-padded seconds', () => {
    expect(formatTimestamp(0)).toBe('0:00')
    expect(formatTimestamp(3)).toBe('0:03')
    expect(formatTimestamp(65.4)).toBe('1:05')
    expect(formatTimestamp(600)).toBe('10:00')
  })
  test('truncates (floors) fractional seconds, never rounds up', () => {
    expect(formatTimestamp(59.9)).toBe('0:59')
  })
  test('negative, NaN, and non-finite values clamp to 0:00', () => {
    expect(formatTimestamp(-5)).toBe('0:00')
    expect(formatTimestamp(Number.NaN)).toBe('0:00')
    expect(formatTimestamp(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})

describe('timestampPrefix', () => {
  test('wraps the formatted time in brackets with a trailing space, ready to prepend', () => {
    expect(timestampPrefix(65)).toBe('[1:05] ')
  })
})
