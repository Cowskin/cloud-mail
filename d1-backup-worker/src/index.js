import { WorkflowEntrypoint } from "cloudflare:workers";

const EXPORT_URL = (env) =>
  `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/d1/database/${env.DATABASE_ID}/export`;

async function exportRequest(env, payload) {
  const response = await fetch(EXPORT_URL(env), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.D1_REST_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(`D1 export failed (${response.status}): ${JSON.stringify(body.errors || body)}`);
  }
  return body.result;
}

export async function putMultipart(bucket, key, body, options) {
  const partSize = 5 * 1024 * 1024;
  const upload = await bucket.createMultipartUpload(key, options);
  const uploadedParts = [];
  const reader = body.getReader();
  let buffer = new Uint8Array(partSize);
  let buffered = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      let offset = 0;
      while (offset < value.byteLength) {
        const length = Math.min(partSize - buffered, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + length), buffered);
        buffered += length;
        offset += length;

        if (buffered === partSize) {
          uploadedParts.push(await upload.uploadPart(uploadedParts.length + 1, buffer));
          buffer = new Uint8Array(partSize);
          buffered = 0;
        }
      }
    }

    if (buffered > 0) {
      uploadedParts.push(
        await upload.uploadPart(uploadedParts.length + 1, buffer.subarray(0, buffered))
      );
    }
    return await upload.complete(uploadedParts);
  } catch (error) {
    await upload.abort();
    throw error;
  }
}

export class D1BackupWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const bookmark = await step.do("Start a consistent D1 export", async () => {
      const result = await exportRequest(this.env, { output_format: "polling" });
      if (!result?.at_bookmark) throw new Error("D1 export did not return a bookmark");
      return result.at_bookmark;
    });

    const exported = await step.do(
      "Wait for the export and store a compressed copy",
      { retries: { limit: 360, delay: "5 seconds", backoff: "constant" }, timeout: "45 minutes" },
      async () => {
        const result = await exportRequest(this.env, {
          output_format: "polling",
          current_bookmark: bookmark
        });

        if (result?.status === "error" || result?.success === false) {
          throw new Error(`D1 export stopped: ${result.error || "unknown error"}`);
        }

        const completed = result?.result || result;
        if (!completed?.signed_url || !completed?.filename) {
          throw new Error("D1 export is still being prepared");
        }

        const dump = await fetch(completed.signed_url);
        if (!dump.ok || !dump.body) throw new Error(`Could not download D1 export (${dump.status})`);

        const scheduledAt = new Date(event.timestamp || Date.now());
        const date = scheduledAt.toISOString().slice(0, 10);
        const key = `weekly/${date}/${completed.filename}.gz`;
        const compressed = dump.body.pipeThrough(new CompressionStream("gzip"));
        await putMultipart(this.env.BACKUP_BUCKET, key, compressed, {
          httpMetadata: { contentType: "application/gzip" },
          customMetadata: {
            databaseId: this.env.DATABASE_ID,
            bookmark,
            createdAt: scheduledAt.toISOString(),
            compression: "gzip"
          }
        });
        return { key };
      }
    );

    return exported;
  }
}

export default {
  async fetch() {
    return new Response("Not found", { status: 404 });
  }
};
