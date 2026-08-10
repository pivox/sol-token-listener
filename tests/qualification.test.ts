import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createQualificationEngine,
  QualificationEngine,
  createDefaultQualificationRuleSet,
} from '../src/qualification/qualification-engine.js';
import { parseConfig } from '../src/config/env.js';
import type { QualificationCalibrationFacts } from '../src/domain/qualification.js';
import type { QualificationReasonCode } from '../src/domain/qualification-reasons.js';
import { parseQualificationProfile } from '../src/qualification/qualification-profile.js';

const defaultQualificationRuleSet = createDefaultQualificationRuleSet(60);

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

function completeInput() {
  return {
    evaluatedAtMs: 1,
    signals: {
      imageValid: true,
      socialCrossLinkConfirmed: true,
      creatorHasNotSold: true,
      reverseQuoteAvailable: true,
      externalBuyersObserved: true,
    },
    blockers: [] as QualificationReasonCode[],
    calibrationFacts: null,
  };
}

void test('imports the qualification engine without reading the bundled profile', () => {
  const script = `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const require = createRequire(import.meta.url);
    const fileSystem = require('node:fs');
    const originalOpenSync = fileSystem.openSync;
    let bundledOpenCount = 0;
    fileSystem.openSync = (...arguments_) => {
      if (String(arguments_[0]).includes('/config/qualification/pumpfun-v1-unvalidated.json')) bundledOpenCount += 1;
      return originalOpenSync(...arguments_);
    };
    syncBuiltinESMExports();
    await import('./src/qualification/qualification-engine.ts');
    if (bundledOpenCount !== 0) process.exitCode = 1;
  `;
  const result = spawnSync(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    script,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
});

void test('creates an engine from the selected custom profile without reading the bundled default', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qualification-engine-selected-profile-'));
  const customPath = join(directory, 'custom.json');
  try {
    const raw = JSON.parse(readFileSync(
      new URL('../config/qualification/pumpfun-v1-unvalidated.json', import.meta.url),
      'utf8',
    )) as { id: string };
    raw.id = 'selected-custom-profile';
    writeFileSync(customPath, JSON.stringify(raw));
    const script = `
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      const require = createRequire(import.meta.url);
      const fileSystem = require('node:fs');
      const originalOpenSync = fileSystem.openSync;
      let bundledOpenCount = 0;
      let customOpenCount = 0;
      fileSystem.openSync = (...arguments_) => {
        const openedPath = String(arguments_[0]);
        if (openedPath.includes('/config/qualification/pumpfun-v1-unvalidated.json')) bundledOpenCount += 1;
        if (openedPath === ${JSON.stringify(customPath)}) customOpenCount += 1;
        return originalOpenSync(...arguments_);
      };
      syncBuiltinESMExports();
      const { createQualificationEngine } = await import('./src/qualification/qualification-engine.ts');
      const engine = createQualificationEngine({
        qualificationProfilePath: ${JSON.stringify(customPath)},
        qualificationMinimumScore: null,
      });
      if (engine.profileSummary.id !== 'selected-custom-profile' || bundledOpenCount !== 0 || customOpenCount !== 1) process.exitCode = 1;
    `;
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('rejects hostile qualification input shapes without invoking getters or proxy traps', () => {
  const engine = new QualificationEngine(defaultQualificationRuleSet);
  let rootGetterReads = 0;
  const rootAccessor = Object.freeze(Object.defineProperty(completeInput(), 'evaluatedAtMs', {
    enumerable: true,
    get(): number { rootGetterReads += 1; return 1; },
  }));
  let signalGetterReads = 0;
  const signalAccessor = Object.freeze(Object.defineProperty({ ...completeInput().signals }, 'imageValid', {
    enumerable: true,
    get(): boolean { signalGetterReads += 1; return true; },
  }));
  let proxyTraps = 0;
  const signalsProxy = new Proxy({}, {
    get() { proxyTraps += 1; throw new Error('must not read proxy'); },
    getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('must not inspect proxy'); },
    ownKeys() { proxyTraps += 1; throw new Error('must not enumerate proxy'); },
  });

  assert.throws(() => engine.evaluate(rootAccessor as unknown as ReturnType<typeof completeInput>));
  assert.throws(() => engine.evaluate({ ...completeInput(), signals: signalAccessor }));
  assert.throws(() => engine.evaluate({ ...completeInput(), signals: signalsProxy }));
  assert.equal(rootGetterReads, 0);
  assert.equal(signalGetterReads, 0);
  assert.equal(proxyTraps, 0);
});

void test('rejects inherited, unknown, and non-boolean qualification signals before scoring', () => {
  const engine = new QualificationEngine(defaultQualificationRuleSet);
  const inherited = Object.create({ imageValid: true }) as Record<string, boolean>;
  inherited.socialCrossLinkConfirmed = true;
  inherited.creatorHasNotSold = true;
  assert.throws(() => engine.evaluate({ ...completeInput(), signals: inherited }));
  assert.throws(() => engine.evaluate({
    ...completeInput(),
    signals: { ...completeInput().signals, unexpected: true } as Record<string, boolean>,
  }));
  assert.throws(() => engine.evaluate({
    ...completeInput(),
    signals: { ...completeInput().signals, imageValid: 'true' as unknown as boolean },
  }));
});

void test('uses an immutable qualification input snapshot', () => {
  const engine = new QualificationEngine(defaultQualificationRuleSet);
  const input = completeInput();
  const report = engine.evaluate(input);
  input.signals.imageValid = false;
  input.blockers.push('STALE_DATA');

  assert.equal(report.verdict, 'QUALIFIED');
  assert.equal(report.scores.total.score, 100);
  assert.equal(report.blockers.length, 0);
});

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

void test('authorizes only the exact reports emitted by the same qualification engine', () => {
  const engine = new QualificationEngine(defaultQualificationRuleSet);
  const otherEngine = new QualificationEngine(defaultQualificationRuleSet);
  const subject = { mint: 'MINT', triggerEventId: 'trigger' };
  const plainReport = engine.evaluate(completeInput());
  const report = engine.evaluateAuthorized(subject, completeInput());

  assert.equal(engine.isAuthorized(plainReport, subject), false);
  assert.equal(engine.isAuthorized(report, subject), true);
  assert.equal(engine.isAuthorized(report, { ...subject, mint: 'OTHER' }), false);
  assert.equal(engine.isAuthorized(report, { ...subject, triggerEventId: 'other' }), false);
  assert.equal(engine.isAuthorized(structuredClone(report), subject), false);
  assert.equal(otherEngine.isAuthorized(report, subject), false);
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

void test('preserves the selected profile minimum unless the environment overrides it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qualification-profile-minimum-'));
  const profilePath = join(directory, 'profile.json');
  try {
    const raw = JSON.parse(readFileSync(
      new URL('../config/qualification/pumpfun-v1-unvalidated.json', import.meta.url),
      'utf8',
    )) as { minimumTotalScore: number };
    raw.minimumTotalScore = 73;
    writeFileSync(profilePath, JSON.stringify(raw));
    const baseEnvironment = {
      SOLANA_HTTP_RPC_URL: 'https://rpc.example.invalid',
      SOLANA_WS_RPC_URL: 'wss://rpc.example.invalid',
      QUALIFICATION_PROFILE_PATH: profilePath,
    };

    assert.equal(createQualificationEngine(parseConfig(baseEnvironment)).minimumTotalScore, 73);
    assert.equal(createQualificationEngine(parseConfig({
      ...baseEnvironment,
      QUALIFICATION_MIN_SCORE: '61',
    })).minimumTotalScore, 61);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
