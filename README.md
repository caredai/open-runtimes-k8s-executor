# Open Runtimes K8s Executor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Kubernetes-native implementation of the [Open Runtimes Executor](https://github.com/open-runtimes/executor), built with TypeScript, Bun, and Hono.js. This service provides a stateless HTTP API for creating and executing serverless functions within Kubernetes clusters.

## Overview

Open Runtimes K8s Executor is a JavaScript/TypeScript rewrite of the original [Open Runtimes Executor](https://github.com/open-runtimes/executor) (PHP), designed specifically for Kubernetes environments. It maintains API compatibility with the original executor while leveraging Kubernetes primitives for container orchestration, resource management, and scalability.

## Features

- **Kubernetes-Native**: Uses Kubernetes Jobs and Pods for runtime execution, fully integrated with K8s resource management
- **Stateless Architecture**: Horizontally scalable as a Kubernetes Deployment with no shared state
- **Runtime Management**: Create, list, and manage runtime environments with full lifecycle control
- **Background Cleanup**: Automatic cleanup of completed/failed jobs using a leader election mechanism via Kubernetes Leases
- **S3 Storage Integration**: Supports S3-compatible storage for function source code and artifacts
- **Multi-Version Support**: Compatible with Open Runtimes v2 and v5
- **High Performance**: Built on Bun runtime and Hono.js framework for optimal performance
- **Production Ready**: Includes graceful shutdown, health checks, and comprehensive error handling

## Architecture

The executor operates as a stateless HTTP service that:

1. Accepts runtime creation and execution requests via REST API
2. Creates Kubernetes Jobs for building function artifacts
3. Manages Kubernetes Deployments for long-running runtime servers
4. Executes functions in isolated Pods with configurable resource limits
5. Automatically cleans up completed jobs and inactive runtimes

### Key Components

- **API Server**: Hono.js-based HTTP server handling executor API endpoints
- **Kubernetes Client**: Manages K8s resources (Jobs, Deployments, Pods, Services)
- **Maintenance Loop**: Background worker with leader election for cleanup tasks
- **S3 Client**: Handles function source code storage and retrieval

## Prerequisites

- Kubernetes cluster (1.20+)
- kubectl configured to access your cluster
- S3-compatible storage (or compatible object storage)
- Docker image registry (for runtime images)

## Quick Start

### Build and Deploy

1. Build the Docker image:
```bash
docker build -t your-registry/open-runtimes-k8s-executor:latest .
docker push your-registry/open-runtimes-k8s-executor:latest
```

2. Deploy to Kubernetes:
```bash
kubectl apply -k deploy/
```

For detailed deployment instructions, configuration, and troubleshooting, see [deploy/README.md](deploy/README.md).

## API Endpoints

The executor provides the same API interface as the original [Open Runtimes Executor](https://github.com/open-runtimes/executor#api-endpoints):

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/health` | Health check endpoint |
| POST | `/v1/runtimes` | Create a new runtime server |
| GET | `/v1/runtimes` | List currently active runtimes |
| GET | `/v1/runtimes/{runtimeId}` | Get a runtime by its ID |
| DELETE | `/v1/runtimes/{runtimeId}` | Delete a runtime |
| POST | `/v1/runtimes/{runtimeId}/executions` | Execute a function |
| GET | `/v1/runtimes/{runtimeId}/logs` | Get live stream of logs |

### Example: Create and Execute a Runtime

```bash
# Create a runtime
curl -X POST http://localhost:8080/v1/runtimes \
  -H "Authorization: Bearer your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "runtimeId": "my-function",
    "image": "openruntimes/php:v5-8.3",
    "source": "s3://bucket/my-function.tar.gz",
    "entrypoint": "index.php"
  }'

# Execute the function
curl -X POST http://localhost:8080/v1/runtimes/my-function/executions \
  -H "Authorization: Bearer your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "body": "{\"name\": \"World\"}",
    "path": "/",
    "method": "POST",
    "headers": {}
  }'
```

## Configuration

### Environment Variables

#### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `OPR_EXECUTOR_SECRET` | Secret key for API authentication | `openssl rand -hex 32` |
| `S3_ENDPOINT` | S3-compatible storage endpoint URL | `https://s3.amazonaws.com` |
| `S3_BUCKET` | S3 bucket name for function storage | `my-functions-bucket` |
| `S3_ACCESS_KEY_ID` | S3 access key ID | `AKIAIOSFODNN7EXAMPLE` |
| `S3_SECRET_ACCESS_KEY` | S3 secret access key | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |

#### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `KUBERNETES_NAMESPACE` | Namespace for runtime pods | `appwrite-executor` |
| `S3_REGION` | S3 region | `us-east-1` |
| `PORT` | HTTP server port | `3000` |
| `OPR_EXECUTOR_MAINTENANCE_INTERVAL` | Maintenance loop interval (seconds) | `60` |
| `OPR_EXECUTOR_INACTIVE_THRESHOLD` | Inactive runtime cleanup threshold (seconds) | `300` |
| `NODE_ENV` | Node environment | `production` |

### Kubernetes RBAC

The executor requires the following Kubernetes permissions:

- **Jobs**: Create, read, delete (for build and cleanup jobs)
- **Deployments**: Create, read, update, delete (for runtime servers)
- **Pods**: Read, exec (for execution and log streaming)
- **Services**: Create, read, delete (for runtime service exposure)
- **Leases**: Create, read, update (for leader election)

See `deploy/rbac.yaml` for the complete RBAC configuration.

## Development

### Prerequisites

- [Bun](https://bun.sh/) runtime (latest version)
- Node.js 18+ (for TypeScript tooling)

### Setup

```bash
# Install dependencies
bun install

# Run development server
bun dev

# Run type checking
bun run typecheck

# Run linting and formatting
bun run check
```

### Project Structure

```
src/
├── index.ts              # Main application entry point
├── routes/
│   └── runtimes.ts       # Runtime API routes
├── k8s/
│   ├── client.ts         # Kubernetes client initialization
│   └── definitions.ts    # K8s resource definitions
├── maintenance/
│   └── loop.ts           # Background cleanup loop with leader election
├── middleware/
│   └── auth.ts           # Authentication middleware
├── s3/
│   ├── config.ts         # S3 client configuration
│   └── scripts.ts        # S3 utility functions
└── utils/
    ├── delay.ts          # Utility functions
    ├── errors.ts         # Error handling
    ├── logs.ts           # Log parsing utilities
    ├── multipart.ts      # Multipart response handling
    ├── pod-exec.ts       # Pod execution utilities
    └── runtime.ts        # Runtime management utilities
```

## Differences from Original Executor

While maintaining API compatibility, this Kubernetes implementation differs in several ways:

1. **Container Orchestration**: Uses Kubernetes Jobs/Deployments instead of Docker directly
2. **Storage**: Requires S3-compatible storage (no local filesystem option)
3. **Scaling**: Designed for horizontal scaling in Kubernetes
4. **Cleanup**: Uses Kubernetes Leases for distributed leader election
5. **Resource Management**: Leverages Kubernetes resource quotas and limits

## Production Considerations

The executor is stateless and can be scaled horizontally. It exposes a health endpoint at `/v1/health` for Kubernetes liveness and readiness probes.

For production deployment best practices, scaling, resource limits, and high availability configuration, see [deploy/README.md](deploy/README.md).

## Troubleshooting

For deployment-related troubleshooting (pods, permissions, secrets, etc.), see [deploy/README.md](deploy/README.md#troubleshooting).

## Contributing

Contributions are welcome! Please ensure:

1. Code follows the existing style (enforced by Biome)
2. All tests pass
3. Type checking passes (`bun run typecheck`)
4. Linting passes (`bun run check`)

## License

This project is licensed under the MIT License - see the [LICENSE.txt](LICENSE.txt) file for details.

## Related Projects

- [Open Runtimes Executor](https://github.com/open-runtimes/executor) - Original PHP implementation
- [Open Runtimes](https://github.com/open-runtimes/open-runtimes) - Runtime environments for serverless computing
- [Open Runtimes Proxy](https://github.com/open-runtimes/proxy) - Load balancer for Open Runtimes

## Support

For issues, questions, or contributions, please open an issue on GitHub.
