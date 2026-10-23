import { withApiRoute, json, requireMode } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";
import { ingestUpload } from "@/lib/server/ingest";
import { detectKind, MAX_FILE_BYTES } from "@/lib/server/ingest-kind";

export const dynamic = "force-dynamic";

/** GET /api/v1/datasets — metadata for every uploaded dataset. */
export const GET = withApiRoute(async () => {
  const items = await db.dataset.findMany({ orderBy: { createdAt: "desc" } });
  return json({
    items: items.map((d) => ({
      id: d.id, kind: d.kind, sha256: d.sha256, rows: d.rows, syntheticTag: d.syntheticTag,
      mappingProfile: d.mappingProfileJson ? JSON.parse(d.mappingProfileJson) : null,
      createdAt: d.createdAt,
    })),
  });
});

/**
 * POST /api/v1/datasets — multipart upload of transactions, employees, policy
 * or finding format. Limits, PII and synthetic checks run before any write.
 */
export const POST = withApiRoute(async ({ req, actor }) => {
  const enabled = await db.featureFlag.findUnique({ where: { key: "uploads.enabled" } });
  if (enabled?.value === "false") throw new MzError("MZ-MODE-503", "Uploads are off by flag uploads.enabled.");
  await requireMode("upload");

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_FILE_BYTES + 1024 * 1024) throw new MzError("MZ-DS-413", "The request is larger than 50 MB.");
  const form = await req.formData().catch(() => null);
  if (!form) throw new MzError("MZ-VAL-422", "A multipart/form-data upload is required.");
  const file = form.get("file");
  if (!(file instanceof File)) throw new MzError("MZ-VAL-422", "The form field 'file' is required.");
  const buffer = new Uint8Array(await file.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES) throw new MzError("MZ-DS-413", "The file is larger than 50 MB.");
  const requestedKind = String(form.get("kind") ?? "auto");
  const source = String(form.get("source") ?? (requestedKind === "auto" ? "default" : requestedKind));
  const synthetic = ["true", "yes", "1"].includes(String(form.get("synthetic") ?? "").toLowerCase());
  const kind = detectKind(requestedKind, file.name, buffer);
  const result = await ingestUpload({ kind, source, filename: file.name, buffer, synthetic, actor: actor.id });
  return json(result, result.dataset.deduplicated ? 200 : 201);
});
