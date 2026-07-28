import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createQualificationEngine,
  QualificationEngine,
  createDefaultQualificationRuleSet,
  defaultQualificationRuleSet,
} from '../src/qualification/qualification-engine.js';
import { parseConfig } from '../src/config/env.js';

void test('qualifie un lancement dont les trois dimensions atteignent le seuil', () => {
  const report = new QualificationEngine(defaultQualificationRuleSet).evaluate({
    evaluatedAtMs: 1,
    signals: {
      imageValid: true,
      socialCrossLinkConfirmed: true,
      creatorHasNotSold: true,
    },
    blockers: [],
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
  });

  assert.equal(report.ruleSet.minimumTotalScore, 61);
  assert.equal(report.verdict, 'WATCHLISTED');
});

void test('snapshotte le ruleset pour empêcher une mutation après validation', () => {
  const mutableRuleSet = {
    ...defaultQualificationRuleSet,
    rules: defaultQualificationRuleSet.rules.map((rule) => ({ ...rule })),
  };
  const engine = new QualificationEngine(mutableRuleSet);
  const socialRule = mutableRuleSet.rules.find((rule) => rule.signal === 'socialCrossLinkConfirmed');
  if (socialRule === undefined) throw new Error('Règle sociale manquante dans la fixture.');
  socialRule.weight = 100;

  const report = engine.evaluate({
    evaluatedAtMs: 1,
    signals: { socialCrossLinkConfirmed: true, creatorHasNotSold: true },
    blockers: [],
  });

  assert.equal(report.scores.total.score, 45);
  assert.equal(report.verdict, 'WATCHLISTED');
});
