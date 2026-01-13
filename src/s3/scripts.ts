export const getS3DownloadScript = () => `
#!/bin/sh
set -e

DOWNLOAD_PATH="/code/artifact.tar.gz"
EXTRACT_DIR="/code"
AWS_REGION=\${AWS_REGION:-us-east-1}

if [ -z "$S3_ENDPOINT" ] || [ -z "$S3_BUCKET" ] || [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ] || [ -z "$ARTIFACT_PATH" ]; then
    echo "Missing S3 configuration environment variables."
    exit 1
fi

echo "Downloading $ARTIFACT_PATH from $S3_BUCKET..."
mkdir -p "$(dirname "$DOWNLOAD_PATH")"
aws configure set aws_access_key_id "$AWS_ACCESS_KEY_ID"
aws configure set aws_secret_access_key "$AWS_SECRET_ACCESS_KEY"
aws configure set region "$AWS_REGION"
aws --endpoint-url "$S3_ENDPOINT" s3 cp "s3://$S3_BUCKET/$ARTIFACT_PATH" "$DOWNLOAD_PATH"

if [ ! -f "$DOWNLOAD_PATH" ]; then
    echo "Failed to download artifact from S3."
    exit 1
fi

echo "Downloaded $ARTIFACT_PATH to $DOWNLOAD_PATH"

echo "Extracting $DOWNLOAD_PATH to $EXTRACT_DIR..."
mkdir -p "$EXTRACT_DIR"
tar -xzf "$DOWNLOAD_PATH" -C "$EXTRACT_DIR" || tar -xf "$DOWNLOAD_PATH" -C "$EXTRACT_DIR"
echo "Extraction complete."
`

export const getS3DeleteScript = () => `
#!/bin/sh
set -e

AWS_REGION=\${AWS_REGION:-us-east-1}

if [ -z "$S3_ENDPOINT" ] || [ -z "$S3_BUCKET" ] || [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ] || [ -z "$RUNTIME_ID" ]; then
    echo "Missing S3 configuration or RUNTIME_ID environment variables."
    exit 1
fi

echo "Deleting artifacts for $RUNTIME_ID from $S3_BUCKET..."
aws configure set aws_access_key_id "$AWS_ACCESS_KEY_ID"
aws configure set aws_secret_access_key "$AWS_SECRET_ACCESS_KEY"
aws configure set region "$AWS_REGION"
aws --endpoint-url "$S3_ENDPOINT" s3 rm "s3://$S3_BUCKET/$RUNTIME_ID/" --recursive

echo "Successfully deleted all artifacts for $RUNTIME_ID."
`
