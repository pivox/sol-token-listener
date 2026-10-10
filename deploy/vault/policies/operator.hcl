# The operator login (spec 6.2): every entry under sol/ with its versions; nothing on policies or
# authentication.
path "sol/*" {
  capabilities = ["create", "read", "update", "patch", "delete", "list"]
}
