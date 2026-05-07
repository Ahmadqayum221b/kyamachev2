/**
 * Backblaze B2 helper — uses the B2 Native API (not S3-compatible)
 * Docs: https://www.backblaze.com/apidocs/
 *
 * FIX (bug): B2Client previously cached the auth token on the instance,
 * but Cloudflare Workers are ephemeral — a new makeB2() call on every
 * request creates a fresh instance with _auth=null, making the cache useless
 * and causing an extra authorize() round-trip on every operation.
 *
 * Fix: auth token is now stored in Cloudflare KV (if available) with a
 * 23-hour TTL. Falls back to a fresh authorize() when KV is unavailable.
 */

const B2_API       = 'https://api.backblazeb2.com';
const B2_AUTH_KEY  = 'b2:auth_token';
const B2_AUTH_TTL  = 23 * 60 * 60; // 23 hours in seconds

export class B2Client {
  constructor(keyId, appKey, bucketId, bucketName, kv = null) {
    this.keyId      = keyId;
    this.appKey     = appKey;
    this.bucketId   = bucketId;
    this.bucketName = bucketName;
    this.kv         = kv; // Cloudflare KV binding for token caching
  }

  async authorize() {
    // Try KV cache first
    if (this.kv) {
      const cached = await this.kv.get(B2_AUTH_KEY, 'json').catch(() => null);
      if (cached) return cached;
    }

    const creds = btoa(`${this.keyId}:${this.appKey}`);
    const res   = await fetch(`${B2_API}/b2api/v3/b2_authorize_account`, {
      headers: { Authorization: `Basic ${creds}` },
    });
    if (!res.ok) throw new Error(`B2 auth failed: ${res.status} ${await res.text()}`);

    const data = await res.json();
    const auth = {
      apiUrl:      data.apiInfo.storageApi.apiUrl,
      downloadUrl: data.apiInfo.storageApi.downloadUrl,
      authToken:   data.authorizationToken,
    };

    // Persist to KV so subsequent requests in the same ~24h window reuse it
    if (this.kv) {
      await this.kv.put(B2_AUTH_KEY, JSON.stringify(auth), { expirationTtl: B2_AUTH_TTL })
        .catch(err => console.warn('[b2] KV cache write failed:', err.message));
    }

    return auth;
  }

  // FIX (bug): private helper that accepts an already-resolved auth so
  // upload() can share one authorize() call instead of calling it twice.
  async _getUploadUrl(auth) {
    const res = await fetch(`${auth.apiUrl}/b2api/v3/b2_get_upload_url`, {
      method:  'POST',
      headers: { Authorization: auth.authToken, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ bucketId: this.bucketId }),
    });
    if (!res.ok) throw new Error(`B2 get_upload_url failed: ${await res.text()}`);
    return res.json();
  }

  async getUploadUrl() {
    const auth = await this.authorize();
    return this._getUploadUrl(auth);
  }

  async upload(key, buffer, mimeType = 'application/octet-stream') {
    // FIX (bug): previously called authorize() twice — once inside getUploadUrl()
    // and again directly. Call it once and reuse the result.
    const auth       = await this.authorize();
    const uploadInfo = await this._getUploadUrl(auth);

    const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
    const sha1       = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    const res = await fetch(uploadInfo.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization:       uploadInfo.authorizationToken,
        'X-Bz-File-Name':   encodeURIComponent(key),
        'Content-Type':      mimeType,
        'Content-Length':    buffer.byteLength,
        'X-Bz-Content-Sha1': sha1,
      },
      body: buffer,
    });
    if (!res.ok) throw new Error(`B2 upload failed: ${await res.text()}`);

    const data = await res.json();
    return {
      fileId:    data.fileId,
      fileName:  data.fileName,
      publicUrl: `${auth.downloadUrl}/file/${this.bucketName}/${key}`,
    };
  }

  async getDownloadUrl(key, validDurationSeconds = 3600) {
    const auth = await this.authorize();
    const res  = await fetch(`${auth.apiUrl}/b2api/v3/b2_get_download_authorization`, {
      method:  'POST',
      headers: { Authorization: auth.authToken, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        bucketId:               this.bucketId,
        fileNamePrefix:         key,
        validDurationInSeconds: validDurationSeconds,
      }),
    });
    if (!res.ok) throw new Error(`B2 download_auth failed: ${await res.text()}`);
    const data = await res.json();
    return `${auth.downloadUrl}/file/${this.bucketName}/${key}?Authorization=${data.authorizationToken}`;
  }

  async deleteFile(fileId, fileName) {
    const auth = await this.authorize();
    const res  = await fetch(`${auth.apiUrl}/b2api/v3/b2_delete_file_version`, {
      method:  'POST',
      headers: { Authorization: auth.authToken, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fileId, fileName }),
    });
    if (!res.ok) throw new Error(`B2 delete failed: ${await res.text()}`);
    return true;
  }

  /**
   * Verify file existence via HEAD request to the download URL.
   * Cheap and works for both public and private buckets (with auth).
   */
  async fileExists(key) {
    const auth = await this.authorize();
    const url  = `${auth.downloadUrl}/file/${this.bucketName}/${key}`;
    const res  = await fetch(url, {
      method:  'HEAD',
      headers: { Authorization: auth.authToken },
    });
    return res.ok;
  }
}

// FIX: pass the KV binding so authorize() can cache the token across requests
export function makeB2(env) {
  return new B2Client(
    env.B2_KEY_ID,
    env.B2_APP_KEY,
    env.B2_BUCKET_ID,
    env.B2_BUCKET_NAME,
    env.KYMACACHE_KV ?? null,
  );
}
