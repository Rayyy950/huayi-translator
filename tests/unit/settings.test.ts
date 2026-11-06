import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  DEFAULT_SETTINGS,
  parseSettings,
  type Settings,
} from '../../src/shared/settings';

const base: Settings = { ...DEFAULT_SETTINGS, configVersion: 5 };

describe('applyPatch', () => {
  it('bumps configVersion for result-affecting changes', () => {
    expect(applyPatch(base, { engineMode: 'cloud-only' }).configVersion).toBe(6);
    expect(applyPatch(base, { sourceLanguage: 'en' }).configVersion).toBe(6);
    expect(applyPatch(base, { targetLanguage: 'zh-Hans' }).configVersion).toBe(5);
    expect(applyPatch(base, { tokenhub: { region: 'singapore' } }).configVersion).toBe(6);
    expect(applyPatch(base, { cloudFallback: true }).configVersion).toBe(6);
  });

  it('does not bump for presentation or limit changes', () => {
    expect(applyPatch(base, { debounceMs: 400 }).configVersion).toBe(5);
    expect(applyPatch(base, { enabled: false }).configVersion).toBe(5);
    expect(applyPatch(base, { dailySoftLimit: null }).configVersion).toBe(5);
    expect(applyPatch(base, { disabledHosts: ['example.com'] }).configVersion).toBe(5);
  });

  it('merges nested tokenhub settings', () => {
    const next = applyPatch(base, { tokenhub: { region: 'singapore' } });
    expect(next.tokenhub).toEqual({ region: 'singapore', model: 'hy-mt2-plus' });
  });
});

describe('parseSettings', () => {
  it('merges partial settings with defaults', () => {
    const settings = parseSettings({ engineMode: 'local-only' });
    expect(settings.engineMode).toBe('local-only');
    expect(settings.targetLanguage).toBe('zh-Hans');
    expect(settings.dailySoftLimit).toBe(20_000);
  });

  it('falls back to defaults for invalid data', () => {
    expect(parseSettings({ engineMode: 'nonsense' })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('not an object')).toEqual(DEFAULT_SETTINGS);
  });
});
