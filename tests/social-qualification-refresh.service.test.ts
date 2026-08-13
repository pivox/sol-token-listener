import assert from 'node:assert/strict';
import test from 'node:test';
import { SocialQualificationRefreshService } from '../src/application/social-qualification-refresh.service.js';
import type { CanonicalQualificationProjection } from '../src/ports/qualification-projection-repository.js';

void test('enqueues paper from the exact canonical projection rebuilt after social evidence',async()=>{
  const projection=canonicalProjection();
  const rebuilds:unknown[][]=[];
  const enqueued:unknown[]=[];
  const service=new SocialQualificationRefreshService({
    rebuild:async(...args:unknown[])=>{
      rebuilds.push(args);
      return Object.freeze({ kind:'UPDATED' as const,projection });
    },
  },{
    enqueue:async(input:unknown)=>{enqueued.push(input);},
  });

  await service.refresh('MINT');

  assert.deepEqual(rebuilds,[['MINT','ERROR']]);
  assert.deepEqual(enqueued,[{
    mint:'MINT',sourceEventId:'evt_new_canonical',sourceRawEventId:'raw_new_canonical',
    sourceConfirmationStatus:'finalized',inputFingerprint:'d'.repeat(64),
  }]);
});

function canonicalProjection():CanonicalQualificationProjection{
  const report=Object.freeze({
    ruleSet:Object.freeze({
      id:'profile',version:1,status:'UNVALIDATED_RULE_SET' as const,
      minimumTotalScore:60,fingerprint:'c'.repeat(64),
    }),
    scores:Object.freeze({
      preparation:Object.freeze({ score:0,maximum:0 }),
      socialAuthenticity:Object.freeze({ score:0,maximum:0 }),
      onchainHealth:Object.freeze({ score:0,maximum:0 }),
      total:Object.freeze({ score:0,maximum:100 }),
    }),
    evidence:Object.freeze([]),conditions:Object.freeze([]),blockers:Object.freeze([]),
    verdict:'WATCHLISTED' as const,evaluatedAtMs:2_000,
  });
  const evaluation=Object.freeze({
    evaluatedAtMs:2_000,signals:Object.freeze({}),blockers:Object.freeze([]),calibrationFacts:null,
  });
  return Object.freeze({
    reportId:`qreport_${'b'.repeat(64)}`,sourceEventId:'evt_new_canonical',
    sourceRawEventId:'raw_new_canonical',evidenceFingerprint:'d'.repeat(64),
    evaluation,report,qualificationEvent:Object.freeze({
      id:'evt_qualification',type:'QualificationUpdated' as const,mint:'MINT',
      source:'qualification',program:'pump',signature:'new-signature',
      cursor:Object.freeze({
        slot:20n,transactionIndex:0,instructionIndex:2,innerInstructionIndex:null,
      }),confirmationStatus:'finalized' as const,blockchainTimeMs:1_900,
      observedAtMs:2_000,payloadVersion:1,payload:Object.freeze({
        reportId:`qreport_${'b'.repeat(64)}`,evidenceFingerprint:'d'.repeat(64),evaluation,report,
      }),
    }),
  });
}
