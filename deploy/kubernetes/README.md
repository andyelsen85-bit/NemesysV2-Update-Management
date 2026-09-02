# Kubernetes deployment

The Kustomize deployment follows the Change Manager layout:

```text
deploy/kubernetes/
├── base/
└── overlays/
    └── test/
```

The test overlay deploys PostgreSQL, the API, and the React console. The API and
console images are mirrored into Nexus, while PostgreSQL uses the official
`postgres:16-alpine` image mirrored into Nexus as well.

Before applying the test overlay:

1. Enable Actions to write packages. The workflow at
   `.github/workflows/build-images.yml` builds both images on pushes to `main`
   and publishes `latest`, branch, tag, and immutable commit-SHA tags.
2. Push the API and console images into the Nexus paths used in
   `overlays/test/kustomization.yml`.
3. Mirror PostgreSQL into Nexus and update the image in
   `overlays/test/pg-deployment.yml` if your Nexus connector differs.
4. Create the `regcred` image-pull Secret in the `nemesys` namespace using your
   cluster secret-management process. `base/regcred.yml` is only a template and
   is intentionally not included in the Kustomization.
5. Replace the example values in `overlays/test/api-env.yml` and
   `overlays/test/pg-env.yml`. The password in `DATABASE_URL` must match
   `POSTGRES_PASSWORD`.
6. Set `TLS_HOSTNAME` in `base/web-env.yml` (or patch it in an overlay) to the
   public DNS name used to reach the `web` Service.
7. Ensure the `nemesys` namespace exists. For ArgoCD, set
   `spec.syncPolicy.syncOptions` to include `CreateNamespace=true`; for manual
   kubectl use, run `kubectl create namespace nemesys` once.
8. Apply the test overlay:

The PostgreSQL PVC is intentionally protected from replacement and pruning by
an ArgoCD resource annotation. Do not enable `Replace=true` globally for this
Application. A PVC that is already `Bound` must not be deleted or recreated;
changing its `storageClassName`, `volumeName`, `volumeMode`, or access mode can
destroy the database or make the sync fail.

```bash
kubectl apply -k deploy/kubernetes/overlays/test
kubectl -n nemesys rollout status deployment/pg-deployment
```

If the cluster cannot pull from Docker Hub, mirror the PostgreSQL image into
Nexus from an intermediate server:

```bash
docker pull postgres:16-alpine
docker tag postgres:16-alpine nexus.example.com:8083/postgres:16-alpine
docker push nexus.example.com:8083/postgres:16-alpine
```

The API automatically provisions the Nemesys schema during startup using
idempotent, additive DDL. It creates missing tables and adds missing client
poll-timestamp and policy-postpone columns before default settings are
initialized. No
manual schema command is required. The database user in `DATABASE_URL` must
have permission to create tables and alter tables.

Fresh installations start without demo clients or sample application policies.
For an existing installation that was initialized with the old demo data, run
`migrations/004-remove-demo-data.sql` once. It removes the two known seeded audit
rows and removes client/application rows only when their original seeded
identity fields also match.

Before deploying the release that introduces one latest audit row per client,
run `migrations/003-latest-audit-per-client.sql` once against an existing
database. The migration deterministically keeps the newest row for each client,
removes older audit rows, and adds the unique client constraint. Take the normal
database backup first, then use the cluster's secret-managed connection rather
than putting credentials in the command or repository.

For a database reachable from a trusted administration environment, the full
Drizzle schema push remains an optional alternative provisioning method:

```bash
DATABASE_URL='postgresql://...' pnpm --filter @workspace/db run push
```

Use the cluster’s secret-management process rather than committing the
connection string to a shell history or repository. The PostgreSQL Deployment
has one replica, so configure PostgreSQL backups and understand that this is not
a highly available database topology.

There is no Kubernetes Ingress in this deployment. Expose the `web` Service
directly (for example with a LoadBalancer, external IP, or the cluster's
networking policy) on TCP ports `80` and `443`. The console Nginx redirects
HTTP to HTTPS and proxies `/api/*` to the API over the Pod-local HTTP port
`8081`. Only `/healthz` remains available over HTTP for Kubernetes probes.
The internal `api` Service remains available on port `8080` for cluster-local
administration and diagnostics. Runtime state is held in PostgreSQL and the
administrator session is signed with `SESSION_SECRET`.

## Update the test image versions

After a successful workflow run and Nexus push, update the immutable tags in
`overlays/test/kustomization.yml`, then apply:

```bash
kubectl apply -k deploy/kubernetes/overlays/test
kubectl -n nemesys rollout status deployment/nemesys-deployment
```

The base deployment contains both the API and web containers, matching the
Change Manager pattern. Production will be added later as a separate overlay
that points `DATABASE_URL` to the Patroni service and does not include the test
PostgreSQL resources.

Because the API and web containers share one Pod network namespace, the API
listens only on HTTP port `8081`; the web console owns ports `80` and `443`.
The API ConfigMap sets `TLS_TERMINATION=proxy`, so it remains HTTP even if
`forceHttps` is enabled in the console. It continues to make redirect and HSTS
decisions from Nginx's `X-Forwarded-Proto` header.

## HTTPS and Windows client connections

The public client endpoint is the externally reachable `web` Service hostname
on port `443`:

```text
https://<nemesys-service-host>/api/sync/enroll
```

The Windows installer uses standard HTTPS without requiring a `/port`
argument. The service defaults to TCP `443`. The `sync_port` compatibility
setting is seeded at `443`, and existing installations still using the old
untouched default `5187` are moved to `443` during additive startup bootstrap.

The `longhorn-nemesys-certs-pvc` is shared by the API and console containers.
On first boot the console creates a persisted self-signed certificate using
`TLS_HOSTNAME` and `TLS_SELFSIGNED_DAYS` (default `365`) if no valid uploaded
certificate exists. Upload a production certificate, chain, and matching
private key through the administrator console. Nemesys keeps the certificate
and encrypted key in PostgreSQL, atomically materializes them to the shared
PVC, and the console validates and reloads Nginx when those files change.
Do not put certificates or private keys in Git or create a Kubernetes TLS
Secret for this deployment. The certificate must cover the real public DNS
name.
