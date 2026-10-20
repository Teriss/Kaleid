import { useEffect, useState } from "react";
import type { MediaItem } from "../../../shared/types";
import { provider } from "./catalog";
import { report, useApp } from "../store";
export default function PlatformActions({ item }: { item: MediaItem }) {
  const [allowed, setAllowed] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setAllowed(false);
    if (item.sourceRef?.kind === "online")
      void provider(item.sourceRef.providerId).then((p) => {
        if (live) setAllowed(Boolean(p.mutations?.likeSong));
      });
    return () => {
      live = false;
    };
  }, [item.id]);
  if (!allowed) return null;
  async function like(value: boolean) {
    if (item.sourceRef?.kind !== "online") return;
    setBusy(true);
    try {
      const p = await provider(item.sourceRef.providerId);
      await p.mutations.likeSong(item.remoteData, value);
      useApp.getState().notify(value ? "已添加到平台喜欢" : "已取消平台喜欢");
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="text-button"
        disabled={busy}
        onClick={() => void like(true)}
      >
        平台喜欢
      </button>
      <button
        className="text-button"
        disabled={busy}
        onClick={() => void like(false)}
      >
        取消平台喜欢
      </button>
    </>
  );
}
