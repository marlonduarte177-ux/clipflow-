import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Operaciones de almacenamiento que usa la API. La API nunca recibe el archivo:
 * solo inicia la subida en S3, firma URLs temporales y confirma el resultado.
 */
export interface VideoStorage {
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  presignUploadPart(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<string>;
  completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  /** Tamaño real del objeto en S3, o null si no existe. */
  getObjectSize(key: string): Promise<number | null>;
  deleteObject(key: string): Promise<void>;
  /** Borra todos los archivos que empiezan con `prefix` (p. ej. "clips/<usuario>/<trabajo>/"). Devuelve cuántos. */
  deletePrefix(prefix: string): Promise<number>;
  /** URL temporal de lectura (previews y descargas). */
  presignGet(key: string, expiresInSeconds: number, downloadFilename?: string): Promise<string>;
}

export function createS3Storage(options: { bucket: string; region: string; client?: S3Client }): VideoStorage {
  const s3 = options.client ?? new S3Client({ region: options.region });
  const Bucket = options.bucket;

  return {
    async createMultipartUpload(key, contentType) {
      const result = await s3.send(
        new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType, ServerSideEncryption: "AES256" }),
      );
      if (!result.UploadId) throw new Error("S3 no devolvió UploadId");
      return result.UploadId;
    },

    presignUploadPart(key, uploadId, partNumber, expiresInSeconds) {
      // La URL solo sirve para ESTA parte de ESTE archivo y caduca sola.
      return getSignedUrl(s3, new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), {
        expiresIn: expiresInSeconds,
      });
    },

    async completeMultipartUpload(key, uploadId, parts) {
      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
        }),
      );
    },

    async abortMultipartUpload(key, uploadId) {
      await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
    },

    async getObjectSize(key) {
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
        return head.ContentLength ?? null;
      } catch (err) {
        if (err instanceof NotFound || (err as { name?: string }).name === "NotFound") return null;
        throw err;
      }
    },

    async deleteObject(key) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    async deletePrefix(prefix) {
      let deleted = 0;
      let ContinuationToken: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }));
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (keys.length > 0) {
          const result = await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys, Quiet: true } }));
          if (result.Errors?.length) throw new Error(`S3 no pudo borrar ${result.Errors.length} archivos`);
          deleted += keys.length;
        }
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return deleted;
    },

    presignGet(key, expiresInSeconds, downloadFilename) {
      const disposition = downloadFilename
        ? `attachment; filename="${downloadFilename.replace(/[^\w.-]/g, "_")}"`
        : undefined;
      return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key, ResponseContentDisposition: disposition }), {
        expiresIn: expiresInSeconds,
      });
    },
  };
}
