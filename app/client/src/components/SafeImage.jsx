import { useEffect, useState } from "react";

export default function SafeImage({ src, alt = "", fallback, ...props }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => { setFailed(false); }, [src]);

  if (!src || failed) return fallback || null;
  return (
    <img
      {...props}
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
