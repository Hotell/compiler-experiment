import type { CSSProperties } from "react";

const styleKeys = { color: "--widget-color", fill: "--widget-fill" };

export function Example({ iconColor }: { iconColor: string | undefined }) {
  const style: CSSProperties & Record<string, string | undefined> = {
    [`${styleKeys.color}`]: iconColor,
    [`${styleKeys.fill}`]: iconColor,
  };
  return <div style={style}>{iconColor}</div>;
}
