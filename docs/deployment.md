# Execution and publication

Install/check locally with Node22.18–24 and pnpm10.15.0:

```sh
pnpm install --frozen-lockfile
pnpm check
```

This source-only Node composition has no separate compilation, deployment command,
provider build or scheduled monitor. Native safety and real-model proof are
separate authorized local runs; they are never part of default checks or remote
CI. No GitHub Actions workflow is introduced for this new repository.

The owner conditionally authorized publication to openifsoul/bridge-minecraft
following independent acceptance and final allowlisted audit. Root/release
integration owns commit/push and repository creation. A successful check does not
itself authorize those actions. npm publication is not authorized; private:true
prevents accidental npm publishing without affecting repository visibility.

Publish only owned source/tests, English docs, license, manifest/lock, release
metadata and reviewed built SDK archive/provenance. Exclude parent-local reports,
run fixtures/receipts, databases, real/synthetic transcript captures, downloads,
server worlds/settings, secrets, authentication caches and generated installation
artifacts. Preserve local data; exclusion is a publication decision, not deletion.

The public App is independently self-hosted on loopback. This bridge neither
exposes it publicly nor controls private Cloud deployment. No production keys,
bindings, Clerk settings, migrations or managed hosting changes belong here.
