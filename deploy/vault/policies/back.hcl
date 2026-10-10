# Back container AppRole (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 6.2): reads
# its configuration, its secrets and the login passwords at boot, nothing else.
path "sol/data/config/*" {
  capabilities = ["read"]
}

path "sol/data/secrets/back/*" {
  capabilities = ["read"]
}

path "sol/data/secrets/logins/*" {
  capabilities = ["read"]
}
