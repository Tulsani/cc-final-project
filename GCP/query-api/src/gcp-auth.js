let _accessToken  = null;
let _tokenExpiresAt = 0;

export const getAccessToken = async () => {
  if (_accessToken && Date.now() < _tokenExpiresAt) return _accessToken;
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if (!res.ok) throw new Error(`Metadata token fetch failed: ${res.status}`);
  const data = await res.json();
  _accessToken    = data.access_token;
  _tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
  return _accessToken;
};

export const getProjectId = async () => {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/project/project-id',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if (!res.ok) throw new Error(`Metadata project-id fetch failed: ${res.status}`);
  return res.text();
};