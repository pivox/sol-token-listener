import type { ChainConfirmationStatus } from '../domain/types.js';
import type { PaperDecisionJobInput } from '../ports/paper-decision-repository.js';
import type { CanonicalQualificationProjection } from '../ports/qualification-projection-repository.js';
import type { MissingCanonicalLaunchPolicy } from './qualification-projection.service.js';

interface QualificationProjectionRefresher {
  rebuild(
    mint:string,
    missingLaunchPolicy:MissingCanonicalLaunchPolicy,
  ):Promise<Readonly<{
    kind:'UPDATED'|'UNCHANGED';
    projection:CanonicalQualificationProjection;
  }> | Readonly<{ kind:'DISSOLVED';projection:null }>>;
}

interface PaperDecisionScheduler {
  enqueue(input:PaperDecisionJobInput):Promise<void>;
}

export class SocialQualificationRefreshService {
  public constructor(
    private readonly qualification:QualificationProjectionRefresher,
    private readonly paper:PaperDecisionScheduler,
  ) {}

  public async refresh(mint:string):Promise<void>{
    const rebuilt=await this.qualification.rebuild(mint,'ERROR');
    if(rebuilt.kind==='DISSOLVED'){
      throw new TypeError('Social qualification refresh lost its canonical launch.');
    }
    const projection=rebuilt.projection;
    if(projection.qualificationEvent.mint!==mint){
      throw new TypeError('Social qualification refresh mint is invalid.');
    }
    await this.paper.enqueue(Object.freeze({
      mint,
      sourceEventId:projection.sourceEventId,
      sourceRawEventId:projection.sourceRawEventId,
      sourceConfirmationStatus:confirmationStatus(
        projection.qualificationEvent.confirmationStatus,
      ),
      inputFingerprint:projection.evidenceFingerprint,
    }));
  }
}

function confirmationStatus(value:ChainConfirmationStatus):ChainConfirmationStatus{
  if(!['processed','confirmed','finalized'].includes(value)){
    throw new TypeError('Social qualification refresh confirmation is invalid.');
  }
  return value;
}
