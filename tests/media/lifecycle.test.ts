import { describe, expect, it } from "vitest";
import type { Bindings } from "@/worker/env";
import { MediaError } from "@/worker/media/errors";
import {
  bindUpload,
  copyObjectsForBinding,
  deriveBoundMediaScope,
  derivePostMediaScope,
  isBoundObjectKey,
  reconcileBoundUploadScope,
  serveMedia,
  type ObjectMove,
} from "@/worker/media/lifecycle";
import {
  isAnyTemporaryObjectKey,
  isTemporaryObjectKey,
} from "@/worker/media/service";
import {
  makeCategory,
  makeGuest,
  makeTopic,
  makeViewer,
} from "../permissions/fixtures";

const UPLOAD_ID = "11111111-1111-4111-8111-111111111111";
const TOPIC_ID = "22222222-2222-4222-8222-222222222222";
const POST_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const SOURCE_MAIN =
  `tmp/${OWNER_ID}/66666666-6666-4666-8666-666666666666.png`;
const SOURCE_THUMB =
  `tmp/${OWNER_ID}/77777777-7777-4777-8777-777777777777.png`;

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  new DataView(bytes.buffer).setUint32(8, 13, false);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

function base64(buffer: ArrayBuffer): string {
  return btoa(
    String.fromCharCode(...new Uint8Array(buffer)),
  );
}

interface Stored {
  key: string;
  body: ArrayBuffer;
  mimeType: string;
  digest: ArrayBuffer;
  uploaded: Date;
}

function r2Object(stored: Stored, body: boolean): R2Object | R2ObjectBody {
  const common = {
    key: stored.key,
    version: "v1",
    size: stored.body.byteLength,
    etag: "etag",
    httpEtag: '"etag"',
    checksums: {
      sha256: stored.digest.slice(0),
      toJSON: () => ({ sha256: base64(stored.digest) }),
    },
    uploaded: stored.uploaded,
    httpMetadata: { contentType: stored.mimeType },
    customMetadata: {},
    storageClass: "Standard",
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", stored.mimeType);
    },
  };
  if (!body) return common as unknown as R2Object;
  return {
    ...common,
    body: new Blob([stored.body]).stream(),
    bodyUsed: false,
    arrayBuffer: async () => stored.body.slice(0),
    bytes: async () => new Uint8Array(stored.body.slice(0)),
    text: async () => new TextDecoder().decode(stored.body),
    json: async <T>() => JSON.parse(new TextDecoder().decode(stored.body)) as T,
    blob: async () => new Blob([stored.body]),
  } as unknown as R2ObjectBody;
}

class MemoryBucket {
  readonly objects = new Map<string, Stored>();
  readonly gets: string[] = [];
  readonly deletes: string[][] = [];
  failPutNumber: number | null = null;
  private puts = 0;

  async seed(
    key: string,
    bytes: Uint8Array,
    mimeType = "image/png",
    uploaded = new Date(),
  ): Promise<void> {
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    this.objects.set(key, {
      key,
      body,
      mimeType,
      digest: await crypto.subtle.digest("SHA-256", body),
      uploaded,
    });
  }

  async head(key: string): Promise<R2Object | null> {
    const stored = this.objects.get(key);
    return stored ? (r2Object(stored, false) as R2Object) : null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    this.gets.push(key);
    const stored = this.objects.get(key);
    return stored ? (r2Object(stored, true) as R2ObjectBody) : null;
  }

  async put(
    key: string,
    value: ArrayBuffer,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    this.puts += 1;
    if (this.puts === this.failPutNumber) throw new Error("simulated put failure");
    const body = value.slice(0);
    const digest =
      options?.sha256 instanceof ArrayBuffer
        ? options.sha256.slice(0)
        : await crypto.subtle.digest("SHA-256", body);
    const stored: Stored = {
      key,
      body,
      mimeType:
        options?.httpMetadata instanceof Headers
          ? options.httpMetadata.get("content-type") ?? ""
          : options?.httpMetadata?.contentType ?? "",
      digest,
      uploaded: new Date(),
    };
    this.objects.set(key, stored);
    return r2Object(stored, false) as R2Object;
  }

  async delete(keys: string | string[]): Promise<void> {
    const values = Array.isArray(keys) ? keys : [keys];
    this.deletes.push(values);
    values.forEach((key) => this.objects.delete(key));
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    return {
      objects: [...this.objects.values()]
        .filter((object) => object.key.startsWith(prefix))
        .map((object) => r2Object(object, false) as R2Object),
      delimitedPrefixes: [],
      truncated: false,
    };
  }

  asBucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

function bindings(
  database: D1Database,
  privateBucket: R2Bucket,
  publicBucket: R2Bucket,
): Bindings {
  return {
    CFORUM_DB: database,
    PRIVATE_MEDIA: privateBucket,
    PUBLIC_MEDIA: publicBucket,
  } as unknown as Bindings;
}

function result(rows: unknown[]): D1Result {
  return {
    success: true,
    results: rows,
    meta: { changes: 0 },
  } as unknown as D1Result;
}

function idempotentDatabase(): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        sql,
        bind() {
          return statement;
        },
      };
      return statement;
    },
    async batch() {
      return [
        result([
          {
            id: UPLOAD_ID,
            owner_user_id: OWNER_ID,
            topic_id: TOPIC_ID,
            post_id: POST_ID,
            scope: "private",
            state: "bound",
            object_key: `bound/${UPLOAD_ID}/${ATTEMPT_ID}/main.png`,
            content_hash: "unused",
            mime_type: "image/png",
            byte_size: 24,
            width: 1,
            height: 1,
          },
        ]),
        result([]),
        result([
          {
            post_id: POST_ID,
            topic_id: TOPIC_ID,
            post_author_id: OWNER_ID,
            post_status: "published",
            topic_status: "open",
            category_id: "category-1",
            owner_status: "active",
          },
        ]),
      ];
    },
  } as unknown as D1Database;
}

function mediaDatabase(
  media: Record<string, unknown>,
  category: Record<string, unknown> = publicCategory(),
): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          if (sql.includes("FROM uploads u") && sql.includes("JOIN posts")) {
            return media;
          }
          if (sql.includes("FROM topics t")) {
            return {
              id: TOPIC_ID,
              category_id: "category-1",
              author_id: OWNER_ID,
              min_view_level: 0,
              effective_min_view_level: 0,
              author_qualified_visibility_level: 0,
              author_downgrade_locked: 0,
              status: "open",
              author_trust_level: 1,
            };
          }
          if (sql.includes("FROM categories")) return category;
          throw new Error(`unexpected first query: ${sql}`);
        },
        async all() {
          if (sql.includes("FROM category_permissions")) {
            return {
              success: true,
              results: category.acl_mode === "restricted"
                ? [
                    {
                      category_id: "category-1",
                      principal_type: "group",
                      principal_id: "secret-group",
                      action: "see",
                    },
                  ]
                : [],
              meta: {},
            };
          }
          throw new Error(`unexpected all query: ${sql}`);
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function reconciliationDatabase(media: Record<string, unknown>): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        sql,
        bind() {
          return statement;
        },
        async first() {
          if (sql.includes("FROM uploads u") && sql.includes("JOIN posts")) {
            return media;
          }
          if (sql.includes("FROM topics t")) {
            return {
              id: TOPIC_ID,
              category_id: "category-1",
              author_id: OWNER_ID,
              min_view_level: 0,
              effective_min_view_level: 0,
              author_qualified_visibility_level: 0,
              author_downgrade_locked: 0,
              status: "open",
              author_trust_level: 1,
            };
          }
          if (sql.includes("FROM categories")) return publicCategory();
          throw new Error(`unexpected first query: ${sql}`);
        },
        async all() {
          if (sql.includes("FROM upload_variants")) return result([]);
          if (sql.includes("FROM category_permissions")) return result([]);
          throw new Error(`unexpected all query: ${sql}`);
        },
      };
      return statement;
    },
    async batch(statements: D1PreparedStatement[]) {
      return statements.map((rawStatement) => {
        const statement = rawStatement as unknown as { sql: string };
        if (statement.sql.includes("UPDATE uploads")) {
          return {
            ...result([]),
            meta: { changes: 1 },
          } as unknown as D1Result;
        }
        throw new Error(`unexpected batch query: ${statement.sql}`);
      });
    },
  } as unknown as D1Database;
}

function privateCategory() {
  return {
    id: "category-1",
    slug: "private",
    name: "Private",
    description: "",
    color: "#000000",
    state: "active",
    acl_mode: "restricted",
    min_view_level: 0,
    min_reply_level: 0,
    min_create_level: 0,
    allowed_topic_min_level_max: 4,
    require_topic_approval: 0,
    require_reply_approval: 0,
    allow_images: 1,
  };
}

function publicCategory() {
  return {
    ...privateCategory(),
    slug: "public",
    name: "Public",
    acl_mode: "open",
  };
}

function boundMedia(overrides: Record<string, unknown> = {}) {
  return {
    id: UPLOAD_ID,
    owner_user_id: OWNER_ID,
    topic_id: TOPIC_ID,
    post_id: POST_ID,
    scope: "public",
    state: "bound",
    object_key: `bound/${UPLOAD_ID}/${ATTEMPT_ID}/main.png`,
    content_hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    mime_type: "image/png",
    byte_size: 24,
    width: 1,
    height: 1,
    post_author_id: OWNER_ID,
    post_status: "published",
    ...overrides,
  };
}

