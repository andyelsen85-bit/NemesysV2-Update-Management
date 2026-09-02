# Kubernetes deployment

`nemesys-control-plane.yaml` is a starting template for the existing cluster. Before applying it:

1. Publish the API server image and replace the image reference.
2. Replace the example `stringData` values using the cluster’s secret-management workflow.
3. Point `DATABASE_URL` at the existing PostgreSQL service.
4. Replace the example hostname and select the cluster’s ingress/TLS annotations.
5. Publish the web console and route it through the same HTTPS host, or serve its static build from the existing web tier.

The API deployment is replica-safe because runtime state is held in PostgreSQL and the administrator session is signed with `SESSION_SECRET`.