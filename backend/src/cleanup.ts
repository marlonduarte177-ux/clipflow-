import type { FastifyBaseLogger } from "fastify";
import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { HEARTBEAT_TIMEOUT_SECONDS, schema, type Database } from "@clipflow/shared/db";
import type { VideoStorage } from "./storage.js";

const { projects, videos, processingJobs, clips, exports } = schema;

/** Lo que hay que borrar de S3 cuando se eliminan videos (se calcula ANTES de borrar las filas). */
export interface VideoFiles {
  prefixes: string[];
  keys: string[];
  uploads: { key: string; uploadId: string }[];
}

/**
 * Elimina videos del usuario con todo lo que generaron (trabajos, clips, subtítulos, exportaciones).
 * - No se borra un video que un worker está procesando en este momento: devuelve "busy".
 *   (Un procesamiento colgado, sin latido en 3 min, sí se puede borrar.)
 * - Las filas se borran en una transacción que bloquea los trabajos: un worker no puede
 *   tomarlos a la vez.
 * - El historial de consumo (`usage`) se conserva, sin el enlace al video.
 * - Con `projectId` también se borra el proyecto, en la misma transacción (así no se cuela
 *   un video nuevo sin limpiar sus archivos).
 * Devuelve los archivos a borrar de S3, que se borran después con `purgeVideoFiles`.
 */
export async function deleteVideoRows(
  db: Database,
  userId: string,
  where: { videoId: string } | { projectId: string },
): Promise<{ status: "busy" } | { status: "not_found" } | { status: "deleted"; files: VideoFiles; videoIds: string[] }> {
  return db.transaction(async (tx) => {
    if ("projectId" in where) {
      const [project] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, where.projectId), eq(projects.userId, userId)))
        .for("update");
      if (!project) return { status: "not_found" };
    }
    const own = await tx
      .select({ id: videos.id, s3Key: videos.s3Key, s3UploadId: videos.s3UploadId })
      .from(videos)
      .where(
        and(
          eq(videos.userId, userId),
          "videoId" in where ? eq(videos.id, where.videoId) : eq(videos.projectId, where.projectId),
        ),
      )
      .for("update");
    const videoIds = own.map((v) => v.id);
    const files: VideoFiles = { prefixes: [], keys: [], uploads: [] };
    if ("videoId" in where && videoIds.length === 0) return { status: "not_found" };

    const jobs = videoIds.length === 0 ? [] : await tx
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(and(eq(processingJobs.userId, userId), inArray(processingJobs.videoId, videoIds)))
      .for("update");
    const [busy] = jobs.length === 0 ? [] : await tx
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.userId, userId),
          inArray(processingJobs.videoId, videoIds),
          eq(processingJobs.status, "processing"),
          gt(processingJobs.heartbeatAt, sql`now() - make_interval(secs => ${HEARTBEAT_TIMEOUT_SECONDS})`),
        ),
      );
    if (busy) return { status: "busy" };

    const exportKeys = videoIds.length === 0 ? [] : await tx
      .select({ key: exports.s3Key })
      .from(exports)
      .innerJoin(clips, and(eq(clips.id, exports.clipId), eq(clips.userId, exports.userId)))
      .where(and(eq(exports.userId, userId), inArray(clips.videoId, videoIds), isNotNull(exports.s3Key)));

    for (const video of own) {
      files.prefixes.push(`originals/${userId}/${video.id}/`);
      if (video.s3UploadId) files.uploads.push({ key: video.s3Key, uploadId: video.s3UploadId });
    }
    for (const job of jobs) {
      for (const folder of ["clips", "thumbnails", "subtitles"]) files.prefixes.push(`${folder}/${userId}/${job.id}/`);
    }
    files.keys.push(...exportKeys.map((e) => e.key!));

    if (videoIds.length > 0) await tx.delete(videos).where(and(eq(videos.userId, userId), inArray(videos.id, videoIds)));
    if ("projectId" in where) {
      await tx.delete(projects).where(and(eq(projects.id, where.projectId), eq(projects.userId, userId)));
    }
    return { status: "deleted", files, videoIds };
  });
}

/**
 * Borra de S3 los archivos de videos ya eliminados. Si algo falla se registra y se sigue:
 * el video ya no existe para el usuario; lo que quede es solo espacio a limpiar.
 */
export async function purgeVideoFiles(storage: VideoStorage, files: VideoFiles, log: FastifyBaseLogger): Promise<void> {
  const tasks = [
    ...files.uploads.map((u) => storage.abortMultipartUpload(u.key, u.uploadId)),
    ...files.prefixes.map((prefix) => storage.deletePrefix(prefix)),
    ...files.keys.map((key) => storage.deleteObject(key)),
  ];
  const results = await Promise.allSettled(tasks);
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) log.warn({ failed, total: tasks.length }, "no se pudieron borrar algunos archivos en S3");
}
