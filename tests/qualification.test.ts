import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createQualificationEngine,
  QualificationEngine,
  createDefaultQualificationRuleSet,
  defaultQualificationRuleSet,
} from '../src/qualification/qualification-engine.js';
import { parseConfig } from '../src/config/env.js';
import type { QualificationCalibrationFacts } from '../src/domain/qualification.js';
import type { QualificationReasonCode } from '../src/domain/qualification-reasons.js';
import { parseQualificationProfile } from '../src/qualification/qualification-profile.js';

function noCalibrationFacts(): QualificationCalibrationFacts {
  return Object.freeze({
    top1HolderBps: null,
    top5HoldersBps: null,
    top10HoldersBps: null,
    maximumRelatedClusterBps: null,
    maximumSharedFunderCount: null,
    buySimulationSucceeded: null,
    sellQuoteAvailable: null,
    roundTripLossBps: null,
    upstreamConditions: Object.freeze([]),
  });
}

function profileWithPolicy(
  code: QualificationReasonCode,
  change: Record<string, unknown>,
) {
  const raw = JSON.parse(readFileSync(
    new URL('../config/qualification/pumpfun-v1-unvalidated.json', import.meta.url),
    'utf8',
  )) as {
    conditionPolicies: Record<string, unknown>[];
  };
  raw.conditionPolicies = raw.conditionPolicies.map((policy) => ({
      ...policy,
      ...(policy.code === code ? change : {}),
    }));
  return parseQualificationProfile(deepFreeze(raw), null);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

void test('qualifie un lancement dont les trois dimensions atteignent le seuil', () => {
  const report = new QualificationEngine(defaultQualificationRuleSet).evaluate({
    evaluatedAtMs: 1,
    signals: {
      imageValid: true,
      socialCrossLinkConfirmed: true,
      creatorHasNotSold: true,
    },
    blockers: [],
    calibrationFacts: null,
  });

  assert.equal(report.verdict, 'QUALIFIED');
  assert.equal(report.scores.total.score, 60);
  assert.equal(report.scores.total.maximum, 100);
});

void test('rejette un lancement bloqué indépendamment du score', () => {
  const report = new QualificationEngine(defaultQualificationRuleSet).evaluate({
    evaluatedAtMs: 1,
    signals: {
      imageValid: true,
      socialCrossLinkConfirmed: true,
      creatorHasNotSold: true,
      reverseQuoteAvailable: true,
      externalBuyersObserved: true,
    },
    blockers: ['STALE_DATA'],
    calibrationFacts: null,
  });

  assert.equal(report.scores.total.score, 100);
  assert.equal(report.verdict, 'REJECTED');
  assert.deepEqual(report.blockers.map((blocker) => blocker.code), ['STALE_DATA']);
});

void test('met en watchlist les preuves obligatoires encore inconnues', () => {
  const report = new QualificationEngine(defaultQualificationRuleSet).evaluate({
    evaluatedAtMs: 1,
    signals: {},
    blockers: [],
    calibrationFacts: null,
  });

  assert.equal(report.verdict, 'WATCHLISTED');
  assert.equal(report.evidence.find((item) => item.signal === 'imageValid')?.status, 'UNKNOWN');
});

void test('applique le seuil configuré sans transformer un score en blocker', () => {
  const report = new QualificationEngine(createDefaultQualificationRuleSet(61)).evaluate({
    evaluatedAtMs: 1,
    signals: {
      imageValid: true,
      socialCrossLinkConfirmed: true,
      creatorHasNotSold: true,
    },
    blockers: [],
    calibrationFacts: null,
  });

  assert.equal(report.scores.total.score, 60);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.verdict, 'WATCHLISTED');
});

void test('injecte le seuil d’environnement dans le moteur construit pour l’application', () => {
  const config = parseConfig({
    SOLANA_HTTP_RPC_URL: 'https://rpc.example.invalid',
    SOLANA_WS_RPC_URL: 'wss://rpc.example.invalid',
    QUALIFICATION_MIN_SCORE: '61',
  });
  const report = createQualificationEngine(config).evaluate({
    evaluatedAtMs: 1,
    signals: {
      imageValid: true,
      socialCrossLinkConfirmed: true,
      creatorHasNotSold: true,
    },
    blockers: [],
    calibrationFacts: null,
  });

  assert.equal(report.ruleSet.minimumTotalScore, 61);
  assert.equal(report.verdict, 'WATCHLISTED');
});

