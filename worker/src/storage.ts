import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Lo que el worker necesita de S3. */
export interface WorkerStorage {
  download(key: string, file: string, onBytes?: (bytes: number) => void, signal?: AbortSignal): Promise<void>;
  upload(file: string, key: string, contentType: string): Promise<void>;
}

export function createS3WorkerStorage(options: { bucket: string; region: string; client?: S3Client }): WorkerStorage {
  const s3 = options.client ?? new S3Client({ region: options.region });
  const Bucket = options.bucket;
  return {
    async download(key, file, onBytes, signal) {
      const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }), { abortSignal: signal });
      if (!res.Body) throw new Error("S3 devolvió un archivo vacío");
      const body = res.Body as Readable;
      let total = 0;
      body.on("data", (chunk: Buffer) => {
        total += chunk.length;
        onBytes?.(total);
      });
      await pipeline(body, createWriteStream(file), { signal });
    },
    async upload(file, key, contentType) {
      const { size } = await stat(file);
      await s3.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: createReadStream(file),
          ContentLength: size,
          ContentType: contentType,
          ServerSideEncryption: "AES256",
        }),
      );
    },
  };
}

/** Almacenamiento en una carpeta local (tests y desarrollo sin AWS). */
export function createLocalStorage(root: string): WorkerStorage {
  return {
    async download(key, file, onBytes) {
      await copyFile(path.join(root, key), file);
      onBytes?.((await stat(file)).size);
    },
    async upload(file, key) {
      const target = path.join(root, key);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(file, target);
    },
  };
}
