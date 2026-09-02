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
7. Apply the test overlay:

```bash
kubectl apply -k deploy/kubernetes/overlays/test
kubectl -n nemesys rollout status deployment/pg-deployment
kubectl -n nemesys rollout status deployment/nemesys-deployment
```

If the cluster cannot pull from Docker Hub, mirror the PostgreSQL image into
Nexus from an intermediate server:

```bash
docker pull postgres:16-alpine
docker tag postgres:16-alpine nexus.example.com:8083/postgres:16-alpine
docker push nexus.example.com:8083/postgres:16-alpine
```

The test API connects to PostgreSQL through the internal `pg` Service. Apply the
additive Drizzle schema update after PostgreSQL is ready and before using the
control center:

```bash
DATABASE_URL='postgresql://...' pnpm --filter @workspace/db run push
```

This creates the Nemesys administrator, LDAP, SSL, per-application policy, and
encrypted client-key columns/tables without deleting existing data. Use the
cluster’s secret-management process rather than committing the connection
string to a shell history or repository. The PostgreSQL Deployment has one replica, so
configure PostgreSQL backups and understand that this is not a highly available
database topology.

The Ingress sends `/api/*` to the API and all other paths to the console. The
API deployment is replica-safe because runtime state is held in PostgreSQL and
the administrator session is signed with `SESSION_SECRET`.

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
