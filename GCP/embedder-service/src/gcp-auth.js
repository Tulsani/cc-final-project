

let _accessToken   = null;
let _tokenExpiresAt = 0;

/**
 * Returns a valid GCP access token using the Cloud Run metadata server.
 * No credentials needed — Cloud Run handles this via the attached SA.
 */
export const getAccessToken = async () => {
  if (_accessToken && Date.now() < _tokenExpiresAt) return _accessToken;

  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );

  if (!res.ok) throw new Error(`Metadata server token fetch failed: ${res.status}`);

  const data       = await res.json();
  _accessToken     = data.access_token;
  // Expire 5 min early
  _tokenExpiresAt  = Date.now() + (data.expires_in - 300) * 1000;

  return _accessToken;
};

/**
 * Returns the current GCP project ID from the metadata server.
 */
export const getProjectId = async () => {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/project/project-id',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if (!res.ok) throw new Error(`Metadata server project-id fetch failed: ${res.status}`);
  return res.text();
};