# KRS-docLibrary

Simple document library Lambda for browsing file metadata written by `KRS-docUploader`.

The uploader stores every file record in DynamoDB with a `parentFolder` string such as
`deals/2024/q2`, while the file itself stays in S3 using the uploaded record's `s3Key`.
This Lambda derives the folder tree from DynamoDB and returns presigned S3 GET URLs for
viewing files in the UI.

## Environment

Required:

- `DOCUMENTS_TABLE`: DynamoDB table used by `KRS-docUploader`

Usually required:

- `UPLOAD_BUCKET`: fallback bucket if a DynamoDB record does not include `s3Bucket`

Optional:

- `CORS_ORIGIN`: defaults to `*`
- `VIEW_URL_EXPIRES_SECONDS`: defaults to `900`
- `MAX_SCAN_PAGES`: defaults to `8`

## Operations

### List a folder

`GET`:

```bash
curl "https://API_URL/default/KRS-docLibrary?clientId=client_acme_001&folder=deals/2024"
```

`POST`:

```bash
curl --location "https://API_URL/default/KRS-docLibrary" \
  --header "content-type: application/json" \
  --data '{
    "requestType": "list-folder",
    "clientId": "client_acme_001",
    "folder": "deals/2024"
  }'
```

Returns:

- `breadcrumbs`: paths the UI can render as navigation
- `folders`: immediate child folders under the requested folder
- `files`: files whose `parentFolder` exactly matches the requested folder

### Get a file view URL

```bash
curl --location "https://API_URL/default/KRS-docLibrary" \
  --header "content-type: application/json" \
  --data '{
    "requestType": "get-file",
    "clientId": "client_acme_001",
    "fileId": "FILE_ID_FROM_UPLOAD_RESPONSE"
  }'
```

Returns file metadata and a short-lived `viewUrl` for inline browser display.

### Get file metadata only

```bash
curl --location "https://API_URL/default/KRS-docLibrary" \
  --header "content-type: application/json" \
  --data '{
    "requestType": "get-file-metadata",
    "clientId": "client_acme_001",
    "fileId": "FILE_ID_FROM_UPLOAD_RESPONSE"
  }'
```

## Notes

This is intentionally lightweight for the demo. It uses DynamoDB `Scan` filtered by
`clientId`, then builds the folder structure in memory. For production-scale browsing,
add a GSI such as `clientId + parentFolder` and query it directly.
