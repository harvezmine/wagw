import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings, parseSettingsUpdate } from '../src/services/sessionSettings.js';

test('normalizeSettings fills in defaults', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ rejectCalls: true }), { ...DEFAULT_SETTINGS, rejectCalls: true });
});

test('parseSettingsUpdate accepts known settings and normalises empty messages', () => {
  assert.deepEqual(parseSettingsUpdate({ readMessages: null, rejectCalls: true, rejectCallMessage: '', ignoreGroups: false }),
    { readMessages: null, rejectCalls: true, rejectCallMessage: null, ignoreGroups: false });
});

test('parseSettingsUpdate rejects unknown keys and wrong types', () => {
  assert.throws(() => parseSettingsUpdate({ autoReply: true }), { status: 400 });
  assert.throws(() => parseSettingsUpdate({ rejectCalls: 'yes' }), { status: 400 });
  assert.throws(() => parseSettingsUpdate({ rejectCallMessage: 'x'.repeat(1001) }), { status: 400 });
  assert.throws(() => parseSettingsUpdate([]), { status: 400 });
});

test('anti-ban settings: daily new-chat limit, campaign consent and the opt-out reply', () => {
  assert.deepEqual(parseSettingsUpdate({ newContactDailyLimit: 5, campaignConsentRequired: false, optOutReply: 'Baik, kami berhenti.' }), {
    newContactDailyLimit: 5,
    campaignConsentRequired: false,
    optOutReply: 'Baik, kami berhenti.'
  });
  assert.deepEqual(parseSettingsUpdate({ newContactDailyLimit: null, campaignConsentRequired: null, optOutReply: '' }), {
    newContactDailyLimit: null,
    campaignConsentRequired: null,
    optOutReply: null
  });
  for (const bad of [{ newContactDailyLimit: -1 }, { newContactDailyLimit: 1001 }, { newContactDailyLimit: 2.5 }, { campaignConsentRequired: 'no' }, { optOutReply: 'x'.repeat(1001) }]) {
    assert.throws(() => parseSettingsUpdate(bad), { status: 400 });
  }
});
