import { describe, expect, it } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { createS3Storage } from "./storage.js";

describe("createS3Storage.presignUploadPart (firma real, sin red)", () => {
  const storage = createS3Storage({
    bucket: "clipflow-test-bucket",
    region: "us-east-1",
    // Credenciales falsas: firmar una URL no llama a AWS.
    client: new S3Client({ region: "us-east-1", credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" } }),
  });

  it("genera una URL limitada a una parte, un archivo y un tiempo", async () => {
    const url = new URL(await storage.presignUploadPart("originals/u/v/original.mp4", "upload-123", 7, 900));
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toContain("clipflow-test-bucket");
    expect(url.pathname).toBe("/originals/u/v/original.mp4");
    expect(url.searchParams.get("partNumber")).toBe("7");
    expect(url.searchParams.get("uploadId")).toBe("upload-123");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });
});
