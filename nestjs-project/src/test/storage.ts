import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';

export async function deleteObjectsByPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const objects = (page.Contents ?? []).map(({ Key }) => ({ Key }));
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects },
        }),
      );
    }
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined;
  } while (continuationToken);
}
