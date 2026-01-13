# Kubernetes Deployment Guide

This directory contains Kubernetes manifests for deploying the Appwrite Executor.

## Prerequisites

- Kubernetes cluster (1.20+)
- kubectl configured to access your cluster
- Docker image built and pushed to a registry

## Files Overview

- `namespace.yaml` - Creates the namespace for the executor
- `serviceaccount.yaml` - Service account for the executor pod
- `rbac.yaml` - Role and RoleBinding for Kubernetes API permissions
- `configmap.yaml` - Non-sensitive configuration
- `secret.yaml.example` - Template for sensitive configuration (copy to `secret.yaml`)
- `deployment.yaml` - Main application deployment
- `service.yaml` - ClusterIP service for internal access
- `kustomization.yaml` - Kustomize configuration for managing all resources

## Quick Start

### 1. Create Secret

Copy the example secret file and fill in your values:

```bash
cp secret.yaml.example secret.yaml
```

Edit `secret.yaml` and update:
- `OPR_EXECUTOR_SECRET`: Generate a secure key: `openssl rand -hex 32`
- `S3_ENDPOINT`: Your S3 endpoint URL
- `S3_BUCKET`: Your S3 bucket name
- `S3_ACCESS_KEY_ID`: Your S3 access key
- `S3_SECRET_ACCESS_KEY`: Your S3 secret key

### 2. Update ConfigMap (Optional)

Edit `configmap.yaml` to adjust:
- `KUBERNETES_NAMESPACE`: Namespace where runtime pods will be created (default: `appwrite-executor`)
- `S3_REGION`: S3 region (default: `us-east-1`)
- `NODE_ENV`: Node environment (default: `production`)

### 3. Update Deployment Image

Edit `deployment.yaml` and update the image reference:

```yaml
image: your-registry/appwrite-executor:tag
```

### 4. Deploy

#### Option A: Using kubectl

```bash
# Apply all resources
kubectl apply -f namespace.yaml
kubectl apply -f serviceaccount.yaml
kubectl apply -f rbac.yaml
kubectl apply -f configmap.yaml
kubectl apply -f secret.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
```

#### Option B: Using Kustomize

```bash
# First, update kustomization.yaml to use secret.yaml instead of secret.yaml.example
# Edit kustomization.yaml and replace secret.yaml.example with secret.yaml
kubectl apply -k .
```

## Verification

Check deployment status:

```bash
# Check pods
kubectl get pods -n appwrite

# Check logs
kubectl logs -f deployment/appwrite-executor -n appwrite

# Check service
kubectl get svc -n appwrite

# Test health endpoint via port-forward
kubectl port-forward -n appwrite svc/appwrite-executor 8080:80
curl http://localhost:8080/v1/health
```

## Configuration

### Environment Variables

The application uses `envFrom` to automatically load all environment variables from ConfigMap and Secret. This means any variables added to these resources will be automatically available in the container.

**ConfigMap variables:**
- `KUBERNETES_NAMESPACE`: Namespace for runtime pods
- `S3_REGION`: S3 region
- `NODE_ENV`: Node environment

**Secret variables:**
- `OPR_EXECUTOR_SECRET`: API authentication secret
- `S3_ENDPOINT`: S3 endpoint URL
- `S3_BUCKET`: S3 bucket name
- `S3_ACCESS_KEY_ID`: S3 access key ID
- `S3_SECRET_ACCESS_KEY`: S3 secret access key

### Resource Limits

Default resource requests and limits are set in `deployment.yaml`:
- Requests: CPU 500m, Memory 512Mi
- Limits: CPU 1000m, Memory 1Gi

Adjust these based on your workload requirements.

### Scaling

To scale the deployment:

```bash
kubectl scale deployment appwrite-executor -n appwrite --replicas=3
```

Or update `replicas` in `deployment.yaml`.

## Accessing the Service

The service is exposed as a ClusterIP, which means it's only accessible within the cluster. To access it from outside:

1. **Port Forwarding** (for testing):
   ```bash
   kubectl port-forward -n appwrite svc/appwrite-executor 8080:80
   ```

2. **Create an Ingress** (for production):
   Create your own Ingress resource or use a LoadBalancer service type if your cluster supports it.

## Troubleshooting

### Pods not starting

```bash
# Check pod events
kubectl describe pod -n appwrite -l app=appwrite-executor

# Check logs
kubectl logs -n appwrite -l app=appwrite-executor
```

### Permission issues

Verify RBAC is correctly configured:

```bash
kubectl get role -n appwrite
kubectl get rolebinding -n appwrite
kubectl describe rolebinding appwrite-executor-rolebinding -n appwrite
```

### Secret issues

Ensure secret is created and mounted:

```bash
kubectl get secret appwrite-executor-secret -n appwrite
kubectl describe secret appwrite-executor-secret -n appwrite
```

### ConfigMap issues

Verify ConfigMap exists and contains expected values:

```bash
kubectl get configmap appwrite-executor-config -n appwrite
kubectl describe configmap appwrite-executor-config -n appwrite
```

### Environment variables not loading

Since we use `envFrom`, all variables from ConfigMap and Secret are automatically loaded. To verify:

```bash
# Check environment variables in a running pod
kubectl exec -n appwrite deployment/appwrite-executor -- env | grep -E '(KUBERNETES_NAMESPACE|S3_|OPR_|NODE_ENV)'
```

## Cleanup

To remove all resources:

```bash
kubectl delete -k .  # If using kustomize
# Or
kubectl delete -f .  # If using individual files
```

## Notes

- The deployment uses `envFrom` to automatically inject all environment variables from ConfigMap and Secret, so you don't need to manually specify each variable in the deployment.
- The service is configured as ClusterIP by default. Modify `service.yaml` if you need external access.
- Health checks are configured with liveness and readiness probes pointing to `/v1/health` endpoint.
