import { describe, it, expect } from 'vitest';
import { resolutionToLabel } from './quality';

describe('resolutionToLabel', () => {
  it('should return SD for resolutions <= 480p', () => {
    expect(resolutionToLabel('640x480')).toBe('SD');
    expect(resolutionToLabel('720x480')).toBe('SD');
    expect(resolutionToLabel('320x240')).toBe('SD');
  });

  it('should return HD for resolutions > 480p and <= 720p', () => {
    expect(resolutionToLabel('1280x720')).toBe('HD');
    expect(resolutionToLabel('960x540')).toBe('HD');
  });

  it('should return FHD for resolutions > 720p and <= 1080p', () => {
    expect(resolutionToLabel('1920x1080')).toBe('FHD');
    expect(resolutionToLabel('1440x1080')).toBe('FHD');
  });

  it('should return QHD for resolutions > 1080p and <= 1440p', () => {
    expect(resolutionToLabel('2560x1440')).toBe('QHD');
  });

  it('should return UHD for resolutions > 1440p and <= 2160p', () => {
    expect(resolutionToLabel('3840x2160')).toBe('UHD');
    expect(resolutionToLabel('4096x2160')).toBe('UHD');
  });

  it('should return 8K for resolutions > 2160p', () => {
    expect(resolutionToLabel('7680x4320')).toBe('8K');
  });

  it('should handle case-insensitive resolution strings', () => {
    expect(resolutionToLabel('1920X1080')).toBe('FHD');
    expect(resolutionToLabel('1280X720')).toBe('HD');
  });

  it('should return an empty string for malformed resolution strings', () => {
    expect(resolutionToLabel('')).toBe('');
    expect(resolutionToLabel('invalid')).toBe('');
    expect(resolutionToLabel('1080p')).toBe('');
    expect(resolutionToLabel('1920x')).toBe('');
  });

  it('should handle edge cases at boundaries', () => {
    // Exactly 480
    expect(resolutionToLabel('720x480')).toBe('SD');
    // Just above 480
    expect(resolutionToLabel('720x481')).toBe('HD');

    // Exactly 720
    expect(resolutionToLabel('1280x720')).toBe('HD');
    // Just above 720
    expect(resolutionToLabel('1280x721')).toBe('FHD');

    // Exactly 1080
    expect(resolutionToLabel('1920x1080')).toBe('FHD');
    // Just above 1080
    expect(resolutionToLabel('1920x1081')).toBe('QHD');

    // Exactly 1440
    expect(resolutionToLabel('2560x1440')).toBe('QHD');
    // Just above 1440
    expect(resolutionToLabel('2560x1441')).toBe('UHD');

    // Exactly 2160
    expect(resolutionToLabel('3840x2160')).toBe('UHD');
    // Just above 2160
    expect(resolutionToLabel('3840x2161')).toBe('8K');
  });
});
