# Vault server of the stack (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 5): one
# node, integrated storage on the vault-data volume, HTTP inside the Docker networks only.
ui            = true
disable_mlock = true
api_addr      = "http://vault:8200"
cluster_addr  = "http://vault:8201"

# Vault 2 refuses an unauthenticated generate-root (CVE-2026-5807 fix). The runbook regenerates a
# root token from the unseal key to change a policy or rotate an AppRole, so it must stay possible.
enable_unauthenticated_access = ["generate-root"]

storage "raft" {
  path    = "/vault/file"
  node_id = "sol-vault"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}
