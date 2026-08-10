import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const documentPath = resolve(repositoryRoot, 'docs/system-overview.html');
const html = await readFile(documentPath, 'utf8');
const failures: string[] = [];

function requireMatch(pattern: RegExp, message: string): void {
  if (!pattern.test(html)) failures.push(message);
}

requireMatch(/^<!doctype html>/i, 'doctype HTML5 absent');
requireMatch(/<html\s+lang="fr">/, 'langue française absente');
requireMatch(/href="assets\/vendor\/bootstrap\/bootstrap\.min\.css"/, 'Bootstrap local absent');

if (/<script\b/i.test(html)) failures.push('la page ne doit contenir aucun script');

const resourceReferences = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((match) => match[1] ?? '');
for (const reference of resourceReferences) {
  if (/^https?:\/\//i.test(reference)) failures.push(`ressource réseau interdite: ${reference}`);
}

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1] ?? '');
const uniqueIds = new Set(ids);
if (uniqueIds.size !== ids.length) failures.push('les attributs id doivent être uniques');

const requiredSections = [
  'resume', 'perimetre', 'architecture', 'flux-produit', 'acquisition', 'inbox',
  'decodage', 'finalite', 'analyses', 'qualification', 'paper', 'persistance',
  'api', 'runtime', 'tests', 'limites',
];
for (const section of requiredSections) {
  if (!uniqueIds.has(section)) failures.push(`section requise absente: ${section}`);
}

for (const anchor of resourceReferences.filter((reference) => reference.startsWith('#'))) {
  if (!uniqueIds.has(anchor.slice(1))) failures.push(`ancre interne invalide: ${anchor}`);
}

const localReferences = resourceReferences.filter(
  (reference) => !reference.startsWith('#') && !/^[a-z]+:/i.test(reference),
);
for (const reference of localReferences) {
  const [referencePath] = reference.split('#', 1);
  if (referencePath === undefined || referencePath.length === 0) {
    failures.push(`chemin local vide: ${reference}`);
    continue;
  }
  const target = resolve(dirname(documentPath), referencePath);
  try {
    await access(target);
  } catch {
    failures.push(`chemin local introuvable: ${reference}`);
  }
}

const svgBlocks = [...html.matchAll(/<svg\s[\s\S]*?<\/svg>/g)].map((match) => match[0]);
if (svgBlocks.length !== 7) failures.push(`sept diagrammes SVG attendus, trouvés: ${svgBlocks.length}`);
for (const [index, svg] of svgBlocks.entries()) {
  if (!/\bid="diagram-[^"]+"/.test(svg)) failures.push(`SVG ${index + 1}: id stable absent`);
  if (!/\brole="img"/.test(svg)) failures.push(`SVG ${index + 1}: role img absent`);
  if (!/<title\s+id="[^"]+">[^<]+<\/title>/.test(svg)) failures.push(`SVG ${index + 1}: titre accessible absent`);
  if (!/<desc\s+id="[^"]+">[^<]+<\/desc>/.test(svg)) failures.push(`SVG ${index + 1}: description accessible absente`);
  if (!/\baria-labelledby="[^"]+"/.test(svg)) failures.push(`SVG ${index + 1}: aria-labelledby absent`);
}

const requiredStatements = [
  'Aucun mode live',
  'Aucune clé privée',
  'Nombre de tentatives non plafonné',
  'quatre heures',
  'SOL/WSOL',
  'Raydium CPMM',
  "La suite complète ne peut être annoncée sans échec ni skip qu'après exécution avec PostgreSQL disponible.",
  'un score ne peut jamais le compenser',
  'SocialEvidenceCollected',
  'URL_REACHABLE',
  'CROSS_LINK_CONFIRMED',
  'MINT_PUBLISHED',
  'VERIFICATION_UNKNOWN',
  'collectionStatus',
  'linksTruncated',
  'evidenceTruncated',
  'sans API payante',
  'contenu brut',
  'paper:dry-run',
  'TradingCandidateUpdated',
  'PaperStrategySessionUpdated',
  'PaperExternalBuyCounted',
  'paperDecisionJobs',
  'NO_CLOSED_POSITION',
  'PUMP_FUN_BONDING_CURVE',
  'PUMPSWAP',
  'EXECUTION_MODE=paper',
  'PAPER_STRATEGY_ENABLED=true',
];
for (const statement of requiredStatements) {
  if (!html.includes(statement)) failures.push(`affirmation requise absente: ${statement}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`docs:check: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`docs:check: OK — ${requiredSections.length} sections, ${svgBlocks.length} SVG, ${resourceReferences.length} références`);
}
