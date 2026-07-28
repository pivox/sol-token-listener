import { createServer, type Server } from 'node:http';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.js';
import type { Heartbeat } from '../heartbeat/heartbeat.js';
import type {
  PoolRepository,
  RiskReportRepository,
  SessionRepository,
  TradeRepository,
} from '../storage/repositories.js';
import { handleDashboardAction, writeJson } from './action-dashboard.js';
import type { DashboardActionService } from './dashboard-action.service.js';

export class Dashboard {
  private server: Server | null = null;

  constructor(
    private readonly config: Pick<AppConfig, 'dashboardHost' | 'dashboardPort' | 'dashboardMaxRows' | 'dashboardRefreshSeconds'>,
    private readonly pools: PoolRepository,
    private readonly sessions: SessionRepository,
    private readonly trades: TradeRepository,
    private readonly risks: RiskReportRepository,
    private readonly heartbeat: Heartbeat,
    private readonly actions: DashboardActionService,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.server) return;
    this.server = createServer((request, response) => { void this.route(request, response); });
    this.server.listen(this.config.dashboardPort, this.config.dashboardHost, () => {
      this.logger.info({ host: this.config.dashboardHost, port: this.config.dashboardPort }, 'Dashboard local démarré.');
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server?.close((error) => error ? reject(error) : resolve()));
    this.server = null;
  }