void test('refuse un profil effectif mutable avant de le consommer', () => {
  const mutableRuleSet = {
    ...defaultQualificationRuleSet,
    rules: defaultQualificationRuleSet.rules.map((rule) => ({ ...rule })),
  };
  assert.throws(() => new QualificationEngine(mutableRuleSet), /PROFILE_SCHEMA_INVALID/u);
});

void test('propagates the effective profile fingerprint and all calibrated conditions', () => {
  const engine = new QualificationEngine(defaultQualificationRuleSet);
  const report = engine.evaluate({
    evaluatedAtMs: 1,
    signals: {
      imageValid: true,
      socialCrossLinkConfirmed: true,
      creatorHasNotSold: true,
      reverseQuoteAvailable: true,
      externalBuyersObserved: true,
    },
    blockers: [],
    calibrationFacts: null,
  });

  assert.equal(report.ruleSet.fingerprint, defaultQualificationRuleSet.fingerprint);
  assert.equal(report.conditions.length, 14);
  assert.equal(engine.profileSummary.fingerprint, defaultQualificationRuleSet.fingerprint);
  assert.ok(Object.isFrozen(engine.profileSummary));
});

void test('lets report-only calibration conditions remain visible without rejecting', () => {
  const report = new QualificationEngine(profileWithPolicy('MINT_SOCIAL_MISMATCH', {
    mode: 'REPORT_ONLY',
  })).evaluate({
    evaluatedAtMs: 1,
    signals: {
      imageValid: true,
      socialCrossLinkConfirmed: true,
      creatorHasNotSold: true,
      reverseQuoteAvailable: true,
      externalBuyersObserved: true,
    },
    blockers: ['MINT_SOCIAL_MISMATCH'],
    calibrationFacts: noCalibrationFacts(),
  });

  assert.equal(report.conditions.find((item) => item.code === 'MINT_SOCIAL_MISMATCH')?.status, 'TRIGGERED');
  assert.equal(report.blockers.length, 0);
  assert.equal(report.verdict, 'QUALIFIED');
});

void test('reports a triggered report-only wallet cluster without rejecting', () => {
  const report = new QualificationEngine(profileWithPolicy('RELATED_WALLET_CLUSTER_EXCEEDED', {
    mode: 'REPORT_ONLY',
    maximumClusterBps: 400,
  })).evaluate({
    evaluatedAtMs: 1,
    signals: {
      imageValid: true,
      socialCrossLinkConfirmed: true,
      creatorHasNotSold: true,
      reverseQuoteAvailable: true,
      externalBuyersObserved: true,
    },
    blockers: [],
    calibrationFacts: Object.freeze({
      ...noCalibrationFacts(),
      maximumRelatedClusterBps: 401n,
    }),
  });

  assert.equal(report.conditions.find((item) => item.code === 'RELATED_WALLET_CLUSTER_EXCEEDED')?.status, 'TRIGGERED');
  assert.equal(report.blockers.length, 0);
  assert.equal(report.verdict, 'QUALIFIED');
});

void test('uses the effective profile minimum override and keeps null facts compatible with legacy blockers', () => {
  const config = parseConfig({
    SOLANA_HTTP_RPC_URL: 'https://rpc.example.invalid',
    SOLANA_WS_RPC_URL: 'wss://rpc.example.invalid',
    QUALIFICATION_MIN_SCORE: '61',
  });
  const report = createQualificationEngine(config).evaluate({
    evaluatedAtMs: 1,
    signals: {
      imageValid: true,
      socialCrossLinkConfirmed: true,
      creatorHasNotSold: true,
      reverseQuoteAvailable: true,
      externalBuyersObserved: true,
    },
    blockers: ['STALE_DATA'],
    calibrationFacts: null,
  });

  assert.equal(report.ruleSet.minimumTotalScore, 61);
  assert.equal(report.scores.total.score, 100);
  assert.deepEqual(report.blockers.map((item) => item.code), ['STALE_DATA']);
  assert.equal(report.verdict, 'REJECTED');
});
