import { SNAPSHOT_SECONDS, snapshotPosition, summarizePosition, type Snapshot, type Observation } from './position.js';
import type { NormalizedPosition } from './runner.js';
export interface Fraction { numerator: string; denominator: string }
export interface Statistics { n: number; missing: number; mean: Fraction | null; median: Fraction | null; min: string | null; max: string | null }
export function exactStats(values: (string | null)[]): Statistics {
  const n = values.flatMap(v => v === null ? []:[BigInt(v)]).sort((a,b) => a < b ? -1:a > b ? 1:0);
  const middle=Math.floor(n.length/2);
  return {n:n.length,missing:values.length-n.length,
    mean:n.length === 0 ? null:{numerator:String(n.reduce((a,b)=>a+b,0n)),denominator:String(n.length)},
    median:n.length === 0 ? null:n.length%2 === 0 ? {numerator:String(required(n[middle-1])+required(n[middle])),denominator:'2'}:{numerator:String(required(n[middle])),denominator:'1'},
    min:n[0]?.toString() ?? null,max:n.at(-1)?.toString() ?? null};
}
function metrics(s: Snapshot): Record<string,string|null> {
  const str=(v: number|boolean|null|undefined): string|null => v == null ? null:typeof v === 'boolean' ? v ? '1':'0':String(v);
  return { uniqueBuyers:str(s.activity?.uniqueBuyers),buyCount:str(s.activity?.buyCount),sellCount:str(s.activity?.sellCount),
    buyVolumeQuoteRaw:s.activity?.buyVolumeQuoteRaw ?? null,sellVolumeQuoteRaw:s.activity?.sellVolumeQuoteRaw ?? null,
    netQuoteFlowRaw:s.activity?.netQuoteFlowRaw ?? null,buySellRatioBps:s.activity?.buySellRatioBps === 'NO_SELL' ? null:s.activity?.buySellRatioBps ?? null,
    averageBuyPerBuyerRaw:s.activity?.averageBuyPerBuyerRaw ?? null,buyersInClusters:str(s.clusters?.buyersInClusters),
    clusterCount:str(s.clusters?.clusterCount),largestBuyerCluster:str(s.clusters?.largestBuyerCluster),
    sharedFunderCluster:str(s.clusters?.sharedFunderCluster),strongRelationsPresent:str(s.clusters?.strongRelationsPresent),
    strongRelationshipCount:str(s.clusters?.strongRelationshipCount),creatorBuyCount:str(s.creator?.creatorBuyCount),creatorSellCount:str(s.creator?.creatorSellCount),
    creatorBuyVolumeRaw:s.creator?.creatorBuyVolumeRaw ?? null,creatorSellVolumeRaw:s.creator?.creatorSellVolumeRaw ?? null,
    creatorNetFlowRaw:s.creator?.creatorNetFlowRaw ?? null,timeToFirstCreatorSellMs:str(s.creator?.timeToFirstCreatorSellMs),
    netExecutablePnlRaw:s.netExecutablePnlRaw,grossPnlRaw:s.grossPnlRaw,observedMfeRaw:s.observedMfeRaw,observedMaeRaw:s.observedMaeRaw,
    netFlowDeltaRaw:s.momentum?.netFlowDeltaRaw ?? null,buyVolumeDeltaRaw:s.momentum?.buyVolumeDeltaRaw ?? null,
    sellVolumeDeltaRaw:s.momentum?.sellVolumeDeltaRaw ?? null,uniqueBuyersDelta:str(s.momentum?.uniqueBuyersDelta) };
}
function positionAnalysis(p: NormalizedPosition): {
  entry: NormalizedPosition['entry']; group:'WIN'|'LOSS'|'UNKNOWN'|'ORPHANED_ENTRY'; snapshots:Snapshot[];
  summary:ReturnType<typeof summarizePosition>; orphanedTradeIds:string[];
} {
  const latest=new Map(p.observations.flatMap(o=>o.trades.map(t=>[t.id,t] as const)));
  const orphaned=[...latest.values()].filter(t=>t.confirmation === 'orphaned');
  const invalid = new Set(orphaned.map(t=>t.id));
  // Negative reconciliation only: no later positive fact is introduced into an earlier snapshot.
  const observations:Observation[]=p.observations.map(o=>({...o,trades:o.trades.filter(t=>!invalid.has(t.id)),graphAvailable:o.graphAvailable && invalid.size === 0,
    quote:invalid.size>0 && o.quote?.status==='AVAILABLE' ? {status:'UNAVAILABLE',reason:'REORG_QUOTE_PROVENANCE_UNVERIFIABLE'}:o.quote}));
  const snapshots:Snapshot[]=[];
  for (const sec of SNAPSHOT_SECONDS) snapshots.push(snapshotPosition(p.entry,observations,p.entry.entryAtMs+sec*1000,snapshots.at(-1)));
  const pnl=p.entry.exit?.realizedNetPnlRaw;
  return {entry:p.entry,group:orphaned.some(t=>t.signature === p.entry.buySignature) ? 'ORPHANED_ENTRY':pnl == null ? 'UNKNOWN':BigInt(pnl)>0n?'WIN':'LOSS',
    snapshots,summary:summarizePosition(p.entry,observations),orphanedTradeIds:[...invalid]};
}
function thresholdRaw(usdt: string, price: string | null): bigint|null {
  const frac=(v:string): [bigint,bigint]|null=>{const m=/^(\d+)(?:\.(\d+))?$/.exec(v);return m?[BigInt(required(m[1])+(m[2]??'')),10n**BigInt(m[2]?.length??0)]:null;};
  const a=frac(usdt); const b=price===null?null:frac(price);
  if (!a || !b || b[0]===0n) return null;
  const num=a[0]*b[1]*1000000000n; const den=a[1]*b[0];
  return -(num+den-1n)/den;
}
interface Counterfactual {
  rule:string; quoteMint:string; eligible:number; unavailable:number; triggered:number;
  winningPositionsCut:number; losingPositionsCut:number; simulatedDeltaRaw:string;
  outcomes:{positionId:string;atMs:number;actualRaw:string;simulatedRaw:string;deltaRaw:string}[];
}
export function analyzeDataset(dataset: readonly NormalizedPosition[]): {
  positions:ReturnType<typeof positionAnalysis>[];
  comparisons:{seconds:number;quoteMint:string;WIN:Record<string,Statistics>;LOSS:Record<string,Statistics>;noSell:{WIN:number;LOSS:number};closed:{WIN:number;LOSS:number}}[];
  counterfactuals:Counterfactual[];
} {
  const positions=dataset.map(positionAnalysis);
  const comparisons=[]; const counterfactuals:Counterfactual[]=[];
  for (const quoteMint of [...new Set(positions.map(p=>p.entry.quoteMint))]) {
    for (const [i,seconds] of SNAPSHOT_SECONDS.entries()) {
      const groups={WIN:{} as Record<string,Statistics>,LOSS:{} as Record<string,Statistics>};
      const noSell={WIN:0,LOSS:0}; const closed={WIN:0,LOSS:0};
      for (const group of ['WIN','LOSS'] as const) {
        const population=positions.filter(p=>p.group===group && p.entry.quoteMint===quoteMint).map(p=>required(p.snapshots[i]));
        for (const key of Object.keys(population[0] ? metrics(population[0]):{})) groups[group][key]=exactStats(population.map(s=>metrics(s)[key]??null));
        noSell[group]=population.filter(s=>s.activity?.buySellRatioBps==='NO_SELL').length;
        closed[group]=population.filter(s=>s.activityStatus==='POSITION_CLOSED').length;
      }
      comparisons.push({seconds,quoteMint,...groups,noSell,closed});
    }
    for (const rule of ['loss_usdt_0.03','loss_usdt_0.05','loss_usdt_0.08','loss_usdt_0.10','negative_window_net_flow','decreasing_buy_volume_rate']) {
      const result:Counterfactual={rule,quoteMint,eligible:0,unavailable:0,triggered:0,winningPositionsCut:0,losingPositionsCut:0,simulatedDeltaRaw:'0',outcomes:[]};
      for (const p of positions.filter(p=>p.entry.quoteMint===quoteMint && (p.group==='WIN'||p.group==='LOSS'))) {
        const threshold=rule.startsWith('loss_usdt_')?thresholdRaw(rule.slice(10),p.entry.solUsdt):null;
        // Conversion only applies to the SOL quote asset used by these runners.
        const isSol=['SOL','So11111111111111111111111111111111111111112'].includes(quoteMint);
        const points=p.snapshots.filter(s=>s.netExecutablePnlRaw!==null && (rule.startsWith('loss_usdt_') ? threshold!==null && isSol:s.momentum!==null));
        if (points.length===0) {result.unavailable++;continue;}
        result.eligible++;
        const point=points.find(s=>{
          if (rule.startsWith('loss_usdt_')) return BigInt(required(s.netExecutablePnlRaw))<=required(threshold);
          if (rule==='negative_window_net_flow') return BigInt(required(s.momentum).netFlowDeltaRaw)<0n;
          const index=p.snapshots.indexOf(s); const prior=p.snapshots[index-1]; const before=p.snapshots[index-2];
          return prior?.momentum != null && before !== undefined
            && BigInt(required(s.momentum).buyVolumeDeltaRaw)*BigInt(prior.atMs-before.atMs)
              < BigInt(prior.momentum.buyVolumeDeltaRaw)*BigInt(s.atMs-prior.atMs);
        });
        if (!point) continue;
        const actual=required(p.summary.realizedNetPnlRaw); const delta=BigInt(required(point.netExecutablePnlRaw))-BigInt(actual);
        result.triggered++;if(p.group==='WIN')result.winningPositionsCut++;else result.losingPositionsCut++;
        result.simulatedDeltaRaw=String(BigInt(result.simulatedDeltaRaw)+delta);
        result.outcomes.push({positionId:p.entry.positionId,atMs:point.atMs,actualRaw:actual,simulatedRaw:required(point.netExecutablePnlRaw),deltaRaw:String(delta)});
      }
      counterfactuals.push(result);
    }
  }
  return {positions,comparisons,counterfactuals};
}
const fraction=(v:Fraction|null):string=>v===null?'UNAVAILABLE':v.denominator==='1'?v.numerator:`${v.numerator}/${v.denominator}`;
const stat=(s:Statistics|undefined):string=>s===undefined?'n=0':`n=${String(s.n)}, abs=${String(s.missing)}; méd=${fraction(s.median)}; moy=${fraction(s.mean)}; min=${s.min??'—'}; max=${s.max??'—'}`;
export function renderReport(report:ReturnType<typeof analyzeDataset>):string {
  const lines=['# Mesure des positions — analyse offline','',
    'Petite population : aucune conclusion statistique forte. Les extrema sont observés, pas continus. Les moyennes et médianes sont des fractions exactes en unités raw. Absence ≠ zéro. WIN > 0 ; LOSS ≤ 0 ; UNKNOWN exclu de ces groupes.',
    '',`Positions : ${String(report.positions.length)} ; WIN : ${String(report.positions.filter(p=>p.group==='WIN').length)} ; LOSS : ${String(report.positions.filter(p=>p.group==='LOSS').length)} ; non classées : ${String(report.positions.filter(p=>!['WIN','LOSS'].includes(p.group)).length)}.`,
    '', 'Les snapshots utilisent exclusivement les preuves disponibles au cutoff. Les événements ultérieurement orphaned sont exclus dans cette vue réconciliée ; les snapshots originaux restent dans le journal. Après fermeture : POSITION_CLOSED, sans quote fictive. Les données DB sont celles observées par le listener, sans garantie de couverture exhaustive.', ''];
  for(const c of report.comparisons){lines.push(`## T+${String(c.seconds)} s — ${c.quoteMint}`,'',`NO_SELL WIN/LOSS : ${String(c.noSell.WIN)}/${String(c.noSell.LOSS)}. Déjà fermées WIN/LOSS : ${String(c.closed.WIN)}/${String(c.closed.LOSS)}.`, '', '| Mesure | WIN | LOSS |','|---|---|---|');
    for(const key of new Set([...Object.keys(c.WIN),...Object.keys(c.LOSS)]))lines.push(`| ${key} | ${stat(c.WIN[key])} | ${stat(c.LOSS[key])} |`);lines.push('');}
  lines.push('## Simulations contrefactuelles','', 'Sorties hypothétiques aux seuls checkpoints observés, au minimum de quote et avec réserve réseau. Exécution, latence et inclusion non garanties. Aucun seuil sélectionné automatiquement ; aucune stratégie live modifiée. Comparer les gagnants coupés aux perdants coupés. Une validation ultérieure doit utiliser un autre dataset. La conversion USDT est indicative et figée au cours du BUY.', '', '| Règle | Quote | Éligibles | Indisponibles | Déclenchements | WIN coupés | LOSS coupés | Delta hypothétique raw |','|---|---|---:|---:|---:|---:|---:|---:|');
  for(const c of report.counterfactuals)lines.push(`| ${c.rule} | ${c.quoteMint} | ${String(c.eligible)} | ${String(c.unavailable)} | ${String(c.triggered)} | ${String(c.winningPositionsCut)} | ${String(c.losingPositionsCut)} | ${c.simulatedDeltaRaw} |`);
  for(const p of report.positions){lines.push('',`## Position ${p.entry.positionId}`, '',`Mint : ${p.entry.mint}. BUY : ${p.entry.buySignature}. Groupe : ${p.group}. PnL réalisé raw : ${p.summary.realizedNetPnlRaw??'UNKNOWN'}. Sortie : ${p.summary.exitReason??'UNKNOWN'}. Orphans exclus : ${String(p.orphanedTradeIds.length)}.`, '', '| T+ s | État | Buyers | Net flow raw | Net exécutable raw | MFE observé | MAE observé |','|---:|---|---:|---:|---:|---:|---:|');
    for(const s of p.snapshots)lines.push(`| ${String(s.elapsedMs/1000)} | ${s.quote.status==='UNAVAILABLE'?s.quote.reason:'QUOTE_AVAILABLE'} | ${s.activity?.uniqueBuyers??'UNKNOWN'} | ${s.activity?.netQuoteFlowRaw??'UNKNOWN'} | ${s.netExecutablePnlRaw??'UNAVAILABLE'} | ${s.observedMfeRaw??'UNAVAILABLE'} | ${s.observedMaeRaw??'UNAVAILABLE'} |`);}
  return lines.join('\n')+'\n';
}

function required<T>(value:T|null|undefined):T { if(value==null)throw new Error("MISSING_ANALYSIS_VALUE");return value; }