  private async route(request: Parameters<typeof handleDashboardAction>[0], response: Parameters<typeof handleDashboardAction>[1]): Promise<void> {
    if (await handleDashboardAction(request, response, this.actions)) return;
    if (request.method === 'GET' && request.url === '/healthz') {
      writeJson(response, 200, { ok: true, heartbeat: this.heartbeat.get() });
      return;
    }
    if (request.method === 'GET' && request.url === '/api/state') {
      try { writeJson(response, 200, await this.state()); }
      catch (error) { writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (request.method === 'GET' && (request.url === '/' || request.url === '/index.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(renderHtml(this.config.dashboardRefreshSeconds));
      return;
    }
    writeJson(response, 404, { error: 'Route introuvable.' });
  }

  private async state(): Promise<Record<string, unknown>> {
    const [pools, sessions] = await Promise.all([
      this.pools.list(this.config.dashboardMaxRows),
      this.sessions.list(this.config.dashboardMaxRows),
    ]);
    const enriched = await Promise.all(sessions.map(async (session) => {
      const [trades, risk] = await Promise.all([
        this.trades.listBySession(session.id),
        this.risks.latestBySession(session.id),
      ]);
      return { session, trades, risk, pnl: calculatePnl(session) };
    }));
    return { generatedAt: new Date().toISOString(), heartbeat: this.heartbeat.get(), pools, sessions: enriched };
  }
}

export function calculatePnl(session: Awaited<ReturnType<SessionRepository['list']>>[number]): Record<string, unknown> | null {
  if (!session.entry || !session.exit) return null;
  const gross = session.exit.amountOutLamports - session.entry.amountInLamports;
  const costsKnown = session.entry.feeLamports !== undefined && session.exit.feeLamports !== undefined
    && session.entry.rentDeltaLamports !== undefined && session.exit.rentDeltaLamports !== undefined;
  const net = costsKnown
    ? gross - session.entry.feeLamports! - session.exit.feeLamports!
      - session.entry.rentDeltaLamports! + session.exit.rentDeltaLamports!
    : null;
  return {
    grossLamports: gross.toString(),
    netLamports: net?.toString() ?? null,
    netAvailable: net !== null,
    note: net === null ? 'Coûts incomplets: aucun PnL net n’est affiché.' : null,
  };
}

function renderHtml(refreshSeconds: number): string {
  const refreshMs = refreshSeconds * 1000;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Solana Token Listener</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0c111b;color:#e8eef9}body{margin:0;padding:24px}.wrap{max-width:1500px;margin:auto}h1{margin:0 0 8px}.muted{color:#9aabc4}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:20px 0}.card,table{background:#151d2b;border:1px solid #26344a;border-radius:10px}.card{padding:14px}.value{font-size:1.25rem;font-weight:700}table{width:100%;border-collapse:collapse;overflow:hidden}th,td{text-align:left;padding:10px;border-bottom:1px solid #26344a;font-size:.88rem}th{position:sticky;top:0;background:#1b2638}.ok{color:#66d9a8}.warn{color:#ffd166}.bad{color:#ff7b89}code{font-size:.78rem;word-break:break-all}a{color:#7ab8ff}.scroll{overflow:auto;max-height:72vh}</style></head><body><div class="wrap">
<h1>Solana Token Listener</h1><div class="muted">Raydium CPMM · supervision locale · aucune garantie de position dans le slot</div>
<div id="cards" class="cards"></div><div class="scroll"><table><thead><tr><th>Statut</th><th>Token / Pool</th><th>Liquidité / risque</th><th>Premier achat</th><th>Progression</th><th>Entrée / sortie</th><th>PnL</th><th>Erreur</th></tr></thead><tbody id="rows"></tbody></table></div>
<script>
const solscan=(kind,value)=>value?'https://solscan.io/'+kind+'/'+value:'';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=v=>v?esc(v.slice(0,6)+'…'+v.slice(-6)):'—';
async function refresh(){try{const r=await fetch('/api/state',{cache:'no-store'});const d=await r.json();const h=d.heartbeat||{};
document.getElementById('cards').innerHTML=[['Slot HTTP',h.lastHttpSlot],['Slot WebSocket',h.lastWebsocketSlot],['Retard slots',h.lagSlots],['Finalisé',h.lastFinalizedSlot],['Sessions actives',h.activeSessions],['En attente',h.pendingTransactions]].map(x=>'<div class="card"><div class="muted">'+esc(x[0])+'</div><div class="value">'+esc(x[1]??'—')+'</div></div>').join('');
document.getElementById('rows').innerHTML=(d.sessions||[]).map(x=>{const s=x.session,r=x.risk,p=x.pnl;const verdict=r?.verdict||'—';const cls=verdict==='ALLOW'?'ok':verdict==='BLOCK'?'bad':'warn';return '<tr><td><b>'+esc(s.status)+'</b><br><span class="'+cls+'">'+esc(verdict)+(r?' '+r.score+'/100':'')+'</span></td><td><a target="_blank" href="'+solscan('token',s.pool.tokenMint)+'">'+short(s.pool.tokenMint)+'</a><br><a target="_blank" href="'+solscan('account',s.pool.pool)+'">'+short(s.pool.pool)+'</a><br><span class="muted">'+esc(s.pool.tokenProgram)+'</span></td><td>'+esc(r?.checks?.find(c=>c.code==='WSOL_LIQUIDITY')?.message||'—')+'<br><span class="muted">'+esc((r?.extensions||[]).join(', '))+'</span></td><td>'+(s.firstBuy?'<a target="_blank" href="'+solscan('tx',s.firstBuy.signature)+'">'+short(s.firstBuy.signature)+'</a>':'—')+'</td><td>'+esc(s.subsequentBuyCount)+' / '+esc(s.targetBuysAfterEntry)+'</td><td>'+tx(s.entry)+'<br>'+tx(s.exit)+'</td><td>'+(p?(p.netAvailable?'net '+esc(p.netLamports):'brut '+esc(p.grossLamports)):'—')+'</td><td class="bad">'+esc(s.rejectionReason||'')+'</td></tr>'}).join('');}catch(e){console.error(e)}}
function tx(v){return v?(v.signature?'<a target="_blank" href="'+solscan('tx',v.signature)+'">'+short(v.signature)+'</a>':esc(v.mode)):'—'}refresh();setInterval(refresh,${refreshMs});</script></div></body></html>`;
}
