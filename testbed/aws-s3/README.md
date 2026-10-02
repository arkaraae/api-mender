# AWS S3 scan fixture

Two small TypeScript call sites for API Mender's public repository scan. The code is never run and needs no AWS credentials. It is test data, not an example of a breaking AWS change.

The fixture imports `@aws-sdk/client-s3` and constructs `PutObjectCommand` and `GetObjectCommand`. A successful inventory should link to these exact lines and identify the matching S3 operations in AWS's published model. A separate model diff is required before claiming that an upstream change affects either call.
