import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LiveExecutionMigrationCatalogEntry { readonly name: string; readonly sha256: string; }

const CATALOG = `
001_initial.sql 4d825efda19d42e9b78ccd4905f0d882907ad52c3956b064f8f16f81363317a6
002_pumpfun_foundation.sql dc04d71f2d6f4ba087e4c720164368637da83e1eb73e58f5e7308faf3d3f7399
003_pumpfun_observations.sql e51e10ed8f42b74c45e595cc904f5553f685c15b685163af822e527348c41123
004_paper_trading.sql 13b54df9f06c7e1a3cd06a7b258853f2e0a3d237807eb695afb838473ae7ef7b
005_pumpswap_market.sql 4227e0f353d073a9115dd04b84180dd66a261ec07f9797e014167ad58b5f76f1
006_api_event_stream.sql 8bed277b894ca1b8e2787065f05ce4cf0d79c302b40b13a69578d3476ceec2c5
007_participant_analytics.sql 44a82da6340c23e8030b672dbe76d56b8c61031d2ed0d865670ef5a3930c3fb8
008_wallet_graph.sql 9e1e37f83dec100c27cbdf4571aa48d8053b25db6dd0a3fe5f720f0e708f4d5c
009_transaction_ingestion.sql f1fab847227212a85725b98f10e85ca0c9174307ffb8fc45d47ee0b67eafab82
010_transaction_inbox_timestamps.sql 15a2a1048c357466ed77fa4b78ac7a3deed88d5e9af527e2854d2ff8077eebee
011_transaction_inbox_retry_recovery.sql 32f5bbd4817df70bde162179d32c59221c27dca6007e693fb76e8a26f2d2b1c9
012_public_social_evidence.sql 2c389681136f3793961267351c63bcd97a8a5efc9e84ef4b6053b1f946a0061b
013_paper_e2e.sql a721229ca987dc03472323953566b788ac77db9968d87bb160935cbdd1879efa
014_social_persistence_retry.sql 08cfa11596886214558e18abedb9c67e52aea2be634495b86eae78f16280247a
015_paper_active_session_per_mint.sql 2dcbb50ccafa0fa7e0b49853383ab338128bd6f64ba2f2034fb483c7f71e3f91
016_listener_catch_up_gaps.sql 3a6257fb9508a8a07aed972f6b5f8c72289df3b9c7ceaf49b5c2f5aac6d9497a
017_creation_entry_strategy.sql 893c747596e1fa6e200743c6cfee97e6cfd74d525056ee1348660954bd7692e3
018_paper_mvp_validation.sql 7cef1b8888c55af975d2dde1f59e874d7386d885eba98bc839533d4b644b0e36
019_paper_mvp_collection.sql 59ef1b78c5e10e6630c1b277941b52ea1f3f642900e245e2df262da36b301028
020_paper_mvp_derived_pnl.sql 2456b5352ea45912ca1e5c53c27c82898261d5b0736ba0f9f9a85a83abdb976c
021_paper_mvp_runner_hardening.sql 1871f85bc106f63424be888a96d957a38a12516703df3a8000221a40a1c6903a
022_paper_mvp_coverage_indexes.sql e76a0a7b46d6af9d527ae617d985d7c34c0e4e8a9df665d104ed62b6f4c5388b
023_paper_mvp_exact_strategy.sql 7f25459deb5c729fd31ff114e224b85ea47fd6a8d3f19e91dfba6742cc461b05
024_paper_mvp_position_coverage.sql 81768974d497cf652452dc8b5a7aec7df278514631b74219a5fc8bc90f23a23a
025_paper_mvp_effective_configuration.sql f882e6d04e0e18b8a350a9a8ed54d1c5bac3658ac2602a7bbf63691151d5d740
026_listener_strict_catch_up_failures.sql 6e3465d6e194419316e1d19bcde459acaa06495189233f06e9dff48b51ddfd64
027_listener_provider_affine_finality.sql 1bf19a1651a0fa7f9f610e9f3f201b75af4ad8b7bb2b84f66ca52964f79ea104
028_paper_finality_replay_evidence.sql 6a1b1cc44fdf9acedf3d87b9c1caea9030bb5226f0b27bc747d018b1f8ab7203
029_paper_finality_claim_scheduler.sql e13e4983501ee6799fa496eed3008cce9700d80be64a871ad3c762926e2d0cc9
030_listener_websocket_health.sql f0c840cb3b4e74c5aa73a066455ecfa621cd919d81a9e2376ff356074f8b49f3
031_execution_intents.sql c8ea25e1152f74cf5b60d853ec442fb47ea225c93dc6e60b9b84f1b49f9395ff
032_execution_dry_run_assessments.sql 45aa9a16f12c2fcfc847a3274814c7473d3148ab6ff20364af94bd9e4f221854
033_execution_simulation_artifacts.sql 68a095552029fcb4773bfcf267bba23993cdce4f2019d9a5b922aeb55628ea6e
034_execution_risk_reconciliation.sql 4068070c90993a008619eb8a54977c058b597a84d02c74150f311d7fa33fe9aa
035_execution_preflight_operations.sql 23b47fc445850180399534638ab2f5b56fb37612caccd19c23c68dbed29806a7
036_execution_live_canary.sql ede09c7dc6eef3dd1ead634ea4aa8f52d8da69f3f269c3e0cbd60bbb0b3249d5
037_execution_live_orchestration.sql 7d07ab8d33d4f13e66cfa9718e673b0333de8135137f3ec8daa8bc7ee6ba1d35
038_execution_live_rpc_budget.sql 01171349cbb428e927b0a41a7a218882ca462d66b2434eda382dd55e5a97a197
039_execution_canary_operator_binding.sql 0fee1e9b87ae1ab0b34c7a23ddb7c01814fa7bea7ecb7502b4363f73ed465b09
`;

export const LIVE_EXECUTION_MIGRATION_CATALOG: readonly LiveExecutionMigrationCatalogEntry[] =
  Object.freeze(CATALOG.trim().split('\n').map((line) => {
    const [name, sha256, ...rest] = line.split(' ');
    if (name === undefined || sha256 === undefined || rest.length !== 0) throw new Error();
    return Object.freeze({ name, sha256 });
  }));

export async function validateLiveExecutionMigrationFiles(
  migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations'),
): Promise<void> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (!sameStrings(names, LIVE_EXECUTION_MIGRATION_CATALOG.map((item) => item.name))) throw new Error();
  for (const entry of LIVE_EXECUTION_MIGRATION_CATALOG) {
    const contents = await readFile(resolve(migrationsDirectory, entry.name));
    if (createHash('sha256').update(contents).digest('hex') !== entry.sha256) throw new Error();
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
