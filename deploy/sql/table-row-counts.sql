-- Exact row count of every table of schema public, one `table|rows` line each, compared before
-- and after a restore (docs/operations/deployment.md, « Reprise de la base actuelle »).
SELECT table_name || '|' || (xpath('/row/c/text()', query_to_xml(
    format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name COLLATE "C";
