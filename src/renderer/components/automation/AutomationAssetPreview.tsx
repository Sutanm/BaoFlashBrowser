import React, { useEffect, useState } from 'react';
import { Image } from 'lucide-react';

export function AssetPreview({
  packageId,
  asset,
}: {
  packageId: string;
  asset: string;
}): React.JSX.Element {
  const [preview, setPreview] = useState<{ dataUrl: string; width: number; height: number }>();
  useEffect(() => {
    let live = true;
    void window.electronAPI.automationV3
      .assetPreview(packageId, asset)
      .then((value) => {
        if (live) setPreview(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [asset, packageId]);
  return (
    <>
      {preview ? <img src={preview.dataUrl} alt="" /> : <Image />}
      {preview && (
        <small>
          {preview.width} × {preview.height}
        </small>
      )}
    </>
  );
}
