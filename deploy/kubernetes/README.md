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
6. Replace the example hostname and select the cluster’s ingress/TLS annotations.
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
poll-timestamp and policy-postpone columns before seed data is inserted. No
manual schema command is required. The database user in `DATABASE_URL` must
have permission to create tables and alter tables.

For a database reachable from a trusted administration environment, the full
Drizzle schema push remains an optional alternative provisioning method:

```bash
DATABASE_URL='postgresql://...' pnpm --filter @workspace/db run push
```

Use the cluster’s secret-management process rather than committing the
connection string to a shell history or repository. The PostgreSQL Deployment
has one replica, so configure PostgreSQL backups and understand that this is not
a highly available database topology.

The Ingress sends `/api/*` to the API and all other paths to the console. The
Ingress terminates HTTPS on public port `443` and forwards to the internal
HTTP Services. The API deployment is replica-safe because runtime state is held
in PostgreSQL and the administrator session is signed with `SESSION_SECRET`.

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

Because the API and web containers share one Pod network namespace, they must
listen on different container ports. The API uses `8081` and the web console
uses `8080`; the API Service remains available on Service port `8080` and
targets the API's `8081` container port.

## HTTPS and Windows client connections

The public client endpoint is the Ingress hostname on port `443`:

```text
https://<nemesys-ingress-host>/api/sync/enroll
```

The Windows installer uses standard HTTPS without requiring a `/port`
argument. The service defaults to TCP `443`. The `sync_port` compatibility
setting is seeded at `443`, and existing installations still using the old
untouched default `5187` are moved to `443` during additive startup bootstrap.

Install a certificate for the Ingress as a Kubernetes TLS Secret; do not put
the certificate or private key in Git:

```bash
kubectl -n nemesys create secret tls nemesys-tls \
  --cert=/secure/path/fullchain.pem \
  --key=/secure/path/private-key.pem
```

Set the real client-facing DNS name in the Ingress `host` and `tls.hosts`
values. The existing `nemesys.example.com` value is a placeholder. The
certificate must cover that hostname. The certificate upload in the
administrator console is for a directly exposed API runtime; Kubernetes
Ingress TLS termination should be used for this deployment because the
console Nginx proxies to the API over internal HTTP.
