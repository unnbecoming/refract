# Kubernetes deployment

Use a dedicated namespace: `network-policy.yaml` includes namespace-wide default deny. Replace the image reference in `refract.yaml` with an immutable reviewed digest, then create credentials without committing a Secret manifest:

```sh
kubectl -n "$NAMESPACE" create secret generic refract-provider-credentials \
  --from-file=anthropic-api-key=/secure/anthropic-api-key \
  --from-file=openai-api-key=/secure/openai-api-key \
  --from-file=admin-token=/secure/admin-token
kubectl -n "$NAMESPACE" apply -f kubernetes/refract.yaml
kubectl -n "$NAMESPACE" apply -f kubernetes/network-policy.yaml
```

The single-replica `Recreate` Deployment prevents overlapping SQLite writers. Durable state uses a ReadWriteOnce PVC. Raw capture uses a size-bounded `emptyDir` and is intentionally lost on Pod replacement; replace it with a separate disposable PVC if the short window must survive. Never combine raw and durable volumes.

The agent routes OpenAI calls to `http://refract-proxy:8340/v1` and Anthropic calls to `http://refract-proxy:8340`. Verify each SDK's base-URL joining behavior. The agent label in the example policy is `app.kubernetes.io/name=restricted-agent`; the admin ingress source label is `app.kubernetes.io/component=refract-operator`.

Standard NetworkPolicy cannot select provider FQDNs. The included fallback permits only public TCP/443 from Refract while excluding common private/link-local/multicast ranges. Prefer Cilium FQDN policy or a separately controlled egress gateway. The agent remains unable to use that egress and cannot reach port 8341.

`/health/ready` answers whether the data plane can forward. Recorder degradation is reported in its JSON but does not remove the only proxy endpoint. `/health/recording` is the separate recorder-health signal. `/health/live` is event-loop liveness.
