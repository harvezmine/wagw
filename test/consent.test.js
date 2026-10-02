import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consentBlockReason, isActiveConversation, matchConsentKeyword, parseKeywordList } from '../src/services/consent.js';

const keywords = { optOut: parseKeywordList('STOP, berhenti ,Stop Promo'), optIn: parseKeywordList('START') };
const now = new Date('2026-10-03T12:00:00Z');
const hoursAgo = (hours) => new Date(now.getTime() - hours * 3600000);

test('keyword lists are normalised', () => {
  assert.deepEqual(keywords.optOut, ['STOP', 'BERHENTI', 'STOP PROMO']);
});

test('only whole messages match a consent keyword', () => {
  assert.equal(matchConsentKeyword(' stop! ', keywords), 'opted_out');
  assert.equal(matchConsentKeyword('Stop   promo', keywords), 'opted_out');
  assert.equal(matchConsentKeyword('start', keywords), 'opted_in');
  assert.equal(matchConsentKeyword('jangan stop dulu', keywords), null);
  assert.equal(matchConsentKeyword('', keywords), null);
});

test('an active conversation means the recipient wrote within 24 hours', () => {
  assert.equal(isActiveConversation({ lastInboundAt: hoursAgo(2) }, now), true);
  assert.equal(isActiveConversation({ lastInboundAt: hoursAgo(30) }, now), false);
  assert.equal(isActiveConversation(null, now), false);
});

test('opt-outs block everything except replies in an active conversation, until the person writes again', () => {
  const optedOut = { lastInboundAt: hoursAgo(48), consent: { status: 'opted_out', updatedAt: hoursAgo(47) } };
  assert.equal(consentBlockReason({ category: 'transactional', isGroup: false, contact: optedOut, requireConsent: false, now }), 'recipient opted out');
  const reengaged = { lastInboundAt: hoursAgo(1), consent: { status: 'opted_out', updatedAt: hoursAgo(47) } };
  assert.equal(consentBlockReason({ category: 'transactional', isGroup: false, contact: reengaged, requireConsent: false, now }), null);
  const justStopped = { lastInboundAt: hoursAgo(1), consent: { status: 'opted_out', updatedAt: hoursAgo(0.9) } };
  assert.equal(consentBlockReason({ category: 'reply', isGroup: false, contact: justStopped, requireConsent: false, now }), null);
  assert.equal(consentBlockReason({ category: 'campaign', isGroup: false, contact: justStopped, requireConsent: false, now }), 'recipient opted out');
});

test('campaigns need a known contact or an opt-in when consent is required', () => {
  const stranger = { lastInboundAt: null, consent: null };
  assert.match(consentBlockReason({ category: 'campaign', isGroup: false, contact: stranger, requireConsent: true, now }), /no consent/);
  assert.equal(consentBlockReason({ category: 'campaign', isGroup: false, contact: stranger, requireConsent: false, now }), null);
  assert.equal(consentBlockReason({ category: 'campaign', isGroup: false, contact: { lastInboundAt: null, consent: { status: 'opted_in', updatedAt: now } }, requireConsent: true, now }), null);
  assert.equal(consentBlockReason({ category: 'campaign', isGroup: false, contact: { lastInboundAt: hoursAgo(500), consent: null }, requireConsent: true, now }), null);
  assert.equal(consentBlockReason({ category: 'campaign', isGroup: true, contact: null, requireConsent: true, now }), null);
});
