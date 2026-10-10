# The operator login (spec 6.2): every entry under sol/ with its versions; nothing on policies or
# authentication.
path "sol/*" {
  capabilities = ["create", "read", "update", "patch", "delete", "list"]
}

# The engine configuration stays read-only: an exact path wins over the glob above. max_versions or
# delete_version_after would drop versions of every entry, and cas_required would fail vault-import.
path "sol/config" {
  capabilities = ["read"]
}
