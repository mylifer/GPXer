import type { ComponentProps } from "react";
import { MapView } from "./MapView";
import { DetailPanel } from "./DetailPanel";
import { useIdx, type IdxStore } from "../lib/idxStore";

/** İmleci dış depodan okuyan sarmalayıcılar: imleç değişince yalnızca bunlar yeniden çizilir. */
export function HoverMapView({ cursor, ...rest }: Omit<ComponentProps<typeof MapView>, "hoverIdx"> & { cursor: IdxStore }) {
  return <MapView {...rest} hoverIdx={useIdx(cursor)} />;
}

export function HoverDetailPanel({ cursor, ...rest }: Omit<ComponentProps<typeof DetailPanel>, "hoverIdx"> & { cursor: IdxStore }) {
  return <DetailPanel {...rest} hoverIdx={useIdx(cursor)} />;
}
