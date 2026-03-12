import type { NextRequest } from "next/server";

function getForwardedValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value
    .split(",")[0]
    ?.trim() || null;
}

export function getRequestOrigin(request: NextRequest): string {
  const forwardedHost = getForwardedValue(
    request.headers.get("x-forwarded-host"),
  );
  const forwardedProto = getForwardedValue(
    request.headers.get("x-forwarded-proto"),
  );

  if (forwardedHost) {
    return `${forwardedProto ?? "https"}://${forwardedHost}`;
  }

  return request.nextUrl.origin;
}

export function buildAppUrl(request: NextRequest, path: string): URL {
  return new URL(path, getRequestOrigin(request));
}

export function buildSafeAppRedirectUrl(
  request: NextRequest,
  pathOrUrl: string,
  fallbackPath = "/dashboard",
): URL {
  const appOrigin = getRequestOrigin(request);

  try {
    const url = new URL(pathOrUrl, appOrigin);

    if (url.origin !== appOrigin) {
      return buildAppUrl(request, fallbackPath);
    }

    return url;
  } catch {
    return buildAppUrl(request, fallbackPath);
  }
}
