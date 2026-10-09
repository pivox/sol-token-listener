# Migrate container AppRole (spec 6.2): reads the nine login passwords, nothing else.
path "sol/data/secrets/logins/*" {
  capabilities = ["read"]
}
