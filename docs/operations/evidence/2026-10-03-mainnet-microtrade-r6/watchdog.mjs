import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const dir = path.dirname(new URL(import.meta.url).pathname);
const statusFile = path.join(dir, 'status.json');
const alertsFile = path.join(dir, 'alerts.jsonl');
const sessionPid = Number(process.env.SESSION_PID);
const alertStates = new Set(['open_position_or_uncertain', 'fatal', 'risk_stop', 'buy_limit', 'deadline_no_new_buy', 'operator_stop', 'finished']);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function processAlive() { try { process.kill(sessionPid, 0); return true; } catch { return false; } }
function alert(reason, state) {
  const row = { at: new Date().toISOString(), reason, status: state?.status ?? null, stage: state?.stage ?? null, waves: state?.waves ?? null, buysSubmitted: state?.buys ?? null, sells: state?.sells ?? null, lastError: state?.lastError ?? null };
  fs.appendFileSync(alertsFile, JSON.stringify(row) + '\n', { mode: 0o600 });
  try { execFileSync('/usr/bin/osascript', ['-e', `display notification "${reason.replaceAll('"', '')}" with title "Relance Pump.fun"`], { timeout: 5000, stdio: 'ignore' }); } catch {}
  console.log(JSON.stringify(row));
}
if (!Number.isInteger(sessionPid) || sessionPid <= 0) throw Error('SESSION_PID required');
while (true) {
  let state;
  try { state = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { await wait(10000); continue; }
  if (alertStates.has(state.status)) { alert(`Session en pause ou terminée : ${state.status}`, state); break; }
  if (!processAlive()) { alert('Processus de trading disparu', state); break; }
  if (Date.now() - Date.parse(state.updatedAt) > 90000) { alert('État non mis à jour depuis 90 secondes', state); break; }
  await wait(10000);
}