describe("bound media scope", () => {
  it("requires both the category ACL and all effective view levels to admit guests", () => {
    expect(deriveBoundMediaScope(makeCategory(), makeTopic())).toBe("public");
    expect(
      deriveBoundMediaScope(
        makeCategory(),
        makeTopic({ minViewLevel: 2, effectiveMinViewLevel: 2 }),
      ),
    ).toBe("private");
    expect(
      deriveBoundMediaScope(
        makeCategory({
          aclMode: "restricted",
          grants: [{ principal: "everyone", permission: "see" }],
        }),
        makeTopic(),
      ),
    ).toBe("public");
    expect(
      deriveBoundMediaScope(
        makeCategory({
          aclMode: "restricted",
          grants: [{ principal: "authenticated", permission: "see" }],
        }),
        makeTopic(),
      ),
    ).toBe("private");
  });

  it("keeps pending posts private and makes an approved public post eligible", () => {
    expect(
      derivePostMediaScope(makeCategory(), makeTopic(), "pending"),
    ).toBe("private");
    expect(
      derivePostMediaScope(makeCategory(), makeTopic(), "published"),
    ).toBe("public");
  });
});

describe("two-phase R2 binding", () => {
  it("compensates every attempt-owned destination when a later copy fails", async () => {
    const bytes = png(1, 1);
    const source = new MemoryBucket();
    const destination = new MemoryBucket();
    await source.seed(SOURCE_MAIN, bytes);
    await source.seed(SOURCE_THUMB, bytes);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
    const contentHash = base64(digest);
    const moves: ObjectMove[] = [
      {
        uploadId: UPLOAD_ID,
        id: UPLOAD_ID,
        kind: "main",
        sourceKey: SOURCE_MAIN,
        destinationKey: `bound/${UPLOAD_ID}/${ATTEMPT_ID}/main.png`,
        contentHash,
        mimeType: "image/png",
        byteSize: bytes.byteLength,
        width: 1,
        height: 1,
      },
      {
        uploadId: UPLOAD_ID,
        id: "88888888-8888-4888-8888-888888888888",
        kind: "thumbnail",
        sourceKey: SOURCE_THUMB,
        destinationKey: `bound/${UPLOAD_ID}/${ATTEMPT_ID}/thumbnail.png`,
        contentHash,
        mimeType: "image/png",
        byteSize: bytes.byteLength,
        width: 1,
        height: 1,
      },
    ];
    destination.failPutNumber = 2;

    await expect(
      copyObjectsForBinding(
        source.asBucket(),
        destination.asBucket(),
        moves,
        "private",
      ),
    ).rejects.toMatchObject({ code: "MEDIA_MOVE_FAILED", status: 503 });
    expect(destination.objects.size).toBe(0);
    expect(destination.deletes.at(-1)).toEqual(
      moves.map((move) => move.destinationKey),
    );
    expect(source.objects.size).toBe(2);
  });

  it("returns an already-bound upload without touching R2", async () => {
    const privateBucket = new MemoryBucket();
    const publicBucket = new MemoryBucket();
    const response = await bindUpload(
      bindings(
        idempotentDatabase(),
        privateBucket.asBucket(),
        publicBucket.asBucket(),
      ),
      makeViewer({ userId: OWNER_ID }),
      { uploadId: UPLOAD_ID, topicId: TOPIC_ID, postId: POST_ID },
    );

    expect(response).toEqual({
      uploadId: UPLOAD_ID,
      state: "bound",
      scope: "private",
      media: { main: `/api/media/${UPLOAD_ID}` },
    });
    expect(privateBucket.gets).toEqual([]);
    expect(publicBucket.gets).toEqual([]);
  });

  it("promotes an approved post through the retry-safe reconciliation hook", async () => {
    const bytes = png(1, 1);
    const source = new MemoryBucket();
    const destination = new MemoryBucket();
    const sourceKey = `bound/${UPLOAD_ID}/${ATTEMPT_ID}/main.png`;
    await source.seed(sourceKey, bytes);
    const sourceObject = source.objects.get(sourceKey);
    if (!sourceObject) throw new Error("test source object missing");
    const media = boundMedia({
      scope: "private",
      object_key: sourceKey,
      content_hash: base64(sourceObject.digest),
      post_status: "published",
    });

    const reconciled = await reconcileBoundUploadScope(
      bindings(
        reconciliationDatabase(media),
        source.asBucket(),
        destination.asBucket(),
      ),
      UPLOAD_ID,
    );

    expect(reconciled).toMatchObject({
      uploadId: UPLOAD_ID,
      scope: "public",
      changed: true,
    });
    expect(source.objects.has(sourceKey)).toBe(false);
    expect(
      [...destination.objects.keys()].some(
        (key) => isBoundObjectKey(key, UPLOAD_ID, "main"),
      ),
    ).toBe(true);
  });
});

