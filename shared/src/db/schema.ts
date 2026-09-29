/**
 * Esquema de la base de datos de ClipFlow (PostgreSQL).
 *
 * Reglas generales:
 * - Toda tabla con datos de un usuario tiene `user_id`: las consultas SIEMPRE filtran por él.
 * - Los archivos viven en S3; aquí solo se guarda la ruta (`*_s3_key`), nunca el archivo.
 * - Cambiar este archivo NO cambia la base de datos: hay que generar una migración
 *   (`npm run db:generate -w @clipflow/shared`) y aplicarla (`npm run db:migrate`).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Enums (valores permitidos)
// ---------------------------------------------------------------------------

export const videoStatus = pgEnum("video_status", [
  "pending_upload", // registro creado, el navegador está subiendo a S3
  "uploaded", // S3 confirmó el archivo completo
  "ready", // validado con ffprobe, listo para procesar
  "rejected", // no es un video válido o supera los límites
  "deleted",
]);

export const jobType = pgEnum("job_type", ["analyze_video", "render_clip", "export_clip"]);

export const jobStatus = pgEnum("job_status", ["queued", "processing", "completed", "failed", "cancelled"]);

export const jobStage = pgEnum("job_stage", [
  "preparing",
  "analyzing",
  "detecting_moments",
  "rendering_clips",
  "finalizing",
]);

export const clipStatus = pgEnum("clip_status", ["generated", "approved", "discarded"]);

export const aspectRatio = pgEnum("aspect_ratio", ["9:16", "1:1", "16:9", "original"]);

export const subtitleFormat = pgEnum("subtitle_format", ["srt", "vtt", "json"]);

export const exportStatus = pgEnum("export_status", ["queued", "processing", "completed", "failed"]);

export const usageMetric = pgEnum("usage_metric", [
  "video_seconds_uploaded",
  "video_seconds_processed",
  "processing_seconds", // tiempo de CPU del worker
  "storage_bytes",
  "clips_generated",
  "ai_audio_seconds",
  "ai_input_tokens",
  "ai_output_tokens",
]);

export const ledgerEntryType = pgEnum("ledger_entry_type", [
  "purchase",
  "subscription",
  "processing",
  "refund",
  "bonus",
  "adjustment",
]);

export const subscriptionStatus = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "expired",
]);

// ---------------------------------------------------------------------------
// Tablas
// ---------------------------------------------------------------------------

/** Usuarios. La identidad y la contraseña las maneja Cognito; aquí se enlaza por `cognito_sub`. */
export const users = pgTable("users", {
  id: id(),
  cognitoSub: text("cognito_sub").notNull().unique(),
  email: text("email"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/*
 * Aislamiento entre usuarios a nivel de base de datos:
 * las tablas hijas apuntan a (id, user_id) del padre. Así es IMPOSIBLE guardar, por ejemplo,
 * un video del usuario A dentro de un proyecto del usuario B, aunque el código tuviera un error.
 */

export const projects = pgTable(
  "projects",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("projects_user_idx").on(t.userId, t.createdAt),
    unique("projects_id_user_uq").on(t.id, t.userId),
    check("projects_name_len", sql`char_length(${t.name}) between 1 and 120`),
  ],
);

export const videos = pgTable(
  "videos",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    status: videoStatus("status").notNull().default("pending_upload"),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    /** Duración real (ffprobe). La que informa el navegador va en `declared_duration_seconds`. */
    durationSeconds: numeric("duration_seconds", { precision: 10, scale: 3, mode: "number" }),
    declaredDurationSeconds: numeric("declared_duration_seconds", { precision: 10, scale: 3, mode: "number" }),
    width: integer("width"),
    height: integer("height"),
    s3Key: text("s3_key").notNull().unique(),
    /** Id del multipart upload de S3 mientras se sube. */
    s3UploadId: text("s3_upload_id"),
    /** Resultado de ffprobe (codecs, fps, etc.). */
    probe: jsonb("probe"),
    rejectionReason: text("rejection_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
  },
  (t) => [
    index("videos_user_idx").on(t.userId, t.createdAt),
    unique("videos_id_user_uq").on(t.id, t.userId),
    foreignKey({
      name: "videos_project_owner_fk",
      columns: [t.projectId, t.userId],
      foreignColumns: [projects.id, projects.userId],
    }).onDelete("cascade"),
    index("videos_project_idx").on(t.projectId),
    check("videos_size_positive", sql`${t.sizeBytes} > 0`),
  ],
);

export const processingJobs = pgTable(
  "processing_jobs",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    videoId: uuid("video_id").notNull(),
    type: jobType("type").notNull(),
    status: jobStatus("status").notNull().default("queued"),
    stage: jobStage("stage"),
    /** Progreso real 0–100 que escribe el worker. */
    progress: smallint("progress").notNull().default(0),
    /** Evita crear dos veces el mismo trabajo (p. ej. doble clic). */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** Parámetros del trabajo (duraciones pedidas, formato, etc.). */
    params: jsonb("params").notNull().default({}),
    lockedBy: text("locked_by"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    errorCode: text("error_code"),
    /** Mensaje apto para mostrar al usuario (sin detalles internos). */
    errorMessage: text("error_message"),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_user_idx").on(t.userId, t.createdAt),
    foreignKey({
      name: "jobs_video_owner_fk",
      columns: [t.videoId, t.userId],
      foreignColumns: [videos.id, videos.userId],
    }).onDelete("cascade"),
    index("jobs_video_idx").on(t.videoId),
    index("jobs_status_idx").on(t.status),
    check("jobs_progress_range", sql`${t.progress} between 0 and 100`),
    check("jobs_attempts_range", sql`${t.attempts} >= 0 and ${t.attempts} <= ${t.maxAttempts}`),
  ],
);

export const clips = pgTable(
  "clips",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    videoId: uuid("video_id").notNull(),
    /** Trabajo que generó (o re-renderizó) el clip. */
    jobId: uuid("job_id").references(() => processingJobs.id, { onDelete: "set null" }),
    status: clipStatus("status").notNull().default("generated"),
    title: text("title"),
    startSeconds: numeric("start_seconds", { precision: 10, scale: 3, mode: "number" }).notNull(),
    endSeconds: numeric("end_seconds", { precision: 10, scale: 3, mode: "number" }).notNull(),
    aspectRatio: aspectRatio("aspect_ratio").notNull().default("9:16"),
    /** Score de interés 0–1 y el aporte de cada señal. */
    score: numeric("score", { precision: 5, scale: 4, mode: "number" }),
    scoreBreakdown: jsonb("score_breakdown"),
    s3Key: text("s3_key"),
    thumbnailS3Key: text("thumbnail_s3_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("clips_user_idx").on(t.userId, t.createdAt),
    unique("clips_id_user_uq").on(t.id, t.userId),
    foreignKey({
      name: "clips_video_owner_fk",
      columns: [t.videoId, t.userId],
      foreignColumns: [videos.id, videos.userId],
    }).onDelete("cascade"),
    index("clips_video_idx").on(t.videoId),
    check("clips_time_range", sql`${t.startSeconds} >= 0 and ${t.endSeconds} > ${t.startSeconds}`),
    check("clips_score_range", sql`${t.score} is null or (${t.score} >= 0 and ${t.score} <= 1)`),
  ],
);

export const subtitles = pgTable(
  "subtitles",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    videoId: uuid("video_id").notNull(),
    /** null = transcripción del video completo; con valor = subtítulos de un clip. */
    clipId: uuid("clip_id"),
    format: subtitleFormat("format").notNull(),
    language: text("language"),
    s3Key: text("s3_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("subtitles_video_idx").on(t.videoId),
    index("subtitles_clip_idx").on(t.clipId),
    foreignKey({
      name: "subtitles_clip_owner_fk",
      columns: [t.clipId, t.userId],
      foreignColumns: [clips.id, clips.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "subtitles_video_owner_fk",
      columns: [t.videoId, t.userId],
      foreignColumns: [videos.id, videos.userId],
    }).onDelete("cascade"),
  ],
);

export const exports = pgTable(
  "exports",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clipId: uuid("clip_id").notNull(),
    jobId: uuid("job_id").references(() => processingJobs.id, { onDelete: "set null" }),
    status: exportStatus("status").notNull().default("queued"),
    /** Preset de salida (resolución, subtítulos quemados, etc.). */
    options: jsonb("options").notNull().default({}),
    s3Key: text("s3_key"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("exports_user_idx").on(t.userId, t.createdAt),
    index("exports_clip_idx").on(t.clipId),
    foreignKey({
      name: "exports_clip_owner_fk",
      columns: [t.clipId, t.userId],
      foreignColumns: [clips.id, clips.userId],
    }).onDelete("cascade"),
  ],
);

/**
 * Consumo y costos: una fila por medición (minutos de video, segundos de CPU, tokens de IA…).
 * Sirve para calcular la rentabilidad. Registro contable: no se borra con el usuario.
 */
export const usage = pgTable(
  "usage",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    jobId: uuid("job_id").references(() => processingJobs.id, { onDelete: "set null" }),
    videoId: uuid("video_id").references(() => videos.id, { onDelete: "set null" }),
    metric: usageMetric("metric").notNull(),
    quantity: numeric("quantity", { precision: 20, scale: 6, mode: "number" }).notNull(),
    /** Costo estimado en USD, si se puede calcular. */
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 14, scale: 6, mode: "number" }),
    details: jsonb("details"),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_user_idx").on(t.userId, t.createdAt),
    index("usage_job_idx").on(t.jobId),
    check("usage_quantity_nonneg", sql`${t.quantity} >= 0`),
  ],
);

