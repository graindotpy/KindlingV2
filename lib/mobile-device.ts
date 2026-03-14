const MOBILE_DEVICE_PATTERN =
  /Android.+Mobile|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini|Windows Phone|Mobile Safari/i;

export function isMobileUserAgent(userAgent: string | null | undefined) {
  if (!userAgent) {
    return false;
  }

  return MOBILE_DEVICE_PATTERN.test(userAgent);
}