describe("media access", () => {
  it("re-checks a private topic and conceals media after group access is lost", async () => {
    const privateBucket = new MemoryBucket();
    await expect(
      serveMedia(
        bindings(
          mediaDatabase(
            boundMedia({ scope: "private" }),
            privateCategory(),
          ),
          privateBucket.asBucket(),
          new MemoryBucket().asBucket(),
        ),
        makeViewer({ userId: "different-user", groupIds: new Set() }),
        UPLOAD_ID,
        "main",
        "GET",
      ),
    ).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND", status: 404 });
    expect(privateBucket.gets).toEqual([]);
  });

  it("rejects injected object keys before any R2 lookup", async () => {
    const publicBucket = new MemoryBucket();
    await expect(
      serveMedia(
        bindings(
          mediaDatabase(
            boundMedia({
              object_key: `bound/${UPLOAD_ID}/${ATTEMPT_ID}/../main.png`,
            }),
          ),
          new MemoryBucket().asBucket(),
          publicBucket.asBucket(),
        ),
        makeGuest(),
        UPLOAD_ID,
        "main",
        "GET",
      ),
    ).rejects.toBeInstanceOf(MediaError);
    expect(publicBucket.gets).toEqual([]);
  });

  it("revokes a formerly public Worker URL as soon as the topic ACL tightens", async () => {
    const publicBucket = new MemoryBucket();
    await expect(
      serveMedia(
        bindings(
          mediaDatabase(boundMedia(), privateCategory()),
          new MemoryBucket().asBucket(),
          publicBucket.asBucket(),
        ),
        makeGuest(),
        UPLOAD_ID,
        "main",
        "GET",
      ),
    ).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND", status: 404 });
    expect(publicBucket.gets).toEqual([]);
  });

  it("serves only safe headers and never exposes the storage key", async () => {
    const bucket = new MemoryBucket();
    const key = `bound/${UPLOAD_ID}/${ATTEMPT_ID}/main.png`;
    const bytes = png(1, 1);
    await bucket.seed(key, bytes);
    const stored = bucket.objects.get(key);
    if (!stored) throw new Error("test object missing");
    const contentHash = base64(stored.digest);
    const response = await serveMedia(
      bindings(
        mediaDatabase(boundMedia({ content_hash: contentHash })),
        new MemoryBucket().asBucket(),
        bucket.asBucket(),
      ),
      makeGuest(),
      UPLOAD_ID,
      "main",
      "GET",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=60, must-revalidate",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const expectedEtag = `"sha256-${contentHash
      .slice(0, -1)
      .replaceAll("+", "-")
      .replaceAll("/", "_")}"`;
    expect(response.headers.get("etag")).toBe(expectedEtag);
    expect(JSON.stringify([...response.headers])).not.toContain(key);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

    const notModified = await serveMedia(
      bindings(
        mediaDatabase(boundMedia({ content_hash: contentHash })),
        new MemoryBucket().asBucket(),
        bucket.asBucket(),
      ),
      makeGuest(),
      UPLOAD_ID,
      "main",
      "GET",
      response.headers.get("etag") ?? undefined,
    );
    expect(notModified.status).toBe(304);
    expect(notModified.headers.has("content-length")).toBe(false);
  });
});

describe("storage-key grammar", () => {
  it("accepts only generated temporary and bound keys", () => {
    expect(isTemporaryObjectKey(SOURCE_MAIN, OWNER_ID)).toBe(true);
    expect(isAnyTemporaryObjectKey(SOURCE_MAIN)).toBe(true);
    expect(
      isBoundObjectKey(
        `bound/${UPLOAD_ID}/${ATTEMPT_ID}/thumbnail.png`,
        UPLOAD_ID,
        "thumbnail",
      ),
    ).toBe(true);
    expect(isTemporaryObjectKey(`tmp/${OWNER_ID}/../secret.png`, OWNER_ID)).toBe(
      false,
    );
    expect(
      isBoundObjectKey(`bound/${UPLOAD_ID}/${ATTEMPT_ID}/../main.png`),
    ).toBe(false);
    expect(
      isBoundObjectKey(
        `bound/${UPLOAD_ID}/${ATTEMPT_ID}/main.png`,
        UPLOAD_ID,
        "thumbnail",
      ),
    ).toBe(false);
  });
});
