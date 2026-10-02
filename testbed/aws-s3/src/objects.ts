import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

// This file is only a scan fixture. These functions are never called by API Mender.
export async function storeReceipt(client: S3Client, bucket: string, key: string, body: string) {
  return client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'text/plain' }));
}

export async function readReceipt(client: S3Client, bucket: string, key: string) {
  return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
}
