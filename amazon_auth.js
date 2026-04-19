// amazon_auth.js — LWA token refresh for SP-API and Amazon Ads API

import axios from "axios";

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

// In-memory token cache
const tokenCache = {
  spApi: { accessToken: null, expiresAt: 0 },
  ads: { accessToken: null, expiresAt: 0 },
};

export function hasSpApiCredentials() {
  return !!(
    process.env.SP_API_CLIENT_ID &&
    process.env.SP_API_CLIENT_SECRET &&
    process.env.SP_API_REFRESH_TOKEN
  );
}

export function hasAdsCredentials() {
  return !!(
    process.env.AMAZON_ADS_CLIENT_ID &&
    process.env.AMAZON_ADS_CLIENT_SECRET &&
    process.env.AMAZON_ADS_REFRESH_TOKEN
  );
}

async function refreshToken({ clientId, clientSecret, refreshToken, cacheKey }) {
  const cache = tokenCache[cacheKey];

  // Return cached token if still valid (with 60s buffer)
  if (cache.accessToken && Date.now() < cache.expiresAt - 60000) {
    return cache.accessToken;
  }

  const res = await axios.post(
    LWA_TOKEN_URL,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  cache.accessToken = res.data.access_token;
  cache.expiresAt = Date.now() + res.data.expires_in * 1000;

  return cache.accessToken;
}

export async function getSpApiToken() {
  return refreshToken({
    clientId: process.env.SP_API_CLIENT_ID,
    clientSecret: process.env.SP_API_CLIENT_SECRET,
    refreshToken: process.env.SP_API_REFRESH_TOKEN,
    cacheKey: "spApi",
  });
}

export async function getAdsToken() {
  return refreshToken({
    clientId: process.env.AMAZON_ADS_CLIENT_ID,
    clientSecret: process.env.AMAZON_ADS_CLIENT_SECRET,
    refreshToken: process.env.AMAZON_ADS_REFRESH_TOKEN,
    cacheKey: "ads",
  });
}
