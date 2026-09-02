# Kubernetes deployment

`nemesys-control-plane.yaml` deploys PostgreSQL, the API, and the React console.
The API and console images are published by GitHub Actions to GitHub Container
Registry (GHCR), while PostgreSQL uses the official `postgres:16-alpine` image.
Before applying it:

1. Enable Actions to write packages. The workflow at
   `.github/workflows/build-images.yml` builds both images on pushes to `main`
   and publishes `latest`, branch, tag, and immutable commit-SHA tags.
2. Make the GHCR packages public, or create an image pull secret and add
   `imagePullSecrets` to both Deployments if the packages remain private.
3. If this is a fork, replace `ghcr.io/andyelsen85-bit` in the manifest with
   the fork owner.
4. Replace the example `stringData` values using the cluster’s secret-management workflow.
5. Replace `POSTGRES_PASSWORD` and the matching password in `DATABASE_URL` with a
   strong value. The manifest keeps PostgreSQL internal at the
   `nemesys-postgres` ClusterIP service and persists data in a 20 GiB PVC.
6. Replace the example hostname and select the cluster’s ingress/TLS annotations.
7. Apply the additive Drizzle schema update to the PostgreSQL pod before rolling
   out the API image:

If the cluster cannot pull from Docker Hub, mirror the PostgreSQL image into
Nexus from an intermediate server and replace `postgres:16-alpine` in the
manifest with the Nexus image reference:

```bash
docker pull postgres:16-alpine
docker tag postgres:16-alpine nexus.example.com:8083/postgres:16-alpine
docker push nexus.example.com:8083/postgres:16-alpine
```

```bash
DATABASE_URL='postgresql://...' pnpm --filter @workspace/db run push
```

This creates the Nemesys administrator, LDAP, SSL, per-application policy, and
encrypted client-key columns/tables without deleting existing data. Use the
cluster’s secret-management process rather than committing the connection
string to a shell history or repository. The StatefulSet has one replica, so
configure PostgreSQL backups and understand that this is not a highly available
database topology.

The Ingress sends `/api/*` to the API and all other paths to the console. The
API deployment is replica-safe because runtime state is held in PostgreSQL and
the administrator session is signed with `SESSION_SECRET`.

## Pull and deploy a published image

After a successful workflow run, use the immutable SHA tag shown in the
workflow summary for a reproducible rollout:

```bash
kubectl apply -f deploy/kubernetes/nemesys-control-plane.yaml
kubectl -n nemesys set image deployment/nemesys-api \
  api=ghcr.io/andyelsen85-bit/nemesys-api-server:sha-COMMIT_SHA
kubectl -n nemesys set image deployment/nemesys-console \
  console=ghcr.io/andyelsen85-bit/nemesys-console:sha-COMMIT_SHA
kubectl -n nemesys rollout status deployment/nemesys-api
kubectl -n nemesys rollout status deployment/nemesys-console
```

For a simple moving-tag update, re-apply the manifest and restart both
Deployments:

```bash
kubectl apply -f deploy/kubernetes/nemesys-control-plane.yaml
kubectl -n nemesys rollout restart deployment/nemesys-api deployment/nemesys-console
```
