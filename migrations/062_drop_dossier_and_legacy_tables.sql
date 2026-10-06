-- Simple path (docs/superpowers/specs/2026-10-06-simple-path-design.md): tables of the removed
-- dossier subsystem, the paper MVP harness and the unused migration-001 schema. Fails closed:
-- no CASCADE, so an unexpected dependent object aborts the migration.

DROP TABLE paper_mvp_position_samples, paper_mvp_runs;
DROP FUNCTION prevent_paper_mvp_sample_mutation();
DROP FUNCTION prevent_paper_mvp_run_immutable_mutation();

DROP TABLE social_verification_evidence, social_http_observations, social_links,
  social_evidence_collections, social_enrichment_jobs;

DROP TABLE wallet_cluster_members, wallet_clusters, wallet_relationships, wallet_graph_snapshots,
  wallet_graph_profiles, wallet_funding_evidence, wallet_funding_observations;

DROP TABLE observed_wallet_positions, token_holders_snapshots, creator_profiles;

DROP TABLE launch_trades;

DROP TABLE trades, swap_events, token_risk_reports, token_sessions, discovered_pools,
  listener_checkpoints, risk_settings, ignored_assets;
