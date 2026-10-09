# Backup AppRole (spec 6.2, 8.4): takes a raft snapshot, nothing else.
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
