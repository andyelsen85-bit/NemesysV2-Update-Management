# Kubernetes deployment

`nemesys-control-plane.yaml` deploys the API and React console images published by
GitHub Actions to GitHub Container Registry (GHCR). Before applying it:

1. Enable Actions to write packages. The workflow at
   `.github/workflows/build-images.yml` builds both images on pushes to `main`
   and publishes `latest`, branch, tag, and immutable commit-SHA tags.
2. Make the GHCR packages public, or create an image pull secret and add
   `imagePullSecrets` to both Deployments if the packages remain private.
3. If this is a fork, replace `ghcr.io/andyelsen85-bit` in the manifest with
   the fork owner.
4. Replace the example `stringData` values using the cluster’s secret-management workflow.
5. Point `DATABASE_URL` at the existing PostgreSQL service.
6. Replace the example hostname and select the cluster’s ingress/TLS annotations.

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