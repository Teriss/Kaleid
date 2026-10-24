import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LoaderCircle } from "lucide-react";
import type { ComicPreviewSession } from "./comicPreviewSession";
import { formatOnlineComicError } from "../../shared/onlineComicErrors";

function PreviewImage({ url, index, read, canRead }: { url: string; index: number; read(): void; canRead: boolean }) {
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  return <div className="comic-preview-tile">
    <button className="comic-preview-open" onClick={read} disabled={!canRead} aria-label={`从第 ${index + 1} 页开始阅读`}>
      <span className="comic-preview-image">
        {failed ? <span className="muted">预览加载失败</span> : <img
          src={retry ? `${url}?retry=${retry}` : url} loading="lazy" decoding="async"
          alt={`第 ${index + 1} 页预览`} onError={() => setFailed(true)} draggable={false}
        />}
      </span>
      <span className="comic-preview-number">{index + 1}</span>
    </button>
    {failed && <button className="text-button comic-preview-retry" aria-label={`重试第 ${index + 1} 页预览图`}
      onClick={() => { setFailed(false); setRetry((value) => value + 1); }}>重试图片</button>}
  </div>;
}

export default function ComicPreviews({ session, read, canRead }: {
  session: ComicPreviewSession;
  read(index: number): void;
  canRead: boolean;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => { void session.start(); }, [session]);
  useEffect(() => {
    if (!sentinel.current || !state.hasMore || state.loading || state.error) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void session.loadNext();
    }, { root: sentinel.current.closest(".online-comics"), rootMargin: "200px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [session, state.hasMore, state.loading, state.error, state.items.length]);
  return <section className="comic-detail-section comic-detail-preview-section" aria-label="漫画预览">
    <div className="comic-detail-section-heading"><div><h2>预览</h2><span>{state.items.length} 页{state.hasMore ? "已加载" : ""}</span></div></div>
    <div className="comic-preview-grid" aria-busy={state.loading}>
      {state.items.map((url, index) => <PreviewImage key={`${index}:${url}`} url={url} index={index} canRead={canRead} read={() => read(index)} />)}
    </div>
    {!state.items.length && !state.loading && !state.error && <p className="muted">漫画源暂无预览图片。</p>}
    <div className="comic-preview-footer" ref={sentinel}>
      {state.loading && <p role="status"><LoaderCircle size={16} className="spin" />正在加载预览…</p>}
      {state.error && <div role="alert"><p>{formatOnlineComicError(state.error)}</p><button className="button secondary" onClick={() => void session.loadNext()}>重试预览</button></div>}
      {!state.loading && !state.error && state.hasMore && <button className="text-button" onClick={() => void session.loadNext()}>加载更多预览</button>}
    </div>
  </section>;
}