/**
 * Libro contable de créditos. Solo se AGREGAN filas (un trigger impide modificar o borrar).
 * El saldo es el `balance_after` de la última fila del usuario; nunca un número editable.
 * `amount` > 0 suma créditos, < 0 los consume.
 */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: id(),
    /** Orden global de inserción (fiable incluso con transacciones concurrentes). */
    seq: bigserial("seq", { mode: "number" }).notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    amount: integer("amount").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    type: ledgerEntryType("type").notNull(),
    /** Qué originó el movimiento, p. ej. ("processing_job", "<uuid>") o ("payment", "<id externo>"). */
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    /** Garantiza que el mismo movimiento no se registre dos veces. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ledger_user_seq_idx").on(t.userId, t.seq),
    check("ledger_amount_nonzero", sql`${t.amount} <> 0`),
    check("ledger_balance_nonneg", sql`${t.balanceAfter} >= 0`),
  ],
);

/** Suscripciones, independientes del proveedor de pagos (se conectará después). */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    planCode: text("plan_code").notNull(),
    status: subscriptionStatus("status").notNull(),
    /** Proveedor de pagos (null hasta integrarlo) y su identificador. */
    provider: text("provider"),
    providerSubscriptionId: text("provider_subscription_id"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("subscriptions_user_idx").on(t.userId),
    uniqueIndex("subscriptions_provider_uq")
      .on(t.provider, t.providerSubscriptionId)
      .where(sql`${t.provider} is not null`),
  ],
);
